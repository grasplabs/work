import { defineSchema, defineTable, v } from "@grasp-os/sdk";
import { manifestText, schemaManifest } from "@grasp-os/sdk/host";
import type { AccessMode } from "@grasp-os/sdk/host";
import { storeMaxIndexes } from "@grasp-os/shared/store-limits";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import { createStore, openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import {
  fieldExpression,
  nullSentinel,
  tableIdLiteral,
} from "../src/store-expressions.ts";

// A store's declared indexes as real SQLite indexes (store-indexes.ts):
// installed when a store is handed a schema, named by their definitions,
// kept for older schemas, capped per store, and read through by SQLite's
// own plans. Everything here goes through core's way into a store and its
// actual SQLite database.

const builder: Acting = {
  userId: "ada",
  role: "builder",
  teams: [],
  staff: false,
};

const noteFields = {
  title: v.string(),
  rank: v.number().nullable().optional(),
  done: v.boolean().default(false),
};

/** The Notes schema, with `indexes` as `[name, fields]`, read in mode `read`. */
const notesManifest = (
  indexes: readonly (readonly [string, readonly string[]])[],
  read: AccessMode = "appMembers"
): string => {
  let table = defineTable(noteFields);
  for (const [name, fields] of indexes) {
    // SAFETY: the test names only fields the table has.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    table = table.index(name, fields as ["title"]);
  }
  return manifestText(
    schemaManifest(defineSchema({ notes: table }), {
      tables: { notes: { read, write: read } },
    })
  );
};

const newStore = async (): Promise<OpenStore> =>
  await openStore(env, await createStore(env, builder));

interface IndexRow {
  name: string;
  sql: string;
}

/** The declared indexes the store's SQLite holds, by name. */
const indexesOf = async (store: OpenStore): Promise<IndexRow[]> =>
  await runInDurableObject(
    env.DATA_STORES.getByName(store.id),
    (_instance, state) =>
      state.storage.sql
        .exec<{
          name: string;
          sql: string;
        }>(
          "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'sdk\\_ix\\_%' ESCAPE '\\' ORDER BY name"
        )
        .toArray()
  );

/** The schemas the store recorded, by hash. */
const schemasOf = async (store: OpenStore): Promise<string[]> =>
  await runInDurableObject(
    env.DATA_STORES.getByName(store.id),
    (_instance, state) =>
      state.storage.sql
        .exec<{ hash: string }>(
          "SELECT schema_hash AS hash FROM sdk_schemas ORDER BY schema_hash"
        )
        .toArray()
        .map(({ hash }) => hash)
  );

/** SQLite's plan for `sql`, one line per step. */
const planOf = async (
  store: OpenStore,
  sql: string,
  ...params: (string | number | null)[]
): Promise<string> =>
  await runInDurableObject(
    env.DATA_STORES.getByName(store.id),
    (_instance, state) =>
      state.storage.sql
        .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params)
        .toArray()
        .map(({ detail }) => detail)
        .join("\n")
  );

