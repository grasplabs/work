/**
 * The on-prem D1 service on plain workerd, through workerd's own D1 client,
 * as core's D1 bindings reach it there (workerd-d1.ts). A small Worker
 * runs each test's statements on its `DB` and `OTHER` bindings and answers
 * what D1 returned, or the error it threw.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { d1Bindings, d1Service, writeD1Service } from "./workerd-d1.ts";
import type { D1DatabaseConfig } from "./workerd-d1.ts";
import {
  cleanUp,
  serveOnWorkerd,
  storageDir,
  tempDir,
} from "./workerd-test-server.ts";

/**
 * Runs the steps it's sent on its D1 bindings and answers each one's result.
 * A step is `{db, sql, params}` (one statement, `all()`, or `first()`,
 * `raw()` or `run()` when it says so), or `{db, batch: [{sql, params}]}`
 * (one `batch()`).
 */
const testWorker = `
const statement = (db, { sql, params = [] }) => db.prepare(sql).bind(...params);
// What a statement changed; the last row ID only once it changed something,
// as before that it's whatever the connection inserted last.
const changed = ({ changes, last_row_id }) =>
  changes === 0 ? { changes } : { changes, lastRowId: last_row_id };
export default {
  async fetch(request, env) {
    const steps = await request.json();
    const results = [];
    for (const step of steps) {
      const db = env[step.db];
      try {
        if (step.batch) {
          const done = await db.batch(step.batch.map((s) => statement(db, s)));
          results.push({ ok: done.map(({ results, meta }) => ({ results, ...changed(meta) })) });
        } else if (step.first) {
          results.push({ ok: await statement(db, step).first() });
        } else if (step.run) {
          const { success, meta } = await statement(db, step).run();
          results.push({ ok: { success, changes: meta.changes, lastRowId: meta.last_row_id } });
        } else if (step.raw) {
          results.push({ ok: await statement(db, step).raw() });
        } else {
          const { results: rows, meta } = await statement(db, step).all();
          results.push({ ok: { results: rows, ...changed(meta) } });
        }
      } catch (error) {
        results.push({ error: String(error.message) });
      }
    }
    return Response.json(results);
  },
};
`;

interface Step {
  db: "DB" | "OTHER";
  sql?: string;
  params?: unknown[];
  first?: boolean;
  raw?: boolean;
  run?: boolean;
  batch?: { sql: string; params?: unknown[] }[];
}

const resultsSchema = z.array(
  z.union([z.object({ ok: z.unknown() }), z.object({ error: z.string() })])
);

/** A workerd serving the D1 service and the test Worker, on one storage. */
interface ServedD1 {
  run: (steps: Step[]) => Promise<z.infer<typeof resultsSchema>>;
  stop: () => Promise<void>;
}

/** A database's migrations directory with `files` in it. */
const migrationsDir = (files: Record<string, string>): string => {
  const dir = tempDir();
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), sql);
  }
  return dir;
};

/** Serves `databases` from `storage`, which outlives the workerd. */
const serve = async (
  databases: D1DatabaseConfig[],
  storage: string
): Promise<ServedD1> => {
  const out = tempDir();
  writeFileSync(path.join(out, "test.js"), testWorker);
  writeD1Service(out, databases);
  const { url, stop } = await serveOnWorkerd(
    out,
    (address) => `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "test", worker = (
      modules = [(name = "test.js", esModule = embed "test.js")],
      compatibilityDate = "2026-09-15",
      bindings = [${d1Bindings(databases).join(", ")}],
    )),
    (name = "storage", disk = (path = "${storage}", writable = true)),
    ${d1Service("storage")},
  ],
  sockets = [(name = "http", address = "${address}", http = (), service = "test")],
);
`
  );
  return {
    run: async (steps) => {
      const response = await fetch(url, {
        method: "POST",
        body: JSON.stringify(steps),
      });
      return resultsSchema.parse(await response.json());
    },
    stop,
  };
};

const notes = {
  "0000_notes.sql":
    "-- The notes.\nCREATE TABLE `notes` (\n\t`id` integer PRIMARY KEY,\n\t`text` text NOT NULL UNIQUE\n);\n--> statement-breakpoint\nCREATE INDEX `notes_text_idx` ON `notes` (`text`);",
  "0001_attachments.sql":
    "CREATE TABLE `attachments` (`note_id` integer NOT NULL, `bytes` blob NOT NULL);",
};

