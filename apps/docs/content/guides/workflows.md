---
title: Workflows
description: Work that runs on its own, for minutes or for weeks, which an App starts and follows.
sidebar:
  order: 5
---

Anything that runs on its own is a workflow: steps that call models and connected apps, wait for an hour or for someone's decision, and pick up where they left off after any failure. A workflow is built in Grasp, by asking for it in a chat or on its canvas, and runs in Grasp's workflow engine; an admin decides which models and connections it may use.

An App doesn't contain workflows. It starts them, and follows their runs. This guide shows how.

## Declaring the workflows an App starts

An App declares each workflow it starts as a permission in its definition, with `addPermission`: an alias, the `args` a run starts with and what it `returns`, in `v`'s words, as a function declares them. Like every permission, it grants nothing yet. The App's builders bind the alias to a version of a workflow, and an admin grants the App permission to start it. Until both, every start fails.

Grasp generates the permission into `grasp.config.ts`, which exports it as `permissions.<alias>`:

```ts grasp.config.ts
import { defineApp, permission, v } from "@grasp-os/sdk";

export const permissions = {
  review: permission.workflow("review", {
    args: v.object({ task: v.id("tasks") }),
    returns: v.object({ approved: v.boolean() }),
    events: {
      edited: {
        type: "tasks.task.edited",
        data: v.object({ task: v.id("tasks") }),
      },
    },
    listens: { "do/1/awaitEdit": ["edited"] },
    decisions: {
      approve: {
        value: v.object({ comment: v.string() }),
        context: v.object({ title: v.string() }),
      },
    },
  }),
};

export default defineApp({
  name: "Tasks",
  permissions: { workflows: [permissions.review] },
});
```

A workflow that waits for events from the App, or asks people to decide, declares them too: the `events` its Pages and mutations send (each event's `type` and `data`), the `listens` tasks waiting on them, and the `decisions` people answer (each one's `value` and the `context` they review). They are the contract the App relies on, and what `workflows.<alias>` in `@server/_generated/api` names and types. Binding the workflow in the draft writes them in from the version you bind, with the `bindWorkflow` definition tool, as `review` above declares them.

A version whose events, decisions or listen tasks differ from what the App's current version declares can't be bound directly. Bind it in the App's draft, which declares the new contract, and publish the App: the version is bound as that App version becomes current, and bound again to whatever an older App version bound if you roll back to it.

Then any of the App's actions and mutations can start it:

```ts server/reviews.ts
import { v } from "@grasp-os/sdk";
import { action, mutation } from "@server/_generated/server";

export const finish = mutation({
  args: { id: v.id("tasks") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("tasks", args.id, { done: true });
    await ctx.workflows.review.start({ task: args.id });
    return null;
  },
});

export const reviewNow = action({
  args: { id: v.id("tasks") },
  returns: v.string(),
  handler: async (ctx, args) => {
    const run = await ctx.workflows.review.start({ task: args.id });
    return run.runId;
  },
});
```

## Starting a run

A function starts one of the App's workflows by its alias:

A mutation and an action both start it with `ctx.workflows.<alias>.start(args)`:

- In a mutation, the start happens only once the mutation's writes commit. If the mutation fails, nothing starts. `finish` above saves the task and starts its review as one change.
- In an action, the start happens right away. It resolves once Grasp has accepted the start, durably: with its `startId`, the workflow `version` it started and the `runId` of its run. The run goes on after the action returns; a Page follows it by that ID.

Grasp checks every start's args against the workflow's, so a start the workflow can't take fails at once.

## Following a run from a Page

`useWorkflow` starts and follows a run from a Page. It shows the run of its latest start, or the run you give it by ID, and updates as the run goes on:

```tsx src/routes/index.tsx
import { useQuery, useWorkflow } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { api, workflows } from "@server/_generated/api";
import { createFileRoute } from "@tanstack/react-router";

const Tasks = () => {
  const tasks = useQuery(api.tasks.list, { done: true });
  const review = useWorkflow(workflows.review);
  if (tasks === undefined) {
    return <Spinner className="m-6" />;
  }
  return (
    <main className="flex flex-col gap-3 p-6">
      {tasks.map((task) => (
        <Button
          key={task._id}
          disabled={!review.canStart}
          onClick={async () => await review.start({ task: task._id })}
        >
          Review {task.title}
        </Button>
      ))}
      {review.status === "completed" && (
        <p>{review.result.approved ? "Approved" : "Not approved"}</p>
      )}
      {review.status === "failed" && <p>{review.error.message}</p>}
    </main>
  );
};

export const Route = createFileRoute("/")({ component: Tasks });
```

