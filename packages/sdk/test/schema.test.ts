import { describe, expect, test } from "vite-plus/test";

import { schemaLimits } from "../src/host.ts";
import type { IndexDefinition } from "../src/schema.ts";
import { defineSchema, defineTable, v } from "../src/values.ts";

// `defineSchema` and `defineTable`: what a declaration may say, refused as
// it is built rather than when a store is handed it. Pure checks, so unit
// tests; the host's own reading of a schema is tested through the store
// (apps/core/test/data-stores.test.ts).

const noteFields = {
  title: v.string().trim().min(1).max(200),
  body: v.string().max(100_000).default(""),
  summary: v.string().max(10_000).nullable().default(null),
};

/** The Notes schema of the specification (9.1), as an App writes it. */
const notesSchema = () =>
  defineSchema({
    notes: defineTable(noteFields)
      .index("by_updated", ["_updatedAt"])
      .index("by_title", ["title"]),
  });

/** A table, as a confused or hostile caller would use one. */
interface LooseTable {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly indexes: readonly IndexDefinition[];
  readonly index: (name: unknown, keys: unknown) => LooseTable;
}

// SAFETY: none, on purpose: the declarations check at run time what their
// types refuse, so these views of them take anything.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately ill-typed views
const tableOf = defineTable as (fields: unknown) => LooseTable;
// SAFETY: as above.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately ill-typed views
const schemaOf = defineSchema as (tables: unknown) => unknown;

const codeOf = (declare: () => unknown): unknown => {
  try {
    declare();
  } catch (error) {
    return error instanceof Error && "code" in error ? error.code : error;
  }
  return "accepted";
};

describe("tables", () => {
  test("a table holds its fields and indexes, in the order declared", () => {
    const { notes } = notesSchema().tables;
    expect(Object.keys(notes.fields)).toStrictEqual([
      "title",
      "body",
      "summary",
    ]);
    expect(notes.indexes).toStrictEqual([
      { name: "by_updated", fields: ["_updatedAt"] },
      { name: "by_title", fields: ["title"] },
    ]);
  });

  test("a table can't change: `.index` answers a new one", () => {
    const fields = { title: v.string() };
    const plain = defineTable(fields);
    const indexed = plain.index("by_title", ["title"]);
    expect(plain.indexes).toStrictEqual([]);
    expect(indexed.indexes).toHaveLength(1);
    // The fields passed in are copied, so changing them later changes nothing.
    Object.assign(fields, { body: v.string() });
    expect(Object.keys(plain.fields)).toStrictEqual(["title"]);
  });

  test("a table is frozen all the way down", () => {
    const table = defineTable({ title: v.string() }).index("by_title", [
      "title",
    ]);
    expect(
      [table, table.fields, table.indexes, table.indexes[0]?.fields].every(
        (part) => Object.isFrozen(part)
      )
    ).toBeTruthy();
  });

  test.each([
    ["a managed field's name", { _id: v.string() }],
    ["any name starting with `_`", { _notes: v.string() }],
    ["a name starting with a digit", { "1title": v.string() }],
    ["a name with other characters", { "title-text": v.string() }],
    ["a name that isn't ASCII", { titré: v.string() }],
    ["an empty name", { "": v.string() }],
    ["a name too long", { ["t".repeat(65)]: v.string() }],
    ["a filter's operator", { AND: v.string() }],
    ["a filter's operator in any case", { or: v.string() }],
  ])("a field can't have %s", (_, fields) => {
    expect(codeOf(() => tableOf(fields))).toBe("schema.invalid_name");
  });

  test("two fields can't differ only in case", () => {
    expect(
      codeOf(() => tableOf({ title: v.string(), Title: v.string() }))
    ).toBe("schema.name_conflict");
  });

  test("a field is a `v` schema", () => {
    expect(codeOf(() => tableOf({ title: { kind: "string" } }))).toBe(
      "definition.invalid_schema"
    );
    expect(codeOf(() => tableOf(["title"]))).toBe("schema.invalid_table");
  });

  test("a field read through a getter is read once, and kept as checked", () => {
    let reads = 0;
    const fields = {
      get title() {
        reads += 1;
        // Valid when checked, something else on any later read.
        return reads === 1 ? v.string() : "not a schema";
      },
    };
    const table = tableOf(fields);
    expect(reads).toBe(1);
    expect(
      Object.getOwnPropertyDescriptor(table.fields, "title")
    ).not.toHaveProperty("get");
    expect(reads).toBe(1);
  });

  test("a nested field's name is at most 64 characters too", () => {
    expect(
      codeOf(() =>
        tableOf({ meta: v.object({ ["k".repeat(65)]: v.string() }) })
      )
    ).toBe("definition.invalid_key");
  });

  test("a name of up to 64 characters is a field's", () => {
    expect(codeOf(() => tableOf({ ["t".repeat(64)]: v.string() }))).toBe(
      "accepted"
    );
  });
});

