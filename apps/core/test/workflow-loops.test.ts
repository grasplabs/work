/* oxlint-disable no-template-curly-in-string, unicorn/no-thenable -- workflow expressions are written as ${ … } strings, and transitions as then */
import type { Role } from "@grasp-os/shared/roles";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import type { Acting } from "../src/auth/identity.ts";
import { loadWorkflowBuild } from "../src/workflow-builds.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  workflowSource,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import type { Settled } from "../src/workflows/code.ts";
import { runObjectOf } from "../src/workflows/engine.ts";
import type { RunStep } from "../src/workflows/host.ts";
import { ResourceRunHost } from "../src/workflows/resource-host.ts";
import { resourceRunTrace } from "../src/workflows/resource-run-trace.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { withCpuKills } from "./cpu-kills.ts";
import { admittedFreely } from "./runs.ts";
import { unique } from "./sign-in.ts";

// Sequential `for` loops of JSON workflows (GRA-276; @grasp-os/open-workflow's
// generate.ts, the SDK's open-workflow.ts and core's resource-host.ts), from
// their threat model: a loop runs over the items its enter step recorded and
// no others, so a replay runs the same items and a forged module can't add
// one; each item's steps are its own (`task:<id>@<for>.<index>`), so an
// item's effect is keyed apart from another's and runs once; `while` ends
// the items before any effect of the next; context carries from one item to
// the next; `exit` ends an item and `end` the workflow; a collection past
// the platform's 1,000 items fails the run before any item runs; items'
// keys (`metadata.grasp.key`) are made once, on the recorded items, and
// keys that don't tell every item apart fail the run before any item runs;
// and generated code still has no loop statement.

/** A builder of the organization, as their session has them. */
const builder = async (role: Role = "builder"): Promise<Acting> => {
  const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES ('organization', 'Acme', 'acme', ?)"
    ).bind(Date.now()),
    env.DB.prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
    ).bind(userId, "Person", `${userId}@acme.test`, Date.now(), Date.now()),
    env.DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, ?, ?)"
    ).bind(crypto.randomUUID(), userId, role, Date.now()),
  ]);
  return { userId, role, teams: [], staff: false };
};

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** A definition of `name` running `tasks`: input `{ who }`, output `{ status }`. */
const definitionOf = (name: string, tasks: unknown[]): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "1.0.0",
      title: name,
      metadata: {
        grasp: { profile: "grasp-open-workflow/1", params: {}, bindings: {} },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: tasks,
  });

/** A workflow of `by`'s, published once with `tasks`. */
const published = async (by: Acting, tasks: unknown[]) => {
  const workflow = await createWorkflowResource(env, by, `loop-${unique()}`);
  const version = await publishWorkflowVersion(env, by, workflow.id, {
    definition: definitionOf(workflow.name, tasks),
    basedOn: null,
  });
  return { workflow, version };
};

/** Starts version 1 of workflow `id` for `by`, and waits for its end. */
const ranFor = async (by: Acting, id: string): Promise<WorkflowResourceRun> => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    id,
    { version: 1, input: { who: "Ada" }, key: unique() }
  );
  expect(runId).not.toBeNull();
  return await vi.waitFor(
    async () => {
      const run = await resourceRunFor(env, by, id, runId);
      expect(run.endedAt).not.toBeNull();
      return run;
    },
    { timeout: 30_000, interval: 100 }
  );
};

/** What a run ended with: its status, and its output or error code. */
const endOf = (run: WorkflowResourceRun) => ({
  status: run.status,
  ...(run.status === "completed"
    ? { output: run.output }
    : { code: run.error?.code }),
});

/** How many times run `runId`'s journal completed each step, by name. */
const completedSteps = async (runId: string): Promise<Map<string, number>> => {
  const page = await runObjectOf(env, runId).history({ after: 0, limit: 500 });
  const completed = new Map<string, number>();
  for (const record of page?.records ?? []) {
    const step = record.unreadable ? null : record.step;
    if (
      step !== null &&
      !record.unreadable &&
      record.type === "step_completed"
    ) {
      completed.set(step.name, (completed.get(step.name) ?? 0) + 1);
    }
  }
  return completed;
};

