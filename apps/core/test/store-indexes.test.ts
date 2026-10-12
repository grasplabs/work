import { defineSchema, defineTable, v } from "@grasp-os/sdk";
import { manifestText, schemaManifest } from "@grasp-os/sdk/host";
import type { AccessMode } from "@grasp-os/sdk/host";
import { storeMaxIndexes } from "@grasp-os/shared/store-limits";
import { queryRequestSchema } from "@grasp-os/shared/store-queries";
import type { FilterNode, RangeBound } from "@grasp-os/shared/store-reads";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import { createStore, openStore } from "../src/data-stores.ts";
import type { OpenStore } from "../src/data-stores.ts";
import {
  fieldExpression,
  filterSql,
  nullSentinel,
  rangeSql,
  tableIdLiteral,
} from "../src/store-expressions.ts";
import type { FieldTypes } from "../src/store-expressions.ts";

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

/**
 * A schema of `tables` tables of 32 string fields, each with 32 indexes,
 * the `index`th by the fields `fieldsOf(index)`.
 */
const manyIndexes = (
  tables: number,
  fieldsOf: (index: number) => [string, ...string[]]
): string => {
  const fields = Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => [`f${index}`, v.string()])
  );
  const declared = Object.fromEntries(
    Array.from({ length: tables }, (_, tableIndex) => {
      let table = defineTable(fields);
      for (let index = 0; index < 32; index += 1) {
        table = table.index(`by_${index}`, fieldsOf(index));
      }
      return [`t${tableIndex}`, table];
    })
  );
  return manifestText(schemaManifest(defineSchema(declared)));
};

/** The notes' fields as the pinned schema types them. */
const notesTypes: FieldTypes = {
  base: (field) =>
    (({ title: "string", rank: "number", done: "boolean" }) as const)[
      field === "rank" || field === "done" ? field : "title"
    ],
  nullable: (field) => field === "rank",
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

/** The tables the store holds, by name. */
const tablesOf = async (store: OpenStore): Promise<string[]> =>
  await runInDurableObject(
    env.DATA_STORES.getByName(store.id),
    (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sdk_tables ORDER BY name")
        .toArray()
        .map(({ name }) => name)
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
    const tooMany = manyIndexes(9, (index) => [`f${index}`]);
    await expect(store.defineTables(tooMany)).rejects.toMatchObject({
      code: "data.too_many_indexes",
    });
    // Nothing of the refused schema stays: no index, no schema, no table.
    expect({
      indexes: await indexesOf(store),
      schemas: await schemasOf(store),
      tables: await tablesOf(store),
    }).toStrictEqual({ indexes: [], schemas: [], tables: [] });
  });

  it(`count the indexes kept for older schemas against the ${storeMaxIndexes}`, async () => {
    const store = await newStore();
    // Seven tables of 32 indexes, 224, kept for the schema that has them.
    const older = await store.defineTables(
      manyIndexes(7, (index) => [`f${index}`])
    );
    // A newer schema of other indexes on the same tables adds 224 more.
    const newer = manyIndexes(7, (index) => [
      `f${index}`,
      `f${(index + 1) % 32}`,
    ]);
    await expect(store.defineTables(newer)).rejects.toMatchObject({
      code: "data.too_many_indexes",
    });
    await expect(indexesOf(store)).resolves.toHaveLength(224);
    await expect(schemasOf(store)).resolves.toStrictEqual([older.schemaHash]);
  });
});

