import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { PermissionId } from "@grasp-os/shared/ids";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Authority, WorkContext } from "@grasp-os/shared/permissions";

import { appendAuditEvent } from "./audit-outbox.ts";
import {
  correctAs,
  entityAs,
  findEntitiesAs,
  forgetAs,
  rememberAs,
} from "./brain-next.ts";
import type {
  Correction,
  EntitiesWanted,
  EntityCard,
  MemoryWord,
  Remembered,
  RememberedMemory,
} from "./brain-next.ts";
import { authorize } from "./permissions.ts";

// The Brain's memories and entities for a caller acting for a person core
// verified (GRA-1743): a person's own chat saving what they said
// (agent-remember.ts), the person's own undo (brain-memories-rpc.ts), and
// code reading entities. The threat model is on GRA-1743. In order:
//
// - Who and whose word: core sets the caller (the person, how the audit
//   log names the actor, whose word a write is, and whether their own
//   store may be read), never the input. A write lands in the person's
//   own store, readable by them alone (brain-next.ts says why).
// - Writes in the person's own word need no grant: they come from their
//   own chat, in a turn they started, or from the person themselves. A
//   write in an agent's word (an App's or a run's) needs the Brain's write
//   permission, an action of its own (shared/permissions.ts: a read grant
//   never gains writes), which arrives with the SDK's `remember`: until
//   then it is refused.
// - Reads by code need the code's grant to read the Brain, active, now,
//   as `authorize` checks every grant; the person's own reads need none.
// - Every call is audited, answered or refused, before it returns: ids,
//   counts and codes, never a statement, quote, value or name. A call the
//   audit log can't take is answered nothing (a write that took stands:
//   its change key makes a retry the same memory, audited then).

/** Who calls, as core resolved them, never as the input says. */
export interface MemoryCaller {
  /** The member it acts for, as core verified them. */
  readonly person: string;
  /** How the audit log names who acted. */
  readonly actor: AuditActor;
  /** What the audit event is about: the chat, the App or the run. */
  readonly target?: AuditEntry["target"];
  /** Whose word what it writes is. */
  readonly word: MemoryWord;
  /** Whether it may read what only the person may (their own chat, the person). */
  readonly personal: boolean;
  /**
   * For code (an App, a run, a chat's agent reading), its grant to read
   * the Brain, checked on every read; none when the person acts.
   */
  readonly code?: {
    readonly authority: Authority;
    readonly context: WorkContext;
    readonly permissionId: PermissionId | null;
  };
}

type Detail = Record<string, string | number | boolean | null>;

/**
 * Runs `call` for `caller` and audits it as `action`, answered with what
 * `detailOf` says of its result, or refused with its code, before it
 * returns or throws.
 */
const audited = async <T>(
  env: Env,
  caller: MemoryCaller,
  action: string,
  call: () => Promise<T>,
  detailOf: (result: T) => Detail
): Promise<T> => {
  const audit = async (detail: Detail) => {
    await appendAuditEvent(env, {
      actor: caller.actor,
      action,
      ...(caller.target === undefined ? {} : { target: caller.target }),
      detail: { onBehalfOf: caller.person, ...detail },
    });
  };
  let result: T;
  try {
    result = await call();
  } catch (error) {
    await audit({
      refused: isExpectedError(error) ? error.code : "internal.unexpected",
    });
    throw error;
  }
  await audit(detailOf(result));
  return result;
};

/** Refuses a write in an agent's word: its permission isn't built yet. */
const requireOwnWord = (caller: MemoryCaller): void => {
  if (caller.word.kind !== "own") {
    throw permissionErrors.create("permission.denied", {
      action: "brain.remember",
    });
  }
};

/** Checks code's grant to read the Brain; the person's own reads need none. */
const requireReadGrant = async (
  env: Env,
  caller: MemoryCaller
): Promise<void> => {
  const { code } = caller;
  if (code === undefined) {
    return;
  }
  if (code.permissionId === null) {
    throw permissionErrors.create("permission.denied", { action: "brain" });
  }
  await authorize(
    env,
    code.authority,
    { type: "platform" },
    "brain",
    code.permissionId,
    code.context
  );
};

/**
 * Saves a memory for `caller`'s person, in their own word, readable by
 * them alone (`rememberAs`). Audited as `brain.memory.remembered`.
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
    async () => {
      requireOwnWord(caller);
      return await rememberAs(env, caller.person, caller.word, remembered);
    },
    ({ memory, entity }) => ({ memory, entity })
  );

/**
 * Retires a memory `caller` saved in the person's word (`forgetAs`):
 * `nothing` alike for none, another's and one no longer current. Audited
 * as `brain.memory.forgotten`.
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
    async () => {
      requireOwnWord(caller);
      return await forgetAs(env, caller.person, { memory, word: caller.word });
    },
    (outcome) => ({ memory, outcome })
  );

/**
 * Confirms a memory the person may read, or corrects it with a fix in
 * their word (`correctAs`): the memory confirmed, or null. Audited as
 * `brain.memory.corrected`.
 */
export const correctFor = async (
  env: Env,
  caller: MemoryCaller,
  correction: Correction
) =>
  await audited(
    env,
    caller,
    "brain.memory.corrected",
    async () => {
      requireOwnWord(caller);
      await requireReadGrant(env, caller);
      return await correctAs(env, caller.person, correction, {
        personal: caller.personal,
      });
    },
    (confirmed) => ({
      memory: confirmed,
      fixed: correction.fix !== undefined,
    })
  );

/**
 * An entity's card for the person (`entityAs`), or null. Audited as
 * `brain.entity.read`.
 */
export const entityFor = async (
  env: Env,
  caller: MemoryCaller,
  entity: string
): Promise<EntityCard | null> =>
  await audited(
    env,
    caller,
    "brain.entity.read",
    async () => {
      await requireReadGrant(env, caller);
      return await entityAs(env, caller.person, entity, {
        personal: caller.personal,
      });
    },
    (card) => ({
      entities: card === null ? 0 : 1,
      memories: card?.memories.length ?? 0,
    })
  );

/**
 * The entities the person may see that match (`findEntitiesAs`). Audited
 * as `brain.entity.read`.
 */
export const findEntitiesFor = async (
  env: Env,
  caller: MemoryCaller,
  wanted: EntitiesWanted
) =>
  await audited(
    env,
    caller,
    "brain.entity.read",
    async () => {
      await requireReadGrant(env, caller);
      return await findEntitiesAs(env, caller.person, wanted, {
        personal: caller.personal,
      });
    },
    (found) => ({ entities: found.length })
  );
