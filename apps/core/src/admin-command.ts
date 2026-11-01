import {
  adminCommandEnvelopeSchema,
  adminCommandErrors,
  adminCommandMaxBytes,
  adminCommandMaxSkewMs,
  adminCommandPurpose,
} from "@grasp-os/shared/admin-command";
import type {
  AdminCommandAnswer,
  AdminCommandEnvelope,
} from "@grasp-os/shared/admin-command";
import type { AuditActor } from "@grasp-os/shared/audit";
import { authErrors, requestErrors } from "@grasp-os/shared/errors";
import { log } from "@grasp-os/shared/log";
import { onboardingErrors } from "@grasp-os/shared/onboarding";
import { and, eq, isNull, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { staffLetIn } from "./admin-kickoff.ts";
import { signInConfig } from "./auth/config.ts";
import { consoleSigned } from "./console-signed.ts";
import { adminCommands } from "./db/core/schema.ts";
import { errorResponse } from "./errors.ts";
import { closeGate, openGate, setGateThreshold } from "./onboarding/gate.ts";
import { onboardingStore } from "./onboarding/store.ts";

// Commands from Grasp's admin (`@grasp-os/shared/admin-command`, which
// lists what can go wrong): every change staff make to this company's
// onboarding, applied here and nowhere else, each as the staff member the
// admin names, whom every change's own audit entry records.
//
// - Only the admin's envelope, signed for this purpose with this
//   company's key, reaches a command (console-signed.ts); anything else
//   is 401 or 403, and nothing applies.
// - Grasp's staff steer only while the company lets them in: its staff
//   window is open and its admin hasn't ended staff access, as for the
//   kickoff (admin-kickoff.ts).
// - A command applies once by its id, however often it is delivered: it
//   is claimed before it applies (`adminCommands`) and marked once it
//   did. One that fails is let go, so delivering it again tries again;
//   one claimed by a run that died is taken again after `claimStaleMs`.
//
// Today the admin delivers each command here directly. An on-prem core,
// which only connects out to Grasp, will fetch its pending commands and
// hand each to `applyCommand` the same way. So a command answers with no
// data: the admin sees what changed in the next snapshot.
//
// The kickoff stays its own route (admin-kickoff.ts) for now: bringing a
// transcript in reads it with the model for minutes and answers with what
// it brought, which a delivered command can't. It becomes a command once
// an on-prem delivery exists, its reading shown in the snapshot.

/**
 * How long a claim holds before another delivery may take the command
 * again: longer than a command stays fresh both ways
 * (`adminCommandMaxSkewMs`), so a command whose run died after its change
 * but before its mark can't be delivered again once its claim lapses.
 */
const claimStaleMs = 2 * adminCommandMaxSkewMs + 60 * 1000;

/** Why a command wasn't applied, as its answer says it. */
type Refusal =
  | { status: 403; code: "onboarding.staff_only" }
  | { status: 409; code: "admin.command_pending" };

/** Throws `code` unless the change was `done`. */
const refuseUnless = (
  done: boolean,
  code: Parameters<typeof onboardingErrors.create>[0]
): void => {
  if (!done) {
    throw onboardingErrors.create(code);
  }
};

/** Applies one command's change, as `by`; throws an onboarding error when it can't. */
const applyChange = async (
  env: Env,
  command: AdminCommandEnvelope,
  by: AuditActor
): Promise<void> => {
  const store = onboardingStore(env);
  switch (command.type) {
    case "onboarding.agreements": {
      // The record of what was agreed before the first interview: once a
      // link went out, it stays as it was.
      const { told } = await store.staffAgreements();
      refuseUnless(!told, "onboarding.agreements_kept");
      await store.setAgreements(command.payload.agreements, by);
      // Once all are in, the links that are due go out now, not at the next alarm.
      await store.releaseDue();
      return;
    }
    case "onboarding.remind": {
      await store.remind(command.payload.people, by);
      return;
    }
    case "onboarding.ask_in": {
      refuseUnless(
        await store.askIn(command.payload.team, by),
        "onboarding.no_team"
      );
      await store.releaseDue();
      return;
    }
    case "onboarding.send_mail_again": {
      refuseUnless(
        await store.sendAgain(command.payload.person, by),
        "onboarding.no_failed_mail"
      );
      return;
    }
    case "onboarding.new_start": {
      refuseUnless(
        await store.newStart(command.payload.person, by),
        "onboarding.no_link"
      );
      return;
    }
    case "onboarding.gate.open": {
      await openGate(env, by);
      return;
    }
    case "onboarding.gate.close": {
      const config = signInConfig(env);
      refuseUnless(config !== undefined, "onboarding.invalid");
      if (config !== undefined) {
        await closeGate(env, config, by);
      }
      return;
    }
    case "onboarding.gate.threshold": {
      await setGateThreshold(env, command.payload.threshold, by);
      return;
    }
    case "onboarding.pause": {
      await store.setPaused(true, by);
      return;
    }
    case "onboarding.resume": {
      await store.setPaused(false, by);
      // Links that came due while paused go out now, not at the next alarm.
      await store.releaseDue();
      return;
    }
    case "onboarding.rules": {
      await store.setRules(command.payload.rules, by);
      return;
    }
    case "onboarding.count_as_known": {
      const { work, counted } = command.payload;
      refuseUnless(
        await store.countAsKnown(work, counted, by),
        "onboarding.no_work"
      );
      return;
    }
    case "onboarding.draw_again": {
      const drawing = await store.drawWorkAgain(command.payload.work, by);
      refuseUnless(drawing !== "no_work", "onboarding.no_work");
      refuseUnless(drawing !== "nothing", "onboarding.nothing_to_draw");
      return;
    }
    case "onboarding.stephen": {
      await store.saveStephen(command.payload.setup, by);
      return;
    }
    default: {
      command satisfies never;
    }
  }
};

/**
 * Applies `command` once, whichever delivery brought it: what it did
 * (`now`, or `before` under the same id), or why it didn't. Throws an
 * onboarding error the change itself refused, having let the command go
 * so it can be delivered again.
 */
export const applyCommand = async (
  env: Env,
  command: AdminCommandEnvelope
): Promise<AdminCommandAnswer | Refusal> => {
  if (!(await staffLetIn(env))) {
    return { status: 403, code: "onboarding.staff_only" };
  }
  const db = drizzle(env.DB);
  const now = new Date();
  const [claimed] = await db
    .insert(adminCommands)
    .values({ id: command.id, type: command.type, claimedAt: now })
    .onConflictDoUpdate({
      target: adminCommands.id,
      set: { claimedAt: now },
      setWhere: and(
        isNull(adminCommands.appliedAt),
        lt(adminCommands.claimedAt, new Date(now.getTime() - claimStaleMs))
      ),
    })
    .returning({ id: adminCommands.id });
  if (claimed === undefined) {
    const [held] = await db
      .select({ appliedAt: adminCommands.appliedAt })
      .from(adminCommands)
      .where(eq(adminCommands.id, command.id));
    return (held?.appliedAt ?? null) === null
      ? { status: 409, code: "admin.command_pending" }
      : { id: command.id, applied: "before" };
  }
  const by: AuditActor = {
    type: "staff",
    userId: command.staff.email,
    via: "console",
  };
  try {
    await applyChange(env, command, by);
  } catch (error) {
    // Let go, so the same command delivered again tries again.
    await db
      .delete(adminCommands)
      .where(
        and(eq(adminCommands.id, command.id), isNull(adminCommands.appliedAt))
      );
    throw error;
  }
  await db
    .update(adminCommands)
    .set({ appliedAt: new Date() })
    .where(eq(adminCommands.id, command.id));
  return { id: command.id, applied: "now" };
};

/** The status a change's own refusal answers with: 400 for what isn't valid, 409 for the state it found. */
const refusedStatus = (code: string): number =>
  code === "onboarding.invalid" ? 400 : 409;

/**
 * The admin's command, delivered directly: 200 with what it did once the
 * envelope is signed, fresh and well formed and the company lets Grasp's
 * staff in. An unsigned envelope, or one signed otherwise, is 401; one
 * too large, stale or malformed, or delivered while the company keeps
 * Grasp out, 403; one being applied right now 409, as is a change the
 * onboarding refused for how it stands; anything but a `POST` a path core
 * doesn't serve.
 */
export const adminCommandResponse = async (
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
  const command = await consoleSigned(request, env, {
    purpose: adminCommandPurpose,
    schema: adminCommandEnvelopeSchema,
    maxBytes: adminCommandMaxBytes,
    maxSkewMs: adminCommandMaxSkewMs,
  });
  if (typeof command === "string") {
    log.info("admin.command.refused", { reason: command });
    return command === "unsigned" || command === "bad_signature"
      ? errorResponse(401, authErrors.create("auth.unauthenticated"), requestId)
      : errorResponse(
          403,
          requestErrors.create("request.forbidden"),
          requestId
        );
  }
  try {
    const answer = await applyCommand(env, command);
    if ("status" in answer) {
      log.info("admin.command.refused", {
        type: command.type,
        reason: answer.code,
      });
      return errorResponse(
        answer.status,
        answer.code === "onboarding.staff_only"
          ? onboardingErrors.create(answer.code)
          : adminCommandErrors.create(answer.code),
        requestId
      );
    }
    log.info("admin.command.applied", {
      type: command.type,
      applied: answer.applied,
    });
    return Response.json(answer, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const code = onboardingErrors.codeOf(error);
    if (code === undefined) {
      throw error;
    }
    log.info("admin.command.refused", { type: command.type, reason: code });
    return errorResponse(
      refusedStatus(code),
      onboardingErrors.create(code),
      requestId
    );
  }
};
