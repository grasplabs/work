---
title: Testing
description: An App's tests, run against the real host whenever a version is published, with vitest's expect.
sidebar:
  order: 6
---

An App's tests live in `tests/`, each suite a file named `*.test.ts`. Grasp runs every suite whenever a version of the App is published, and refuses the version while any test fails, naming each failing test and why. Nothing is mocked: each call a test makes runs through the same host as a Page's, on a store of the test's own that starts empty and is thrown away after it. No outside system is ever reached.

## A suite

A suite is the default export of `appTest`, over the App's schema. Each test acts as someone, with `t.withIdentity`, and asserts with `expect`, which tests import from `vitest`:

```ts tests/tasks.test.ts
import { appTest } from "@grasp-os/sdk/testing";
import { api } from "@server/_generated/api";
import { expect } from "vitest";

import schema from "../server/schema";

export default appTest(schema, {
  "a task added is listed until it's done": async (t) => {
    const ada = t.withIdentity({ name: "Ada" });
    const id = await ada.mutation(api.tasks.add, { title: "Call the bank" });
    const open = await ada.query(api.tasks.list, { done: false });
    expect(open).toMatchObject([{ _id: id, title: "Call the bank" }]);

    await ada.mutation(api.tasks.complete, { id });
    await expect(
      ada.query(api.tasks.list, { done: false })
    ).resolves.toStrictEqual([]);
  },
  "a task needs a title": async (t) => {
    const ada = t.withIdentity({ name: "Ada" });
    await expect(
      ada.mutation(api.tasks.add, { title: " " })
    ).rejects.toMatchObject({ code: "contract.invalid_args" });
  },
});
```

`t.withIdentity({ name, role, teams })` is someone with a role in the App: `user` unless you say `builder`, in the teams you name (by team ID, as a table's `team` rules match them). The same name in one test is the same person. They call the App's public functions through `api`, as a Page does, and the App's access rules hold for them as for anyone: what they may not read, they don't get. A call that fails rejects with the error a Page gets, so match its `code` with `rejects.toMatchObject`.

`expect` is vitest's own: `toBe`, `toEqual`, `toMatchObject`, `rejects` and the rest read as in any vitest test. Suites run in Grasp's sandbox, not under vitest's runner, so `test`, `describe` and `vi` aren't there: a suite's tests are the functions `appTest` is given, each run on its own, one after another.

## Seeding and inspecting data

`t.run` reads and writes the App's tables directly, with `ctx.db`, as one transaction. The App's access rules don't apply to it, so a test can set up what it needs and look at everything there is:

```ts tests/seeded.test.ts
import { appTest } from "@grasp-os/sdk/testing";
import { api } from "@server/_generated/api";
import { expect } from "vitest";

import schema from "../server/schema";

export default appTest(schema, {
  "done tasks aren't listed as open": async (t) => {
    await t.run(async (ctx) => {
      await ctx.db.insert("tasks", { title: "Filed", done: true });
    });
    const ada = t.withIdentity({ name: "Ada" });
    await expect(
      ada.query(api.tasks.list, { done: false })
    ).resolves.toStrictEqual([]);

    const all = await t.run(
      async (ctx) => await ctx.db.query("tasks").take(10)
    );
    expect(all).toHaveLength(1);
  },
});
```

What `t.run` inserts belongs to the test itself, nobody in the App; `ada.run(...)` inserts records that are Ada's. A `t.run` commits once its function returns, and commits nothing if it throws. Its writes are checked against the schema as any mutation's are.

## Workflow runs

An identity starts the workflows the App binds as a Page does, with `start`: a real run of the bound workflow's live version, on Grasp's workflow engine, with nothing of your organization's around it. What it would ask outside, the test answers in the start's options:

- `models`: what each of its model bindings answers, by alias. No model is ever asked, and a model call the test gives no answer fails the run (`workflow.test_unfixtured`).
- `params`: its parameter values. Any other takes its declared default, never the value your organization set.
- `deciders`: who may answer each of its decisions, by binding, as identities of the test. They answer with `respond`.

Its calls of the App's own functions run on the test's store. Calls of connections, the Brain and actions are refused.

`t.runs.untilTerminal(run)` waits for the run to end and says how: completed with its result, failed with the platform's code, or cancelled. `t.effects` says what its steps did: `completedCount(run, task)` counts a task's completed steps as the engine journaled them, and `modelRequestCount(run, task)` counts the model requests the test answered for it.

Tests can also break a run on purpose, and move its clock:

- `restartAfterStep: "<task>"` ends the run's execution right after that task's model call succeeds and is journaled, as if its process died. The engine replays the run from its journal, so the step isn't run again, and its model request isn't repeated. Only a task that calls a model takes one.
- `t.clock.advance(ms)` moves the time of the test's runs on: a sleep, a wait's timeout or a retry that comes due by then runs now, without waiting for it. A sleep counts from when the run reaches it, so wait for the run with `t.runs.untilWaiting(run)` first.

```ts tests/review.test.ts
import { appTest } from "@grasp-os/sdk/testing";
import { api, workflows } from "@server/_generated/api";
import { expect } from "vitest";

import schema from "../server/schema";

export default appTest(schema, {
  "a review survives a restart and asks the model once": async (t) => {
    const ada = t.withIdentity({ name: "Ada" });
    const task = await ada.mutation(api.tasks.add, { title: "Call the bank" });
    const run = await ada.start(
      workflows.review,
      { task },
      { models: { ai: { approved: true } }, restartAfterStep: "assess" }
    );
    // Past its day's wait before the reminder, then to its end.
    await t.runs.untilWaiting(run);
    await t.clock.advance(24 * 60 * 60 * 1000);
    await expect(t.runs.untilTerminal(run)).resolves.toStrictEqual({
      status: "completed",
      result: { approved: true },
    });
    await expect(t.effects.completedCount(run, "assess")).resolves.toBe(1);
    await expect(t.effects.modelRequestCount(run, "assess")).resolves.toBe(1);
  },
  "a review waits a day before it reminds": async (t) => {
    const ada = t.withIdentity({ name: "Ada" });
    const task = await ada.mutation(api.tasks.add, { title: "Call the bank" });
    const run = await ada.start(
      workflows.review,
      { task },
      {
        models: { ai: { approved: true } },
      }
    );
    await t.runs.untilWaiting(run);
    await t.clock.advance(24 * 60 * 60 * 1000);
    await expect(t.runs.untilTerminal(run)).resolves.toMatchObject({
      status: "completed",
    });
  },
});
```

The workflows an App's tests start are declared as for any start (see [Workflows](/guides/workflows)): here the App binds a `review` workflow whose task `assess` asks the model bound as `ai`, and which then waits a day before it reminds anyone.

```ts grasp.config.ts
import { defineApp, permission, v } from "@grasp-os/sdk";

export const permissions = {
  review: permission.workflow("review", {
    args: v.object({ task: v.id("tasks") }),
    returns: v.object({ approved: v.boolean() }),
  }),
};

export default defineApp({
  name: "Tasks",
  permissions: { workflows: [permissions.review] },
});
```

Each test may run 30 seconds, and starts at most 10 runs. A suite holds at most 100 tests, and an App at most 20 suites.
