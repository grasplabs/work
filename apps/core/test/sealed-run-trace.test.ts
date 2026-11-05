import type {
  HistoryRecord,
  ReadableHistoryRecord,
} from "@grasp-os/workerflow/run";
import { describe, expect, it } from "vite-plus/test";

import { waitKeyOf, waitStep, waitStepPrefix } from "../src/workflows/host.ts";
import { traceReading } from "../src/workflows/resource-run-trace.ts";
import type { SealedSteps } from "../src/workflows/sealed-steps.ts";

// How a run's trace reads the steps a run of a build generated for the run
// host runs (sealed-steps.ts): `<task>:<kind>` with each loop's index
// after `@`, as the SDK encodes a key, placed by its build's table of
// tasks; a decision's own steps past its task step and core's steps of
// its wait by that wait's key. A parser of the engine's own records, so
// the records are the engine's shape.

/** A fixed wait, a deadline, a decision, a try and a wait in loop `rows`. */
const sealed: SealedSteps = new Map([
  ["linger", { steps: ["task"], scope: [] }],
  ["pause", { steps: ["enter", "task"], scope: [] }],
  ["approve", { steps: ["enter", "task", "leave"], scope: [] }],
  ["guarded", { steps: ["catch"], scope: [] }],
  ["rows", { steps: ["enter", "item"], scope: [] }],
  ["nap", { steps: ["task"], scope: ["rows"] }],
]);

let ordinals = 0;
let eventId = 0;

/** A record of `type` of `step`, as the engine journals it. */
const recordOf = (
  type: ReadableHistoryRecord["type"],
  step: NonNullable<ReadableHistoryRecord["step"]>,
  extra: Partial<Pick<ReadableHistoryRecord, "attempt" | "error">> = {}
): HistoryRecord => {
  eventId += 1;
  return {
    unreadable: false,
    eventId,
    at: 1000 * eventId,
    type,
    step,
    attempt: null,
    final: false,
    error: null,
    durationMs: null,
    rollbackEnd: null,
    ...extra,
  };
};

/** The engine's records of a `do` step `name` that completed. */
const done = (name: string): HistoryRecord[] => {
  ordinals += 1;
  const step = {
    ordinal: ordinals,
    name,
    occurrence: 1,
    kind: "do" as const,
    eventType: null,
  };
  return [
    recordOf("step_started", step, { attempt: 1 }),
    recordOf("step_completed", step, { attempt: 1 }),
  ];
};

/** The engine's records of a `do` step `name` that failed for good. */
const failed = (name: string): HistoryRecord[] => {
  ordinals += 1;
  const step = {
    ordinal: ordinals,
    name,
    occurrence: 1,
    kind: "do" as const,
    eventType: null,
  };
  const error = { name: "Error", message: "declined", code: "connect.denied" };
  return [
    recordOf("step_started", step, { attempt: 1 }),
    recordOf("step_errored", step, { attempt: 1, error }),
  ];
};

/** The engine's records of a sleep or wait `name`, still open or over. */
const waited = (
  name: string,
  kind: "sleep" | "waitForEvent",
  over: boolean
): HistoryRecord[] => {
  ordinals += 1;
  const step = {
    ordinal: ordinals,
    name,
    occurrence: 1,
    kind,
    eventType: null,
  };
  const [started, ended] =
    kind === "sleep"
      ? (["sleep_started", "sleep_completed"] as const)
      : (["wait_started", "wait_completed"] as const);
  return over
    ? [recordOf(started, step), recordOf(ended, step)]
    : [recordOf(started, step)];
};

/** The steps `records` tell, read against `steps` (the test build's). */
const traced = async (
  records: readonly HistoryRecord[],
  steps: SealedSteps = sealed
) => {
  const reading = traceReading(steps);
  for (const record of records) {
    // oxlint-disable-next-line no-await-in-loop -- in the order the run journaled them
    await reading.fold(record);
  }
  return reading.steps().map(({ task, item, state, attempts }) => ({
    task,
    item,
    state,
    attempts,
  }));
};