describe("the on-prem D1 service", () => {
  afterEach(cleanUp);

  it("applies each database's migrations once, recorded as Wrangler records them, and later ones as they come", async () => {
    const storage = storageDir();
    const dir = migrationsDir(notes);
    const migrated = [
      { db: "DB", sql: "SELECT name FROM d1_migrations ORDER BY id" },
    ] satisfies Step[];

    const first = await serve([{ binding: "DB", migrationsDir: dir }], storage);
    const applied = await first.run(migrated);
    await first.stop();

    writeFileSync(
      path.join(dir, "0002_drafts.sql"),
      "ALTER TABLE `notes` ADD `draft` integer DEFAULT 0 NOT NULL;"
    );
    const second = await serve(
      [{ binding: "DB", migrationsDir: dir }],
      storage
    );
    const reapplied = await second.run([
      ...migrated,
      {
        db: "DB",
        sql: "INSERT INTO notes (text) VALUES ('a') RETURNING draft",
      },
    ]);

    expect({ applied, reapplied }).toStrictEqual({
      applied: [
        {
          ok: {
            results: [
              { name: "0000_notes.sql" },
              { name: "0001_attachments.sql" },
            ],
            changes: 0,
          },
        },
      ],
      reapplied: [
        {
          ok: {
            results: [
              { name: "0000_notes.sql" },
              { name: "0001_attachments.sql" },
              { name: "0002_drafts.sql" },
            ],
            changes: 0,
          },
        },
        { ok: { results: [{ draft: 0 }], changes: 1, lastRowId: 1 } },
      ],
    });
  });

  it("applies migrations in Wrangler's order, by leading number, then name", async () => {
    const served = await serve(
      [
        {
          binding: "DB",
          migrationsDir: migrationsDir({
            "10_second.sql": "INSERT INTO steps (name) VALUES ('10');",
            "2_first.sql":
              "CREATE TABLE steps (name text NOT NULL);\n--> statement-breakpoint\nINSERT INTO steps (name) VALUES ('2');",
          }),
        },
      ],
      storageDir()
    );
    await expect(
      served.run([{ db: "DB", sql: "SELECT name FROM steps ORDER BY rowid" }])
    ).resolves.toStrictEqual([
      { ok: { results: [{ name: "2" }, { name: "10" }], changes: 0 } },
    ]);
  });

  it("rolls back a migration whole when one of its statements fails", async () => {
    const storage = storageDir();
    const dir = migrationsDir({
      "0000_tags.sql":
        "CREATE TABLE `tags` (`name` text NOT NULL);\n--> statement-breakpoint\nINSERT INTO `missing` VALUES (1);",
    });
    const broken = await serve(
      [{ binding: "DB", migrationsDir: dir }],
      storage
    );
    const failed = await broken.run([{ db: "DB", sql: "SELECT 1 AS one" }]);
    await broken.stop();

    // Fixed, it applies from the start: had the failed run kept its first
    // statement, creating the table again would fail.
    writeFileSync(
      path.join(dir, "0000_tags.sql"),
      "CREATE TABLE `tags` (`name` text NOT NULL);"
    );
    const fixed = await serve([{ binding: "DB", migrationsDir: dir }], storage);
    const applied = await fixed.run([
      { db: "DB", sql: "SELECT name FROM d1_migrations" },
      { db: "DB", sql: "SELECT count(*) AS n FROM tags" },
    ]);
    expect({ failed, applied }).toStrictEqual({
      failed: [{ error: "D1_ERROR: no such table: missing: SQLITE_ERROR" }],
      applied: [
        { ok: { results: [{ name: "0000_tags.sql" }], changes: 0 } },
        { ok: { results: [{ n: 0 }], changes: 0 } },
      ],
    });
  });

  it("searches full text with FTS5, as core's knowledge search does", async () => {
    const served = await serve(
      [
        {
          binding: "DB",
          migrationsDir: migrationsDir({
            "0000_search.sql":
              "CREATE VIRTUAL TABLE `search` USING fts5(text, tokenize = 'trigram remove_diacritics 1');",
          }),
        },
      ],
      storageDir()
    );
    const results = await served.run([
      {
        db: "DB",
        sql: "INSERT INTO search (rowid, text) VALUES (1, ?), (2, ?)",
        params: ["zwangerschapsverlof", "vakantie"],
      },
      {
        db: "DB",
        sql: "SELECT rowid AS id FROM search WHERE search MATCH ?",
        params: ["verlof"],
      },
    ]);
    expect(results[1]).toStrictEqual({
      ok: { results: [{ id: 1 }], changes: 0 },
    });
  });

  it("answers statements as D1 does: rows, what changed, blobs as bytes", async () => {
    const served = await serve(
      [{ binding: "DB", migrationsDir: migrationsDir(notes) }],
      storageDir()
    );
    const results = await served.run([
      {
        db: "DB",
        sql: "INSERT INTO notes (text) VALUES (?), (?)",
        params: ["a", "b"],
      },
      {
        db: "DB",
        sql: "INSERT INTO attachments (note_id, bytes) VALUES (?, ?)",
        params: [1, [0, 1, 255]],
      },
      {
        db: "DB",
        sql: "SELECT id, text FROM notes WHERE id = ?",
        params: [2],
        first: true,
      },
      { db: "DB", sql: "SELECT note_id, bytes FROM attachments", raw: true },
      { db: "DB", sql: "UPDATE notes SET text = text || '!'" },
      {
        db: "DB",
        sql: "INSERT INTO notes (text) VALUES (?)",
        params: ["c"],
        run: true,
      },
      {
        db: "DB",
        sql: "DELETE FROM notes WHERE id <= ?",
        params: [2],
        run: true,
      },
    ]);
    expect(results).toStrictEqual([
      { ok: { results: [], changes: 2, lastRowId: 2 } },
      { ok: { results: [], changes: 1, lastRowId: 1 } },
      { ok: { id: 2, text: "b" } },
      { ok: [[1, [0, 1, 255]]] },
      { ok: { results: [], changes: 2, lastRowId: 1 } },
      { ok: { success: true, changes: 1, lastRowId: 3 } },
      { ok: { success: true, changes: 2, lastRowId: 3 } },
    ]);
  });

  it("applies a batch whole or not at all", async () => {
    const served = await serve(
      [{ binding: "DB", migrationsDir: migrationsDir(notes) }],
      storageDir()
    );
    const results = await served.run([
      {
        db: "DB",
        batch: [
          { sql: "INSERT INTO notes (text) VALUES ('kept')" },
          { sql: "INSERT INTO notes (text) VALUES ('second')" },
        ],
      },
      {
        db: "DB",
        batch: [
          { sql: "INSERT INTO notes (text) VALUES ('rolled back')" },
          { sql: "INSERT INTO notes (text) VALUES ('kept')" },
        ],
      },
      { db: "DB", sql: "SELECT text FROM notes ORDER BY id" },
    ]);
    expect(results).toStrictEqual([
      {
        ok: [
          { results: [], changes: 1, lastRowId: 1 },
          { results: [], changes: 1, lastRowId: 2 },
        ],
      },
      {
        error:
          "D1_ERROR: UNIQUE constraint failed: notes.text: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)",
      },
      {
        ok: {
          results: [{ text: "kept" }, { text: "second" }],
          changes: 0,
        },
      },
    ]);
  });

  it("keeps each database apart, with its own migrations", async () => {
    const served = await serve(
      [
        { binding: "DB", migrationsDir: migrationsDir(notes) },
        {
          binding: "OTHER",
          migrationsDir: migrationsDir({
            "0000_tags.sql": "CREATE TABLE `tags` (`name` text NOT NULL);",
          }),
        },
      ],
      storageDir()
    );
    const results = await served.run([
      { db: "OTHER", sql: "INSERT INTO tags (name) VALUES ('x')" },
      { db: "DB", sql: "SELECT count(*) AS n FROM tags" },
      { db: "OTHER", sql: "SELECT count(*) AS n FROM notes" },
    ]);
    expect(results).toStrictEqual([
      { ok: { results: [], changes: 1, lastRowId: 1 } },
      { error: "D1_ERROR: no such table: tags: SQLITE_ERROR" },
      { error: "D1_ERROR: no such table: notes: SQLITE_ERROR" },
    ]);
  });
});
