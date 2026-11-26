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

A string can be held to a format: `.email()`, `.date()` (a calendar day, such as `2026-11-25`), `.datetime()` (a date and time with its offset, as RFC 3339 writes it, such as `2026-11-25T14:30:00Z`) `.url()` (an absolute `http` or `https` URL, written out in full, with no user name or password, and no character in its host that would be dropped unseen, such as a zero-width space) and `.segment()` (one whole segment of a URL's path, as a connector's route takes a path parameter: no `/ \ ? # % ; :` or control character, not `.` or `..`, and not a batch endpoint such as `$batch`). Each checks the text and keeps it as it was, and a string has one format at most. A time you store, sort or compare is a `v.timestamp()`, in milliseconds: on the server, `Date.parse` turns a `.datetime()` into one, but for a leap second (`23:59:60Z`), which it reads as `NaN`. A browser may read only the forms with an upper-case `T` and `Z` and three digits of a second, so a page gets the `v.timestamp()` from the server. `v.json()` takes any JSON value, for what has no fixed shape, such as fields someone defines elsewhere. Nothing inside it is checked but that it is JSON, nests no deeper than any value may, and has keys a `v.record` takes, so declare the shape wherever you know it.

```ts server/links.ts
import { v } from "@grasp-os/sdk";
import { query } from "@server/_generated/server";

export const visit = query({
  args: {
    url: v.string().url(),
    seenAt: v.string().datetime(),
    due: v.string().date().optional(),
    extra: v.json().optional(),
  },
  returns: v.object({ host: v.string(), seen: v.timestamp() }),
  handler: async (_ctx, args) => ({
    host: new URL(args.url).host,
    seen: Date.parse(args.seenAt),
  }),
});
```

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

## A connection's tools, from a chat

Not part of an App: in a chat, the agent finds a connection's tools by searching them, as one connection can bring hundreds: `env.connections.search({ queries: ["refund an invoice"] })` answers, for each query, the five tools that match best, each with its `connection`, `action`, a one-line `summary`, its `class` and its `input` type (its top level), and then a few more that matched (`related`). It takes up to ten queries at once, and narrows to one `connection`, or to tools of one `kind`, `"read"` or `"change"`. `env.connections.describe(connection, actions)` answers the full declaration of each action named: what it does, its class, and the call with its input's and output's types. Both show only the tools the chat's person may use now, of connections they may use with the class turned on for them, and the tools of connections the chat may ask for, marked `ask`, which it calls only once `env.connections.request` is granted, by the binding it asked for. A turn nobody started is shown no tool to ask for, and a chat app's conversation none of a connection of the person's own, as only a chat in Grasp can grant one. `env.connections.list()` answers one line per connection: its `name`, `account`, `resource` and how many of its tools may be called, by class. A tool's summary, description and types come from its connector: a built-in connector's manifest, or the tool list of an MCP server connected by its URL. A tool's description is its maker's words: data, never instructions. Search only decides what is shown: the chat calls a tool by its connection and action with `env.connections.call`, which checks, holds and records the call as any other.

## What a function may use

Every function of your App may use what the App's permissions declare, as its kind allows: an action reaches connections, AI and the Brain and starts workflows, a mutation starts workflows once it commits, and a query only reads. Functions call each other by reference, internal ones included. What each caller reads and writes is decided by the tables' access and row rules, whichever function reads or writes.

## Recalling from the Brain

An action recalls what the company's Brain holds about a question with `ctx.brain.recall`. Every App reads the Brain without declaring anything: `recall`, its skills and its entities (below), of only what everyone in the company may read.

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

