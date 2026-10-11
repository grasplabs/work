// Compile-time guarantees of `ctx.db` for reading. This file is
// type-checked by `vp check` and never run: every `@ts-expect-error` below
// must stay an error.
import { expectTypeOf } from "vite-plus/test";

import type { DatabaseReader, Doc, PaginationResult } from "../src/database.ts";
import { defineSchema, defineTable, v } from "../src/values.ts";
import type { Id, Infer, paginationOptionsValidator } from "../src/values.ts";

const schema = defineSchema({
  people: defineTable({ name: v.string() }),
  notes: defineTable({
    title: v.string(),
    body: v.string().default(""),
    summary: v.string().nullable().default(null),
    author: v.id("people"),
    rank: v.number().optional(),
    tags: v.array(v.string()).default([]),
  })
    .index("by_updated", ["_updatedAt"])
    .index("by_title", ["title"])
    .index("by_author_rank", ["author", "rank"]),
});

declare const db: DatabaseReader<(typeof schema)["tables"]>;
declare const noteId: Id<"notes">;
declare const personId: Id<"people">;

type Note = Doc<(typeof schema)["tables"]["notes"], "notes">;

// A record has its managed fields and its declared fields, normalized.
expectTypeOf<Note["_id"]>().toEqualTypeOf<Id<"notes">>();
expectTypeOf<Note["_rev"]>().toEqualTypeOf<number>();
expectTypeOf<Note["body"]>().toEqualTypeOf<string>();
expectTypeOf<Note["summary"]>().toEqualTypeOf<string | null>();
expectTypeOf(db.get("notes", noteId)).resolves.toEqualTypeOf<Note | null>();

// IDs belong to one table.
// @ts-expect-error -- a person's ID isn't a note's
void db.get("notes", personId);
// @ts-expect-error -- a plain string isn't an ID
void db.get("notes", "r1");
// @ts-expect-error -- the schema has no such table
void db.get("missing", noteId);
// @ts-expect-error -- the schema has no such table
db.query("missing");

// Indexes and their ranges follow the declaration.
const byAuthor = db
  .query("notes")
  .withIndex("by_author_rank", (range) =>
    range.eq("author", personId).gte("rank", 1).lt("rank", 9)
  );
expectTypeOf(byAuthor.take(5)).resolves.toEqualTypeOf<Note[]>();
db.query("notes").withIndex("by_title");
db.query("notes").withIndex("by_updated", (range) => range.gt("_updatedAt", 0));
// @ts-expect-error -- the table has no such index
db.query("notes").withIndex("by_body");
// @ts-expect-error -- an index's fields are bounded in order: `author` first
db.query("notes").withIndex("by_author_rank", (range) => range.eq("rank", 1));
db.query("notes").withIndex("by_author_rank", (range) => {
  const lower = range.gt("author", personId);
  // After a lower bound, only an upper bound on the same field.
  expectTypeOf(lower).not.toHaveProperty("eq");
  expectTypeOf(lower).not.toHaveProperty("gt");
  // @ts-expect-error -- the upper bound is on the same field
  lower.lt("rank", 1);
  return lower;
});
db.query("notes").withIndex("by_title", (range) => {
  const upper = range.lt("title", "m");
  // Nothing follows the upper bound.
  expectTypeOf(upper).not.toHaveProperty("gt");
  expectTypeOf(upper).not.toHaveProperty("eq");
  return upper;
});
// @ts-expect-error -- `title` is a string
db.query("notes").withIndex("by_title", (range) => range.eq("title", 3));
db.query("notes").withIndex("by_author_rank", (range) =>
  // @ts-expect-error -- a bound is never null
  range.eq("author", personId).gt("rank", null)
);
// @ts-expect-error -- the range function returns the range it built
db.query("notes").withIndex("by_title", () => ({}));
// An index is chosen first, before filters.
expectTypeOf(db.query("notes").filter({ title: "a" })).not.toHaveProperty(
  "withIndex"
);

// Filters name scalar fields, with values of their type.
db.query("notes").filter({
  title: { gte: "a", lt: "m" },
  summary: null,
  OR: [{ rank: { in: [1, 2] } }, { rank: { exists: false } }],
  NOT: { _createdAt: { lt: 10 } },
});
// @ts-expect-error -- an array isn't a filter field
db.query("notes").filter({ tags: ["a"] });
// @ts-expect-error -- the table has no such field
db.query("notes").filter({ missing: 1 });
// @ts-expect-error -- `title` is a string
db.query("notes").filter({ title: 3 });
// @ts-expect-error -- comparisons never match null
db.query("notes").filter({ summary: { gt: null } });
// @ts-expect-error -- no JavaScript predicates
db.query("notes").filter((note: Note) => note.title === "a");

// Every terminal is bounded; there is no unbounded read.
expectTypeOf(db.query("notes").first()).resolves.toEqualTypeOf<Note | null>();
expectTypeOf(db.query("notes").collect()).resolves.toEqualTypeOf<Note[]>();
expectTypeOf(db.query("notes").count()).resolves.toEqualTypeOf<number>();
expectTypeOf(
  db.query("notes").paginate({ pageSize: 20, cursor: null })
).resolves.toEqualTypeOf<PaginationResult<Note>>();
declare const pagination: Infer<typeof paginationOptionsValidator>;
void db.query("notes").order("desc").paginate(pagination);
declare const anyCount: number;
void db.query("notes").take(anyCount);
// @ts-expect-error -- `take` returns at most 100
void db.query("notes").take(101);
// @ts-expect-error -- `take` counts from 0
void db.query("notes").take(-1);
// @ts-expect-error -- a page holds at most 100
void db.query("notes").paginate({ pageSize: 500 });
// @ts-expect-error -- a page holds at least one
void db.query("notes").paginate({ pageSize: 0 });
// There is no unbounded `all`, and a query isn't iterable.
expectTypeOf(db.query("notes")).not.toHaveProperty("all");
expectTypeOf(db.query("notes")).not.toExtend<AsyncIterable<Note>>();
expectTypeOf(db.query("notes")).not.toExtend<Iterable<Note>>();
// A query is ordered once.
expectTypeOf(db.query("notes").order("asc")).not.toHaveProperty("order");

// Aggregates take numeric fields.
expectTypeOf(
  db.query("notes").aggregate({ operation: "sum", field: "rank" })
).resolves.toEqualTypeOf<number>();
expectTypeOf(
  db.query("notes").aggregate({ operation: "max", field: "_updatedAt" })
).resolves.toEqualTypeOf<number | null>();
// @ts-expect-error -- `title` isn't numeric
void db.query("notes").aggregate({ operation: "sum", field: "title" });
// @ts-expect-error -- `sum` names its field
void db.query("notes").aggregate({ operation: "sum" });