describe("SQLite's plans", () => {
  it("read a declared index for the emitter's ranges and its order, with no sort", async () => {
    const store = await newStore();
    const defined = await store.defineTables(
      notesManifest([["by_done_rank", ["done", "rank"]]], "owner")
    );
    const [index] = await indexesOf(store);
    const name = index?.name ?? "";
    const table = tableIdLiteral(defined.tables.notes ?? "");
    const done = rangeSql(notesTypes, "done", [
      { field: "done", op: "eq", value: false },
    ]);
    const rank = (...bounds: RangeBound[]) =>
      rangeSql(notesTypes, "rank", bounds);
    const filter = filterSql(notesTypes, {
      not: { field: "title", op: "in", values: ["a", "b"] },
    });
    // Every shape of range, the filter as the computed column it is,
    // ordered by the index's columns past those the range holds equal.
    const byRank = `${fieldExpression("rank")} DESC, record_id DESC`;
    const cases: [(typeof done)[], string][] = [
      [[done], byRank],
      [
        [
          done,
          rank(
            { field: "rank", op: "gt", value: 2 },
            { field: "rank", op: "lte", value: 5 }
          ),
        ],
        byRank,
      ],
      [
        [done, rank({ field: "rank", op: "eq", value: null })],
        "record_id DESC",
      ],
      [[done, rank({ field: "rank", op: "lt", value: 5 })], byRank],
      [[done, rank({ field: "rank", op: "gte", value: 5 })], byRank],
    ];
    for (const [fragments, order] of cases) {
      const where = fragments.map(({ sql }) => sql).join(" AND ");
      const sql = `SELECT record_id, ${filter.sql} AS matched FROM sdk_records INDEXED BY ${name} WHERE table_id = ${table} AND owner_id = ? AND ${where} ORDER BY ${order} LIMIT 10`;
      // oxlint-disable-next-line no-await-in-loop -- one plan at a time
      const plan = await planOf(
        store,
        sql,
        ...filter.params,
        "ada",
        ...fragments.flatMap(({ params }) => params)
      );
      expect(plan).toContain(`USING INDEX ${name} (owner_id=? AND <expr>=?`);
      expect(plan).not.toMatch(/TEMP B-TREE|\bSCAN sdk_records\b/u);
    }
  });

  it("run the largest descriptor a store accepts, within its SQLite's limits", async () => {
    const store = await newStore();
    const keys: [string, ...string[]] = [
      "f0",
      ...Array.from({ length: 15 }, (_, index) => `f${index + 1}`),
    ];
    const number = v.number().nullable();
    const numbers: Record<string, typeof number> = {};
    for (const key of keys) {
      numbers[key] = number;
    }
    const defined = await store.defineTables(
      manifestText(
        schemaManifest(
          defineSchema({
            wide: defineTable(numbers).index("by_all", keys),
          }),
          { tables: { wide: { read: "owner", write: "owner" } } }
        )
      )
    );
    const [index] = await indexesOf(store);
    // Fifteen fields equal, the last bounded both ways: 17 values.
    const range: RangeBound[] = [
      ...keys
        .slice(0, 15)
        .map((field) => ({ field, op: "eq" as const, value: 1 })),
      { field: "f15", op: "gt", value: 0 },
      { field: "f15", op: "lt", value: 9 },
    ];
    // Eight deep, 56 nodes, 46 conditions and the longest `in`: 47 values.
    let filter: FilterNode = {
      and: [
        ...Array.from({ length: 46 }, (_, position) => ({
          field: "f1",
          op: "neq" as const,
          value: position + 100,
        })),
        {
          field: "f0",
          op: "in",
          values: [...Array.from({ length: 99 }, (_, value) => value), null],
        },
      ],
    };
    for (let level = 0; level < 7; level += 1) {
      filter = { not: filter };
    }
    const descriptor = {
      descriptorVersion: 1,
      table: "wide",
      index: "by_all",
      range,
      filter,
      order: "asc",
      terminal: { kind: "collect" },
    };
    // The store's boundary accepts it: it is the most it takes.
    expect(queryRequestSchema.safeParse(descriptor).success).toBeTruthy();
    const types: FieldTypes = {
      base: () => "number",
      nullable: () => true,
    };
    const terms = [
      ...range
        .slice(0, 15)
        .map((bound) => rangeSql(types, bound.field, [bound])),
      rangeSql(types, "f15", range.slice(15)),
    ];
    const condition = filterSql(types, filter);
    const params = [
      ...condition.params,
      "ada",
      ...terms.flatMap((term) => term.params),
    ];
    // 47 filter values, the owner and 17 range values.
    expect(params).toHaveLength(65);
    const rows = await runInDurableObject(
      env.DATA_STORES.getByName(store.id),
      (_instance, state) =>
        state.storage.sql
          .exec(
            `SELECT record_id, ${condition.sql} AS matched FROM sdk_records INDEXED BY ${index?.name ?? ""} WHERE table_id = ${tableIdLiteral(defined.tables.wide ?? "")} AND owner_id = ? AND ${terms.map(({ sql }) => sql).join(" AND ")} ORDER BY ${fieldExpression("f15")}, record_id LIMIT 10001`,
            ...params
          )
          .toArray()
    );
    expect(rows).toStrictEqual([]);
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
