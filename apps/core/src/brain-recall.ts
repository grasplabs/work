import type { BrainPack } from "@grasp-os/runtime/app";
import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import { functionErrors } from "@grasp-os/shared/functions";
import type { PermissionId } from "@grasp-os/shared/ids";
import type { Authority, WorkContext } from "@grasp-os/shared/permissions";
import { drizzle } from "drizzle-orm/d1";

import { keepAuditEvent } from "./audit-outbox.ts";
import { recallAs, recallOf } from "./brain-next.ts";
import { authorize } from "./permissions.ts";

// The Brain's recall for code: an App's action (resource-brain.ts), a
// workflow's step (workflows/brain-calls.ts) and a chat's code
// (agent-brain.ts) all come here, with the same request and the same pack
// (`BrainRecall`, `BrainPack` in @grasp-os/runtime). The threat model is
// on GRA-1731. In order:
//
// - The request is untrusted: checked first, strictly, with the Brain's
//   own limits (`recallOf`), so it can't name a reader, groups or a
//   vector, and refused in the function host's fixed words
//   (`permission.invalid_args`).
// - The caller's grant: the App, run or agent must hold the permission to
//   read the Brain it names, active, now, as `authorize` checks every
//   grant (the person still a member; a chat's own permission only in
//   that chat). It is all or nothing: the Brain can't yet narrow a recall
//   below a person (no scopes), and filtering a pack afterwards would make
//   `notFound` and `truncated` untrue, so nothing is.
// - The person: the recall reads as the person the call acts for
//   (`onBehalfOf`, which core set from the session or the run, never the
//   code), through `recallAs`, so the Brain filters by them inside its own
//   search and a pack never holds more than they may read.
// - Nothing of the question or the pack is in a refusal, a log line or
//   the audit event, which is kept, answered or refused, before the call
//   returns.

/** Who recalls, as core resolved them, never as the code says. */
export interface RecallCaller {
  readonly authority: Authority;
  /** Where it works: a chat's own permission holds only in that chat. */
  readonly context: WorkContext;
  /** Its permission to read the Brain (`{ type: "platform" }`, `brain`). */
  readonly permissionId: PermissionId;
  /** How the audit log names it. */
  readonly actor: AuditActor;
  /** What the audit event is about: the App, the run or the chat. */
  readonly target?: AuditEntry["target"];
}

/** Whether `input` is a recall as code asks for one (`BrainRecall`). */
export const isBrainRecall = (input: unknown): boolean =>
  recallOf(input) !== undefined;

/** `error` in the function host's words, which carry nothing of the call. */
const inHostWords = (error: unknown): unknown => {
  if (isExpectedError(error) && error.code === "permission.person_inactive") {
    return functionErrors.create("permission.unavailable");
  }
  return error;
};

/**
 * A pack of what `caller`'s person may read for `input`'s question, within
 * its budget, as of its moment when given. Refused as
 * `permission.invalid_args` when `input` isn't a request, as
 * `permission.denied` without the grant, and as `permission.unavailable`
 * once the person is no longer a member (a visitor never was). Audited,
 * answered or refused, before it returns.
 */
export const recallFor = async (
  env: Env,
  caller: RecallCaller,
  input: unknown
): Promise<BrainPack> => {
  const audit = async (detail: Record<string, string | number | boolean>) => {
    await keepAuditEvent(env, drizzle(env.DB), {
      actor: caller.actor,
      action: "brain.recall",
      ...(caller.target === undefined ? {} : { target: caller.target }),
      detail: { onBehalfOf: caller.authority.onBehalfOf, ...detail },
    });
  };
  try {
    const recall = recallOf(input);
    if (recall === undefined) {
      throw functionErrors.create("permission.invalid_args");
    }
    await authorize(
      env,
      caller.authority,
      { type: "platform" },
      "brain",
      caller.permissionId,
      caller.context
    );
    // From the organization's shared content only, never a person's
    // private chats or files: once `recallAs` takes `personal`
    // (GRA-1762), this passes `personal: false`, and nothing code sends
    // can change it.
    const pack: BrainPack = await recallAs(
      env,
      caller.authority.onBehalfOf,
      recall
    );
    await audit({ items: pack.items.length, truncated: pack.truncated });
    return pack;
  } catch (error) {
    const refused = inHostWords(error);
    await audit({
      refused: isExpectedError(refused) ? refused.code : "internal.unexpected",
    });
    throw refused;
  }
};
