import { queryRequestSchema } from "@grasp-os/shared/store-queries";
import type { ReadRequest } from "@grasp-os/shared/store-queries";
import { describe, expect, test } from "vite-plus/test";

import { databaseReader, QueryDefinitionError } from "../src/database.ts";
import type { QueryDefinitionCode } from "../src/database.ts";
import {
  defineSchema,
  defineTable,
  paginationOptionsValidator,
  paginationResultValidator,
  v,
} from "../src/values.ts";
import type { Id } from "../src/values.ts";

// `ctx.db` for reading, as App code builds its reads: each read becomes one
// request to the host, which these tests capture instead of a store. What
// the host does with a request is tested through the store itself
// (apps/core/test); here, that a query is built into the descriptor the
// host reads, and that a query the schema doesn't allow is refused before
// anything is read.

const notesSchema = defineSchema({
  people: defineTable({ name: v.string() }),
  notes: defineTable({
    title: v.string().trim().min(1).max(200),
    body: v.string().max(100_000).default(""),
    summary: v.string().nullable().default(null),
    author: v.id("people"),
    rank: v.number().optional(),
    done: v.boolean().default(false),
    tags: v.array(v.string()).default([]),
  })
    .index("by_updated", ["_updatedAt"])
    .index("by_title", ["title"])
    .index("by_author_rank", ["author", "rank"]),
});

/** A reader whose reads are recorded, each answering `answer`. */
const recording = (answer: unknown = null) => {
  const requests: ReadRequest[] = [];
  const db = databaseReader(notesSchema, async (request) => {
    requests.push(request);
    return await Promise.resolve(answer);
  });
  return { db, requests };
};

/** The one query request recorded, checked as the host checks it. */
const onlyQuery = (requests: readonly ReadRequest[]) => {
  expect(requests).toHaveLength(1);
  const [request] = requests;
  if (request?.kind !== "query") {
    throw new Error("Not a query");
  }
  // What the builder makes is what the host's own schema accepts.
  return queryRequestSchema.parse(request.query);
};

/** A range, as a confused or hostile caller would build one. */
interface LooseRange {
  readonly eq: (field: unknown, value: unknown) => LooseRange;
  readonly gt: (field: unknown, value: unknown) => LooseRange;
  readonly gte: (field: unknown, value: unknown) => LooseRange;
  readonly lt: (field: unknown, value: unknown) => LooseRange;
  readonly lte: (field: unknown, value: unknown) => LooseRange;
}

/** A query, as a confused or hostile caller would use one. */
interface LooseQuery {
  readonly withIndex: (
    name: unknown,
    range?: (range: LooseRange) => unknown
  ) => LooseQuery;
  readonly filter: (filter: unknown) => LooseQuery;
  readonly order: (direction: unknown) => LooseQuery;
  readonly take: (count: unknown) => Promise<unknown>;
  readonly paginate: (options: unknown) => Promise<unknown>;
  readonly aggregate: (options: unknown) => Promise<unknown>;
}

/** The reader, as a confused or hostile caller would use it. */
interface LooseReader {
  readonly get: (table: unknown, id: unknown, options?: unknown) => unknown;
  readonly query: (table: unknown) => LooseQuery;
}

/**
 * The reader without its types: it checks at run time what its types
 * refuse, so this view takes anything.
 */
const looseOf = (db: unknown): LooseReader =>
  // SAFETY: none, on purpose: a deliberately ill-typed view.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  db as LooseReader;

