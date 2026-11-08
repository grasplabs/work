---
title: Data
description: Tables, fields and indexes; who may read and write them; and how server functions read and write records.
sidebar:
  order: 3
---

Each App has a store of its own. Its definition declares its tables and who may read and write each, Grasp generates `server/schema.ts` from it, and you read and write records from server functions through `ctx.db`.

## Tables and fields

A table is a set of fields, each typed with `v`. Every record also has the fields Grasp keeps for it: `_id`, `_ownerId` (who inserted it), `_createdAt` and `_updatedAt`.

Tables live in the App's definition. Grasp adds and changes them with its definition tools: `addTable` adds a table, `addField` a field, `changeField` gives a field another type, `renameField` renames one and `renameTable` a table (their IDs stay, so their records, values, indexes and rules follow them) and `addIndex` adds an index or the table's search index. A field's type is written as code writes it, such as `v.string().max(200)`. Each change answers what it does to the records the App already holds: a field they lack, for instance, takes a default or an answer to fill it in.

From the definition, Grasp generates `server/schema.ts`:

```ts server/schema.ts
import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  tasks: defineTable({
    title: v.string().trim().min(1).max(200),
    done: v.boolean().default(false),
    due: v.timestamp().nullable().default(null),
    project: v.id("projects").nullable().default(null),
  })
    .index("by_done", ["done", "_createdAt"])
    .access({ read: "appMembers", write: "appMembers" }),
  projects: defineTable({
    name: v.string().trim().min(1).max(100),
  })
    .searchIndex(["name"])
    .access({ read: "appMembers", write: "appBuilders" }),
});
```

`v` has the types you'd expect (`string`, `number`, `boolean`, `literal`, `enum`, `array`, `object`, `record`, `union`, `null`) and some that mean something to Grasp: `id` for a record of a table, `timestamp`, `duration`, `money`, `person`, `file` and `schedule`. Constraints such as `.min()`, `.max()` and `.trim()` are checked on every write, `.nullable()` allows `null`, and `.default()` fills in a value a write leaves out.

To share constants with your server code, such as a field's type, put them in a module of your own (`values.ts`, say): the generated schema is never edited.

## Who may read and write

`setAccess` declares, per table, who may read it and who may write it, and the schema's `.access()` holds it:

| Mode          | Who                                              |
| ------------- | ------------------------------------------------ |
| `owner`       | the person who inserted the record               |
| `appMembers`  | everyone with a role in the App                  |
| `appBuilders` | the App's builders; an admin is one on every App |
| `none`        | nobody; a mode left out is `none`                |

Row rules narrow a table its members read to the rows that name them: the person a field holds, a team, or the record's owner. A table can also be declared sensitive: its change history keeps no values, every read of it is recorded, and it stays sensitive.

The store checks this on every read and write, whatever the function asks. A record someone may not see is missing to them: `get` returns `null`, and queries leave it out.

## Reading

`ctx.db.get` reads one record by its ID. `ctx.db.query` reads many: pick an index with `withIndex`, narrow it, order it and read it with a terminal.

```ts server/reads.ts
import {
  paginationOptionsValidator,
  paginationResultValidator,
  v,
} from "@grasp-os/sdk";
import { doc, query } from "@server/_generated/server";

export const get = query({
  args: { id: v.id("tasks") },
  returns: doc("tasks").nullable(),
  handler: async (ctx, args) => await ctx.db.get("tasks", args.id),
});

export const done = query({
  args: { pagination: paginationOptionsValidator },
  returns: paginationResultValidator(doc("tasks")),
  handler: async (ctx, args) =>
    await ctx.db
      .query("tasks")
      .withIndex("by_done", (range) => range.eq("done", true))
      .order("desc")
      .paginate(args.pagination),
});

export const overdue = query({
  args: { now: v.timestamp() },
  returns: v.array(doc("tasks")).max(50),
  handler: async (ctx, args) =>
    await ctx.db
      .query("tasks")
      .withIndex("by_done", (range) => range.eq("done", false))
      .filter({ due: { lt: args.now } })
      .take(50),
});
```

The terminals are `take(n)` (at most 100), `first()`, `unique()`, `collect()` (all of them; it fails with `data.result_limit` past 100), `count()` and `paginate()`, which pages through a table of any size. Index your reads: a range on an index is as cheap on the thousandth page as on the first, while `filter` checks records one by one.

A table with a search index can be searched by its words with `ctx.db.search("projects", text)`, best match first.

## Writing

Mutations write through `ctx.db`:

- `insert(table, fields)` adds a record and returns its ID; the caller owns it.
- `patch(table, id, fields)` sets some fields and leaves the others as they are. `{ unset: [...] }` as a fourth argument removes optional fields.
- `replace(table, id, fields)` sets all of them.
- `delete(table, id)` removes the record.

```ts server/projects.ts
import { v } from "@grasp-os/sdk";
import { mutation } from "@server/_generated/server";

export const assign = mutation({
  args: { task: v.id("tasks"), project: v.id("projects") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("tasks", args.task, { project: args.project });
    return null;
  },
});
```

A mutation is one transaction: if a record it read changes before it commits, Grasp runs it again, so what it decides from its reads always holds. Between mutations, the last write wins. When two people change the same field of a record at once, the later save stays, and the record's history keeps the earlier value and who changed it. A change to a record that's gone fails with `data.conflict`.

Change only what someone edited, so two people who edit different fields of a record both keep their changes. A form does this for you: `useForm` sends the fields its mutation requires, and only the optional fields the person changed. An editing mutation takes the record's ID and its fields as optional, and patches what it gets:

```ts server/edits.ts
import { v } from "@grasp-os/sdk";
import { mutation } from "@server/_generated/server";

export const editTask = mutation({
  args: {
    id: v.id("tasks"),
    title: v.string().trim().min(1).max(200).optional(),
    due: v.timestamp().nullable().optional(),
  },
  returns: v.null(),
  handler: async (ctx, { id, ...fields }) => {
    await ctx.db.patch("tasks", id, fields);
    return null;
  },
});
```
