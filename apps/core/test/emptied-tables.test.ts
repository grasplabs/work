import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { testBinding } from "./test-env.ts";

// Features that went leave their tables for a rollback to the release
// before, until a later release drops them (GRA-2240), and the migration
// that follows empties them at once, so what outsiders left there isn't
// kept until then: guest chats (GRA-2234) and App visitors (GRA-2235).

/** A migration's statement that deletes rows, its comments before it. */
const deleteStatement = /^DELETE\b/mu;

/** Runs the deletions of the migration whose name ends in `name`. */
const empty = async (name: string): Promise<void> => {
  const migrations = z
    .array(z.object({ name: z.string(), queries: z.array(z.string()) }))
    .parse(testBinding("CORE_MIGRATIONS"));
  const emptying = migrations
    .find((migration) => migration.name.endsWith(`_${name}`))
    ?.queries.filter((query) => deleteStatement.test(query));
  if (emptying === undefined || emptying.length === 0) {
    throw new Error(`${name} deletes nothing`);
  }
  await env.DB.batch(emptying.map((query) => env.DB.prepare(query)));
};

/** How many rows each of `tables` holds. */
const rows = async (
  tables: readonly string[]
): Promise<Record<string, number | undefined>> => {
  const counts = await env.DB.batch<{ count: number }>(
    tables.map((table) =>
      env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    )
  );
  return Object.fromEntries(
    tables.map((table, at) => [table, counts[at]?.results[0]?.count])
  );
};

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

/** What the release before left of an App's visitors. */
const leftVisitors = async (): Promise<void> => {
  const app = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO apps (id, name, description, owner_id, created_at) VALUES (?, 'Visited', '', ?, ?)"
    ).bind(app, crypto.randomUUID(), now),
    env.DB.prepare(
      "INSERT INTO app_visitor_entries (app_id, kind, value, added_by, added_at) VALUES (?, 'address', 'ann@example.com', ?, ?), (?, 'domain', 'example.com', ?, ?)"
    ).bind(app, crypto.randomUUID(), now, app, crypto.randomUUID(), now),
    env.DB.prepare(
      "INSERT INTO app_visitor_grants (app_id, version, function, granted_by, granted_at) VALUES (?, 1, 'notes.list', ?, ?)"
    ).bind(app, crypto.randomUUID(), now),
    env.DB.prepare(
      "INSERT INTO app_visitor_codes (id, app_id, address, code_hash, tries, used_at, sent_at, expires_at) VALUES (?, ?, 'ann@example.com', 'h', 0, NULL, ?, ?)"
    ).bind(crypto.randomUUID(), app, now, now + 600_000),
    env.DB.prepare(
      "INSERT INTO app_visitor_sessions (id, app_id, address, token_hash, created_at, expires_at) VALUES (?, ?, 'ann@example.com', ?, ?, ?)"
    ).bind(crypto.randomUUID(), app, crypto.randomUUID(), now, now + 3_600_000),
  ]);
};

describe("the migrations after a feature went", () => {
  it("empty what the release before kept of guest chats, and keep both tables for a rollback", async () => {
    const tables = ["guest_chats", "guest_messages"];
    await leftChat(null);
    await leftChat("finished");
    const before = await rows(tables);

    await empty("guest_chats_emptied");

    expect({ before, after: await rows(tables) }).toStrictEqual({
      before: { guest_chats: 2, guest_messages: 4 },
      after: { guest_chats: 0, guest_messages: 0 },
    });
  });

  it("empty what the release before kept of App visitors, and keep the tables for a rollback", async () => {
    const tables = [
      "app_visitor_entries",
      "app_visitor_grants",
      "app_visitor_codes",
      "app_visitor_sessions",
    ];
    await leftVisitors();
    const before = await rows(tables);

    await empty("app_visitors_emptied");

    expect({ before, after: await rows(tables) }).toStrictEqual({
      before: {
        app_visitor_entries: 2,
        app_visitor_grants: 1,
        app_visitor_codes: 1,
        app_visitor_sessions: 1,
      },
      after: {
        app_visitor_entries: 0,
        app_visitor_grants: 0,
        app_visitor_codes: 0,
        app_visitor_sessions: 0,
      },
    });
  });
});