/** What step `name` of run `runId` recorded, as its journal keeps it. */
const recordedText = async (runId: string, name: string): Promise<string> =>
  await runInDurableObject(runObjectOf(env, runId), (_object, state) => {
    const [row] = state.storage.sql
      .exec<{ value: string | null }>(
        "SELECT value FROM steps WHERE name = ? AND state = 'succeeded'",
        name
      )
      .toArray();
    return row?.value ?? "";
  });

/** Ends the list with a status of the context's `field`, as text. */
const statusOf = (field: string) => ({
  finished: { set: `\${ {status: ($context.${field} | tostring)} }` },
});

/** Starts the context with `value`. */
const initially = (value: string) => ({
  init: { set: "${ . }", export: { as: value } },
});

/** A switch that leaves an item at `item`, by `then`, else goes on to add. */
const gate = (item: number, then: string) => ({
  gate: {
    switch: [
      { stop: { when: `\${ $item == ${item} }`, then } },
      { go: { then: "add" } },
    ],
  },
});

/** Run `runId`'s lineage's host calls, as core's database has them. */
const hostCallsOf = async (runId: string): Promise<number | undefined> => {
  const row = await env.DB.prepare(
    "SELECT host_calls AS hostCalls FROM run_lineages WHERE root_run_id = ?"
  )
    .bind(runId)
    .first<{ hostCalls: number }>();
  return row?.hostCalls;
};

/** An ID of `length` characters, of its own letter. */
const longId = (letter: string, length = 60): string =>
  `${letter}${"x".repeat(length - 1)}`;

/**
 * Three loops of long IDs, one inside another, around a task: the first
 * two's step names fit what the engine takes, the third's don't, so it is
 * refused (and the task in it with it).
 */
const longNamed = (): unknown => ({
  [longId("a")]: {
    for: { each: "a", at: "ia", in: "${ [1] }" },
    do: [
      {
        [longId("b")]: {
          for: { each: "b", at: "ib", in: "${ [1] }" },
          do: [
            {
              [longId("c")]: {
                for: { each: "c", at: "ic", in: "${ [1] }" },
                do: [{ [longId("d")]: { set: '${ {status: "x"} }' } }],
              },
            },
          ],
        },
      },
    ],
  },
});

/** A loop of one item with `metadata.grasp`. */
const loop = (metadata: Record<string, unknown>) => ({
  each: {
    for: { in: "${ [1] }" },
    do: [{ inner: { set: '${ {status: "x"} }' } }],
    metadata: { grasp: metadata },
  },
});

/** `levels` loops one inside another. */
const nested = (levels: number): unknown => {
  let tasks: unknown[] = [{ inner: { set: '${ {status: "x"} }' } }];
  for (let level = levels; level > 0; level -= 1) {
    tasks = [
      {
        [`level-${level}`]: {
          for: {
            each: `item${level}`,
            at: `index${level}`,
            in: "${ [1] }",
          },
          do: tasks,
        },
      },
    ];
  }
  return tasks[0];
};

