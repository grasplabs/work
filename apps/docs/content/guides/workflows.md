---
title: Workflows
description: Work that runs on its own, for minutes or for weeks, which an App starts and follows.
sidebar:
  order: 5
---

Anything that runs on its own is a workflow: steps that call models and connected apps, wait for an hour or for someone's decision, and pick up where they left off after any failure. A workflow is built in Grasp, by asking for it in a chat or on its canvas, and runs in Grasp's workflow engine; an admin decides which models and connections it may use.

An App doesn't contain workflows. It starts them, and follows their runs. This guide shows how.

## Declaring the workflows an App starts

An App declares each workflow it starts with `permission.workflow`: an alias, and the input and output it expects. Like every permission, it grants nothing yet: an admin binds the alias to a workflow and approves the App's starts. Until then, every start fails.

```ts server/reviews.ts
import { permission, v } from "@grasp-os/sdk";
import { action, mutation } from "@server/_generated/server";

export const review = permission.workflow("review", {
  input: v.object({ task: v.id("tasks") }),
  output: v.object({ approved: v.boolean() }),
});

export const finish = mutation({
  args: { id: v.id("tasks"), expectedRevision: v.number().integer().min(1) },
  returns: v.null(),
  uses: [review],
  handler: async (ctx, args) => {
    await ctx.db.patch(
      "tasks",
      args.id,
      { done: true },
      { expectedRevision: args.expectedRevision }
    );
    await ctx.afterCommit.workflows.review.start({ task: args.id });
    return null;
  },
});

export const reviewNow = action({
  args: { id: v.id("tasks") },
  returns: v.string().nullable(),
  uses: [review],
  handler: async (ctx, args) => {
    const run = await ctx.workflows.review.start({ task: args.id });
    return run.runId;
  },
});
```

List the permission in `app.ts`:

```ts app.ts
import { app } from "@grasp-os/sdk";

import schema from "./schema.ts";
import { review } from "./server/reviews.ts";

export default app({
  name: "Tasks",
  schema,
  access: {
    tables: { tasks: { read: "appMembers", write: "appMembers" } },
  },
  screens: [{ name: "tasks", path: "/", source: "screens/tasks.tsx" }],
  permissions: { workflows: [review] },
});
```

## Starting a run

A function starts a workflow its `uses` lists:

- A mutation starts it with `ctx.afterCommit.workflows.<alias>.start(input)`, which happens only once the mutation's writes commit. If the mutation fails, nothing starts. `finish` above saves the task and starts its review as one change.
- An action starts it with `ctx.workflows.<alias>.start(input)`, which resolves once Grasp has accepted the start, durably: with its `startId`, the workflow `version` it started and the `runId` of its run. The run goes on after the action returns; a Page follows it by that ID.

Grasp checks every start's input against the workflow's, so a start the workflow can't take fails at once.

## Following a run from a Page

`useWorkflow` starts and follows a run from a Page. It shows the run of its latest start, or the run you give it by ID, and updates as the run goes on:

```tsx screens/tasks.tsx
import { useQuery, useWorkflow } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import { api, workflows } from "@server/_generated/api";

const Tasks = () => {
  const tasks = useQuery(api.tasks.list, { done: true });
  const review = useWorkflow(workflows.review);
  if (tasks === undefined) {
    return <output>Loading tasks…</output>;
  }
  return (
    <main className="flex flex-col gap-3 p-6">
      {tasks.map((task) => (
        <Button
          key={task._id}
          disabled={!review.canRun}
          onClick={async () => await review.run({ task: task._id })}
        >
          Review {task.title}
        </Button>
      ))}
      {review.status === "completed" && (
        <p>{review.output.approved ? "Approved" : "Not approved"}</p>
      )}
      {review.status === "failed" && <p>{review.error.message}</p>}
    </main>
  );
};

export default Tasks;
```

A run is `queued`, `running`, `waiting` (for time, an event or a decision) or `paused`, and ends `completed` with its output, `failed` with its error, or `cancelled`. `pause`, `resume` and `cancel` control it, for whoever may.