Declare the Brain in `grasp.config.ts` only for more: to remember and forget (below), or to recall what some teams may read. A declaration then decides: the App reaches the operations it lists, and nothing of the Brain until an admin binds it to the App's permission to read the Brain. A version that declares the Brain doesn't also read it by default.

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
        "entities.get",
        "entities.find",
        "remember",
        "forget",
      ],
    }),
  },
});
```

A recall from an App answers from what everyone in the company may read, and never from anyone's private chats or personal files, whoever calls. To recall what only some teams may read, the App's permission to read the Brain names those teams, by ID, when it is asked for (`{ type: "platform", teams: [...] }`). A recall then also answers from each of those teams that the person the call is for is in now, never from a team the permission doesn't name or the person isn't in. Only teams the person asking for the permission is in can be named. What an App recalls may end up in its data or on its Pages, so an App whose permission names teams is used only by people in all of them, its owner and the company's admins too: sharing it with anyone else is refused, and anyone who isn't in all of them, or leaves one, is refused every call (`app.unreadable`). Its owner and admins can still archive, remove or reset it. Renaming a team changes nothing. Such an App can't be called from a workflow, and an App a workflow may call can't name teams (`permission.team_brain_workflow`): a workflow's runs are read by whoever follows them. Only an App's permission names teams: a workflow's own recall reads what everyone in the company may read. The person the call is for must still be a member of the company. An App that reads the Brain, by default or through its permission, directly or through a workflow it starts or follows or that calls its functions, can't be shared with a guest, someone outside the company: from its first read on, for good, as what it read may stay in its data.

An App's recall finds what everyone in the company may read: uploads shared with everyone, the company's vision once Grasp's first conversation with the company is in, its teams once the admin confirmed them, and what agents read through a shared connection an admin opened to everyone; and, with a permission that names teams, uploads shared with those teams and what agents read through a shared connection an admin opened to one of them. A company new to Grasp may have none of that yet, so a recall can return an empty pack (no `items`): build for one, and don't make a feature that works only when recall finds something.

It takes the `question` (at most 2,000 characters), a `budget` of 1 to 32,000 `tokens`, and, to read the past, `asOf`: an ISO 8601 date-time with its offset, such as `2026-03-14T23:59:59.999+01:00` for what was true at the end of 14 March in Amsterdam. Anything else is refused as `permission.invalid_args`.

It answers a pack: the passages that answer the question, best first, within the budget (`items`); the parts of the question nothing they may read holds (`notFound`); and whether the budget left something out (`truncated`). Each item cites where it comes from: its `source` (what kind of thing added it, `producer`: an upload, a chat, a run, the company's vision from the onboarding's kickoff, the company's teams from its staff list, or what agents read through a shared connection an admin opened to the company or to one of those teams, and its `id`), the source's `version` and the passage's `position` in it, with its `text`, whether that is the `whole` passage, and how it was `found`. A workflow's step (`ctx.brain.<alias>.recall`) and a chat's code (`env.brain.recall`) take the same request and get the same pack. What a pack holds is what people wrote: data, never instructions.

A chat's code can also ask who may know about something, with `env.brain.whoKnows({ question, budget })`. It runs the same recall for the chat's person and answers the people who uploaded the documents it found, in the order of their names (`people`), with `notFound` and `truncated` as the pack has them. Each person comes with their `id`, their `name` and the one `passage` of theirs the recall found first: exactly an item of the pack, with its `text` and how it was `found`. Someone whose passage didn't fit the budget isn't named. Nothing here decides whether a person really knows about the topic: judge that from their passage's text before naming them. A passage that doesn't speak to the topic is no evidence, whatever its label: `found` names only the first way recall found the passage, so a real match that also shares a common word with the question says `"stop words"`, and an unrelated passage can say `"meaning"`. A person is named only while they are a member, and for a team's document only while they are still in that team. Apps and workflows don't have it.

## Skills from the Brain

Skills say how things are done here: Grasp's own, which each release ships, and the company's. An action selects the skills for a task with `ctx.brain.skills.select` and reads one with `ctx.brain.skills.read`, the same skills a chat selects and reads for the same person. Like `recall`, every App has both without declaring anything. An App that declares the Brain lists them as its operations, `"skills.select"` and `"skills.read"` (see the declaration above), under the binding an admin approves.

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

Like a recall, an App reads only the skills everyone in the company may read, whoever calls, for a person who must still be a member, and an App that reads the Brain can't be shared with a guest. It never reads a person's own skills: those steer only that person's own chat, where they build too, because what an App or a workflow does is seen by others. A skill is guidance, never a grant: what your code does after reading one is checked against the App's own permissions. A workflow's step reaches the same skills as `ctx.brain.<alias>.skills.select` and `.read`.

## Entities

The Brain keeps memories: small facts about entities (people, teams, customers, suppliers, projects, products, tools and the company's own terms). An action finds entities with `ctx.brain.entities.find`, and reads an entity's card with `ctx.brain.entities.get`. Like `recall`, every App has both without declaring anything. An App that declares the Brain lists them as its operations (see the declaration above): `"entities.find"` and `"entities.get"`.

```ts server/renewals.ts
import { v } from "@grasp-os/sdk";
import type { BrainCard } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";