describe("sequential for loops of JSON workflows", { timeout: 60_000 }, () => {
  it("run each item in order with its own variables, carrying the context, and answer the last item's output", async () => {
    const by = await builder();
    const { workflow, version } = await published(by, [
      initially("${ {seen: []} }"),
      {
        "each-name": {
          for: { each: "name", in: '${ ["a", "b", "c"] }', at: "i" },
          do: [
            {
              note: {
                set: "${ {status: ($name + ($i | tostring))} }",
                export: {
                  as: "${ $context + {seen: ($context.seen + [$name + ($i | tostring)])} }",
                },
              },
            },
          ],
        },
      },
      {
        finished: {
          set: '${ {status: (.status + ":" + ($context.seen | join(",")))} }',
        },
      },
    ]);
    const run = await ranFor(by, workflow.id);
    const trace = await resourceRunTrace(env, by, workflow.id, run.id);
    expect({
      executable: version.build.executable,
      end: endOf(run),
      // Each item's steps count as their task's in the run's trace.
      traced: trace.tasks
        .map(({ task, state }) => `${task}:${state}`)
        .toSorted(),
    }).toStrictEqual({
      executable: true,
      end: { status: "completed", output: { status: "c2:a0,b1,c2" } },
      traced: [
        "each-name:reached",
        "finished:reached",
        "init:reached",
        "note:reached",
      ],
    });
  });

  it("answer the transformed input for no items, running nothing of the list", async () => {
    const by = await builder();
    const { workflow } = await published(by, [
      initially("${ {ran: false} }"),
      {
        none: {
          for: { in: "${ [] }" },
          input: { from: '${ {status: "nothing"} }' },
          do: [
            {
              never: { set: "${ . }", export: { as: "${ {ran: true} }" } },
            },
          ],
        },
      },
      {
        finished: {
          set: '${ {status: (.status + ":" + ($context.ran | tostring))} }',
        },
      },
    ]);
    expect(endOf(await ranFor(by, workflow.id))).toStrictEqual({
      status: "completed",
      output: { status: "nothing:false" },
    });
  });

  it("stop at the first item whose while is false, before any of its tasks run", async () => {
    const by = await builder();
    const { workflow } = await published(by, [
      initially("${ {count: 0} }"),
      {
        poll: {
          for: { each: "attempt", in: "${ [range(0; 10)] }" },
          while: "${ $context.count < 3 }",
          do: [
            {
              bump: {
                set: "${ . }",
                export: { as: "${ {count: ($context.count + 1)} }" },
              },
            },
          ],
        },
      },
      statusOf("count"),
    ]);
    const run = await ranFor(by, workflow.id);
    const completed = await completedSteps(run.id);
    expect({
      end: endOf(run),
      bumped: [0, 2, 3, 9].map(
        (index) => completed.get(`task:bump@poll.${index}`) ?? 0
      ),
      checked: completed.get("item:poll@poll.3") ?? 0,
    }).toStrictEqual({
      end: { status: "completed", output: { status: "3" } },
      bumped: [1, 1, 0, 0],
      checked: 1,
    });
  });

  it("end an item at its exit, and the workflow at an end, leaving the rest unrun", async () => {
    const by = await builder();
    const add = {
      add: {
        set: "${ . }",
        export: { as: "${ {sum: ($context.sum + $item)} }" },
      },
    };
    const looping = (then: string) => [
      initially("${ {sum: 0} }"),
      {
        sum: {
          for: { in: "${ [1, 2, 3, 4] }" },
          input: { from: '${ {status: "ended"} }' },
          do: [gate(3, then), add],
        },
      },
      statusOf("sum"),
    ];
    const exited = await published(by, looping("exit"));
    const ended = await published(by, looping("end"));
    expect({
      exited: endOf(await ranFor(by, exited.workflow.id)),
      ended: endOf(await ranFor(by, ended.workflow.id)),
    }).toStrictEqual({
      // 1 + 2 + 4: the third item left at its exit.
      exited: { status: "completed", output: { status: "7" } },
      // The workflow's output where its end left it: nothing after ran.
      ended: { status: "completed", output: { status: "ended" } },
    });
  });

  it("run each item's steps once, keyed by its item, across a replay after a wait", async () => {
    const by = await builder();
    const { workflow } = await published(by, [
      initially("${ {rolls: []} }"),
      {
        rolling: {
          for: { in: "${ [1, 2] }" },
          do: [
            {
              roll: {
                call: "grasp.random",
                export: {
                  as: "${ $context + {rolls: ($context.rolls + [.])} }",
                },
              },
            },
            // A new activation: everything before replays from its record.
            { pause: { wait: "PT1S" } },
          ],
        },
      },
      {
        finished: {
          set: "${ {status: ($context.rolls | unique | length | tostring)} }",
        },
      },
    ]);
    const run = await ranFor(by, workflow.id);
    const completed = await completedSteps(run.id);
    expect({
      end: endOf(run),
      rolled: [
        completed.get("task:roll@rolling.0") ?? 0,
        completed.get("task:roll@rolling.1") ?? 0,
      ],
      // No step of the loop's tasks runs outside an item.
      unscoped: completed.get("task:roll") ?? 0,
    }).toStrictEqual({
      end: { status: "completed", output: { status: "2" } },
      rolled: [1, 1],
      unscoped: 0,
    });
  });

  it("go on after an item's attempt is killed: earlier items not run again, the item retried under its key, its lineage counting both", async () => {
    const by = await builder();
    const { workflow } = await published(by, [
      initially("${ {seen: []} }"),
      {
        each: {
          for: { in: '${ ["a", "b", "c"] }' },
          do: [
            {
              note: {
                set: "${ {status: $item} }",
                export: {
                  as: "${ $context + {seen: ($context.seen + [$item])} }",
                },
              },
            },
          ],
        },
      },
      { finished: { set: '${ {status: ($context.seen | join(","))} }' } },
    ]);
    const plain = await ranFor(by, workflow.id);
    // The second item's first attempt is cut off once its code returned:
    // what it did is lost, and its step runs again.
    const killedNote = await withCpuKills(
      "task:note@each.1",
      (attempt) => attempt === 1,
      async () => await ranFor(by, workflow.id),
      "end"
    );
    // The loop's enter step is cut off as it starts: its items are
    // resolved, and recorded, by its retry alone.
    const killedEnter = await withCpuKills(
      "enter:each",
      (attempt) => attempt === 1,
      async () => await ranFor(by, workflow.id)
    );
    const completed = await completedSteps(killedNote.id);
    expect({
      note: endOf(killedNote),
      enter: endOf(killedEnter),
      notes: ["0", "1", "2"].map(
        (index) => completed.get(`task:note@each.${index}`) ?? 0
      ),
      counted:
        ((await hostCallsOf(killedNote.id)) ?? 0) >
        ((await hostCallsOf(plain.id)) ?? 0),
    }).toStrictEqual({
      note: { status: "completed", output: { status: "a,b,c" } },
      enter: { status: "completed", output: { status: "a,b,c" } },
      notes: [1, 1, 1],
      counted: true,
    });
  });

  it("fail a run whose collection isn't a list of at most 1,000 items before any item runs, and count items against the run's steps", async () => {
    const by = await builder();
    const loopOver = (collection: string) => [
      // The context isn't typed: what it holds is only known as it runs.
      initially('${ {ran: false, notList: "a b"} }'),
      {
        over: {
          for: { in: collection },
          do: [{ mark: { set: "${ . }", export: { as: "${ {ran: true} }" } } }],
        },
      },
      statusOf("ran"),
    ];
    const tooMany = await published(by, loopOver("${ [range(0; 1001)] }"));
    const notList = await published(by, loopOver("${ $context.notList }"));
    const full = await published(by, loopOver("${ [range(0; 1000)] }"));
    const tooManyRun = await ranFor(by, tooMany.workflow.id);
    const tooManyMarks = await completedSteps(tooManyRun.id);
    expect({
      tooMany: endOf(tooManyRun),
      notList: endOf(await ranFor(by, notList.workflow.id)),
      marked: tooManyMarks.get("task:mark@over.0") ?? 0,
      full: endOf(await ranFor(by, full.workflow.id)),
    }).toStrictEqual({
      tooMany: { status: "failed", code: "workflow.collection_invalid" },
      notList: { status: "failed", code: "workflow.collection_invalid" },
      marked: 0,
      // A list the loop takes, whose items count against the run's own
      // ceiling of 1,000 steps like any steps (spec 18).
      full: { status: "failed", code: "workflow.too_many_steps" },
    });
  });

  it("key every item once, on the recorded items, before any item runs, and record the keys with the items", async () => {
    const by = await builder();
    const { workflow } = await published(by, [
      initially("${ {seen: []} }"),
      {
        keyed: {
          for: {
            each: "invoice",
            at: "i",
            in: '${ [{id: "x", n: 1}, {id: "y", n: 2}] }',
          },
          // Its own item and index, and the task's input, as the loop
          // binds them for its other expressions.
          metadata: {
            grasp: {
              key: '${ $invoice.id + "-" + ($i | tostring) + $input.who }',
            },
          },
          do: [
            {
              note: {
                set: "${ {status: $invoice.id} }",
                export: {
                  as: "${ $context + {seen: ($context.seen + [$invoice.id])} }",
                },
              },
            },
          ],
        },
      },
      { finished: { set: '${ {status: ($context.seen | join(","))} }' } },
    ]);
    const run = await ranFor(by, workflow.id);
    // Cut off as its enter step starts: its keys are made, and recorded,
    // by its retry alone, once.
    const killed = await withCpuKills(
      "enter:keyed",
      (attempt) => attempt === 1,
      async () => await ranFor(by, workflow.id)
    );
    const recorded = await recordedText(run.id, "enter:keyed");
    const killedSteps = await completedSteps(killed.id);
    expect({
      end: endOf(run),
      killed: endOf(killed),
      // The journal's own encoding of the list: x-0Ada, y-1Ada.
      keys: recorded.includes('"x-0Ada","y-1Ada"'),
      enteredOnce: killedSteps.get("enter:keyed"),
    }).toStrictEqual({
      end: { status: "completed", output: { status: "x,y" } },
      killed: { status: "completed", output: { status: "x,y" } },
      keys: true,
      enteredOnce: 1,
    });
  });

  it("fail a run whose items' keys don't tell each apart, or aren't keys, before any item runs", async () => {
    const by = await builder();
    const keyedOver = (collection: string, key: string) => [
      initially("${ {ran: false} }"),
      {
        over: {
          for: { in: collection },
          metadata: { grasp: { key } },
          do: [{ mark: { set: "${ . }", export: { as: "${ {ran: true} }" } } }],
        },
      },
      statusOf("ran"),
    ];
    // A thousand items, the last two alike: every key made in one step.
    const duplicate = await published(
      by,
      keyedOver("${ [range(0; 999)] + [998] }", "${ $item }")
    );
    const notKeys = await published(
      by,
      keyedOver('${ [{id: "a"}, {id: {deep: 1}}] }', "${ .id }")
    );
    const missing = await published(
      by,
      keyedOver('${ [{id: "a"}, {other: 1}] }', "${ .id }")
    );
    const empty = await published(
      by,
      keyedOver('${ ["a", ""] }', "${ $item }")
    );
    // No key for the first item and two for the second: as many keys as
    // items, all different, but not one for each.
    const noneThenTwo = await published(
      by,
      keyedOver("${ [0, 2] }", "${ range(0; .) }")
    );
    const two = await published(by, keyedOver("${ [1] }", "${ (., . + 10) }"));
    const duplicateRun = await ranFor(by, duplicate.workflow.id);
    const duplicateSteps = await completedSteps(duplicateRun.id);
    const noneThenTwoRun = await ranFor(by, noneThenTwo.workflow.id);
    const noneThenTwoSteps = await completedSteps(noneThenTwoRun.id);
    expect({
      duplicate: endOf(duplicateRun),
      marked: duplicateSteps.get("task:mark@over.0") ?? 0,
      notKeys: endOf(await ranFor(by, notKeys.workflow.id)),
      missing: endOf(await ranFor(by, missing.workflow.id)),
      empty: endOf(await ranFor(by, empty.workflow.id)),
      noneThenTwo: endOf(noneThenTwoRun),
      noneThenTwoMarked: noneThenTwoSteps.get("task:mark@over.0") ?? 0,
      two: endOf(await ranFor(by, two.workflow.id)),
    }).toStrictEqual({
      duplicate: { status: "failed", code: "workflow.item_keys_duplicate" },
      marked: 0,
      notKeys: { status: "failed", code: "workflow.item_keys_invalid" },
      // `null` for an item without one: not a key.
      missing: { status: "failed", code: "workflow.item_keys_invalid" },
      empty: { status: "failed", code: "workflow.item_keys_invalid" },
      noneThenTwo: { status: "failed", code: "workflow.item_keys_invalid" },
      noneThenTwoMarked: 0,
      two: { status: "failed", code: "workflow.item_keys_invalid" },
    });
  });

  it("lower a loop to a call of the SDK's loop, with no loop statement in generated code", async () => {
    const by = await builder();
    const { workflow } = await published(by, [
      {
        each: {
          for: { in: "${ [1] }" },
          do: [{ inner: { set: '${ {status: "x"} }' } }],
        },
      },
    ]);
    const { files } = await workflowSource(env, by, workflow.id, 1);
    const source = files[".grasp/workflow.ts"] ?? "";
    expect({
      sdkLoop: source.includes("await flow.for("),
      statements: /^\s*(?:for|while|do)\b|\bcontinue\b/mu.test(source),
    }).toStrictEqual({ sdkLoop: true, statements: false });
  });

  it("don't lower items at once, loops nested past eight levels or keys too large to list yet", async () => {
    const by = await builder();
    const unsupportedOf = async (task: unknown) => {
      const { version } = await published(by, [task]);
      return version.build.executable
        ? []
        : version.build.unsupported.map(({ feature }) => feature);
    };
    expect({
      concurrent: await unsupportedOf(loop({ concurrency: 2 })),
      keyed: await unsupportedOf(loop({ key: "${ $item }" })),
      // A key the profile takes, but not once listed for every item.
      keyTooLarge: await unsupportedOf(
        loop({ key: `\${ "${"k".repeat(4060)}" }` })
      ),
      eight: await unsupportedOf(nested(8)),
      nine: await unsupportedOf(nested(9)),
      // Step names past what the engine takes, once every loop is named.
      longNames: await unsupportedOf(longNamed()),
    }).toStrictEqual({
      concurrent: ["for:concurrency"],
      keyed: [],
      keyTooLarge: ["for:key_too_large"],
      eight: [],
      nine: ["for:depth"],
      longNames: ["step:name_too_long"],
    });
  });
});

