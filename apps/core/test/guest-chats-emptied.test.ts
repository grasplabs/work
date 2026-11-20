import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { testBinding } from "./test-env.ts";

// Guest chats went (GRA-2234), and with them the sweep that deleted each
// chat a while after its link expired. The migration that followed
// empties both tables at once, so outsiders' words, who invited them and
// the links' hashes aren't kept until the tables are dropped (GRA-2240).
// The tables stay, for a rollback to the release before.

/** A migration's statement that deletes rows, its comments before it. */
const deleteStatement = /^DELETE\b/mu;

/** What the release before left: a chat, open or ended, with its messages. */
const leftChat = async (ended: "finished" | null): Promise<string> => {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO guest_chats (id, app_id, permission_id, invited_by, name, skill, model, token_hash, turns, created_at, expires_at, ended) VALUES (?, ?, ?, ?, 'Ann', 'a-skill', 'openai/gpt-5', ?, 1, ?, ?, ?)"
    ).bind(
      id,
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
      now,
      now + 86_400_000,
      ended
    ),
    env.DB.prepare(
      "INSERT INTO guest_messages (chat_id, seq, role, text, created_at) VALUES (?, 1, 'guest', 'What I do all day.', ?), (?, 2, 'agent', 'Thanks.', ?)"
    ).bind(id, now, id, now),
  ]);
  return id;
};

/** The rows both tables hold. */
const rows = async () => {
  const [chats, messages] = await env.DB.batch<{ count: number }>([
    env.DB.prepare("SELECT COUNT(*) AS count FROM guest_chats"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM guest_messages"),
  ]);
  return {
    chats: chats?.results[0]?.count,
    messages: messages?.results[0]?.count,
  };
};

describe("the migration after guest chats went", () => {
  it("empties what the release before kept of them, and keeps both tables for a rollback", async () => {
    await leftChat(null);
    await leftChat("finished");
    const before = await rows();

    const migrations = z
      .array(z.object({ name: z.string(), queries: z.array(z.string()) }))
      .parse(testBinding("CORE_MIGRATIONS"));
    const emptying = migrations
      .find(({ name }) => name.includes("_guest_chats_emptied"))
      ?.queries.filter((query) => deleteStatement.test(query));
    if (emptying === undefined || emptying.length === 0) {
      throw new Error("guest_chats_emptied deletes nothing");
    }
    await env.DB.batch(emptying.map((query) => env.DB.prepare(query)));

    expect({ before, after: await rows() }).toStrictEqual({
      before: { chats: 2, messages: 4 },
      after: { chats: 0, messages: 0 },
    });
  });
});