Before its first start, `useWorkflow` is `idle`, and `loading` while the run you gave it by ID loads. A run is `queued`, `running`, `waiting` (for time, an event or a decision) or `paused`; `compensating` while it undoes its work after a failure or a cancellation; and it ends `completed` with its `result`, `failed` with its error, or `cancelled`. A run the person may no longer see, such as one whose decision someone else answered, is `unavailable`.

`pause`, `resume` and `cancel` control the run, for whoever may. `send` sends it an event its workflow declares, typed by that event: `review.send(workflows.review.events.<name>, data)`. A mutation sends one the same way, with `ctx.sendEvent(workflows.review.events.<name>, { runId, data })`. To answer a decision the run waits for, make its form with `useForm(workflows.review.decisions.<name>, { defaultValues: { approved: false, value }, onSubmit })` and pass what it submits to `review.respond(wait, answer)`.

`useWorkflow` is built on the workflow reference's own queries and mutations, which a Page can also use directly: `useQuery(workflows.review.queries.run, { runId })` follows one run (`null` for a run the person may not see), `useQuery(workflows.review.queries.canStart)` says whether they may start one, and `useMutation(workflows.review.mutations.start)` starts one with `{ args }`. `mutations.pause`, `.resume` and `.cancel` take `{ runId }`, and `mutations.send` takes `{ runId, event, data }`, the event by its name. `queries.runs` lists the person's runs, and `queries.history` one run's history.

## Events from outside

An outside system, such as a payment provider or a shop, sends events into Grasp through a webhook source. An admin creates one per sender in Settings › Webhooks, and gives the sender its URL and secret. The sender POSTs each event as JSON, with its type and its data, signed with the secret as [Standard Webhooks](https://www.standardwebhooks.com) describes:

```json
{ "type": "payment.paid", "data": { "invoice": "INV-42", "amount": 120 } }
```

Grasp checks the signature, refuses a delivery more than five minutes old or larger than 64 KiB, and takes a retry with the same `webhook-id` as the same event. A provider that signs its webhooks its own way comes in through its connector instead.

A workflow starts on a source's events from its Triggers tab: a webhook trigger names the source and the event type, and each such event's `data` is the run's `args`, checked against the workflow's. It starts nothing until an admin allows it. App code never handles the request itself: a workflow started this way calls the App's mutations through its permission.

### Waiting for a webhook event

A workflow can also wait for an event about its own run, such as the payment for the invoice it just sent. Its `events` permission's contract takes the event's type from a webhook source (`ingress: "webhook"`), and an admin names the source as they approve the permission. The wait says which event is the run's own with `match`: a field of the event's data, as a JSON Pointer, and the value it must have.

```json
{
  "id": "paid",
  "type": "waitForEvent",
  "events": "payments",
  "eventType": "payment.paid",
  "match": {
    "field": "/invoice",
    "equals": { "$expr": "send.invoice" }
  },
  "timeout": "5 days"
}
```

Grasp works the value out as the wait is reached, and hands the run only the event whose data has it. A source's events are kept for a day, so a run that starts waiting after its event came still gets it; each run whose wait matches an event gets it once. A wait on a source's type always names its `match`, so no run takes another's event. Approving the permission lets the workflow receive any event the source sends of the types its contract takes.

## What a workflow is made of

A workflow is saved as JSON in the `grasp-workflow/2` format, which the canvas draws and the chat edits. It uses the same words as an App: the run's `args` and what it `returns` (with its `result`), its `params`, and the `permissions` it needs, by kind (`ai`, `apps`, `connections`, `decisions`, `events`, `files`, `brain`), each of which an admin approves. Its steps are `call` (a connection's action, an App's function, the run's own files, or a recall of the Brain), `generate` (an answer from the workflow's model), `decide` (a person's decision), `waitForEvent`, `wait`, `forEach`, `if`, `try` and `raise`.

