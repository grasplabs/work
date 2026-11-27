import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";

import type { workspace } from "../src/durable-objects.ts";

/**
 * Makes every deletion `stub` has under way due now and runs its alarm,
 * as the alarm would once their pauses are over (`#finishDeletes`).
 */
export const finishDeletesNow = async (
  stub: ReturnType<typeof workspace>
): Promise<void> => {
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("UPDATE chat_deletes SET next_at = 0");
  });
  await runDurableObjectAlarm(stub);
};

/** The chats `stub` is deleting (`chat_deletes`), with how often each failed. */
export const deletesOf = async (
  stub: ReturnType<typeof workspace>
): Promise<{ chatId: string; attempts: number }[]> =>
  await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ chatId: string; attempts: number }>(
        "SELECT chat_id AS chatId, attempts FROM chat_deletes ORDER BY chat_id"
      )
      .toArray()
  );
