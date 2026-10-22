/* oxlint-disable no-template-curly-in-string, unicorn/no-thenable -- workflow expressions are written as ${ … } strings, and transitions as then */
import { describe, expect, it } from "vite-plus/test";

import type { RunStep } from "../src/workflows/host.ts";
import type { ScopeFences } from "../src/workflows/resource-host.ts";
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

// Items and branches at once in JSON workflows (GRA-956): `for` and `fork`
// tasks of `metadata.grasp.concurrency` 2 to 8, from their threat model:
// each item or branch runs from the context its scope found, and their
// outputs come in order; a forged module can't run more than eight of a
// run's attempts at once; a race or an `end` settles its scope in a fence
// kept with the run, first writer's, so a branch another settled over
// starts no step after, in that activation or any later one, and a replay
// or a killed attempt keeps the branch the fence holds; a branch already
// out when its scope settles ends as it would, its effect standing.

/** Starts the context with `value`. */
const initially = (value: string) => ({
  init: { set: "${ . }", export: { as: value } },
});

/** A branch `id`: a wait of `wait`, then a status `status`. */
const after = (id: string, wait: string, status: string) => ({
  [id]: {
    do: [
      { [`${id}-wait`]: { wait } },
      { [`${id}-done`]: { set: `\${ {status: "${status}"} }` } },
    ],
  },
});