A value a step passes may be an expression in JavaScript, `{ "$expr": "invoice.total > params.limit" }`. It reads the run's `args`, `params`, `state` and `run` (`run.id`, and `run.startedAt`, when the run started in milliseconds since the epoch, so a scheduled run finds its week without a clock), and each earlier step's result by the step's ID. Expressions only read: they can't reach an object's prototype (`constructor`, `prototype`, `__proto__`), use a computed name such as `lines[index]`, or call anything but the methods of strings, numbers and lists, and `JSON.stringify(value)` and `JSON.parse(text)` to write and read JSON text, such as an HTTP request's body.

From the JSON, Grasp generates the TypeScript that runs, which reads like an App's code:

```text
export default defineWorkflow({
  args: v.object({ email: v.string(), total: v.number() }),
  returns: v.object({ sent: v.boolean() }),
  permissions: { connections: { mail: { send: "mail.send" } } },
  handler: async (ctx, args) => {
    if (args.total > 1000) {
      throw new AppError("billing.too_large", "The invoice is over the limit.");
    }
    const send = await ctx.connections.mail.send(
      { to: args.email, subject: "Your invoice" },
      { step: "send" }
    );
    return { sent: send.sent };
  },
});
```

A `call` step reaches the run's own files through a `files` permission: `read` (a text, CSV, Markdown or JSON file of up to 512 KB, whole), `write` (a text file, from its name, type and text), `list` and `delete`, as `ctx.files.<alias>.read(…)`. A run's files are its own: a file is named by its ID, and that ID finds nothing in any other run. A `call` step recalls from the Brain through a `brain` permission: `recall`, with a `question`, a `budget` of `tokens` and, to read the past, `asOf`, as `ctx.brain.<alias>.recall(…)`. It takes the same request and answers the same pack as an App's `ctx.brain.recall` (see [Server functions](/guides/server-functions)), with only what everyone in the company may read, whoever the run acts for (who started it, or the workflow's owner for a run a trigger or schedule started): never what only some teams may read, so what a run passes on, to an App, a decision or its result, holds nothing a member of the company couldn't read where it comes from. A connection's action that answers a file, such as an email's attachment, can keep it in the run's files with `into`, and one that sends files can attach the run's files with `from`, each naming a files permission:

```json
{
  "id": "invoice",
  "type": "call",
  "connection": "mail",
  "action": "mail.readAttachment",
  "args": {
    "message": { "$expr": "args.message" },
    "attachment": { "$expr": "args.attachment" }
  },
  "into": "runFiles"
}
```

Its result names the kept file (`invoice.file`) in place of its content, which a later step reads (`{ "files": "runFiles", "action": "read", "args": { "file": { "$expr": "invoice.file.file" } } }`) or attaches.

Each `ctx` call is a durable step: its result is recorded, and a run that picks up again after a failure gets it back rather than calling again. `{ step: "send" }` names the canvas step it belongs to. A step fails with an error that has a `code`, such as `connect.rate_limited`, a `message` and sometimes `details`; a `try` step's `catch` takes errors by `code`, and a `raise` step fails the run with an error of the workflow's own, in its own namespace (`billing.too_large`), never the platform's.

### Calling an App's functions

A workflow can call an App's queries and mutations, never its actions. Its `apps` permission names the App by its ID, and each function by the ID the App's definition gives it, with the function's path as a readable hint:

```json
{
  "permissions": {
    "apps": {
      "notes": {
        "app": "<App ID>",
        "functions": { "<function ID>": "notes.create" }
      }
    }
  },
  "steps": [
    {
      "id": "made",
      "type": "call",
      "app": "notes",
      "function": "<function ID>",
      "args": { "title": { "$expr": "args.title" } }
    }
  ]
}
```

The generated code calls it as `ctx.apps.notes.notes.create({ title: args.title }, { step: "made" })`, named by the path in its `functions` hint, which Grasp updates to the function's current path each time the draft is saved. The call itself goes by the function's ID, so renaming the function in the App never breaks the workflow, and a run already under way keeps calling the same function. A run calls a function only once an admin has granted the workflow `call` on exactly that function, and it acts as the run's person, within the App's roles and row rules. Publishing refuses a function the App no longer offers, and a run calling one that was removed since, or whose grant was revoked, fails that step (`workflow.app_function_unavailable`, `workflow.call_denied`). A test run answers an App call from its fixtures, under `<alias>/<function ID>`, and never reaches the App.
