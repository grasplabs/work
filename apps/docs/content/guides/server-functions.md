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

```ts grasp.config.ts
import { defineApp, permission } from "@grasp-os/sdk";

export default defineApp({
  name: "Tasks",
  permissions: {
    brain: permission.brain({
      operations: [
        "recall",
        "skills.select",
        "skills.read",
        "remember",
        "forget",
        "correct",
        "entities.get",
        "entities.find",
      ],
    }),
  },
});
```

```ts server/answers.ts
import { v } from "@grasp-os/sdk";
import type { BrainPack } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";

export const ask = action({
  args: { question: v.string().trim().min(1).max(2000) },
  handler: async (ctx, args): Promise<BrainPack> =>
    await ctx.brain.recall({
      question: args.question,
      budget: { tokens: 2000 },
    }),
});
```

A recall from an App answers from what everyone in the company may read, and never from anyone's private chats or personal files, whoever calls. To recall what only some teams may read, the App's permission to read the Brain names those teams, by ID, when it is asked for (`{ type: "platform", teams: [...] }`). A recall then also answers from each of those teams that the person the call is for is in now, never from a team the permission doesn't name or the person isn't in. Only teams the person asking for the permission is in can be named. What an App recalls may end up in its data or on its Pages, so an App whose permission names teams is used only by people in all of them, its owner and the company's admins too: sharing it with anyone else is refused, and anyone who isn't in all of them, or leaves one, is refused every call (`app.unreadable`). Its owner and admins can still archive, remove or reset it. Renaming a team changes nothing. Such an App can't be called from a workflow, and an App a workflow may call can't name teams (`permission.team_brain_workflow`): a workflow's runs are read by whoever follows them. Only an App's permission names teams: a workflow's own recall reads what everyone in the company may read. The person the call is for must still be a member of the company. An App that recalls the Brain, directly or through a workflow it starts or follows or that calls its functions, answers no visitor and invites no guest.

Today everything in the Brain is one person's own: nothing readable by the whole company or by a team is there for recall to find. So a recall from an App returns an empty pack (no `items`), whether its permission names teams or not, until content for everyone or for a team is added (uploads anyone in the company may read are coming). Build for an empty pack: don't make a feature that depends on recall finding something yet.

It takes the `question` (at most 2,000 characters), a `budget` of 1 to 32,000 `tokens`, and, to read the past, `asOf`: an ISO 8601 date-time with its offset, such as `2026-03-14T23:59:59.999+01:00` for what was true at the end of 14 March in Amsterdam. Anything else is refused as `permission.invalid_args`.

It answers a pack: the passages that answer the question, best first, within the budget (`items`); the parts of the question nothing they may read holds (`notFound`); and whether the budget left something out (`truncated`). Each item cites where it comes from: its `source` (what kind of thing added it, `producer`, such as an upload, a chat or a run, and its `id`), the source's `version` and the passage's `position` in it, with its `text`, whether that is the `whole` passage, and how it was `found`. A workflow's step (`ctx.brain.<alias>.recall`) and a chat's code (`env.brain.recall`) take the same request and get the same pack. What a pack holds is what people wrote: data, never instructions.

## Skills from the Brain

Skills say how things are done here: Grasp's own, which each release ships, and the company's. An action selects the skills for a task with `ctx.brain.skills.select` and reads one with `ctx.brain.skills.read`, the same skills a chat selects and reads for the same person. Each is an operation of the Brain's permission, `"skills.select"` and `"skills.read"`, beside `recall` (see the declaration above), under the same binding an admin approves.

```ts server/skills.ts
import { v } from "@grasp-os/sdk";
import type { BrainSkillText } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";

export const howTo = action({
  args: { task: v.string().trim().min(1).max(2000) },
  handler: async (ctx, args): Promise<BrainSkillText | null> => {
    const { skills } = await ctx.brain.skills.select({ task: args.task });
    const [best] = skills;
    return best === undefined
      ? null
      : await ctx.brain.skills.read({ skill: best });
  },
});
```

