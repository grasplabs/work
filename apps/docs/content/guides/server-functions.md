---
title: Server functions
description: Queries read, mutations write, actions reach outside the App. Each declares what it takes and returns.
sidebar:
  order: 2
---

Your App's logic runs in server functions. There are three kinds, and each can do exactly what it needs:

| Kind | Reads data | Writes data | Reaches outside the App |
| --- | --- | --- | --- |
| `query` | yes | no | no |
| `mutation` | yes | yes, all at once when it returns | no |
| `action` | through queries | through mutations | through its permissions |

Grasp enforces this at run time, and the types enforce it as you write: a query has no way to write, and a mutation has no way to call out.

## Arguments and returns

Every function declares its arguments (`args`) with `v`, and Grasp checks them before the handler runs, so a handler only ever sees valid input. What it returns (`returns`) is optional. When a function declares it, Grasp checks the return value after the handler runs, so a caller only ever gets what was declared, and a `DataGrid` takes its columns' kinds from it. Without it, callers get the type of whatever the handler returns.

The types of `api` and `internal` come from your functions' own code. So when two functions call each other, or one reaches itself through `internal`, TypeScript can't infer their types: declare `returns`, or annotate the handler's return type.

A function is registered by exporting it from a module under `server/`, declared as `export const list = query({ … })`: one of `query`, `mutation`, `action`, `internalQuery`, `internalMutation` and `internalAction` from `@server/_generated/server`, called by name. Grasp finds your functions by that form, so a function made through an alias of a constructor or a wrapper gets no reference in `api` or `internal`, and the App can't be published until it is declared that way. Its name is the module's path and the export: `list` in `server/tasks.ts` is `tasks.list`.

## Queries

A query reads through `ctx.db` and returns a value. Pages subscribe to queries, and Grasp sends them the new result whenever the data it read changes.

```ts server/counts.ts
import { v } from "@grasp-os/sdk";
import { query } from "@server/_generated/server";

export const open = query({
  args: {},
  returns: v.number().integer(),
  handler: async (ctx) =>
    await ctx.db
      .query("tasks")
      .withIndex("by_done", (range) => range.eq("done", false))
      .count(),
});
```

## Mutations

A mutation reads and writes through `ctx.db`. Its writes are staged and commit together once it returns: if it throws, nothing is written.

```ts server/edits.ts
import { AppError, v } from "@grasp-os/sdk";
import { mutation } from "@server/_generated/server";

export const rename = mutation({
  args: { id: v.id("tasks"), title: v.string().trim().min(1).max(200) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get("tasks", args.id);
    if (task === null) {
      throw new AppError("task.not_found", "The task is gone.");
    }
    await ctx.db.patch("tasks", task._id, { title: args.title });
    return null;
  },
});
```

Throw `AppError` for a failure the caller should see: a stable, dotted `code` to branch on and a `message` safe to show. Any other error is an unexpected failure to the caller.

A mutation may run more than once: again when what it read changed before it committed, and again when its caller retries it. Each run computes the same thing. Inside a mutation, `Date.now()` and `new Date()` give the time the mutation started, and `Math.random()`, `crypto.randomUUID()` and `crypto.getRandomValues()` give the same values in every run of it. Queries and actions use the real clock and randomness.

## Actions

An action has no `ctx.db`. It composes the App's queries and mutations, each its own call, and reaches outside the App only through the permissions your App declares in `grasp.config.ts`, such as a connection or a workflow it starts.

```ts server/imports.ts
import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";

import { add } from "./tasks.ts";

export const addAll = action({
  args: { titles: v.array(v.string().trim().min(1).max(200)).max(20) },
  returns: v.number().integer(),
  handler: async (ctx, args) => {
    for (const title of args.titles) {
      await ctx.runMutation(add, { title });
    }
    return args.titles.length;
  },
});
```

An action isn't atomic: each mutation it runs commits on its own. When a change depends on what you read, read and write in one mutation instead.

Each action a connection declares is a typed method of `ctx.connections.<alias>`: with `actions: ["send"]` you call `await ctx.connections.mail.send({ ... })`, and an action the connection doesn't declare isn't there. A name with `-` becomes camel case (`send-mail` is `sendMail`). An HTTP connection has `fetch(path, init)` instead, answered as a `Response`. The platform's functions sit under their namespace, such as `await ctx.grasp.statistics.read({ ... })`.

