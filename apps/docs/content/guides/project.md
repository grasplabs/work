---
title: An App's project
description: The files an App is made of, and a small Tasks App to start from.
sidebar:
  order: 1
---

An App is a folder of files. Grasp reads them, checks them and runs them; you never deploy anything yourself.

```text
definition.json     What the App is: its name, tables, access and permissions
grasp.config.ts     The App's config, generated from definition.json
server/schema.ts    Its tables, generated from definition.json
server/             Its server functions, one module or more
src/routes/         Its Pages, one file route each
src/components/     Its own components, and src/lib/ its own code
tests/              Its tests
server/_generated/  What Grasp generates from the App; never edited
```

This guide builds a Tasks App: a list of tasks people add and complete.

## The definition

`definition.json` is what the App is, as data: its name, its tables and their fields, indexes and access, and the permissions it needs. Every table and field has an ID of its own, so renaming one never loses what refers to it.

You don't write it by hand. Grasp changes it with its definition tools, in a chat or on the App's page: `addTable`, `addField`, `changeField`, `renameField`, `renameTable`, `setAccess`, `addIndex` and `addPermission`. Each change is checked whole, and Grasp tells you what it does to the records the App already holds.

From the definition, Grasp generates two files you read but never edit: `grasp.config.ts` and `server/schema.ts`. Every version of the App holds them exactly as its definition generates them.

## The schema

`server/schema.ts` declares the App's tables, generated from the definition. Every field has a type, from `v`, and each table says who may read and write it:

```ts server/schema.ts
import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  tasks: defineTable({
    title: v.string().trim().min(1).max(200),
    done: v.boolean().default(false),
  })
    .index("by_done", ["done", "_createdAt"])
    .access({ read: "appMembers", write: "appMembers" }),
});
```

`appMembers` is everyone with a role in the App, its builders included, so they all read and write tasks here. Grasp adds the fields every record has: `_id`, `_ownerId`, `_rev`, `_createdAt` and `_updatedAt`. [Data](/guides/data) covers tables, indexes and access in full.

## The config

`grasp.config.ts` is the App's name and the permissions it needs, generated from the definition too:

```ts grasp.config.ts
import { defineApp } from "@grasp-os/sdk";

export default defineApp({
  name: "Tasks",
});
```

## Server functions

Every module under `server/` exports server functions. Each one declares its arguments and what it returns, and Grasp checks both on every call:

```ts server/tasks.ts
import { v } from "@grasp-os/sdk";
import { doc, mutation, query } from "@server/_generated/server";

export const list = query({
  args: { done: v.boolean() },
  returns: v.array(doc("tasks")).max(100),
  handler: async (ctx, args) =>
    await ctx.db
      .query("tasks")
      .withIndex("by_done", (range) => range.eq("done", args.done))
      .order("desc")
      .take(100),
});

export const add = mutation({
  args: { title: v.string().trim().min(1).max(200) },
  returns: v.id("tasks"),
  handler: async (ctx, args) =>
    await ctx.db.insert("tasks", { title: args.title }),
});

export const complete = mutation({
  args: { id: v.id("tasks"), expectedRevision: v.number().integer().min(1) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(
      "tasks",
      args.id,
      { done: true },
      { expectedRevision: args.expectedRevision }
    );
    return null;
  },
});
```

A function's name is its module and export: these are `tasks.list`, `tasks.add` and `tasks.complete`. `@server/_generated/server` gives you the constructors, typed by your schema.

## A Page

A Page is a file in `src/routes/`, a [TanStack Router](https://tanstack.com/router) file route: `index.tsx` is the App's first Page, at `/`. It calls server functions through `api`, which Grasp generates from them:

```tsx src/routes/index.tsx
import { useMutation, useQuery } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderTitle,
} from "@grasp-os/ui/components/page-header";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { api } from "@server/_generated/api";
import { createFileRoute } from "@tanstack/react-router";

const Tasks = () => {
  const tasks = useQuery(api.tasks.list, { done: false });
  const add = useMutation(api.tasks.add);
  return (
    <main className="flex flex-col gap-6 p-6">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Tasks</PageHeaderTitle>
        </PageHeaderContent>
        <PageHeaderActions>
          <Button onClick={async () => await add({ title: "A new task" })}>
            Add a task
          </Button>
        </PageHeaderActions>
      </PageHeader>
      {tasks === undefined ? (
        <Spinner />
      ) : (
        <ul>
          {tasks.map((task) => (
            <li key={task._id}>{task.title}</li>
          ))}
        </ul>
      )}
    </main>
  );
};

export const Route = createFileRoute("/")({ component: Tasks });
```

The App's Pages aren't listed anywhere: the files in `src/routes/` are its routes. [Pages](/guides/pages) covers them in full.

## What Grasp generates

`server/_generated/` holds what Grasp generates from your App each time it builds it:

- `server`: the constructors (`query`, `mutation`, `action`, `doc`) and the types of `ctx`.
- `api`: a reference to each public function, for Pages and tests.
- `internal`: a reference to each internal function, for server code.
- `dataModel`: the types of your tables (`Doc`, `Id`).

Never edit them: Grasp writes them again on every build.