describe("items and branches at once", { timeout: 60_000 }, () => {
  it("run a loop's items at once, each from the loop's context, and answer their outputs in item order", async () => {
    const by = await builder();
    const { workflow, version } = await published(by, [
      initially("${ {n: 1} }"),
      {
        each: {
          for: { in: "${ [3, 1, 2] }" },
          metadata: { grasp: { concurrency: 3 } },
          do: [
            // Waits of their own lengths: they end in another order.
            { pause: { wait: '${ "PT" + ($item | tostring) + "S" }' } },
            {
              note: {
                set: "${ {v: ($item + $context.n)} }",
                export: { as: "${ {n: 100} }" },
              },
            },
          ],
          output: { as: '${ {status: (map(.v | tostring) | join(","))} }' },
        },
      },
      {
        finished: {
          set: '${ {status: (.status + ":" + ($context.n | tostring))} }',
        },
      },
    ]);
    const started = Date.now();
    const run = await ranFor(by, workflow.id);
    expect({
      executable: version.build.executable,
      end: endOf(run),
      // At once: about the longest wait, not their sum.
      atOnce: Date.now() - started < 5500,
    }).toStrictEqual({
      executable: true,
      end: { status: "completed", output: { status: "4,2,3:1" } },
      atOnce: true,
    });
  });

  it("run a fork's branches at once, and answer their outputs in declaration order", async () => {
    const by = await builder();
    const { workflow } = await published(by, [
      {
        both: {
          fork: {
            branches: [
              after("slow", "PT2S", "slow"),
              after("quick", "PT1S", "quick"),
            ],
          },
          metadata: { grasp: { concurrency: 2 } },
          output: { as: '${ {status: (map(.status) | join(","))} }' },
        },
      },
    ]);
    expect(endOf(await ranFor(by, workflow.id))).toStrictEqual({
      status: "completed",
      output: { status: "slow,quick" },
    });
  });

  it("race at once: the first branch that succeeds wins, and a branch out past it starts no step after", async () => {
    const by = await builder();
    const { workflow } = await published(by, [
      {
        pick: {
          fork: {
            branches: [
              after("slow", "PT2S", "slow"),
              after("quick", "PT1S", "quick"),
            ],
            compete: true,
          },
          metadata: { grasp: { concurrency: 2 } },
        },
      },
    ]);
    const run = await ranFor(by, workflow.id);
    const completed = await completedSteps(run.id);
    expect({
      end: endOf(run),
      settled: completed.get("task:pick") ?? 0,
      quick: completed.get("task:quick-done@pick.1") ?? 0,
      // Out at its wait as the race settled: its step after never runs.
      slow: completed.get("task:slow-done@pick.0") ?? 0,
    }).toStrictEqual({
      end: { status: "completed", output: { status: "quick" } },
      settled: 1,
      quick: 1,
      slow: 0,
    });
  });

  it("end the workflow from one item at once, its siblings fenced off", async () => {
    const by = await builder();
    const { workflow } = await published(by, [
      {
        each: {
          for: { in: "${ [0, 1] }" },
          metadata: { grasp: { concurrency: 2 } },
          input: { from: '${ {status: "ended"} }' },
          do: [
            {
              gate: {
                switch: [
                  { stop: { when: "${ $item == 0 }", then: "end" } },
                  { go: { then: "pause" } },
                ],
              },
            },
            { pause: { wait: "PT2S" } },
            { late: { set: '${ {status: "late"} }' } },
          ],
        },
      },
      { finished: { set: '${ {status: "finished"} }' } },
    ]);
    const run = await ranFor(by, workflow.id);
    const completed = await completedSteps(run.id);
    expect({
      end: endOf(run),
      settled: completed.get("task:each") ?? 0,
      late: completed.get("task:late@each.1") ?? 0,
    }).toStrictEqual({
      end: { status: "completed", output: { status: "ended" } },
      settled: 1,
      late: 0,
    });
  });

  it("keep the race's winner across a killed record: its retry settles on the branch the fence holds", async () => {
    const by = await builder();
    const { workflow } = await published(by, [
      {
        pick: {
          fork: {
            branches: [
              after("slow", "PT2S", "slow"),
              after("quick", "PT1S", "quick"),
            ],
            compete: true,
          },
          metadata: { grasp: { concurrency: 2 } },
        },
      },
    ]);
    // The record's first attempt is cut off as its code returned: the
    // fence it wrote stands, and its retry settles on that branch.
    const run = await withCpuKills(
      "task:pick",
      (attempt) => attempt === 1,
      async () => await ranFor(by, workflow.id),
      "end"
    );
    const completed = await completedSteps(run.id);
    expect({
      end: endOf(run),
      quick: completed.get("task:quick-done@pick.1") ?? 0,
      slow: completed.get("task:slow-done@pick.0") ?? 0,
    }).toStrictEqual({
      end: { status: "completed", output: { status: "quick" } },
      quick: 1,
      slow: 0,
    });
  });

  it("go on after an item's attempt is killed mid-join: the others' outputs kept, each item's step once", async () => {
    const by = await builder();
    const { workflow } = await published(by, [
      {
        each: {
          for: { in: '${ ["a", "b", "c"] }' },
          metadata: { grasp: { concurrency: 3 } },
          do: [{ note: { set: "${ {v: $item} }" } }],
          output: { as: '${ {status: (map(.v) | join(","))} }' },
        },
      },
    ]);
    const run = await withCpuKills(
      "task:note@each.1",
      (attempt) => attempt === 1,
      async () => await ranFor(by, workflow.id),
      "end"
    );
    const completed = await completedSteps(run.id);
    expect({
      end: endOf(run),
      notes: [0, 1, 2].map(
        (index) => completed.get(`task:note@each.${index}`) ?? 0
      ),
    }).toStrictEqual({
      end: { status: "completed", output: { status: "a,b,c" } },
      notes: [1, 1, 1],
    });
  });
});

const ada = { input: { input: { who: "Ada" }, context: {} } };

/** A loop of ten items at once, for the forged modules below. */
const tenAtOnce = [
  {
    each: {
      for: { in: "${ [range(0; 10)] }" },
      metadata: { grasp: { concurrency: 8 } },
      do: [{ note: { set: '${ {status: "x"} }' } }],
    },
  },
];

