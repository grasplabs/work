import { auditedIdOf } from "./audit-outbox.ts";
import { audited } from "./brain-audited.ts";
import type { MemoryCaller } from "./brain-audited.ts";
import { confirmAs, correctAs, forgetAs, rememberAs } from "./brain-next.ts";
import type {
  Correction,
  Remembered,
  RememberedMemory,
  StoredMemoryPlace,
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

export type { MemoryCaller } from "./brain-audited.ts";

type Detail = Record<string, string | number | boolean | null>;

/**
 * The field `name` of `value`, as a caller outside TypeScript sent it:
 * undefined for anything that isn't an object, null included. The audit
 * log's details are built from it before anything is checked, so a value
 * that holds no such field is refused afterwards, with its attempt kept.
 */
const fieldOf = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, name)
    : undefined;

/** `value` if it is a string, else null. */
const stringOf = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/**
 * Saves what `caller`'s person said as their own memory, readable by them
 * alone (`rememberAs`). Audited as `brain.memory.remembered`.
 */
export const rememberFor = async (
  env: Env,
  caller: MemoryCaller,
  remembered: Remembered
): Promise<RememberedMemory> =>
  await audited(
    env,
    caller,
    "brain.memory.remembered",
    {
      change: stringOf(fieldOf(remembered, "change")),
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
    { memory: auditedIdOf(memory) },
    async () => await forgetAs(env, caller.person, memory),
    (outcome) => ({ result: outcome })
  );

/** A memory's place as the audit log may name it: its store and well-formed ids, never what a caller sent instead. */
const placeOf = (memory: unknown) => {
  const store = fieldOf(memory, "store");
  return {
    store: store === "own" || store === "shared" ? store : null,
    memory: auditedIdOf(fieldOf(memory, "memory")),
  };
};

/**
 * `caller`'s person confirms a memory they may read (`confirmAs`): `done`,
 * or `nothing` alike for none, one they may not read, or one not current.
 * Audited as `brain.memory.confirmed`.
 */
export const confirmFor = async (
  env: Env,
  caller: MemoryCaller,
  memory: StoredMemoryPlace | Readonly<Record<string, unknown>>
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
      ...placeOf(fieldOf(correction, "wrong")),
      change: auditedIdOf(fieldOf(correction, "change")),
    },
    async () => await correctAs(env, caller.person, correction),
    (saved): Detail =>
      saved === null
        ? { result: "nothing" }
        : { result: "done", saved: saved.memory, entity: saved.entity }
  );