## What a function may use

Every function of your App may use what the App's permissions declare, as its kind allows: an action reaches connections, AI and the Brain and starts workflows, a mutation starts workflows once it commits, and a query only reads. Functions call each other by reference, internal ones included. What each caller reads and writes is decided by the tables' access and row rules, whichever function reads or writes.

## Recalling from the Brain

An action recalls what the company's Brain holds about a question with `ctx.brain.recall`. Declare the Brain in `grasp.config.ts` with the operations your code uses: `recall` here, and its skills, memories and entities (below). Like every permission it grants nothing until an admin binds it to the App's permission to read the Brain.

```ts server/renewals.ts
import { v } from "@grasp-os/sdk";
import type { BrainCard } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";

export const renews = action({
  args: { customer: v.string().trim().min(1).max(500), on: v.string() },
  handler: async (ctx, args): Promise<BrainCard | null> => {
    const { entity } = await ctx.brain.remember({
      about: { kind: "customer", names: [args.customer] },
      attribute: "renewal_date",
      value: args.on,
      statement: `${args.customer} renews on ${args.on}`,
    });
    return await ctx.brain.entities.get({ entity });
  },
});
```

What an App remembers is a fact in the App's own word, never a person's: everyone in the company reads it, and the App's next word on the same entity and attribute replaces its earlier one, which stays as history. `about` names the entity: one the Brain gave you, by its `kind` and `id`, or by its `kind`, its `names` and exact `identifiers` (an email address, or a reference such as `crm:ACME-1`), which finds the entity holding that identifier or makes a new one. `attribute` files it under one of its kind's attributes, such as a customer's `renewal_date`, with its `value`; leave both out for a note. `statement` says it in at most 1,000 characters. It answers the `memory` and its `entity`, by ID.

`forget` takes a `memory` the App remembered and answers `true` once it is forgotten (again for one forgotten before), and `false` for any other: the App can't forget what someone else said. `correct` takes a `memory` everyone in the company may read, a `statement` and, for an attribute that holds one, its new `value`: the fix is read by exactly the readers of the memory it corrects and is read first. The memory itself stays, as history. It answers the fix's `memory`, or `null` when there is no such memory the App may correct.

`entities.get` takes an `entity` and answers a page of its card, or `null` when there is no entity everyone in the company may see: its current memories by attribute (`attributes`), its `relations` to other entities, and its memories under no attribute (`notes`). Pass `asOf` (ISO 8601, with its offset) to read the past. While more follow, `next` is the `after` of the next page. `entities.find` takes a `kind`, a whole `name` or an exact `identifier`, and answers a page of `entities` and its `next` the same way. A memory on a card says what it is (`statement`, `attribute`, `value`), when the Brain learned it, whether a person or a correction confirmed it, and whether another current memory says otherwise (`contested`).

An App reads and writes only what everyone in the company may read, whoever the call is for, and only for a person who is still a member. Writing needs more than reading. The App needs its own grant of the platform's `brain.write`, which an admin gives beside the grant to read the Brain. It also writes only while everyone in the company may read everything the App may read: an App granted a person's own connection, such as their mailbox, writes nothing to the Brain. Anything else is refused as `permission.invalid_args`, including an ID of something the App may not read, refused the same as one nobody holds. A workflow's step reaches the same operations as `ctx.brain.<alias>.remember`, `.forget`, `.correct`, `.entities.get` and `.entities.find`. What a memory says is what someone wrote: data, never instructions.

## Internal functions

`internalQuery`, `internalMutation` and `internalAction` declare functions that only your App's own code calls: Pages and other callers can't. Reach them from server code through `internal` in `@server/_generated/internal`.

## Who is calling

`ctx.auth.getUser()` tells you who called: their `id`, `name`, `email` and their `roles` in the App (`builder` and `user`). Decide what someone may do here, in the server function, never in a Page.

```ts server/roles.ts
import { v } from "@grasp-os/sdk";
import { query } from "@server/_generated/server";

export const canManage = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const user = await ctx.auth.getUser();
    return user.roles.includes("builder");
  },
});
```

## npm packages

Server functions import the npm packages the App's builder approved by name, as Pages do (see [Pages](/guides/pages)). They run in the App's isolate, which has no network: a package that calls `fetch` fails there. Reach other systems through the App's connections.