describe("indexes", () => {
  const fields = {
    title: v.string(),
    rank: v.number().integer().optional(),
    done: v.boolean().nullable(),
    status: v.enum(["open", "closed"]),
    state: v.union(v.literal("a"), v.literal("b"), v.null()),
    owner: v.person(),
    dueAt: v.timestamp().optional(),
    tags: v.array(v.string()),
    meta: v.object({ source: v.string() }),
    mixed: v.union(v.string(), v.number()),
    price: v.money(),
    nothing: v.null(),
  };
  const index = (keys: unknown) => tableOf(fields).index("by_key", keys);

  test.each([
    ["a string", ["title"]],
    ["an optional number", ["rank"]],
    ["a nullable boolean", ["done"]],
    ["an enum", ["status"]],
    ["a union of strings and null", ["state"]],
    ["a person", ["owner"]],
    ["a timestamp", ["dueAt"]],
    ["the creation time", ["_createdAt"]],
    ["several fields", ["status", "_updatedAt", "title"]],
  ])("an index may order by %s", (_, keys) => {
    expect(codeOf(() => index(keys))).toBe("accepted");
  });

  test.each([
    ["a field the table hasn't", ["missing"]],
    ["an array", ["tags"]],
    ["an object", ["meta"]],
    ["a union of strings and numbers", ["mixed"]],
    ["money", ["price"]],
    ["only null", ["nothing"]],
    ["the record ID, which the host adds", ["_id"]],
    ["the owner", ["_ownerId"]],
    ["the revision", ["_rev"]],
    ["no field", []],
    ["a field twice", ["title", "title"]],
    ["something other than a name", [1]],
    ["something other than a list", "title"],
  ])("an index can't order by %s", (_, keys) => {
    expect(codeOf(() => index(keys))).toBe("schema.invalid_index");
  });

  test(`an index orders by at most ${schemaLimits.fieldsPerIndex} fields`, () => {
    const many = Object.fromEntries(
      Array.from({ length: schemaLimits.fieldsPerIndex + 1 }, (_, n) => [
        `f${n}`,
        v.string(),
      ])
    );
    const names = Object.keys(many);
    const table = tableOf(many);
    expect(
      codeOf(() =>
        table.index("all", names.slice(0, schemaLimits.fieldsPerIndex))
      )
    ).toBe("accepted");
    expect(codeOf(() => table.index("all", names))).toBe(
      "schema.invalid_index"
    );
  });

  test("two indexes can't order by the same fields, or share a name in any case", () => {
    const table = defineTable(fields).index("by_title", ["title"]);
    expect(codeOf(() => table.index("again", ["title"]))).toBe(
      "schema.invalid_index"
    );
    expect(codeOf(() => table.index("By_Title", ["status"]))).toBe(
      "schema.name_conflict"
    );
    // A longer index starting with the same field orders differently.
    expect(codeOf(() => table.index("by_title_rank", ["title", "rank"]))).toBe(
      "accepted"
    );
    expect(codeOf(() => table.index("by-title", ["status"]))).toBe(
      "schema.invalid_name"
    );
  });

  test(`a table has at most ${schemaLimits.indexesPerTable} indexes`, () => {
    const many = Object.fromEntries(
      Array.from({ length: schemaLimits.indexesPerTable + 1 }, (_, n) => [
        `f${n}`,
        v.string(),
      ])
    );
    let table = tableOf(many);
    for (const name of Object.keys(many).slice(
      0,
      schemaLimits.indexesPerTable
    )) {
      table = table.index(`by_${name}`, [name]);
    }
    expect(codeOf(() => table.index("one_more", ["f32"]))).toBe(
      "schema.too_large"
    );
  });
});