describe("declared indexes", () => {
  it("become partial indexes on the table's records, named by their definitions", async () => {
    const store = await newStore();
    const defined = await store.defineTables(
      notesManifest([
        ["by_title", ["title"]],
        ["by_done_rank", ["done", "rank", "_createdAt"]],
      ])
    );
    const table = tableIdLiteral(defined.tables.notes ?? "");
    const indexes = await indexesOf(store);
    expect(indexes).toHaveLength(2);
    for (const { name } of indexes) {
      expect(name).toMatch(/^sdk_ix_[0-9a-f]{32}$/u);
    }
    const columns = indexes.map(({ sql }) =>
      sql.slice(sql.indexOf(" ON ") + 1)
    );
    expect(columns.toSorted()).toStrictEqual(
      [
        `ON sdk_records (${fieldExpression("done")}, ${fieldExpression("rank")}, created_at, record_id) WHERE table_id = ${table}`,
        `ON sdk_records (${fieldExpression("title")}, record_id) WHERE table_id = ${table}`,
      ].toSorted()
    );
  });

  it("put the owner first when the table's records are read by their owner only", async () => {
    const store = await newStore();
    await store.defineTables(notesManifest([["by_title", ["title"]]], "owner"));
    const [index] = await indexesOf(store);
    expect(index?.sql).toContain(
      `ON sdk_records (owner_id, ${fieldExpression("title")}, record_id)`
    );
  });

  it("are installed once: the same schema again, or reordered, adds nothing", async () => {
    const store = await newStore();
    const manifest = notesManifest([
      ["by_title", ["title"]],
      ["by_rank", ["rank"]],
    ]);
    await store.defineTables(manifest);
    const before = await indexesOf(store);
    await store.defineTables(manifest);
    await store.defineTables(
      notesManifest([
        ["by_rank", ["rank"]],
        ["by_title", ["title"]],
      ])
    );
    await expect(indexesOf(store)).resolves.toStrictEqual(before);
  });

  it("are kept for the older schema when a newer one changes them", async () => {
    const store = await newStore();
    const older = await store.defineTables(
      notesManifest([["by_title", ["title"]]])
    );
    const [kept] = await indexesOf(store);
    // A renamed index of the same fields is the same physical index; a
    // changed one is another, beside the first.
    const renamed = await store.defineTables(
      notesManifest([["by_name", ["title"]]])
    );
    await expect(indexesOf(store)).resolves.toStrictEqual([kept]);
    const changed = await store.defineTables(
      notesManifest([["by_title", ["title", "rank"]]])
    );
    const after = await indexesOf(store);
    expect(after).toHaveLength(2);
    expect(after).toContainEqual(kept);
    await expect(schemasOf(store)).resolves.toStrictEqual(
      [older.schemaHash, renamed.schemaHash, changed.schemaHash].toSorted()
    );
  });

  it("refuse an index whose name SQLite already holds with another definition", async () => {
    const store = await newStore();
    const manifest = notesManifest([["by_title", ["title"]]]);
    await store.defineTables(manifest);
    const [index] = await indexesOf(store);
    await runInDurableObject(
      env.DATA_STORES.getByName(store.id),
      (_instance, state) => {
        state.storage.sql.exec(`DROP INDEX ${index?.name ?? ""}`);
        state.storage.sql.exec(
          `CREATE INDEX ${index?.name ?? ""} ON sdk_records (record_id)`
        );
      }
    );
    await expect(store.defineTables(manifest)).rejects.toThrow(
      /another definition/u
    );
  });

  it(`are at most ${storeMaxIndexes} per store, refused before any is created`, async () => {
    const store = await newStore();
    // Nine tables of 32 single-field indexes: 288 in all.
    const fields = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`f${index}`, v.string()])
    );
    const tables = Object.fromEntries(
      Array.from({ length: 9 }, (_, tableIndex) => {
        let table = defineTable(fields);
        for (let index = 0; index < 32; index += 1) {
          const key: [string] = [`f${index}`];
          table = table.index(`by_f${index}`, key);
        }
        return [`t${tableIndex}`, table];
      })
    );
    const tooMany = manifestText(schemaManifest(defineSchema(tables)));
    await expect(store.defineTables(tooMany)).rejects.toMatchObject({
      code: "data.too_many_indexes",
    });
    await expect(indexesOf(store)).resolves.toStrictEqual([]);
    await expect(schemasOf(store)).resolves.toStrictEqual([]);
  });
});