describe("a run on the run host's trace", () => {
  it("shows a fixed wait and a deadline's waiting, its until recorded first", async () => {
    await expect(
      traced(
        [
          ...waited("linger:task", "sleep", true),
          ...done("pause:enter"),
          ...waited("pause:task", "sleep", false),
        ],
        sealed
      )
    ).resolves.toStrictEqual([
      { task: "linger", item: null, state: "reached", attempts: 0 },
      { task: "pause", item: null, state: "reached", attempts: 1 },
      { task: "pause", item: null, state: "waiting", attempts: 0 },
    ]);
  });

  it("shows a decision's task step waiting while its people are asked and it waits, and reached once its outcome is recorded", async () => {
    const answer = "approve:task#answer";
    const core = `${waitStepPrefix}${await waitKeyOf(answer)}`;
    const opened = [
      ...done("approve:enter"),
      ...done("approve:task"),
      ...done("approve:task#ask"),
      ...done("approve:task#asked"),
      ...done(`${core}:reached`),
      ...waited(answer, "waitForEvent", false),
    ];
    const waiting = await traced(opened, sealed);
    // Its wake found nothing answered: it waits again, then it's answered.
    const decided = await traced(
      [
        ...opened.slice(0, -1),
        ...waited(answer, "waitForEvent", true),
        ...done(`${core}:woken:0`),
        ...waited(`${core}:again:1`, "waitForEvent", true),
        ...done(`${core}:woken:1`),
        ...done(`${core}:outcome`),
        ...done("approve:leave"),
      ],
      sealed
    );
    // Answered by the time it first looked: it never waits.
    const early = await traced(
      [...opened.slice(0, -1), ...done(`${core}:outcome`)],
      sealed
    );
    expect({ waiting, decided, early }).toStrictEqual({
      waiting: [
        { task: "approve", item: null, state: "reached", attempts: 1 },
        { task: "approve", item: null, state: "waiting", attempts: 1 },
      ],
      decided: [
        { task: "approve", item: null, state: "reached", attempts: 1 },
        { task: "approve", item: null, state: "reached", attempts: 1 },
        { task: "approve", item: null, state: "reached", attempts: 1 },
      ],
      early: [
        { task: "approve", item: null, state: "reached", attempts: 1 },
        { task: "approve", item: null, state: "reached", attempts: 1 },
      ],
    });
  });

  it("shows each loop item's wait as its own step, placed in its item, and a try's catch", async () => {
    await expect(
      traced(
        [
          ...done("rows:enter"),
          ...done("rows:item%400"),
          ...waited("nap:task%400", "sleep", true),
          ...done("rows:item%401"),
          ...waited("nap:task%401", "sleep", false),
          ...done("guarded:catch"),
        ],
        sealed
      )
    ).resolves.toStrictEqual([
      { task: "rows", item: null, state: "reached", attempts: 1 },
      { task: "rows", item: "rows.0", state: "reached", attempts: 1 },
      { task: "nap", item: "rows.0", state: "reached", attempts: 0 },
      { task: "rows", item: "rows.1", state: "reached", attempts: 1 },
      { task: "nap", item: "rows.1", state: "waiting", attempts: 0 },
      { task: "guarded", item: null, state: "reached", attempts: 1 },
    ]);
  });

  it("reads only the step names its build's table has, in the run host's encoding", async () => {
    const records = [
      ...waited("linger:task", "sleep", false),
      ...waited("task:linger", "sleep", false),
      // No such task or step, an item of a task in no loop, another
      // encoding of an index.
      ...waited("ghost:task", "sleep", false),
      ...waited("linger:enter", "sleep", false),
      ...waited("linger:task%400", "sleep", false),
      ...waited("nap:task@0", "sleep", false),
    ];
    await expect(traced(records)).resolves.toStrictEqual([
      { task: "linger", item: null, state: "waiting", attempts: 0 },
    ]);
  });

  it("shows a call held for its person waiting, then an attempt more once it runs again, reached or failed", async () => {
    const held = waitStep(await waitKeyOf("fetch:task"), "held", 1);
    const steps: SealedSteps = new Map([
      ["fetch", { steps: ["task"], scope: [] }],
    ]);
    const holding = [
      // It ends its round held, then waits for its person.
      ...done("fetch:task"),
      ...done(`${held}:0:check`),
      ...done(`${held}:waiting:held`),
      ...waited(`${held}:0`, "waitForEvent", true),
      ...done(`${held}:1:check`),
    ];
    const shown = async (end: HistoryRecord[]) => {
      const traces = await traced([...holding, ...end], steps);
      return traces.map(({ state, attempts }) => `${state}:${attempts}`);
    };
    expect({
      waiting: await shown([]),
      confirmed: await shown(done(`${held}:run`)),
      declined: await shown(failed(`${held}:run`)),
    }).toStrictEqual({
      waiting: ["waiting:1"],
      confirmed: ["reached:2"],
      declined: ["failed:2"],
    });
  });
});