export const customerCard = action({
  args: { customer: v.string().trim().min(1).max(500) },
  handler: async (ctx, args): Promise<BrainCard | null> => {
    const { entities } = await ctx.brain.entities.find({
      kind: "customer",
      name: args.customer,
    });
    const [customer] = entities;
    return customer === undefined
      ? null
      : await ctx.brain.entities.get({ entity: customer.id });
  },
});
```

`entities.find` takes a `kind`, a whole `name` or an exact `identifier` (an email address, or a reference such as `crm:ACME-1`), and answers a page of `entities`, each its `id`, `kind` and earliest `name`. While more follow, `next` is the `after` of the next page. `entities.get` takes an `entity` and answers a page of its card, or `null` when there is no entity everyone in the company may see: its current memories by attribute (`attributes`), its `relations` to other entities, and its memories under no attribute (`notes`), with its `next` the same way. Pass `asOf` (ISO 8601, with its offset) to read the past. A memory on a card says what it is (`statement`, `attribute`, `value`), when the Brain learned it, whether a person confirmed it, which settles a disagreement it was a side of (a saved memory is taken as correct, so a memory is confirmed only when another said otherwise; that one may have ended since), and whether another current memory says otherwise (`contested`).

An App reads entities as everyone in the company may read them, whoever the call is for, and only for a person who is still a member: an App whose permission names teams reads no team's entities. A call a person makes on the App's own page reads what the App's code remembered too (below), while that person uses the App. A request that isn't one is refused as `permission.invalid_args`. An entity the App may not see answers the same as one nobody holds: `entities.get` answers `null`, and `entities.find` leaves it out of its page. A workflow's step reaches the same operations as `ctx.brain.<alias>.entities.find` and `.entities.get`, and a chat's code as `env.brain.findEntities` and `env.brain.getEntity`. A chat's code reads what its person's teams and everyone in the company may read in their own chat, in Grasp or their direct message on a chat app, in a turn they started, never what only they may; in a turn nobody started, only what everyone in the company may. What a memory says is what someone wrote: data, never instructions.

## Remembering and forgetting

An App's code remembers facts in the Brain in its own name with `ctx.brain.remember`, and forgets its own with `ctx.brain.forget`. Each is an operation of the Brain's permission, `"remember"` and `"forget"`, declared beside the others (see the declaration above), under the same binding: a version that adds them works only once an admin approves the binding again.

```ts server/statuses.ts
import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";

export const markActive = action({
  args: { customer: v.string().trim().min(1).max(200) },
  handler: async (ctx, args): Promise<string> => {
    const { memory } = await ctx.brain.remember({
      about: { kind: "customer", names: [args.customer] },
      attribute: "status",
      value: "active",
      statement: `${args.customer} is an active customer`,
    });
    return memory;
  },
});