describe("SQLite's plans", () => {
  it("read a declared index for equality, ranges and its order, with no sort", async () => {
    const store = await newStore();
    const defined = await store.defineTables(
      notesManifest([["by_done_rank", ["done", "rank"]]], "owner")
    );
    const [index] = await indexesOf(store);
    const name = index?.name ?? "";
    const table = tableIdLiteral(defined.tables.notes ?? "");
    const done = fieldExpression("done");
    const rank = fieldExpression("rank");
    const prefix = `SELECT record_id FROM sdk_records INDEXED BY ${name} WHERE table_id = ${table} AND owner_id = ?`;
    for (const [sql, params] of [
      [`${prefix} AND ${done} = ? ORDER BY ${rank}, record_id LIMIT 10`, [1]],
      [
        `${prefix} AND ${done} = ? AND ${rank} > ? AND ${rank} <= ? ORDER BY ${rank} DESC, record_id DESC LIMIT 10`,
        [1, 2, 5],
      ],
      [`${prefix} ORDER BY ${done}, ${rank}, record_id LIMIT 10`, []],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one plan at a time
      const plan = await planOf(store, sql, "ada", ...params);
      expect(plan).toContain(`USING INDEX ${name} (owner_id=?`);
      expect(plan).not.toContain("TEMP B-TREE");
      expect(plan).not.toMatch(/\bSCAN sdk_records\b/u);
    }
  });

  it("read the fixed default-order indexes when a query names no index", async () => {
    const store = await newStore();
    const defined = await store.defineTables(notesManifest([]));
    const table = tableIdLiteral(defined.tables.notes ?? "");
    const shared = await planOf(
      store,
      `SELECT record_id FROM sdk_records INDEXED BY sdk_records_created WHERE table_id = ${table} ORDER BY created_at DESC, record_id DESC LIMIT 10`
    );
    expect(shared).toContain(
      "USING COVERING INDEX sdk_records_created (table_id=?)"
    );
    expect(shared).not.toContain("TEMP B-TREE");
    const owned = await planOf(
      store,
      `SELECT record_id FROM sdk_records INDEXED BY sdk_records_owner_created WHERE table_id = ${table} AND owner_id = ? ORDER BY created_at, record_id LIMIT 10`,
      "ada"
    );
    expect(owned).toContain(
      "USING COVERING INDEX sdk_records_owner_created (table_id=? AND owner_id=?)"
    );
    expect(owned).not.toContain("TEMP B-TREE");
  });

  it("keep a field left out, an explicit null and values apart, in that order", async () => {
    const store = await newStore();
    const defined = await store.defineTables(
      notesManifest([["by_rank", ["rank"]]])
    );
    const [index] = await indexesOf(store);
    const tableId = defined.tables.notes ?? "";
    const ranks = await runInDurableObject(
      env.DATA_STORES.getByName(store.id),
      (_instance, state) => {
        const now = Date.now();
        for (const [id, document] of [
          ["v2", { title: "a", rank: 2 }],
          ["null", { title: "a", rank: null }],
          ["left-out", { title: "a" }],
          ["v-1", { title: "a", rank: -1e300 }],
        ] as const) {
          state.storage.sql.exec(
            "INSERT INTO sdk_records (table_id, record_id, owner_id, revision, created_at, updated_at, value_json, schema_hash) VALUES (?, ?, 'ada', 1, ?, ?, ?, ?)",
            tableId,
            id,
            now,
            now,
            JSON.stringify(document),
            "a".repeat(64)
          );
        }
        const rank = fieldExpression("rank");
        const read = (where: string) =>
          state.storage.sql
            .exec<{ id: string }>(
              `SELECT record_id AS id FROM sdk_records INDEXED BY ${index?.name ?? ""} WHERE table_id = ${tableIdLiteral(tableId)}${where} ORDER BY ${rank}, record_id`
            )
            .toArray()
            .map(({ id }) => id);
        return {
          all: read(""),
          nulls: read(` AND ${rank} = ${nullSentinel}`),
          belowThree: read(` AND ${rank} < 3 AND ${rank} > ${nullSentinel}`),
        };
      }
    );
    expect(ranks).toStrictEqual({
      all: ["left-out", "null", "v-1", "v2"],
      nulls: ["null"],
      belowThree: ["v-1", "v2"],
    });
  });
});
