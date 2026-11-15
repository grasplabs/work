import { createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { functionErrors } from "@grasp-os/shared/functions";
import { drizzle } from "drizzle-orm/d1";

import {
  appendAuditEvent,
  keepAuditEvent,
  keepEvent,
  uuidFromHash,
} from "./audit-outbox.ts";

// A Brain write as the audit log keeps it (a person's own memories,
// brain-memories.ts; an App's code's, brain-app-writes.ts): its attempt,
// with ids alone, in the log before anything is written, so a write the
// log can't take writes nothing; then its outcome, the ids it made or the
// code it was refused with, through core's outbox, which never fails the
// call. Never what a memory says.

/** Who calls, as core resolved them, never as the input says. */
export interface MemoryCaller {
  /** The member it acts for, as core verified them. */
  readonly person: string;
  /** How the audit log names who acted. */
  readonly actor: AuditActor;
  /** What the audit event is about: the chat. */
  readonly target?: AuditEntry["target"];
}

type Detail = Record<string, string | number | boolean | null>;

/**
 * Runs `call` for `caller` as `action`: its attempt (`attempt`, ids only)
 * kept in the audit log before it runs, then what `detailOf` says of its
 * result, or the code it was refused with (`refusedAs` its error first,
 * when given). With `doneOnce`, an outcome it names a change and a
 * stored time for is kept as one event of that change, whole: its ID
 * from the change, its time the stored one, so a call made again keeps
 * the event the log already holds (brain-app-writes.ts).
 */
export const audited = async <T>(
  env: Env,
  caller: MemoryCaller,
  action: string,
  attempt: Detail,
  call: () => Promise<T>,
  detailOf: (result: T) => Detail,
  {
    refusedAs = (error: unknown) => error,
    doneOnce,
  }: {
    refusedAs?: (error: unknown) => unknown;
    doneOnce?: (result: T) => { change: string; at: Date } | undefined;
  } = {}
): Promise<T> => {
  const entry = (detail: Detail): AuditEntry => ({
    actor: caller.actor,
    action,
    ...(caller.target === undefined ? {} : { target: caller.target }),
    detail: { onBehalfOf: caller.person, ...detail },
  });
  await appendAuditEvent(env, entry({ ...attempt, outcome: "attempted" }));
  const db = drizzle(env.DB);
  let result: T;
  try {
    result = await call();
  } catch (error) {
    const refused = refusedAs(error);
    await keepAuditEvent(
      env,
      db,
      entry({
        ...attempt,
        outcome: "refused",
        reason: isExpectedError(refused) ? refused.code : "internal.unexpected",
      })
    );
    throw refused;
  }
  const outcome = entry({ ...attempt, outcome: "done", ...detailOf(result) });
  const once = doneOnce?.(result);
  if (once === undefined) {
    await keepAuditEvent(env, db, outcome);
    return result;
  }
  await keepEvent(env, db, {
    ...createAuditEvent(outcome, "core"),
    id: uuidFromHash(await sha256Hex(JSON.stringify([action, once.change]))),
    at: once.at.toISOString(),
  });
  return result;
};

/**
 * `error` in the function host's words, which carry nothing of the call:
 * a person no longer a member as the binding no longer serving.
 */
export const inHostWords = (error: unknown): unknown => {
  if (isExpectedError(error) && error.code === "permission.person_inactive") {
    return functionErrors.create("permission.unavailable");
  }
  return error;
};

/** `error` in the function host's words: a request the Brain refused as one it isn't. */
export const inHostBrainWords = (error: unknown): unknown =>
  isExpectedError(error) && error.code === "brain.request_invalid"
    ? functionErrors.create("permission.invalid_args")
    : inHostWords(error);

/**
 * `write` once, and once more when its reply was lost (an error no rule
 * of the Brain's gave): the same change, so it answers what landed, never
 * what the first reply said.
 */
export const landed = async <T>(write: () => Promise<T>): Promise<T> => {
  try {
    return await write();
  } catch (error) {
    if (isExpectedError(error)) {
      throw error;
    }
    return await write();
  }
};
