import { errorFields, log } from "@grasp-os/shared/log";
import { drizzle } from "drizzle-orm/d1";

import { chatTurns } from "./db/core/schema.ts";
import { retriedBatch } from "./db/d1.ts";

// One record per chat turn (`chat_turns`), written once as the turn
// settles in its chat's object (chat-harness.ts): what the person waited
// for and what the turn spent, for staff to read where they read spend
// (model-spend.ts). It is what Codex keeps per turn (its `turn.ttft` and
// `turn.e2e_duration_ms`, tool calls and token use) and Claude Code per
// prompt (its `prompt.id` joining each request's `ttft_ms`, tokens, cost
// and `attempt`, and each tool's `duration_ms`), and T3 Code on each run
// (requested, started, completed, its token use): times, counts and
// identifiers, never what was said. Built from what pi committed of the
// turn and from what the model gateway charged and told the chat as it
// went (models.ts `onWait`); nothing here sits on the turn's path, and a
// record that can't be written is logged and lost, as a usage row is
// (model-usage.ts).

/** A turn's record, as `chat_turns` keeps it. */
export type ChatTurn = typeof chatTurns.$inferInsert;

/**
 * Writes `record` once, by its turn's ID: a write tried again keeps the
 * first. Never throws.
 */
export const recordTurn = async (
  env: Pick<Env, "DB">,
  record: ChatTurn
): Promise<void> => {
  const db = drizzle(env.DB);
  try {
    await retriedBatch(async () => {
      await db.insert(chatTurns).values(record).onConflictDoNothing();
    });
  } catch (error) {
    log.error("chat.turn_unrecorded", {
      ...errorFields(error),
      turnId: record.id,
    });
  }
};
