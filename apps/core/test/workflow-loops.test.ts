/* oxlint-disable no-template-curly-in-string, unicorn/no-thenable -- workflow expressions are written as ${ … } strings, and transitions as then */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { workflowSource } from "../src/workflow-resources.ts";
import type { ResourceRunHost } from "../src/workflows/resource-host.ts";
import { resourceRunTrace } from "../src/workflows/resource-run-trace.ts";
import { withCpuKills } from "./cpu-kills.ts";
import {
  builder,
  codeOf,
  completedSteps,
  endOf,
  hostOf,
  published,
  ranFor,
} from "./json-workflows.ts";

// Sequential `for` loops of JSON workflows (GRA-276; @grasp-os/open-workflow's
// generate.ts, the SDK's open-workflow.ts and core's resource-host.ts), from
// their threat model: a loop runs over the items its enter step recorded and
// no others, so a replay runs the same items and a forged module can't add
// one; each item's steps are its own (`task:<id>@<for>.<index>`), so an
// item's effect is keyed apart from another's and runs once; `while` ends
// the items before any effect of the next; context carries from one item to
// the next; `exit` ends an item and `end` the workflow; a collection past
// the platform's 1,000 items fails the run before any item runs; and
// generated code still has no loop statement.

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

  it("don't lower items at once, items' own keys or loops nested past eight levels yet", async () => {
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
      eight: await unsupportedOf(nested(8)),
      nine: await unsupportedOf(nested(9)),
      // Step names past what the engine takes, once every loop is named.
      longNames: await unsupportedOf(longNamed()),
    }).toStrictEqual({
      concurrent: ["for:concurrency"],
      keyed: ["for:key"],
      eight: [],
      nine: ["for:depth"],
      longNames: ["step:name_too_long"],
    });
  });
});

const itemsSchema = z.object({ ok: z.literal(true), value: z.array(z.json()) });

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
        value: { output: { who: "Ada" }, items: forge(items.value) },
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

describe("a run's host, against a forged module's loop", () => {
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
