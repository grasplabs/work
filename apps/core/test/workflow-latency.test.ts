/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { describe, expect, it } from "vite-plus/test";

import {
  builder,
  completedSteps,
  endOf,
  objectSchema,
  published,
  ranFor,
  startedSteps,
} from "./json-workflows.ts";

// Items and branches at once in JSON workflows, with the host's own I/O
// (its check of the run's person, its wait for one of the run's eight
// attempt slots) made slower at random, by up to 15 ms each time
// (vite.latency.config.ts, src/workflows/host-latency.ts). Local D1
// answers in well under a macrotask, which hid two ways a run went wrong
// only when its host was slower, as deployed:
// - the engine suspended the run while an ask was still in the host, on
//   its way to the engine, and the run slept for its other waits first:
//   a race's slower branch could win, and a replay could differ;
// - a replay held an outcome for a call not made yet, and gave up on it
//   once nothing seemed out, or held the ones after it for ever.
// Each scenario runs a few times: the latency is random.

const rounds = [1, 2, 3];

/** A branch `id`: a wait of `wait`, then a status `status`. */
const after = (id: string, wait: unknown, status: string) => ({
  [id]: {
    do: [
      { [`${id}-wait`]: { wait } },
      { [`${id}-done`]: { set: `\${ {status: "${status}"} }` } },
    ],
  },
});

/** A loop `id` of six items at once: a step, a wait, then another step. */
const sixAtOnce = (id: string) => ({
  [id]: {
    do: [
      {
        [`${id}-items`]: {
          for: { in: "${ [1, 2, 3, 4, 5, 6] }" },
          metadata: { grasp: { concurrency: 6 } },
          do: [
            { [`${id}-note`]: { set: "${ {v: $item} }" } },
            { [`${id}-nap`]: { wait: { milliseconds: 500 } } },
            { [`${id}-done`]: { set: "${ {v: $item} }" } },
          ],
          output: { as: '${ {status: (map(.v | tostring) | join(","))} }' },
        },
      },
    ],
  },
});

/** The items' notes and last steps, of either loop. */
const notes = /^task:(?:left|right)-note@/u;
const dones = /^task:(?:left|right)-done@/u;

/** How often each step whose name `pattern` matches completed. */
const completedOf = (steps: Map<string, number>, pattern: RegExp) =>
  [...steps].filter(([name]) => pattern.test(name)).map(([, count]) => count);

describe("items and branches at once, the host slow at random", () => {
  it("race: the branch due first wins every time, though the host is slow to reach its next step", async () => {
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
    for (const round of rounds) {
      // oxlint-disable-next-line no-await-in-loop -- one run at a time
      const run = await ranFor(by, workflow.id);
      // oxlint-disable-next-line no-await-in-loop -- one run at a time
      const completed = await completedSteps(run.id);
      expect({
        round,
        end: endOf(run),
        slow: completed.get("task:slow-done@pick.0") ?? 0,
      }).toStrictEqual({
        round,
        end: { status: "completed", output: { status: "quick" } },
        slow: 0,
      });
    }
  });

  it("replay twelve items at once past the host's eight slots, each step once", async () => {
    const by = await builder();
    const { workflow } = await published(by, [
      {
        pair: {
          fork: { branches: [sixAtOnce("left"), sixAtOnce("right")] },
          metadata: { grasp: { concurrency: 2 } },
          output: { as: '${ {status: (map(.status) | join(";"))} }' },
        },
      },
    ]);
    for (const round of rounds) {
      // oxlint-disable-next-line no-await-in-loop -- one run at a time
      const run = await ranFor(by, workflow.id);
      // oxlint-disable-next-line no-await-in-loop -- one run at a time
      const completed = await completedSteps(run.id);
      // Every activation after the waits replays the twelve notes at once.
      expect({
        round,
        end: endOf(run),
        notes: completedOf(completed, notes),
        done: completedOf(completed, dones).length,
      }).toStrictEqual({
        round,
        end: {
          status: "completed",
          output: { status: "1,2,3,4,5,6;1,2,3,4,5,6" },
        },
        notes: Array.from({ length: 12 }, () => 1),
        done: 12,
      });
    }
  });

  it("fail a fork at once with the branch that failed, starting none after it", async () => {
    const by = await builder();
    const { workflow } = await published(by, [
      {
        pick: {
          fork: {
            branches: [
              after("held", "PT1S", "held"),
              {
                broken: {
                  do: [
                    {
                      "broken-out": {
                        set: "${ {other: 1} }",
                        output: {
                          schema: objectSchema({
                            status: { type: "string" },
                          }),
                        },
                      },
                    },
                  ],
                },
              },
              after("third", "PT1S", "third"),
              after("fourth", "PT1S", "fourth"),
            ],
          },
          metadata: { grasp: { concurrency: 2 } },
        },
      },
    ]);
    for (const round of rounds) {
      // oxlint-disable-next-line no-await-in-loop -- one run at a time
      const run = await ranFor(by, workflow.id);
      // oxlint-disable-next-line no-await-in-loop -- one run at a time
      const started = await startedSteps(run.id);
      expect({
        round,
        end: endOf(run),
        later: started.filter(
          (name) => name.endsWith("@pick.2") || name.endsWith("@pick.3")
        ),
      }).toStrictEqual({
        round,
        end: { status: "failed", code: "workflow.task_data_invalid" },
        later: [],
      });
    }
  });
});
