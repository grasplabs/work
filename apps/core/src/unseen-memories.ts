import { actorOf } from "@grasp-os/shared/audit";
import { errorFields, log } from "@grasp-os/shared/log";

import { forgetFor } from "./brain-memories.ts";
import type { MemoryCaller } from "./brain-memories.ts";

// A memory the agent saved of what a person said in their direct message
// on a chat app, whose notice they will never see (GRA-1920): the
// platform refused the card (channels/remembered.ts), the turn threw
// after the save, or the turn's result reached a Workspace with nobody
// waiting to post it (workspace.ts). Nothing they can't see and undo
// stays in use, so each is retired, as their own Undo would retire it,
// through the same `forgetFor`, which is idempotent (`forget:<id>`).

/** The person acting through `platform`, as `forgetFor` takes them. */
export const callerOf = (userId: string, platform: string): MemoryCaller => ({
  person: userId,
  actor: actorOf({ userId, staff: false }, platform),
});

/** Retires `memory` of `userId`'s, tried twice: whether it was. */
const retired = async (
  env: Env,
  caller: MemoryCaller,
  memory: string
): Promise<boolean> => {
  for (let tried = 1; tried <= 2; tried += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- once more on a failure
      await forgetFor(env, caller, memory);
      return true;
    } catch (error) {
      log.warn("channel.notice_unretired", { tried, ...errorFields(error) });
    }
  }
  return false;
};

/**
 * Retires each of `memories`, `userId`'s, whose notice nobody will see,
 * each tried twice. Never throws: one that still couldn't be retired
 * stays in use, logged, and is on their Memories page in Grasp.
 */
export const retireUnseen = async (
  env: Env,
  userId: string,
  platform: string,
  memories: readonly string[]
): Promise<void> => {
  const caller = callerOf(userId, platform);
  for (const memory of memories) {
    // oxlint-disable-next-line no-await-in-loop -- one after another
    if (!(await retired(env, caller, memory))) {
      log.error("channel.notice_unretired", { platform });
    }
  }
};