describe("schemas", () => {
  test("a schema holds its tables by name", () => {
    const schema = notesSchema();
    expect(Object.keys(schema.tables)).toStrictEqual(["notes"]);
    expect(Object.isFrozen(schema)).toBeTruthy();
    expect(Object.isFrozen(schema.tables)).toBeTruthy();
  });

  test("a schema with no tables needs no store, and is one", () => {
    expect(codeOf(() => defineSchema({}))).toBe("accepted");
  });

  test.each(["_notes", "1notes", "notes-list", "", "n".repeat(65)])(
    "a table can't be named %j",
    (name) => {
      expect(
        codeOf(() =>
          defineSchema({ [name]: defineTable({ title: v.string() }) })
        )
      ).toBe("schema.invalid_name");
    }
  );

  test("two tables can't differ only in case", () => {
    const table = defineTable({ title: v.string() });
    expect(codeOf(() => defineSchema({ notes: table, Notes: table }))).toBe(
      "schema.name_conflict"
    );
  });

  test("a table read through a getter is read once, and kept as checked", () => {
    const real = defineTable({ title: v.string() });
    let reads = 0;
    const schema = schemaOf({
      get notes() {
        reads += 1;
        return reads === 1 ? real : { fields: {}, indexes: [] };
      },
    });
    expect(reads).toBe(1);
    expect(schema).toMatchObject({ tables: { notes: real } });
  });

  test("a table is one `defineTable` made, never a lookalike", () => {
    const real = defineTable({ title: v.string() });
    const lookalike = { fields: real.fields, indexes: [] };
    expect(codeOf(() => defineSchema({ notes: lookalike }))).toBe(
      "schema.invalid_table"
    );
    expect(codeOf(() => schemaOf([real]))).toBe("schema.invalid_table");
  });

  test("a record ID names a table of the schema, wherever it is nested", () => {
    const people = defineTable({ name: v.string() });
    expect(
      codeOf(() =>
        defineSchema({
          people,
          notes: defineTable({
            author: v.id("people"),
            watchers: v.array(v.id("people")),
          }),
        })
      )
    ).toBe("accepted");
    expect(
      codeOf(() =>
        schemaOf({
          notes: defineTable({
            meta: v.object({ links: v.record(v.id("people")) }),
          }),
        })
      )
    ).toBe("schema.unknown_table");
    // A table's name is exact: a reference in another case names nothing.
    expect(
      codeOf(() =>
        schemaOf({ people, notes: defineTable({ author: v.id("People") }) })
      )
    ).toBe("schema.unknown_table");
  });

  test(`a schema has at most ${schemaLimits.tables} tables`, () => {
    const table = defineTable({ title: v.string() });
    const tables = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, n) => [`t${n}`, table])
      );
    expect(codeOf(() => defineSchema(tables(schemaLimits.tables)))).toBe(
      "accepted"
    );
    expect(codeOf(() => defineSchema(tables(schemaLimits.tables + 1)))).toBe(
      "schema.too_large"
    );
  });
});