/** A host of a run of version 1 of workflow `id`, its steps run at once. */
const hostOf = async (by: Acting, id: string): Promise<ResourceRunHost> => {
  const manifest = await env.DB.prepare(
    "SELECT manifest_hash AS hash FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1"
  )
    .bind(id)
    .first<{ hash: string }>();
  const build = await loadWorkflowBuild(env, id, 1, manifest?.hash ?? "");
  let count = 0;
  const step: RunStep = {
    do: async (name, _config, fn) => {
      count += 1;
      return await fn({ attempt: 1, idempotencyKey: `key:${name}:${count}` });
    },
    sleep: async () => {
      await Promise.resolve();
    },
    sleepUntil: async () => {
      await Promise.resolve();
    },
    waitForEvent: async () => await Promise.reject(new Error("No waits here")),
  };
  const runId = crypto.randomUUID();
  return new ResourceRunHost(
    env,
    step,
    {
      runId,
      workflowId: id,
      version: 1,
      principal: by.userId,
      input: { who: "Ada" },
      params: {},
      createdAt: Date.now(),
      build,
      calling: {
        runId,
        workflowId: id,
        version: 1,
        principal: by.userId,
        invoker: { type: "person", id: by.userId, appVersion: null },
        bindings: new Map(),
        restricted: false,
      },
      maxModelCalls: 1,
    },
    {
      leaseOf: () => ({ generation: 1, deadline: Date.now() + 60_000 }),
      tampered: () => {},
      admitAttempt: admittedFreely,
    }
  );
};