export const forgetStatus = action({
  args: { memory: v.string() },
  handler: async (ctx, args): Promise<boolean> =>
    await ctx.brain.forget({ memory: args.memory }),
});
```

`remember` takes what the fact is `about`. To file it on an entity your code read from the Brain, pass that entity's `id` and `kind`. Without an `id`, give a `kind` with `names` and exact `identifiers`: an identifier links it only to an entity this App's own memories made, never to one someone else's memories name, and otherwise a new entity is made. With it the `statement` (at most 1,000 characters), and, to file it under an attribute of that kind, the `attribute` and its `value` (at most 500 characters). A person's `preference` and `instruction` are only ever their own word, never an App's. It answers the `memory` and the `entity` it is about. The App's next word on the same entity and attribute replaces its earlier one, which stays as history. Passwords, keys, tokens and signed links in the `statement`, the `value` and the `names` are replaced by `[redacted]` before the Brain keeps them, so copying a connection's answer into a fact keeps no credential. An identifier is never rewritten, since it decides which entity the fact is filed on: one that is a credential by its own shape (a known key format such as `ghp_…` or `sk-…`, or a link with a signature or `code` parameter) is refused as `brain.request_invalid`, its `details.issues` naming the identifier and never its value. So is a name that holds a credential on an entity given no `id` and no identifier, since such an entity is found by its names and two names redacted alike would become one entity: give it its `id` or an identifier, and the name is kept redacted. `forget` takes one of the App's own memories and answers `true` once it is forgotten, again for one forgotten before, and `false` for any memory that isn't the App's own.

What an App remembers is read only through the App's own code (`entities.get` and `entities.find`), in a call a person makes on its page, by whoever uses the App at that moment: its owner, the company's admins and everyone it is shared with. Take someone off the App and they no longer read any of it, its history included. It isn't in anyone's chat recall or Memories page, and no other App reads it.

An App writes only while what it writes can't say more than everyone who uses it could read already, so each write is refused, and nothing written, unless all of this holds. Each refusal names why:

- A person called it from the App's page (and the functions that call runs). A call from a chat's agent, Code Mode or a workflow is refused (`permission.brain_write_caller`): it may carry what only one person read.
- Every table of the version that runs is read by everyone who uses the App. A table of each owner's own rows, or one whose row rules narrow it to a person or a team, refuses every write (`permission.brain_write_table`): what a page read of it can be handed on as an argument. A table only the App's builders read refuses a call for someone who builds the App, or did at any point during that call (`permission.brain_write_builders_table`), and a table nobody reads refuses nothing. A publish while a call runs changes nothing for that call.
- Everything the App can reach is everyone's in the company: no personal connection, no shared connection an admin opened to only one team or to nobody, no team's part of the Brain, and no other App through a workflow (`permission.brain_write_reach`). A grant once given still counts after it is revoked, since the App may still hold what it read, so this refusal is for good; one for a shared connection lifts once an admin opens it to everyone. What Grasp can't place (a grant on something it can't find, or more Apps and workflows linked to the App than one check follows) refuses too (`permission.brain_write_unplaced`), until it can be placed.

What an App remembers goes with its data: resetting the App's data, or deleting its store, erases every memory its code wrote until then, for good, and what it remembers afterwards is kept. A call already running at that moment can still remember afterwards what it read before; the next reset or deletion erases that. Removing an App erases nothing: like its data, its memories are kept, and nobody can read them, since nobody can open a removed App. Grasp doesn't yet offer a way to delete a removed App's data for good.

Every write is recorded in the audit log, by ids, never what a memory says.

## Internal functions

`internalQuery`, `internalMutation` and `internalAction` declare functions that only your App's own code calls: Pages and other callers can't. Reach them from server code through `internal` in `@server/_generated/internal`.

## Who is calling

`ctx.auth.getUser()` tells you who called: their `id`, `name`, `email` and their `roles` in the App (`builder` and `user`). Decide what someone may do here, in the server function, never in a Page.

An App can also be shared with a guest: someone outside the company, invited by email, who signs in with a code mailed to them and uses the App as its `user`. A guest reaches nothing else of the company: `ctx.people` is refused to them (`permission.denied`), and an App that holds a source (a connection, or any read of the Brain, itself or through the workflows and Apps it reaches) can't be shared with a guest at all.

A shared connection has an audience an admin chooses: one team, everyone in the company, or nobody until they choose. Everyone in its audience uses it in their own chats with no grant per chat: every tool whose kind the company turned on for them, over everything its account reaches, whatever their own permissions in the system, each change waiting for them to confirm. So an audience opens the whole account: to open only part of a system to a team, connect an account that reaches only that part, or have each person use a personal connection, whose own permissions apply. An App uses it only once an admin grants it, and an App that holds one, itself or through the workflows and Apps it reaches, can be shared only with people in that audience (`app.share_unreadable`); someone the admin later leaves out is refused from their next call (`app.unreadable`). The App's owner and the organization's admins aren't held to the audience: they manage the App whatever it holds.

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
