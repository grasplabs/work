// Compile-time guarantees of `defineSchema` and `defineTable`. This file is
// type-checked by `vp check` and never run: every `@ts-expect-error` below
// must stay an error.
import { expectTypeOf } from "vite-plus/test";

import { defineSchema, defineTable, v } from "../src/values.ts";
import type { Id } from "../src/values.ts";

const noteFields = {
  title: v.string().trim().min(1).max(200),
  body: v.string().max(100_000).default(""),
  summary: v.string().max(10_000).nullable().default(null),
  author: v.id("people"),
  tags: v.array(v.string()),
  rank: v.number().optional(),
  meta: v.object({ source: v.string() }),
  mixed: v.union(v.string(), v.number()),
  state: v.union(v.literal("a"), v.literal("b"), v.null()),
};

// The Notes schema of the specification, with a referenced table.
const schema = defineSchema({
  people: defineTable({ name: v.string() }),
  notes: defineTable(noteFields)
    .index("by_updated", ["_updatedAt"])
    .index("by_title", ["title"])
    .index("by_author_rank", ["author", "rank", "_createdAt"])
    .index("by_state", ["state"]),
});
expectTypeOf(schema.tables.notes.fields.author.descriptor.kind).toBeString();
expectTypeOf<
  NonNullable<(typeof schema.tables.notes)["~indexes"]>["by_title"]
>().toEqualTypeOf<readonly ["title"]>();
expectTypeOf<Id<"people">>().toExtend<string>();

const table = defineTable(noteFields);

// An index names scalar fields of its table, or a commit time.
// @ts-expect-error -- the table has no such field
table.index("by_missing", ["missing"]);
// @ts-expect-error -- an array isn't an index key
table.index("by_tags", ["tags"]);
// @ts-expect-error -- an object isn't an index key
table.index("by_meta", ["meta"]);
// @ts-expect-error -- strings and numbers don't sort as one
table.index("by_mixed", ["mixed"]);
// @ts-expect-error -- the host adds the record ID itself
table.index("by_id", ["_id"]);
// @ts-expect-error -- the owner and revision aren't index keys
table.index("by_owner", ["_ownerId"]);
// @ts-expect-error -- an index names at least one field
table.index("by_nothing", []);

// An author can't declare a managed field, or any field starting with `_`.
// @ts-expect-error -- `_ownerId` is the host's
defineTable({ _ownerId: v.string() });
// @ts-expect-error -- `_` starts only managed fields
defineTable({ _draft: v.boolean() });
// @ts-expect-error -- a filter's operator isn't a field
defineTable({ AND: v.boolean() });

// A record ID names a table of the same schema.
// @ts-expect-error -- this schema has no `people` table
defineSchema({ notes: defineTable({ author: v.id("people") }) });
// @ts-expect-error -- not even nested in an array
defineSchema({ notes: defineTable({ watchers: v.array(v.id("people")) }) });
