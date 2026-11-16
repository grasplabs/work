import { errorFields, log } from "@grasp-os/shared/log";

import { forgetFor } from "./brain-memories.ts";
import type { MemoryCaller } from "./brain-memories.ts";

// A memory the agent saved of what a person said in their direct message
// on a chat app, whose notice they will never see (GRA-1920). Nothing they
// can't see and undo stays in use, so each is retired through the same
// `forgetFor` as their own Undo, which is idempotent (`forget:<id>`), in
// their own store alone (`forgetAs` reads as them). It is not their act:
// the audit log names the platform itself as who did it, with why.

/** Why a memory's notice never reached its person. */
export type UnseenReason =
  /** The platform refused its card (channels/remembered.ts). */
  | "card_refused"
  /** Its turn threw after the save (workspace.ts, `askThrough`). */
  | "turn_threw"
  /**
   * Its turn's result reached the Workspace with nobody waiting to post
   * it: the turn was cut short, or its result came after it ended
   * (workspace.ts, `keepTurnMessages`).
   */
  | "no_asker";

/** Retires `memory` for `caller`, tried twice: whether it was. */
const retired = async (
  env: Env,
  caller: MemoryCaller,
  memory: string,
  reason: UnseenReason
): Promise<boolean> => {
  for (let tried = 1; tried <= 2; tried += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- once more on a failure
      await forgetFor(env, caller, memory, reason);
      return true;
    } catch (error) {
      log.warn("channel.notice_unretired", {
        tried,
        reason,
        ...errorFields(error),
      });
    }
  }
  return false;
};

/**
 * Retires each of `memories`, `userId`'s own, whose notice they will never
 * see, for `reason`, each tried twice. Never throws: one that still
 * couldn't be retired stays in use, logged, and is on their Memories page
 * in Grasp.
 */
export const retireUnseen = async (
  env: Env,
  userId: string,
  reason: UnseenReason,
  memories: readonly string[]
): Promise<void> => {
  const caller: MemoryCaller = { person: userId, actor: { type: "system" } };
  for (const memory of memories) {
    // oxlint-disable-next-line no-await-in-loop -- one after another
    if (!(await retired(env, caller, memory, reason))) {
      log.error("channel.notice_unretired", { reason });
    }
  }
};
