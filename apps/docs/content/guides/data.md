---
title: Data
description: Tables, fields and indexes; who may read and write them; and how server functions read and write records.
sidebar:
  order: 3
---

Each App has a store of its own. You declare its tables in `schema.ts`, say who may read and write each in `app.ts`, and read and write records from server functions through `ctx.db`.

## Tables and fields

A table is a set of fields, each typed with `v`. Every record also has the fields Grasp keeps for it: `_id`, `_ownerId` (who inserted it), `_rev` (its revision, raised by every write), `_createdAt` and `_updatedAt`.

```ts schema.ts
import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  tasks: defineTable({
    title: v.string().trim().min(1).max(200),
    done: v.boolean().default(false),
    due: v.timestamp().nullable().default(null),
    project: v.id("projects").nullable().default(null),
  }).index("by_done", ["done", "_createdAt"]),
  projects: defineTable({
    name: v.string().trim().min(1).max(100),
  }).searchIndex(["name"]),
});
```

`v` has the types you'd expect (`string`, `number`, `boolean`, `literal`, `enum`, `array`, `object`, `record`, `union`, `null`) and some that mean something to Grasp: `id` for a record of a table, `timestamp`, `duration`, `money`, `person`, `file` and `schedule`. Constraints such as `.min()`, `.max()` and `.trim()` are checked on every write, `.nullable()` allows `null`, and `.default()` fills in a value a write leaves out.

## Who may read and write

`app.ts` declares, per table, who may read it and who may write it:

| Mode          | Who                                              |
| ------------- | ------------------------------------------------ |
| `owner`       | the person who inserted the record               |
| `appMembers`  | everyone with a role in the App                  |
| `appBuilders` | the App's builders; an admin is one on every App |
| `none`        | nobody; a mode left out is `none`                |

```ts app.ts
import { app } from "@grasp-os/sdk";

import schema from "./schema.ts";

export default app({
  name: "Tasks",
  schema,
  access: {
    tables: {
      tasks: { read: "appMembers", write: "appMembers" },
      projects: { read: "appMembers", write: "appBuilders" },
    },
  },
  screens: [{ name: "tasks", path: "/", source: "screens/tasks.tsx" }],
});
```

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

The terminals are `take(n)` (at most 100), `first()`, `unique()`, `collect()` (all, at most 100), `count()` and `paginate()`, which pages through a table of any size. Index your reads: a range on an index is as cheap on the thousandth page as on the first, while `filter` checks records one by one.

A table with a search index can be searched by its words with `ctx.db.search("projects", text)`, best match first.

## Writing

Mutations write through `ctx.db`:

- `insert(table, fields)` adds a record and returns its ID; the caller owns it.
- `patch(table, id, fields, { expectedRevision })` sets some fields.
- `replace(table, id, fields, { expectedRevision })` sets all of them.
- `delete(table, id, { expectedRevision })` removes the record.

```ts server/projects.ts
import { v } from "@grasp-os/sdk";
import { mutation } from "@server/_generated/server";

export const assign = mutation({
  args: {
    task: v.id("tasks"),
    expectedRevision: v.number().integer().min(1),
    project: v.id("projects"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(
      "tasks",
      args.task,
      { project: args.project },
      { expectedRevision: args.expectedRevision }
    );
    return null;
  },
});
```

Every change names the revision it expects. If someone changed the record since you read it, the mutation fails with `data.conflict` and writes nothing, so nobody overwrites a change they never saw. Pass the revision a Page showed (`_rev`) as an argument, as `assign` does.
