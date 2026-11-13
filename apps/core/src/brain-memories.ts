import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { appendAuditEvent, keepAuditEvent } from "./audit-outbox.ts";
import { confirmAs, correctAs, forgetAs, rememberAs } from "./brain-next.ts";
import type {
  Correction,
  Remembered,
  RememberedMemory,
  StoredMemoryRef,
} from "./brain-next.ts";

// A person's memories for a caller acting for them (GRA-1743, threat model
// on the issue): their own chat saving what they said (agent-remember.ts)
// and their undo (brain-memories-rpc.ts), and on the Brain's Memories page
// (GRA-1746) their confirmation of a memory and their correction of one. What is saved is the person's
// own word, readable by them alone (brain-next.ts says why). Core sets
// the caller, never the input.
//
// Audited in two steps: the attempt, with the person and the change, is
// in the audit log before anything is written (a call the log can't take
// writes nothing), and its outcome, the memory or the refusal, follows
// through core's outbox, which never fails the call: a memory that was
// written always reaches the caller, to show and undo.

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

/** A memory's id as the audit log may name it: a well-formed id, never what a caller sent instead. */
const idOf = (value: unknown): string | null => {
  const id = z.uuid().safeParse(value);
  return id.success ? id.data : null;
};

/**
 * Runs `call` for `caller` as `action`: its attempt (`attempt`, ids only)
 * kept in the audit log before it runs, then what `detailOf` says of its
 * result, or the code it was refused with.
 */
const audited = async <T>(
  env: Env,
  caller: MemoryCaller,
  action: string,
  attempt: Detail,
  call: () => Promise<T>,
  detailOf: (result: T) => Detail
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
    await keepAuditEvent(
      env,
      db,
      entry({
        ...attempt,
        outcome: "refused",
        reason: isExpectedError(error) ? error.code : "internal.unexpected",
      })
    );
    throw error;
  }
  await keepAuditEvent(
    env,
    db,
    entry({ ...attempt, outcome: "done", ...detailOf(result) })
  );
  return result;
};

/**
 * Saves what `caller`'s person said as their own memory, readable by them
 * alone (`rememberAs`). Audited as `brain.memory.remembered`.
 */
export const rememberFor = async (
  env: Env,
  caller: MemoryCaller,
  remembered: Remembered | Readonly<Record<string, unknown>>
): Promise<RememberedMemory> =>
  await audited(
    env,
    caller,
    "brain.memory.remembered",
    {
      change: typeof remembered.change === "string" ? remembered.change : null,
    },
    async () => await rememberAs(env, caller.person, remembered),
    ({ memory, entity }) => ({ memory, entity })
  );

/**
 * Retires one of `caller`'s person's own memories (`forgetAs`): `done`,
 * again for one retired before; `nothing` for none (an erased one
 * included), another's, or an expired one. Audited as
 * `brain.memory.forgotten`.
 */
export const forgetFor = async (
  env: Env,
  caller: MemoryCaller,
  memory: string
) =>
  await audited(
    env,
    caller,
    "brain.memory.forgotten",
    { memory: idOf(memory) },
    async () => await forgetAs(env, caller.person, memory),
    (outcome) => ({ result: outcome })
  );

/** A memory's place as the audit log may name it: its store and well-formed ids, never what a caller sent instead. */
const placeOf = (memory: Partial<Record<keyof StoredMemoryRef, unknown>>) => ({
  store:
    memory.store === "own" || memory.store === "shared" ? memory.store : null,
  memory: idOf(memory.memory),
});

/**
 * `caller`'s person confirms a memory they may read (`confirmAs`): `done`,
 * or `nothing` alike for none, one they may not read, or one not current.
 * Audited as `brain.memory.confirmed`.
 */
export const confirmFor = async (
  env: Env,
  caller: MemoryCaller,
  memory: StoredMemoryRef | Readonly<Record<string, unknown>>
) =>
  await audited(
    env,
    caller,
    "brain.memory.confirmed",
    placeOf(memory),
    async () => await confirmAs(env, caller.person, memory),
    (outcome) => ({ result: outcome })
  );

/**
 * `caller`'s person says a memory is wrong, with what is right
 * (`correctAs`): saved as their own word, theirs alone, and confirmed; the
 * same again for a retry of it. Null alike for a memory they may not read
 * and for a relation. Audited as `brain.memory.corrected`, with the memory
 * saved: one outcome per attempt.
 */
export const correctFor = async (
  env: Env,
  caller: MemoryCaller,
  correction: Correction | Readonly<Record<string, unknown>>
) =>
  await audited(
    env,
    caller,
    "brain.memory.corrected",
    {
      ...placeOf(
        typeof correction.wrong === "object" && correction.wrong !== null
          ? correction.wrong
          : {}
      ),
      change: idOf(correction.change),
    },
    async () => await correctAs(env, caller.person, correction),
    (saved): Detail =>
      saved === null
        ? { result: "nothing" }
        : { result: "done", saved: saved.memory, entity: saved.entity }
  );
