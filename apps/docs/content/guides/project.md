---
title: An App's project
description: The files an App is made of, and a small Tasks App to start from.
sidebar:
  order: 1
---

An App is its definition and a folder of files. Grasp reads them, checks them and runs them; you never deploy anything yourself.

```text
grasp.config.ts     The App's config, generated from its definition
server/schema.ts    Its tables, generated from its definition
server/             Its server functions, one module or more
src/routes/         Its Pages, one file route each
src/components/     Its own components, and src/lib/ its own code
tests/              Its tests
server/_generated/  What Grasp generates from the App; never edited
```

This guide builds a Tasks App: a list of tasks people add and complete.

## The definition

The definition is what the App is, as data: its name, its tables and their fields, indexes and access, and the permissions it needs. Every table and field has an ID of its own, so renaming one never loses what refers to it. It is no file: Grasp keeps it with each version of the App, beside its files.

Each type in it says what `v` says, as JSON, in the same words, and leaves out whatever is false: `v.string().trim().max(200).optional()` is `{ "kind": "string", "trim": true, "max": 200, "optional": true }`. Workflows declare their args, returns, state and parameters the same way.

You don't write it by hand. Grasp changes it with its definition tools, in a chat or on the App's page: `addTable`, `addField`, `changeField`, `renameField`, `renameTable`, `setAccess`, `addIndex` and `addPermission`. Each change is checked whole, and Grasp tells you what it does to the records the App already holds.

Each query and mutation the App's code exports has an ID in the definition too, given as a draft's write brings it and kept from version to version by its path (`server/tasks.ts`'s `create` is `tasks.create`): what a workflow calls it by. Renaming one in code reads as one removed and another added, so `renameFunction` says the rename, keeping its ID, and the workflows calling it keep calling it under the new name. Publishing a version that removes a function a workflow calls, or changes what it takes or answers so the workflow's calls no longer fit, is refused, naming the workflow.

From the definition, Grasp generates two files you read but never edit: `grasp.config.ts` and `server/schema.ts`. Every version of the App holds them exactly as its definition generates them. Generation goes one way, and the IDs stay in the definition: the code names tables and fields by their names alone, so an exported App is a plain code project.

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

`appMembers` is everyone with a role in the App, its builders included, so they all read and write tasks here. Grasp adds the fields every record has: `_id`, `_ownerId`, `_createdAt` and `_updatedAt`. [Data](/guides/data) covers tables, indexes and access in full.

## The config

`grasp.config.ts` is the App's name and the permissions it needs, generated from the definition too:

```ts grasp.config.ts
import { defineApp } from "@grasp-os/sdk";

export default defineApp({
  name: "Tasks",
});
```

## Server functions

Every module under `server/` exports server functions. Each one declares its arguments, and Grasp checks them on every call. `returns` is optional: when a function declares it, Grasp checks every answer against it, and a `DataGrid` takes each column's kind from it. Without `returns`, callers get the type of whatever the handler returns:

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
  args: { id: v.id("tasks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("tasks", args.id, { done: true });
    return null;
  },
});
```

A function's name is its module and export: these are `tasks.list`, `tasks.add` and `tasks.complete`. Declare each as `export const name = query({ … })`, the constructor called by name: that's how Grasp finds it. `@server/_generated/server` gives you the constructors, typed by your schema.

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

`server/_generated/` is part of your App's files, as `convex/_generated/` is in Convex. Grasp generates it again from your code and definition on every save:

- `server`: the constructors (`query`, `mutation`, `action`, `doc`) and the types of `ctx`.
- `api`: a reference to each public function, for Pages and tests.
- `internal`: a reference to each internal function, for server code.
- `dataModel`: the types of your tables (`Doc`, `Id`).

A reference holds only the function's name (`{ name: "tasks.list" }`). Its types come from the function's own code, as in Convex, so renaming an argument shows up in every Page that passes it.

Never edit them: Grasp refuses changes to `server/_generated/` and writes it again on every save. Publishing generates it again from the version's code and definition, so a release always holds what Grasp generates.