/** The code `settled` failed with, or "ok". */
const codeOf = (settled: Settled<unknown>): unknown =>
  settled.ok ? "ok" : settled.error.code;

const itemsSchema = z.object({
  ok: z.literal(true),
  value: z.object({ items: z.array(z.json()) }),
});

/** The loop the forged modules below run: three names, a while, a task. */
const named = [
  {
    names: {
      for: { each: "name", in: '${ ["a", "b", "c"] }' },
      while: '${ $name != "z" }',
      do: [{ note: { set: "${ {status: $name} }" } }],
    },
  },
];

const ada = { input: { input: { who: "Ada" }, context: {} } };

/**
 * Enters the loop `names` on `host`, its record the items the host
 * resolved, or `forge` of them.
 */
const entered = async (
  host: ResourceRunHost,
  forge: (items: unknown[]) => unknown = (items) => items
) =>
  codeOf(
    await host.do("enter:names", ada, async (attempt) => {
      const items = itemsSchema.parse(
        await attempt.items({ input: { who: "Ada" } })
      );
      return {
        ok: true,
        value: { output: { who: "Ada" }, items: forge(items.value.items) },
      };
    })
  );

/** `host`'s answer to step `name` of a module that records `value`. */
const forged = async (
  host: ResourceRunHost,
  name: string,
  value?: unknown
): Promise<unknown> =>
  codeOf(
    await host.do(
      name,
      ada,
      async () =>
        await Promise.resolve({
          ok: true,
          value: value ?? { output: { status: "a" } },
        })
    )
  );

