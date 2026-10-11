import type { FilterNode, RangeBound } from "@grasp-os/shared/store-reads";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import { createStore, openStore } from "../src/data-stores.ts";
import { filterSql, rangeSql } from "../src/store-expressions.ts";
import type {
  ComparedBase,
  FieldTypes,
  Fragment,
} from "../src/store-expressions.ts";
import { tablesManifest } from "./store-schemas.ts";

// What conditions mean, as the shared emitter writes them and the store's
// own SQLite evaluates them: two-valued, with a field that holds a value,
// one that holds an explicit null and one left out kept apart (the
// meaning is in shared/store-reads.ts, as completed on GRA-243).

const builder: Acting = {
  userId: "ada",
  role: "builder",
  teams: [],
  staff: false,
};

/** The notes' fields as a pinned schema would type them. */
const bases = new Map<string, ComparedBase>([
  ["rank", "number"],
  ["title", "string"],
]);
const types: FieldTypes = {
  base: (field) => bases.get(field),
  nullable: (field) => field === "rank",
};

/** Notes whose `rank` holds a value, another value, null, or nothing. */
const documents = {
  value: { title: "a", rank: 2 },
  other: { title: "b", rank: 5 },
  null: { title: "c", rank: null },
  missing: { title: "d" },
} as const;

/**
 * The IDs of the notes `where` matches, in the store's SQLite: a fresh
 * store holding the four notes above.
 */
const matching = async (...fragments: Fragment[]): Promise<string[]> => {
  const store = await openStore(env, await createStore(env, builder));
  const { tables } = await store.defineTables(tablesManifest("notes"));
  return await runInDurableObject(
    env.DATA_STORES.getByName(store.id),
    (_instance, state) => {
      for (const [id, document] of Object.entries(documents)) {
        state.storage.sql.exec(
          "INSERT INTO sdk_records (table_id, record_id, owner_id, revision, created_at, updated_at, value_json, schema_hash) VALUES (?, ?, 'ada', 1, 1, 1, ?, ?)",
          tables.notes ?? "",
          id,
          JSON.stringify(document),
          "a".repeat(64)
        );
      }
      return state.storage.sql
        .exec<{ id: string }>(
          `SELECT record_id AS id FROM sdk_records WHERE table_id = ? AND ${fragments.map(({ sql }) => sql).join(" AND ")} ORDER BY record_id`,
          tables.notes ?? "",
          ...fragments.flatMap(({ params }) => params)
        )
        .toArray()
        .map(({ id }) => id);
    }
  );
};

/** A filter node as App code could send any: the emitter checks it. */
const loose = (node: unknown): FilterNode =>
  // SAFETY: none, on purpose: the emitter must refuse what is ill-typed.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately ill-typed input
  node as FilterNode;

const rank = (op: string, value: unknown): FilterNode =>
  // SAFETY: the cases below are well formed; the store's schema checks
  // descriptors from App code (store-queries.test.ts in shared).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  ({ field: "rank", op, value }) as FilterNode;

describe("filter conditions", () => {
  it("match values, an explicit null or a field left out, each as they mean", async () => {
    const cases: [FilterNode, string[]][] = [
      [rank("eq", 2), ["value"]],
      [rank("eq", null), ["null"]],
      [rank("neq", 2), ["other"]],
      [rank("neq", null), ["other", "value"]],
      [rank("lt", 3), ["value"]],
      [rank("gte", 2), ["other", "value"]],
      [{ field: "rank", op: "in", values: [2, null] }, ["null", "value"]],
      [{ field: "rank", op: "in", values: [] }, []],
      [rank("exists", false), ["missing"]],
      [rank("exists", true), ["null", "other", "value"]],
    ];
    for (const [condition, expected] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- one case at a time
      await expect(
        matching(filterSql(types, condition))
      ).resolves.toStrictEqual(expected);
    }
  });

  it("negate plainly: NOT keeps what its condition doesn't match, null and left out included", async () => {
    const cases: [FilterNode, string[]][] = [
      [{ not: rank("eq", 2) }, ["missing", "null", "other"]],
      [{ not: rank("lt", 3) }, ["missing", "null", "other"]],
      [{ not: rank("neq", 2) }, ["missing", "null", "value"]],
      [{ not: rank("exists", false) }, ["null", "other", "value"]],
      [{ not: { not: rank("eq", 2) } }, ["value"]],
      [
        { or: [rank("eq", null), { not: rank("exists", true) }] },
        ["missing", "null"],
      ],
      [
        { and: [{ not: rank("eq", 5) }, rank("exists", true)] },
        ["null", "value"],
      ],
    ];
    for (const [condition, expected] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- one case at a time
      await expect(
        matching(filterSql(types, condition))
      ).resolves.toStrictEqual(expected);
    }
  });

  it("refuse what the field's type doesn't allow", () => {
    for (const condition of [
      { field: "title", op: "eq", value: null },
      { field: "title", op: "in", values: ["a", null] },
      { field: "rank", op: "gt", value: null },
      { field: "rank", op: "eq", value: "2" },
      { field: "tags", op: "eq", value: "a" },
      { or: [] },
    ]) {
      expect(() => filterSql(types, loose(condition))).toThrow(
        expect.objectContaining({ code: "data.invalid_query" })
      );
    }
  });
});

/** A bound on `rank`. */
const bound = (
  op: RangeBound["op"],
  value: RangeBound["value"]
): RangeBound => ({ field: "rank", op, value });

describe("index range bounds", () => {
  it("match values only, so an upper bound never reaches null or a field left out", async () => {
    const cases: [string, RangeBound[], string[]][] = [
      ["rank", [bound("lt", 3)], ["value"]],
      ["rank", [bound("lte", 5)], ["other", "value"]],
      ["rank", [bound("gt", 1)], ["other", "value"]],
      ["rank", [bound("gte", 2), bound("lt", 5)], ["value"]],
      ["rank", [bound("eq", null)], ["null"]],
      ["title", [{ field: "title", op: "lt", value: "c" }], ["other", "value"]],
    ];
    for (const [field, bounds, expected] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- one case at a time
      await expect(
        matching(rangeSql(types, field, bounds))
      ).resolves.toStrictEqual(expected);
    }
  });

  it("refuse null outside equality, and on fields that can't hold it", () => {
    expect(() => rangeSql(types, "rank", [bound("lt", null)])).toThrow(
      expect.objectContaining({ code: "data.invalid_query" })
    );
    expect(() =>
      rangeSql(types, "title", [{ field: "title", op: "eq", value: null }])
    ).toThrow(expect.objectContaining({ code: "data.invalid_query" }));
  });
});