const refusedWith = async (
  code: QueryDefinitionCode,
  read: () => unknown
): Promise<void> => {
  let caught: unknown;
  try {
    await read();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(QueryDefinitionError);
  expect(caught).toMatchObject({ code });
};

describe("a query's descriptor", () => {
  test("is read only when a terminal is called", async () => {
    const { db, requests } = recording([]);
    const query = db
      .query("notes")
      .withIndex("by_title", (range) => range.eq("title", "Launch"))
      .filter({ done: false })
      .order("desc");
    expect(requests).toHaveLength(0);
    await query.take(10);
    expect(onlyQuery(requests)).toStrictEqual({
      descriptorVersion: 1,
      table: "notes",
      index: "by_title",
      range: [{ field: "title", op: "eq", value: "Launch" }],
      filter: { field: "done", op: "eq", value: false },
      order: "desc",
      terminal: { kind: "take", count: 10 },
    });
  });

  test("leaves earlier queries as they were: each modifier answers a new one", async () => {
    const { db, requests } = recording([]);
    const all = db.query("notes");
    const open = all.filter({ done: false });
    await all.collect();
    await open.order("desc").collect();
    expect(
      requests.map((request) => request.kind === "query" && request.query)
    ).toStrictEqual([
      expect.objectContaining({ filter: null, order: "asc" }),
      expect.objectContaining({
        filter: { field: "done", op: "eq", value: false },
        order: "desc",
      }),
    ]);
  });

  test("reads by creation time when no index is chosen", async () => {
    const { db, requests } = recording(0);
    await db.query("notes").count();
    expect(onlyQuery(requests)).toMatchObject({
      index: null,
      range: [],
      terminal: { kind: "count" },
    });
  });

  test("holds equality on an index's prefix, then the next field's bounds, in order", async () => {
    const { db, requests } = recording([]);
    // SAFETY: a test ID; the host decides whether a record has it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const author = "p1" as Id<"people">;
    await db
      .query("notes")
      .withIndex("by_author_rank", (range) =>
        range.eq("author", author).gte("rank", 1).lt("rank", 5)
      )
      .first();
    expect(onlyQuery(requests).range).toStrictEqual([
      { field: "author", op: "eq", value: "p1" },
      { field: "rank", op: "gte", value: 1 },
      { field: "rank", op: "lt", value: 5 },
    ]);
  });

  test("turns a filter object into one tree, conditions and logic alike", async () => {
    const { db, requests } = recording([]);
    await db
      .query("notes")
      .filter({
        title: { gte: "a", lt: "m" },
        summary: null,
        OR: [{ rank: { in: [1, 2] } }, { rank: { exists: false } }],
        NOT: { _createdAt: { lt: 10 } },
      })
      .filter({ _ownerId: "ada" })
      .collect();
    expect(onlyQuery(requests).filter).toStrictEqual({
      and: [
        {
          and: [
            { field: "title", op: "gte", value: "a" },
            { field: "title", op: "lt", value: "m" },
            { field: "summary", op: "eq", value: null },
            {
              or: [
                { field: "rank", op: "in", values: [1, 2] },
                { field: "rank", op: "exists", value: false },
              ],
            },
            { not: { field: "_createdAt", op: "lt", value: 10 } },
          ],
        },
        { field: "_ownerId", op: "eq", value: "ada" },
      ],
    });
  });

  test("keeps chained filters side by side, however many", async () => {
    const { db, requests } = recording([]);
    let query = db.query("notes").filter({ rank: { gt: 0 } });
    for (let index = 1; index < 12; index += 1) {
      query = query.filter({ rank: { neq: index } });
    }
    await query.first();
    const { filter } = onlyQuery(requests);
    expect(filter !== null && "and" in filter ? filter.and : []).toHaveLength(
      12
    );
  });

  test("refuses at its terminal a query binding more than 64 values", async () => {
    const { db, requests } = recording([]);
    // SAFETY: a test ID; the host decides whether a record has it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const author = "p1" as Id<"people">;
    let query = db
      .query("notes")
      .withIndex("by_author_rank", (range) =>
        range.eq("author", author).gte("rank", 1).lt("rank", 9)
      );
    for (let index = 0; index < 61; index += 1) {
      query = query.filter({ title: { neq: `t${index}` } });
    }
    // Three range values and 61 conditions, 64 in all: read.
    await query.first();
    // One more is refused before anything is read.
    let caught: unknown;
    try {
      await query.filter({ title: { neq: "last" } }).first();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(QueryDefinitionError);
    expect(requests).toHaveLength(1);
  });

  test("copies what it is given: a list changed later changes nothing", async () => {
    const { db, requests } = recording([]);
    const ranks = [1, 2];
    const query = db.query("notes").filter({ rank: { in: ranks } });
    ranks.push(3);
    await query.collect();
    expect(onlyQuery(requests).filter).toStrictEqual({
      field: "rank",
      op: "in",
      values: [1, 2],
    });
  });

  test("carries each terminal and its bounds", async () => {
    const { db, requests } = recording(null);
    const query = db.query("notes");
    await query.first();
    await query.unique();
    await query.paginate({ pageSize: 20, cursor: null });
    await query.paginate({});
    await query.aggregate({ operation: "count" });
    await query.aggregate({ operation: "sum", field: "rank" });
    await query.aggregate({ operation: "max", field: "rank" });
    expect(
      requests.map(
        (request) => request.kind === "query" && request.query.terminal
      )
    ).toStrictEqual([
      { kind: "first" },
      { kind: "unique" },
      { kind: "paginate", pageSize: 20, cursor: null },
      { kind: "paginate", pageSize: 50, cursor: null },
      { kind: "aggregate", operation: "count" },
      { kind: "aggregate", operation: "sum", field: "rank" },
      { kind: "aggregate", operation: "max", field: "rank" },
    ]);
  });

  test("answers what the host answered", async () => {
    const page = { items: [], nextCursor: null, hasMore: false };
    const { db } = recording(page);
    await expect(db.query("notes").paginate({})).resolves.toBe(page);
  });
});

describe("a record by ID", () => {
  test("is one request, with the revision it asserts", async () => {
    const { db, requests } = recording(null);
    // SAFETY: a test ID; the host decides whether a record has it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const id = "r1" as Id<"notes">;
    await db.get("notes", id);
    await db.get("notes", id, { expectedRevision: 3 });
    expect(requests).toStrictEqual([
      { kind: "get", table: "notes", id: "r1", expectedRevision: null },
      { kind: "get", table: "notes", id: "r1", expectedRevision: 3 },
    ]);
  });

  test("refuses a revision that isn't a whole number of at least 1", async () => {
    const { db, requests } = recording(null);
    const loose = looseOf(db);
    await refusedWith("query.invalid_terminal", () =>
      loose.get("notes", "r1", { expectedRevision: 0 })
    );
    await refusedWith("query.invalid_terminal", () => loose.get("notes", ""));
    expect(requests).toHaveLength(0);
  });
});

describe("a query the schema doesn't allow", () => {
  test("is refused before anything is read", async () => {
    const { db, requests } = recording([]);
    const loose = looseOf(db);
    const notes = () => loose.query("notes");
    await refusedWith("query.unknown_table", () => loose.query("missing"));
    await refusedWith("query.unknown_table", () =>
      loose.get("__proto__", "r1")
    );
    await refusedWith("query.unknown_index", () =>
      notes().withIndex("by_body")
    );
    await refusedWith("query.unknown_index", () =>
      notes().withIndex("toString")
    );
    // Out of order, a skipped field, two bounds on one field the wrong way,
    // or anything after the upper bound.
    for (const build of [
      (range: LooseRange) => range.eq("rank", 1),
      (range: LooseRange) => range.gt("rank", 1),
      (range: LooseRange) => range.gt("author", "p").eq("rank", 1),
      (range: LooseRange) => range.gt("author", "p").gt("author", "q"),
      (range: LooseRange) => range.lt("author", "p").gt("author", "a"),
      (range: LooseRange) =>
        range.eq("author", "p").eq("rank", 1).eq("rank", 2),
      (range: LooseRange) => range.eq("author", 3),
      (range: LooseRange) => range.eq("author", "p").gt("rank", null),
      () => ({ "~indexRange": true }),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one refusal at a time
      await refusedWith("query.invalid_range", () =>
        notes().withIndex("by_author_rank", build)
      );
    }
    for (const filter of [
      { tags: ["a"] },
      { missing: 1 },
      { body: 3 },
      { rank: { gt: null } },
      { rank: { like: "a" } },
      { rank: undefined },
      { AND: { rank: 1 } },
      { rank: { in: Array.from({ length: 101 }, (_, index) => index) } },
      [],
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one refusal at a time
      await refusedWith("query.invalid_filter", () => notes().filter(filter));
    }
    let deep: unknown = { done: true };
    for (let level = 0; level < 9; level += 1) {
      deep = { NOT: deep };
    }
    await refusedWith("query.invalid_filter", () => notes().filter(deep));
    // A range built for one index, returned for another.
    let other: unknown;
    notes().withIndex("by_title", (range: LooseRange) => {
      other = range.eq("title", "a");
      return other;
    });
    await refusedWith("query.invalid_range", () =>
      notes().withIndex("by_author_rank", () => other)
    );
    // Null only where the field may hold null.
    await refusedWith("query.invalid_range", () =>
      notes().withIndex("by_title", (range: LooseRange) =>
        range.eq("title", null)
      )
    );
    for (const filter of [
      { title: null },
      { title: { in: ["a", null] } },
      { title: { neq: null } },
      { title: {} },
      {},
      { OR: [] },
      { AND: [] },
      { title: "x".repeat(4097) },
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one refusal at a time
      await refusedWith("query.invalid_filter", () => notes().filter(filter));
    }
    // Ordered once, whatever comes between.
    await refusedWith("query.invalid_terminal", () =>
      notes().order("asc").filter({ done: true }).order("desc")
    );
    await refusedWith(
      "query.invalid_terminal",
      async () => await notes().paginate({ cursor: "c".repeat(4097) })
    );
    await refusedWith(
      "query.invalid_terminal",
      async () => await notes().paginate({ pageSize: 10, extra: true })
    );
    await refusedWith(
      "query.invalid_terminal",
      async () => await notes().aggregate({ operation: "count", field: "rank" })
    );
    await refusedWith(
      "query.invalid_terminal",
      async () =>
        await notes().aggregate({ operation: "max", field: "_updatedAt" })
    );
    await refusedWith("query.invalid_terminal", () =>
      loose.get("notes", "r1", "3")
    );
    await refusedWith("query.invalid_terminal", () =>
      loose.get("notes", "r1", { revision: 3 })
    );
    await refusedWith(
      "query.invalid_terminal",
      async () => await notes().take(101)
    );
    await refusedWith(
      "query.invalid_terminal",
      async () => await notes().take(-1)
    );
    await refusedWith(
      "query.invalid_terminal",
      async () => await notes().take(1.5)
    );
    await refusedWith(
      "query.invalid_terminal",
      async () => await notes().paginate({ pageSize: 0 })
    );
    await refusedWith(
      "query.invalid_terminal",
      async () => await notes().paginate({ cursor: "" })
    );
    await refusedWith(
      "query.invalid_terminal",
      async () => await notes().aggregate({ operation: "sum", field: "title" })
    );
    await refusedWith(
      "query.invalid_terminal",
      async () => await notes().aggregate({ operation: "avg" })
    );
    await refusedWith("query.invalid_terminal", () => notes().order("up"));
    expect(requests).toHaveLength(0);
  });
});

const validateOptions = (value: unknown) =>
  paginationOptionsValidator["~standard"].validate(value);

describe("the page contract", () => {
  test("fills in a page request's defaults", () => {
    const validate = validateOptions;
    expect(validate({})).toStrictEqual({
      value: { pageSize: 50, cursor: null },
    });
    for (const options of [
      { pageSize: 101 },
      { pageSize: 0 },
      { cursor: "" },
    ]) {
      expect(validate(options)).toHaveProperty("issues");
    }
  });

  test("accepts only a page whose cursor and `hasMore` agree", () => {
    const page = paginationResultValidator(v.object({ id: v.string() }));
    const validate = (value: unknown) => page["~standard"].validate(value);
    expect(
      validate({ items: [], nextCursor: null, hasMore: false })
    ).not.toHaveProperty("issues");
    expect(
      validate({ items: [{ id: "a" }], nextCursor: "c", hasMore: true })
    ).not.toHaveProperty("issues");
    for (const invalid of [
      { items: [], nextCursor: "c", hasMore: true },
      { items: [{ id: "a" }], nextCursor: "", hasMore: true },
      { items: [{ id: "a" }], nextCursor: null, hasMore: true },
      { items: [{ id: "a" }], nextCursor: "c", hasMore: false },
    ]) {
      expect(validate(invalid)).toHaveProperty("issues");
    }
  });
});
