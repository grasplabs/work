import type { AuditDetailValue } from "@grasp-os/shared/audit";
import {
  brainActionPurpose,
  brainActionRequestSchema,
  brainErasureAnswerSchema,
  brainErasureMaxBytes,
  brainErasurePurpose,
  brainErasureRequestSchema,
  brainReportMaxBytes,
  brainReportMaxSkewMs,
  brainReportPurpose,
  brainReportRequestSchema,
  brainReportSchema,
} from "@grasp-os/shared/brain-report";
import type {
  BrainAction,
  BrainActionAnswer,
  BrainErasureAnswer,
  BrainErasureLookup,
} from "@grasp-os/shared/brain-report";
import { authErrors, requestErrors } from "@grasp-os/shared/errors";
import { log } from "@grasp-os/shared/log";

import { appendAuditEvent } from "./audit-outbox.ts";
import { organizationId } from "./auth/auth.ts";
import {
  actOnBrainForStaff,
  brainErasureForStaff,
  brainStaffReport,
} from "./brain-next.ts";
import { consoleSigned } from "./console-signed.ts";
import type { ConsoleRefusal } from "./console-signed.ts";
import { errorResponse } from "./errors.ts";
import { brainErasureStateOf } from "./person-erasure.ts";

// How this client's Brain is doing, for Grasp's staff through the admin
// (GRA-1733; `@grasp-os/shared/brain-report` says what the report holds).
// What it can't let happen, and what stops it here:
//
// - Anyone but the admin reading it or acting: only a request signed for
//   its own purpose (a read's, an action's) with this client's key gets
//   in (console-signed.ts), so a session, a link or the admin's key for
//   anything else, a read's included for an action, opens nothing.
// - A read the company can't see: `admin.brain.read` is written before
//   the overview is even read; a log that can't take it reads nothing.
// - An action the company can't see, or whose entry says otherwise than
//   what happened: `admin.brain.action.asked` is written before it
//   applies (a log that can't take it applies nothing), and
//   `admin.brain.action.answered` with its outcome after, whatever it was
//   (`done`, `nothing`, `unavailable`, or `failed` when the store threw).
//   Should that second write fail too, the log holds the ask alone: an
//   ask with no answer means the outcome is unknown, never that it was
//   done.
// - Content reaching the admin: the report is built field by field from
//   the store's overview (brain-next.ts `brainStaffReport`), leaving out
//   what names anything, and parsed here by the schema, which names
//   nothing else.
//
// - A lookup of an erasure (`brainErasureResponse`) the company can't see,
//   or that says more than whether: `admin.brain.erasure.looked_up`, with
//   the kind and the outcome, is written after the store answered and
//   before anything leaves core (a log that can't take it answers an
//   error), or with `failed` when the store threw. Never the key, the id
//   or its hash: an unsalted hash of a guessable key is the key. The
//   answer is the state and, once erased, when: what was never erased
//   answers as what never existed (the store reads its ledger alone).
//
// Not gated by the company's staff window, unlike the snapshot: the
// report names nobody, and it is how Grasp runs the platform it operates.

/** What a refused signed request answers: 401 when unsigned or signed otherwise, else 403. */
const refused = (reason: ConsoleRefusal, requestId: string): Response => {
  log.info("brain.report.refused", { reason });
  return reason === "unsigned" || reason === "bad_signature"
    ? errorResponse(401, authErrors.create("auth.unauthenticated"), requestId)
    : errorResponse(403, requestErrors.create("request.forbidden"), requestId);
};

const notFound = (requestId: string): Response =>
  errorResponse(404, requestErrors.create("request.not_found"), requestId);

const answer = (body: unknown): Response =>
  Response.json(body, { headers: { "cache-control": "no-store" } });

/** Who staff act as, and on what, in the audit log. */
const staffActor = (email: string) =>
  ({ type: "staff", userId: email, via: "console" }) as const;
const organization = { type: "organization", id: organizationId } as const;

/** What an action asked, as its audit entries name it. */
const askedOf = (action: BrainAction): Record<string, AuditDetailValue> =>
  action.type === "requeue"
    ? { type: action.type, item: action.item }
    : { type: action.type };

/**
 * The admin's read of the Brain: 200 with the report once the request is
 * signed, fresh and well formed and the read is in the audit log; 401 or
 * 403 otherwise; anything but a `POST` a path core doesn't serve.
 */
