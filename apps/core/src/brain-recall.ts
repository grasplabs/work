import type { BrainPack } from "@grasp-os/runtime/app";
import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import { functionErrors } from "@grasp-os/shared/functions";
import type { PermissionId } from "@grasp-os/shared/ids";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Authority, WorkContext } from "@grasp-os/shared/permissions";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { appendAuditEvent } from "./audit-outbox.ts";
import { codeRecallOf, recallAs } from "./brain-next.ts";
import { apps } from "./db/core/schema.ts";
import { authorize } from "./permissions.ts";

// The Brain's recall for code: an App's action (resource-brain.ts), a
// workflow's step (workflows/brain-calls.ts) and a chat's code
// (agent-brain.ts) all come here, with the same request and the same pack
// (`BrainRecall`, `BrainPack` in @grasp-os/runtime). The threat model is
// on GRA-1731. In order:
//
// - The request is untrusted: checked first, strictly, with the Brain's
//   own limits (`codeRecallOf`), so it can't name a reader, groups or a
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
//   code), through `recallAs`, as their teams alone (`personal: false`):
//   the Brain filters by those inside its own search, so a pack never
//   holds more than they may read, and never what only they may read
//   (GRA-1762), whoever the code hands it to.
// - An App keeps what it recalls where its owner reads it (its data, its
//   Pages), and an App can't yet be told what of it each reader may see.
//   So an App's recall is answered only for its owner: a call that acts
//   for anyone else, an admin using the App included, is refused the
//   recall (`permission.denied`), whatever else the App answers them.
//   This is the gate whatever sharing does (app-provenance.ts keeps an
//   App that recalls unshared too, `platform:brain`).
// - Nothing of the question or the pack is in a refusal, a log line or
//   the audit event, which is kept, answered or refused, before the call
//   returns. What is refused before a call gets here (an App's operation
//   it didn't declare, a declaration or a workflow's alias with no
//   binding an admin approved) is the function host's and the run's own
//   refusal, recorded as theirs, not as a recall.

/** Who recalls, as core resolved them, never as the code says. */
export interface RecallCaller {
  readonly authority: Authority;
  /** Where it works: a chat's own permission holds only in that chat. */
  readonly context: WorkContext;
  /**
   * Its permission to read the Brain (`{ type: "platform" }`, `brain`):
   * null when it holds none, and the recall is refused (and audited).
   */
  readonly permissionId: PermissionId | null;
  /** How the audit log names it. */
  readonly actor: AuditActor;
  /** What the audit event is about: the App, the run or the chat. */
  readonly target?: AuditEntry["target"];
  /**
   * What the caller keeps of the pack before it gets it: a run's pins, a
   * chat's reads. Run before the recall is audited as answered, so a pack
   * that couldn't be kept is audited as refused, and nobody gets it.
   */
  readonly keep?: (pack: BrainPack) => Promise<void>;
}

/** Whether `input` is a recall as code asks for one (`BrainRecall`). */
export const isBrainRecall = (input: unknown): boolean =>
  codeRecallOf(input) !== undefined;

/**
 * Refuses an App's recall for anyone but the App's owner, as
 * `permission.denied`: what an App recalls it may keep where its owner
 * reads it. Any other target (a run, a chat) recalls for its own person.
 */
const requireAppOwner = async (
  env: Env,
  caller: RecallCaller
): Promise<void> => {
  if (caller.target?.type !== "app") {
    return;
  }
  const app = await drizzle(env.DB)
    .select({ owner: apps.ownerId })
    .from(apps)
    .where(eq(apps.id, caller.target.id))
    .get();
  if (app?.owner !== caller.authority.onBehalfOf) {
    throw permissionErrors.create("permission.denied", { action: "brain" });
  }
};

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
    // Straight to the log, as a read is (`appendAuditEvent`): a recall
    // the log can't take is answered nothing.
    await appendAuditEvent(env, {
      actor: caller.actor,
      action: "brain.recall",
      ...(caller.target === undefined ? {} : { target: caller.target }),
      detail: { onBehalfOf: caller.authority.onBehalfOf, ...detail },
    });
  };
  try {
    const recall = codeRecallOf(input);
    if (recall === undefined) {
      throw functionErrors.create("permission.invalid_args");
    }
    if (caller.permissionId === null) {
      throw permissionErrors.create("permission.denied", { action: "brain" });
    }
    await authorize(
      env,
      caller.authority,
      { type: "platform" },
      "brain",
      caller.permissionId,
      caller.context
    );
    await requireAppOwner(env, caller);
    // From what the person's teams may read alone, never what only they
    // may: nothing code sends can change it.
    const pack: BrainPack = await recallAs(env, caller.authority.onBehalfOf, {
      ...recall,
      personal: false,
    });
    await caller.keep?.(pack);
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