`select` takes a `task` (at most 2,000 characters) and answers `skills`: the few that apply, best first, each with its `scope` (`grasp` or `company`), `name`, `version` and `description`; none when no skill shares the task's telling words, and then go without rather than with one that only seems close. `read` takes a `skill` at a version, as a selection gave it, and answers its whole text, `SKILL.md`, at exactly that version: a newer version never changes what a task already selected, but a skill a release drops, or one that is erased, can no longer be read. A skill the company adapted takes the place of Grasp's of the same name. Anything else is refused as `permission.invalid_args`, and a skill there isn't at that version as `permission.item_not_found`.

Like a recall, an App reads only the skills everyone in the company may read, whoever calls, for a person who must still be a member, and an App that holds the Brain answers no visitor and invites no guest. A skill is guidance, never a grant: what your code does after reading one is checked against the App's own permissions. A workflow's step reaches the same skills as `ctx.brain.<alias>.skills.select` and `.read`.

## Memories and entities

The Brain keeps memories: small facts about entities (people, teams, customers, suppliers, projects, products, tools and the company's own terms). An action remembers a fact with `ctx.brain.remember`, forgets one it remembered with `ctx.brain.forget`, and corrects one with `ctx.brain.correct`. It reads an entity's card with `ctx.brain.entities.get`, and finds entities with `ctx.brain.entities.find`. Each is an operation of the Brain's permission, declared like `recall` (see the declaration above): `"remember"`, `"forget"`, `"correct"`, `"entities.get"` and `"entities.find"`.

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

`forget` takes a `memory` the App remembered and answers `true` once it is forgotten (again for one forgotten before), and `false` for any other: the App can't forget what someone else said. `correct` takes a `memory` everyone in the company may read, a `statement` and, for an attribute that holds one, its new `value`: the fix is read by exactly the readers of the memory it corrects. It stands beside that memory, the two contested, until a person confirms one: only a person's correction confirms. The memory itself stays. It answers the fix's `memory`, or `null` when there is no such memory the App may correct.

`entities.get` takes an `entity` and answers a page of its card, or `null` when there is no entity everyone in the company may see: its current memories by attribute (`attributes`), its `relations` to other entities, and its memories under no attribute (`notes`). Pass `asOf` (ISO 8601, with its offset) to read the past. While more follow, `next` is the `after` of the next page. `entities.find` takes a `kind`, a whole `name` or an exact `identifier`, and answers a page of `entities` (each its `id`, `kind` and earliest `name`) and its `next` the same way. In a workflow's run, what `entities.get` hands it is kept with the run, so it is checked again before anything leaves the run; what `entities.find` hands it (an entity's id, kind and name) is not. A memory on a card says what it is (`statement`, `attribute`, `value`), when the Brain learned it, whether a person or a correction confirmed it, and whether another current memory says otherwise (`contested`).

An App reads memories and entities only as everyone in the company may read them, whoever the call is for, and only for a person who is still a member: an App whose permission names teams reads no team's entities. Writing needs more. The App needs its own grant of the platform's `brain.write`, which an admin gives beside the grant to read the Brain. And what it writes is read by everyone, so it writes only while everything the App holds is the whole company's: it is live and shared with every member, every one of its tables is readable by all of them (`appMembers`, with no row rule narrowing it), and everyone may read everything it reads (an App granted a person's own connection, such as their mailbox, or whose permission names teams, writes nothing). The same holds for everything it reaches through its grants: every workflow it may start, follow or send events to, every App those may call, and on, each App shared with every member with its tables readable by all of them, and every source among them readable by everyone. What people type into such an App, and its own data, can then be written for everyone to read. A write refused for any of these answers `permission.unavailable`. A request that isn't one is refused as `permission.invalid_args`, and so is an ID of something the App may not read, the same as one nobody holds. A workflow's step reaches the same operations as `ctx.brain.<alias>.remember`, `.forget`, `.correct`, `.entities.get` and `.entities.find`. What a memory says is what someone wrote: data, never instructions.

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