/** `named`, its items keyed by their name. */
const keyedNames = [
  {
    names: {
      ...named[0]?.names,
      metadata: { grasp: { key: "${ $name }" } },
    },
  },
];

const keyedItemsSchema = z.object({
  ok: z.literal(true),
  value: z.object({ items: z.array(z.json()), keys: z.array(z.json()) }),
});

/**
 * Enters the keyed loop `names` on `host`, its record the items and keys
 * the host resolved, or `forge` of the keys.
 */
const enteredKeyed = async (
  host: ResourceRunHost,
  forge: (keys: unknown[]) => unknown = (keys) => keys
) =>
  codeOf(
    await host.do("enter:names", ada, async (attempt) => {
      const { items, keys } = keyedItemsSchema.parse(
        await attempt.items({ input: { who: "Ada" } })
      ).value;
      return {
        ok: true,
        value: { output: { who: "Ada" }, items, keys: forge(keys) },
      };
    })
  );

describe("a run's host, against a forged module's loop", () => {
  it("records only the keys the host made of the items, never other ones or none", async () => {
    const by = await builder();
    const { workflow } = await published(by, keyedNames);
    expect({
      made: await enteredKeyed(await hostOf(by, workflow.id)),
      renamed: await enteredKeyed(await hostOf(by, workflow.id), (keys) =>
        keys.map((key) => `${String(key)}!`)
      ),
      dropped: await enteredKeyed(await hostOf(by, workflow.id), () => {}),
    }).toStrictEqual({
      made: "ok",
      renamed: "workflow.invalid",
      dropped: "workflow.invalid",
    });
  });

  it("runs an item's steps only in an item the loop's enter step recorded", async () => {
    const by = await builder();
    const { workflow } = await published(by, named);
    // A host refused once refuses everything after: each case its own.
    const afterEntering = async (name: string) => {
      const host = await hostOf(by, workflow.id);
      await expect(entered(host)).resolves.toBe("ok");
      return await forged(host, name);
    };
    const twice = await hostOf(by, workflow.id);
    await entered(twice);
    expect({
      beforeEntered: await forged(
        await hostOf(by, workflow.id),
        "task:note@names.0"
      ),
      unscoped: await afterEntering("task:note"),
      pastItems: await afterEntering("task:note@names.3"),
      otherLoop: await afterEntering("task:note@other.0"),
      paddedIndex: await afterEntering("task:note@names.01"),
      tooDeep: await afterEntering("task:note@names.0/names.0"),
      inItem: await forged(twice, "task:note@names.2"),
      again: await forged(twice, "task:note@names.2"),
    }).toStrictEqual({
      beforeEntered: "workflow.invalid",
      unscoped: "workflow.invalid",
      pastItems: "workflow.invalid",
      otherLoop: "workflow.invalid",
      paddedIndex: "workflow.invalid",
      tooDeep: "workflow.invalid",
      inItem: "ok",
      again: "workflow.invalid",
    });
  });

  it("records only the items the host resolved, and an item's check only what its while answered", async () => {
    const by = await builder();
    const { workflow } = await published(by, named);
    /** Item `index`'s check on a fresh host, recording `answer` of its while. */
    const check = async (index: number, answer: (held: unknown) => unknown) => {
      const host = await hostOf(by, workflow.id);
      await entered(host);
      // Slot 1 is the while, which only an item's check evaluates.
      return codeOf(
        await host.do(`item:names@names.${index}`, ada, async (attempt) => {
          const held = await attempt.evaluate(1, {
            input: { who: "Ada" },
            output: null,
          });
          return { ok: true, value: { output: answer(held.ok && held.value) } };
        })
      );
    };
    const inTask = await hostOf(by, workflow.id);
    await entered(inTask);
    expect({
      forgedItems: await entered(await hostOf(by, workflow.id), (items) => [
        ...items,
        "d",
      ]),
      flipped: await check(0, (held) => held !== true),
      held: await check(1, (held) => held),
      whileInTask: codeOf(
        await inTask.do("task:note@names.2", ada, async (attempt) => {
          await attempt.evaluate(1, { input: { who: "Ada" }, output: null });
          return { ok: true, value: { output: { status: "c" } } };
        })
      ),
    }).toStrictEqual({
      forgedItems: "workflow.invalid",
      flipped: "workflow.invalid",
      held: "ok",
      whileInTask: "workflow.invalid",
    });
  });
});
