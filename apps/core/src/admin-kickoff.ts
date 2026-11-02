import {
  adminKickoffMaxBytes,
  adminKickoffMaxSkewMs,
  adminKickoffPurpose,
  adminKickoffRequestSchema,
  adminKickoffViewOf,
  bytesOfBase64,
} from "@grasp-os/shared/admin-kickoff";
import type { AuditActor } from "@grasp-os/shared/audit";
import { staffWindowOpen } from "@grasp-os/shared/deployment-config";
import { authErrors, requestErrors } from "@grasp-os/shared/errors";
import {
  kickoffErrors,
  transcriptFileMaxBytes,
} from "@grasp-os/shared/kickoff";
import type { KickoffInput, KickoffView } from "@grasp-os/shared/kickoff";
import { log } from "@grasp-os/shared/log";
import { modelErrors } from "@grasp-os/shared/models";
import { onboardingErrors } from "@grasp-os/shared/onboarding";
import type { z } from "zod";

import { appendAuditEvent } from "./audit-outbox.ts";
import { organizationId } from "./auth/auth.ts";
import { signInConfig } from "./auth/config.ts";
import { consoleSigned } from "./console-signed.ts";
import { errorResponse } from "./errors.ts";
import { staffMayStay } from "./onboarding/gate.ts";
import { readKickoff, transcriptOf } from "./onboarding/kickoff.ts";
import { onboardingStore } from "./onboarding/store.ts";

// The kickoff brought in from Grasp's admin (GRA-1099,
// `@grasp-os/shared/admin-kickoff`, which lists what can go wrong): the
// transcript is read and kept exactly as the onboarding staff RPC did
// (onboarding/staff-rpc.ts), so what it brought seeds Stephen's context
// the same way, by the staff member the admin names.
//
// - Only the admin's request signed for this purpose with this company's
//   key reaches it (console-signed.ts); anything else is 401 or 403.
// - Grasp's staff act here only while the company lets them in: its staff
//   window is open and its admin hasn't ended staff access (as a staff
//   session is checked, auth/identity.ts), and once more after the
//   reading, which takes a while, before anything is kept.
// - The admin gets what it brought and the questions it left, never the
//   words it rests on (`adminKickoffViewOf`).

type AdminAsk = z.output<typeof adminKickoffRequestSchema>["ask"];

/** Whether Grasp's staff may act in this company now, by its own sign-in config. */
export const staffLetIn = async (env: Env): Promise<boolean> => {
  const config = signInConfig(env);
  if (!(config?.staff && staffWindowOpen(config, Date.now()))) {
    return false;
  }
  return await staffMayStay(env, config.staff.opened, config.staff.scope);
};

/** The status a refused kickoff answers with: 503 for a reading to try again. */
const kickoffStatus = (code: string): number =>
  code === "kickoff.not_read" ? 503 : 400;

/** The transcript as core's kickoff takes it, a file decoded and bounded first. */
const transcriptInput = (
  transcript: Extract<AdminAsk, { kind: "save" }>["transcript"]
): KickoffInput["transcript"] => {
  if ("text" in transcript) {
    return { text: transcript.text };
  }
  const bytes = bytesOfBase64(transcript.file.base64);
  if (bytes === undefined || bytes.byteLength > transcriptFileMaxBytes) {
    throw kickoffErrors.create("kickoff.invalid");
  }
  return { file: { name: transcript.file.name, bytes } };
};

/** Brings `ask`'s transcript in and reads it; nothing is kept when the company shut Grasp out meanwhile. */
const save = async (
  env: Env,
  ask: Extract<AdminAsk, { kind: "save" }>,
  by: AuditActor
): Promise<KickoffView | "shut_out"> => {
  const store = onboardingStore(env);
  // As the reading begins: a purge of the kickoff since refuses it.
  const mark = await store.purgeMark();
  const { text, fileName } = await transcriptOf(
    env,
    transcriptInput(ask.transcript)
  );
  const reading = await readKickoff(env, text, ask.locale, by);
  // The reading takes a while: the company may have ended Grasp's
  // access meanwhile. Nothing is kept unless they are still in.
  if (!(await staffLetIn(env))) {
    return "shut_out";
  }
  return await store.saveKickoff(
    { transcript: text, fileName, reading },
    by,
    mark
  );
};

/** What `ask` comes to: the kickoff after it, or why staff can't. */
const answerOf = async (
  env: Env,
  ask: AdminAsk,
  by: AuditActor,
  requestId: string
): Promise<KickoffView | "shut_out"> => {
  const store = onboardingStore(env);
  if (ask.kind === "save") {
    return await save(env, ask, by);
  }
  if (ask.kind === "answer") {
    if (!(await store.answerKickoff(ask.field, ask.text, by))) {
      throw kickoffErrors.create("kickoff.invalid");
    }
    return await store.kickoff();
  }
  // On record before it is read; a log that can't take it fails the read.
  await appendAuditEvent(env, {
    actor: by,
    action: "admin.kickoff.read",
    target: { type: "organization", id: organizationId },
    requestId,
    detail: {},
  });
  return await store.kickoff();
};

/**
 * The admin's request about the kickoff: 200 with the kickoff as the admin
 * shows it, once the request is signed, fresh and well formed and the
 * company lets Grasp's staff in. An unsigned request, or one signed
 * otherwise, is 401; one too large, stale or malformed, or made while the
 * company keeps Grasp out, 403; a transcript that can't be taken 400, or
 * 503 when it couldn't be read just now; anything but a `POST` a path core
 * doesn't serve.
 */
export const adminKickoffResponse = async (
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> => {
  if (request.method !== "POST") {
    return errorResponse(
      404,
      requestErrors.create("request.not_found"),
      requestId
    );
  }
  const asked = await consoleSigned(request, env, {
    purpose: adminKickoffPurpose,
    schema: adminKickoffRequestSchema,
    maxBytes: adminKickoffMaxBytes,
    maxSkewMs: adminKickoffMaxSkewMs,
  });
  if (typeof asked === "string") {
    log.info("admin.kickoff.refused", { reason: asked });
    return asked === "unsigned" || asked === "bad_signature"
      ? errorResponse(401, authErrors.create("auth.unauthenticated"), requestId)
      : errorResponse(
          403,
          requestErrors.create("request.forbidden"),
          requestId
        );
  }
  const shutOut = (): Response => {
    log.info("admin.kickoff.refused", { reason: "staff_not_let_in" });
    return errorResponse(
      403,
      onboardingErrors.create("onboarding.staff_only"),
      requestId
    );
  };
  if (!(await staffLetIn(env))) {
    return shutOut();
  }
  const by: AuditActor = {
    type: "staff",
    userId: asked.staff.email,
    via: "console",
  };
  try {
    const kickoff = await answerOf(env, asked.ask, by, requestId);
    if (kickoff === "shut_out") {
      return shutOut();
    }
    return Response.json(adminKickoffViewOf(kickoff), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    // No AI provider connected yet: the kickoff can't be read until one is.
    if (modelErrors.codeOf(error) === "model.no_provider") {
      log.info("admin.kickoff.refused", { reason: "model.no_provider" });
      return errorResponse(
        503,
        modelErrors.create("model.no_provider"),
        requestId
      );
    }
    const code = kickoffErrors.codeOf(error);
    if (code === undefined) {
      throw error;
    }
    log.info("admin.kickoff.refused", { reason: code });
    return errorResponse(
      kickoffStatus(code),
      kickoffErrors.create(code),
      requestId
    );
  }
};