export const brainReportResponse = async (
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> => {
  if (request.method !== "POST") {
    return notFound(requestId);
  }
  const asked = await consoleSigned(request, env, {
    purpose: brainReportPurpose,
    schema: brainReportRequestSchema,
    maxBytes: brainReportMaxBytes,
    maxSkewMs: brainReportMaxSkewMs,
  });
  if (typeof asked === "string") {
    return refused(asked, requestId);
  }
  // On record before anything is read; a log that can't take it reads
  // nothing. A read audited that then fails to load answers an error.
  await appendAuditEvent(env, {
    actor: staffActor(asked.staff.email),
    action: "admin.brain.read",
    target: organization,
    requestId,
    detail: {},
  });
  // Only what the schema names leaves core, whatever was built.
  return answer(brainReportSchema.parse(await brainStaffReport(env)));
};

/**
 * The admin's action on the Brain: 200 with what it did once the request
 * is signed, fresh and well formed and the action is in the audit log;
 * 401 or 403 otherwise; anything but a `POST` a path core doesn't serve.
 */
export const brainActionResponse = async (
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> => {
  if (request.method !== "POST") {
    return notFound(requestId);
  }
  const asked = await consoleSigned(request, env, {
    purpose: brainActionPurpose,
    schema: brainActionRequestSchema,
    maxBytes: brainReportMaxBytes,
    maxSkewMs: brainReportMaxSkewMs,
  });
  if (typeof asked === "string") {
    return refused(asked, requestId);
  }
  const { action, staff } = asked;
  const entry = (name: string, detail: Record<string, AuditDetailValue>) => ({
    actor: staffActor(staff.email),
    action: name,
    target: organization,
    requestId,
    detail,
  });
  // The ask on record before it applies; a log that can't take it applies
  // nothing.
  await appendAuditEvent(
    env,
    entry("admin.brain.action.asked", askedOf(action))
  );
  let outcome: BrainActionAnswer["outcome"];
  try {
    outcome = await actOnBrainForStaff(env, action);
  } catch (error) {
    // Whether it applied before it threw is unknown: the answer says it
    // failed, and the error goes on as any other.
    await appendAuditEvent(
      env,
      entry("admin.brain.action.answered", {
        ...askedOf(action),
        outcome: "failed",
      })
    );
    throw error;
  }
  await appendAuditEvent(
    env,
    entry("admin.brain.action.answered", { ...askedOf(action), outcome })
  );
  log.info("brain.action", { type: action.type, outcome });
  return answer({ outcome } satisfies BrainActionAnswer);
};

/**
 * A person's erasure as staff read it: core's own record of their erasure
 * from the Brain (person-erasure.ts `brainErasureStateOf`, both Brain
 * areas), and once that is complete the shared store's ledger, since a
 * staff path never addresses a person's own store (GRA-1762), and core
 * marks its areas complete only once the Brain's erasure of them
 * returned, which is only once their own store was erased whole, files
 * included.
 *
 * - `not_erased` when core holds no erasure of them, alike whether they
 *   ever existed: one statement either way;
 * - `erasing` while either area is pending, and also if core says complete
 *   but the ledger doesn't hold it as erased (never read as done);
 * - `skipped` when core recorded either skipped: not done, not tried again;
 * - once complete, the ledger's answer: `erased` at its time, or
 *   `unavailable` while it can't be read.
 */
const personFound = async (
  env: Env,
  personId: string
): Promise<BrainErasureAnswer> => {
  const core = await brainErasureStateOf(env, personId);
  switch (core) {
    case null: {
      return { state: "not_erased" };
    }
    case "pending": {
      return { state: "erasing" };
    }
    case "skipped": {
      return { state: "skipped" };
    }
    case "complete": {
      const ledger = await brainErasureForStaff(env, {
        kind: "person",
        id: personId,
      });
      return ledger.state === "erased" || ledger.state === "unavailable"
        ? ledger
        : { state: "erasing" };
    }
    default: {
      const unhandled: never = core;
      throw new Error(`No such erasure state (${typeof unhandled})`);
    }
  }
};

/** What staff named, looked up: a source in the shared store's ledger, a person as `personFound` says. */
const erasureFound = async (
  env: Env,
  lookup: BrainErasureLookup
): Promise<BrainErasureAnswer> =>
  lookup.kind === "source"
    ? await brainErasureForStaff(env, lookup)
    : await personFound(env, lookup.id);

/**
 * The admin's lookup of an erasure: 200 with whether the source or person
 * staff named was erased, once the request is signed, fresh and well
 * formed and the lookup is in the audit log; 401 or 403 otherwise;
 * anything but a `POST` a path core doesn't serve.
 */
export const brainErasureResponse = async (
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> => {
  if (request.method !== "POST") {
    return notFound(requestId);
  }
  const asked = await consoleSigned(request, env, {
    purpose: brainErasurePurpose,
    schema: brainErasureRequestSchema,
    maxBytes: brainErasureMaxBytes,
    maxSkewMs: brainReportMaxSkewMs,
  });
  if (typeof asked === "string") {
    return refused(asked, requestId);
  }
  const { lookup, staff } = asked;
  const lookedUp = async (outcome: BrainErasureAnswer["state"] | "failed") => {
    await appendAuditEvent(env, {
      actor: staffActor(staff.email),
      action: "admin.brain.erasure.looked_up",
      target: organization,
      requestId,
      detail: { kind: lookup.kind, outcome },
    });
  };
  let found: BrainErasureAnswer;
  try {
    found = brainErasureAnswerSchema.parse(await erasureFound(env, lookup));
  } catch (error) {
    await lookedUp("failed");
    throw error;
  }
  // On record before it is answered; a log that can't take it answers an
  // error, and nothing of what was found.
  await lookedUp(found.state);
  return answer(found);
};