describe("a run's host, against a forged module at once", () => {
  it("runs at most eight of a run's attempts at once, whatever the module asks", async () => {
    const by = await builder();
    const { workflow } = await published(by, tenAtOnce);
    let running = 0;
    let most = 0;
    const gate = Promise.withResolvers<null>();
    let count = 0;
    const step: RunStep = {
      do: async (name, _config, fn) => {
        count += 1;
        running += 1;
        most = Math.max(most, running);
        try {
          if (name.startsWith("task:")) {
            await gate.promise;
          }
          return await fn({
            attempt: 1,
            idempotencyKey: `key:${name}:${count}`,
          });
        } finally {
          running -= 1;
        }
      },
      sleep: async () => {
        await Promise.resolve();
      },
      sleepUntil: async () => {
        await Promise.resolve();
      },
      waitForEvent: async () => await Promise.reject(new Error("No waits")),
    };
    const host = await hostOf(by, workflow.id, { step });
    await host.do("enter:each", ada, async (attempt) => {
      const items = await attempt.items({ input: { who: "Ada" } });
      return {
        ok: true,
        value: { output: { who: "Ada" }, items: items.ok ? items.value : [] },
      };
    });
    // Ten items' steps asked for at once.
    const asked = Array.from(
      { length: 10 },
      async (_, index) =>
        await host.do(`task:note@each.${index}`, ada, async () => {
          await Promise.resolve();
          return { ok: true, value: { output: { status: "x" } } };
        })
    );
    await scheduler.wait(100);
    const whileHeld = most;
    gate.resolve(null);
    const answers = await Promise.all(asked);
    expect({
      whileHeld,
      most,
      answered: answers.map(codeOf),
    }).toStrictEqual({
      whileHeld: 8,
      most: 8,
      answered: Array.from({ length: 10 }, () => "ok"),
    });
  });

  it("starts no step of a branch its race settled over, though the race settled in an earlier activation", async () => {
    const by = await builder();
    const { workflow } = await published(by, [
      {
        pick: {
          fork: {
            branches: [
              after("slow", "PT2S", "slow"),
              after("quick", "PT1S", "quick"),
            ],
            compete: true,
          },
          metadata: { grasp: { concurrency: 2 } },
        },
      },
    ]);
    // What the run keeps across activations: a fence, settled once.
    const settled = new Map<string, number>();
    const fences: ScopeFences = {
      settle: (place, branch) => {
        if (!settled.has(place)) {
          settled.set(place, branch);
        }
        return settled.get(place) ?? branch;
      },
      settled: (place) => settled.get(place),
    };
    const first = await hostOf(by, workflow.id, { fences });
    const won = await first.do("task:pick", ada, async (attempt) => {
      const branch = await attempt.settle({ branch: 1 });
      return {
        ok: true,
        value: { output: null, branch: branch.ok ? branch.value : null },
      };
    });
    // The next activation: the loser finishes first, and asks to settle.
    const second = await hostOf(by, workflow.id, { fences });
    const settledAgain = await second.do("task:pick", ada, async (attempt) => {
      const branch = await attempt.settle({ branch: 0 });
      return {
        ok: true,
        value: { output: null, branch: branch.ok ? branch.value : null },
      };
    });
    const third = await hostOf(by, workflow.id, { fences });
    const loser = await third.do("task:slow-done@pick.0", ada, async () => {
      await Promise.resolve();
      return { ok: true, value: { output: { status: "slow" } } };
    });
    const winner = await third.do("task:quick-done@pick.1", ada, async () => {
      await Promise.resolve();
      return { ok: true, value: { output: { status: "quick" } } };
    });
    expect({
      won: won.ok && won.value,
      settledAgain: settledAgain.ok && settledAgain.value,
      loser: codeOf(loser),
      winner: codeOf(winner),
    }).toStrictEqual({
      won: { output: null, branch: 1 },
      settledAgain: { output: null, branch: 1 },
      loser: "workflow.branch_cancelled",
      winner: "ok",
    });
  });
});
