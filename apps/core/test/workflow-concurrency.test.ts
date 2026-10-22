/* oxlint-disable no-template-curly-in-string, unicorn/no-thenable -- workflow expressions are written as ${ … } strings, and transitions as then */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { engineCall } from "../src/workflows/engine-asks.ts";
import type { RunStep } from "../src/workflows/host.ts";
import type { ScopeFences } from "../src/workflows/resource-host.ts";
import { withCpuKills } from "./cpu-kills.ts";
import {
  builder,
  codeOf,
  completedSteps,
  endOf,
  hostOf,
  objectSchema,
  published,
  ranFor,
  startedSteps,
} from "./json-workflows.ts";
import { admittedFreely } from "./runs.ts";

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
const after = (id: string, wait: unknown, status: string) => ({
  [id]: {
    do: [
      { [`${id}-wait`]: { wait } },
      { [`${id}-done`]: { set: `\${ {status: "${status}"} }` } },
    ],
  },
});

/** `count` steps, one after another, the last leaving for the item's end. */
const busySteps = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    [`busy-${index}`]: {
      set: '${ {status: "x"} }',
      ...(index === count - 1 ? { then: "end-of-item" } : {}),
    },
  }));

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

  it("keep an item's wait through a sibling's long chain of steps, the run finishing once it is due", async () => {
    const by = await builder();
    const { workflow } = await published(by, [
      {
        each: {
          for: { in: "${ [0, 1] }" },
          metadata: { grasp: { concurrency: 2 } },
          do: [
            {
              gate: {
                switch: [
                  { first: { when: "${ $item == 0 }", then: "pause" } },
                  { other: { then: "busy-0" } },
                ],
              },
            },
            ...busySteps(12),
            { pause: { wait: { milliseconds: 400 } } },
            { "end-of-item": { set: '${ {status: "item"} }' } },
          ],
          output: { as: '${ {status: "done"} }' },
        },
      },
    ]);
    const run = await ranFor(by, workflow.id);
    expect(endOf(run)).toStrictEqual({
      status: "completed",
      output: { status: "done" },
    });
  });

  it("end from an item the pool starts later, and finish though an earlier item's next step is refused, after the settling is lost once", async () => {
    const by = await builder();
    const { workflow } = await published(by, [
      {
        each: {
          // Three items, two at once: item 2 starts only once item 1 ends.
          for: { in: "${ [0, 1, 2] }" },
          metadata: { grasp: { concurrency: 2 } },
          input: { from: '${ {status: "ended"} }' },
          do: [
            {
              gate: {
                switch: [
                  { stop: { when: "${ $item == 2 }", then: "end" } },
                  { first: { when: "${ $item == 0 }", then: "pause" } },
                  { other: { then: "busy-0" } },
                ],
              },
            },
            // Item 1 replays several steps; item 0 a wait, then a step
            // its fenced-off item never runs.
            ...busySteps(6),
            { pause: { wait: { milliseconds: 100 } } },
            { late: { set: '${ {status: "late"} }' } },
            { "end-of-item": { set: '${ {status: "item"} }' } },
          ],
        },
      },
      { finished: { set: '${ {status: "finished"} }' } },
    ]);
    // Item 2's settling of the loop is cut off once its code returned:
    // the fence it wrote stands, and the next activation replays the
    // loop with item 0's wait due, so item 0's next step is refused
    // before item 2 starts again.
    const run = await withCpuKills(
      "task:each",
      (attempt) => attempt === 1,
      async () => await ranFor(by, workflow.id),
      "end"
    );
    const completed = await completedSteps(run.id);
    expect({
      end: endOf(run),
      settled: completed.get("task:each") ?? 0,
      item0Late: completed.get("task:late@each.0") ?? 0,
    }).toStrictEqual({
      end: { status: "completed", output: { status: "ended" } },
      settled: 1,
      item0Late: 0,
    });
  });

  it("start no item of a loop in a branch its race settled over, once the first is refused", async () => {
    const by = await builder();
    const { workflow } = await published(by, [
      {
        pick: {
          fork: {
            branches: [
              {
                slow: {
                  // Entered before the race settles: its first item waits
                  // past it, and its next step is refused.
                  for: { in: "${ [range(0; 6)] }" },
                  do: [
                    {
                      gate: {
                        switch: [
                          { first: { when: "${ $index == 0 }", then: "hold" } },
                          { other: { then: "note" } },
                        ],
                      },
                    },
                    { hold: { wait: { milliseconds: 800 }, then: "note" } },
                    { note: { set: '${ {status: "slow"} }' } },
                  ],
                },
              },
              after("quick", { milliseconds: 200 }, "quick"),
            ],
            compete: true,
          },
          metadata: { grasp: { concurrency: 2 } },
        },
      },
      // Out long enough for the loser's wait to end meanwhile.
      { rest: { wait: { milliseconds: 1500 } } },
    ]);
    const run = await ranFor(by, workflow.id);
    const started = await startedSteps(run.id);
    expect({
      end: endOf(run),
      // The first item's refused step, and no other item's.
      items: started.filter((name) => name.includes("@pick.0/slow.")),
    }).toStrictEqual({
      end: { status: "completed", output: { status: "quick" } },
      items: ["task:gate@pick.0/slow.0", "task:note@pick.0/slow.0"],
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

  it("finish a fork of loops at once, more steps out than slots, though each step's first attempt is cut off and its retry parked", async () => {
    const by = await builder();
    // Twelve items' steps asked for at once, past the run's eight slots.
    const { workflow } = await published(by, [
      {
        pair: {
          fork: {
            branches: ["left", "right"].map((id) => ({
              [id]: {
                do: [
                  {
                    [`${id}-items`]: {
                      for: { in: "${ [1, 2, 3, 4, 5, 6] }" },
                      metadata: { grasp: { concurrency: 6 } },
                      do: [{ [`${id}-note`]: { set: "${ {v: $item} }" } }],
                    },
                  },
                ],
              },
            })),
          },
          metadata: { grasp: { concurrency: 2 } },
          output: { as: '${ {status: "ok"} }' },
        },
      },
    ]);
    // A parked retry holds no slot: the steps behind it run, and the run
    // suspends on the retries and finishes in later activations.
    const run = await withCpuKills(
      (name) => name.includes("-note@"),
      (attempt) => attempt === 1,
      async () => await ranFor(by, workflow.id)
    );
    const completed = await completedSteps(run.id);
    const notes = ["left-note@pair.0", "right-note@pair.1"].flatMap((note) =>
      [0, 1, 2, 3, 4, 5].map(
        (index) =>
          completed.get(`task:${note}/${note.split("-")[0]}-items.${index}`) ??
          0
      )
    );
    expect({ end: endOf(run), notes }).toStrictEqual({
      end: { status: "completed", output: { status: "ok" } },
      notes: Array.from({ length: 12 }, () => 1),
    });
  });
});

/** Short waits, each a new activation that replays the run so far. */
const replays = [1, 2, 3].map((round) => ({
  [`rest-${round}`]: { wait: { milliseconds: 100 } },
}));

/**
 * A race of a quick branch, one that fails after a chain of steps, and
 * one whose first task is `long`; two at once, so the third starts only
 * once the failing one has failed, before the quick one wins. Then waits,
 * each replaying it, and a step `mark` among them.
 */
const raceBehindFailure = (long: unknown) => [
  {
    pick: {
      fork: {
        branches: [
          after("quick", { milliseconds: 1500 }, "quick"),
          {
            broken: {
              do: [
                ...Array.from({ length: 10 }, (_, index) => ({
                  [`broken-${index}`]: { set: '${ {status: "x"} }' },
                })),
                {
                  "broken-out": {
                    set: "${ {other: 1} }",
                    output: {
                      schema: objectSchema({ status: { type: "string" } }),
                    },
                  },
                },
              ],
            },
          },
          {
            long: {
              do: [
                { "long-first": long },
                { "long-done": { set: '${ {status: "long"} }' } },
              ],
            },
          },
        ],
        compete: true,
      },
      metadata: { grasp: { concurrency: 2 } },
    },
  },
  replays[0],
  { mark: { set: "${ . }" } },
  ...replays.slice(1),
];

describe("replays of items and branches at once", { timeout: 60_000 }, () => {
  // Every replay starts each item and branch the first run started, though
  // their scope settled before the replay reached them: a wait or a retry
  // of one the journal holds is reached again, so the run never strays.
  // Each run here replays several times, once after a killed attempt.

  it("race: replay the branch the pool started behind a failure, its long wait reached again, after the race settled", async () => {
    const by = await builder();
    const { workflow } = await published(
      by,
      raceBehindFailure({ wait: "PT1H" })
    );
    for (const round of [1, 2, 3]) {
      // oxlint-disable-next-line no-await-in-loop -- one run at a time
      const run = await withCpuKills(
        "task:mark",
        (attempt) => attempt === 1,
        async () => await ranFor(by, workflow.id)
      );
      expect({ round, end: endOf(run) }).toStrictEqual({
        round,
        end: { status: "completed", output: { status: "quick" } },
      });
    }
  });

  it("race: replay the branch the pool started behind a failure, its step waiting to retry, after the race settled", async () => {
    const by = await builder();
    const { workflow } = await published(
      by,
      raceBehindFailure({ set: '${ {status: "first"} }' })
    );
    for (const round of [1, 2, 3]) {
      // oxlint-disable-next-line no-await-in-loop -- one run at a time
      const run = await withCpuKills(
        "task:long-first@pick.2",
        // Cut off once: its retry waits out a backoff of an hour.
        (attempt) => attempt === 1,
        async () => {
          env.WORKFLOW_RETRY_DELAY_MS = "3600000";
          return await ranFor(by, workflow.id);
        }
      );
      expect({ round, end: endOf(run) }).toStrictEqual({
        round,
        end: { status: "completed", output: { status: "quick" } },
      });
    }
  });

  it("end from an item at once: replay the item the pool started after a sibling's chain, its long wait reached again", async () => {
    const by = await builder();
    const { workflow } = await published(by, [
      {
        each: {
          // Three items, two at once: item 2 starts once item 1 is done,
          // before item 0 ends the workflow.
          for: { in: "${ [0, 1, 2] }" },
          metadata: { grasp: { concurrency: 2 } },
          input: { from: '${ {status: "ended"} }' },
          do: [
            {
              gate: {
                switch: [
                  { first: { when: "${ $item == 0 }", then: "pause" } },
                  { last: { when: "${ $item == 2 }", then: "long" } },
                  { other: { then: "busy-0" } },
                ],
              },
            },
            ...busySteps(10),
            { pause: { wait: { milliseconds: 1500 } } },
            { halt: { set: "${ . }", then: "end" } },
            { long: { wait: "PT1H" } },
            { "end-of-item": { set: '${ {status: "item"} }' } },
          ],
        },
      },
    ]);
    for (const round of [1, 2, 3]) {
      // oxlint-disable-next-line no-await-in-loop -- one run at a time
      const run = await withCpuKills(
        // Its settling cut off once its code returned: the next
        // activation replays the loop, the fence standing.
        "task:each",
        (attempt) => attempt === 1,
        async () => await ranFor(by, workflow.id),
        "end"
      );
      expect({ round, end: endOf(run) }).toStrictEqual({
        round,
        end: { status: "completed", output: { status: "ended" } },
      });
    }
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

/**
 * The engine's steps, each task step's first attempt run and then parked
 * for its retry, as the engine parks one: its call never returns in this
 * activation. Counts the attempts run, and the engine's count of the run
 * busy (`RunStep.busy`).
 */
const parkingEngine = () => {
  const seen = { attempts: 0, busy: 0 };
  let count = 0;
  const step: RunStep = {
    // Told to the ask the host handles, as the engine's innermost step does.
    do: async (name, _config, fn) =>
      await engineCall(async () => {
        count += 1;
        const ran = await fn({
          attempt: 1,
          idempotencyKey: `key:${name}:${count}`,
        });
        if (!name.startsWith("task:")) {
          return ran;
        }
        seen.attempts += 1;
        return await Promise.withResolvers<never>().promise;
      }),
    sleep: async () => {
      await Promise.resolve();
    },
    sleepUntil: async () => {
      await Promise.resolve();
    },
    waitForEvent: async () => await Promise.reject(new Error("No waits")),
    busy: () => {
      seen.busy += 1;
      let ended = false;
      return () => {
        if (!ended) {
          ended = true;
          seen.busy -= 1;
        }
      };
    },
  };
  return { step, seen };
};

/** The enter step of `tenAtOnce`'s loop, its items recorded. */
const enterTen = async (host: Awaited<ReturnType<typeof hostOf>>) =>
  await host.do("enter:each", ada, async (attempt) => {
    const items = await attempt.items({ input: { who: "Ada" } });
    return {
      ok: true,
      value: { output: { who: "Ada" }, items: items.ok ? items.value : [] },
    };
  });

/** Asks for the step of item `index` of `tenAtOnce`'s loop. */
const askItem = async (
  host: Awaited<ReturnType<typeof hostOf>>,
  index: number
) =>
  await host.do(`task:note@each.${index}`, ada, async () => {
    await Promise.resolve();
    return { ok: true, value: { output: { status: "x" } } };
  });

describe("a run's host, against a forged module at once", () => {
  it("runs the steps behind ones parked on their retries, holding the run busy for none of them", async () => {
    const by = await builder();
    const { workflow } = await published(by, tenAtOnce);
    const { step, seen } = parkingEngine();
    const host = await hostOf(by, workflow.id, { step });
    await host.quiet(0, 1);
    await enterTen(host);
    // Ten items' steps asked for at once: each parks after its attempt.
    for (const index of Array.from({ length: 10 }, (_, at) => at)) {
      void askItem(host, index);
    }
    await host.quiet(11, 2);
    await scheduler.wait(200);
    expect(seen).toStrictEqual({ attempts: 10, busy: 0 });
  });

  it("holds its run busy for an isolate that never says it went quiet, with a step parked, for no longer than its time between steps", async () => {
    const by = await builder();
    const { workflow } = await published(by, tenAtOnce);
    const { step, seen } = parkingEngine();
    env.WORKFLOW_BETWEEN_STEPS_MS = "300";
    try {
      const host = await hostOf(by, workflow.id, { step });
      await host.quiet(0, 1);
      await enterTen(host);
      // Answered, the module asks once more and says nothing after.
      void askItem(host, 0);
      await scheduler.wait(100);
      const held = seen.busy;
      await scheduler.wait(400);
      expect({ held, after: seen.busy }).toStrictEqual({ held: 1, after: 0 });
    } finally {
      Reflect.deleteProperty(env, "WORKFLOW_BETWEEN_STEPS_MS");
    }
  });

  it("counts a quiet its isolate sent again once, holding the run busy until the next one comes", async () => {
    const by = await builder();
    const { workflow } = await published(by, tenAtOnce);
    const { step, seen } = parkingEngine();
    const host = await hostOf(by, workflow.id, { step });
    await host.quiet(0, 1);
    await enterTen(host);
    // The quiet after its start, delivered again: not the one after the
    // answer it has had since.
    await host.quiet(0, 1);
    const afterAgain = seen.busy;
    await host.quiet(1, 2);
    expect({ afterAgain, afterNext: seen.busy }).toStrictEqual({
      afterAgain: 1,
      afterNext: 0,
    });
  });

  it("holds its run busy for asks an isolate says it made but never sends, with a step parked, for no longer than its time between steps", async () => {
    const by = await builder();
    const { workflow } = await published(by, tenAtOnce);
    const { step, seen } = parkingEngine();
    env.WORKFLOW_BETWEEN_STEPS_MS = "300";
    try {
      const host = await hostOf(by, workflow.id, { step });
      await host.quiet(0, 1);
      await enterTen(host);
      void askItem(host, 0);
      await host.quiet(Number.MAX_SAFE_INTEGER, 2);
      await scheduler.wait(100);
      const held = seen.busy;
      await scheduler.wait(400);
      expect({ held, after: seen.busy }).toStrictEqual({ held: 1, after: 0 });
    } finally {
      Reflect.deleteProperty(env, "WORKFLOW_BETWEEN_STEPS_MS");
    }
  });

  it("runs at most eight of a run's attempts at once, whatever the module asks", async () => {
    const by = await builder();
    const { workflow } = await published(by, tenAtOnce);
    let running = 0;
    let most = 0;
    const gate = Promise.withResolvers<null>();
    const host = await hostOf(by, workflow.id);
    await enterTen(host);
    // Ten items' steps asked for at once, each attempt held until let go.
    const asked = Array.from(
      { length: 10 },
      async (_, index) =>
        await host.do(`task:note@each.${index}`, ada, async () => {
          running += 1;
          most = Math.max(most, running);
          await gate.promise;
          running -= 1;
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

  it("starts no attempt of a branch whose race settled while the attempt waited to be admitted", async () => {
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
    // The loser's attempt waits in admission until the race has settled.
    const raced = Promise.withResolvers<null>();
    const host = await hostOf(by, workflow.id, {
      admitAttempt: async (attempt) => {
        if (attempt.step === "task:slow-done@pick.0") {
          await raced.promise;
        }
        return await admittedFreely();
      },
    });
    let ranLoser = false;
    const loser = host.do("task:slow-done@pick.0", ada, async () => {
      ranLoser = true;
      await Promise.resolve();
      return { ok: true, value: { output: { status: "slow" } } };
    });
    const won = await host.do("task:pick", ada, async (attempt) => {
      const branch = await attempt.settle({ branch: 1 });
      return {
        ok: true,
        value: { output: null, branch: branch.ok ? branch.value : null },
      };
    });
    raced.resolve(null);
    expect({
      won: won.ok && won.value,
      loser: codeOf(await loser),
      ranLoser,
    }).toStrictEqual({
      won: { output: null, branch: 1 },
      loser: "workflow.branch_cancelled",
      ranLoser: false,
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
