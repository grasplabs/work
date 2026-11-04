import type {
  HistoryRecord,
  ReadableHistoryRecord,
  StepIdentity,
} from "@grasp-os/workerflow/run";
import { describe, expect, it } from "vite-plus/test";

import { historyTeller } from "../src/workflows/history.ts";
import { waitKeyOf, waitStep } from "../src/workflows/host.ts";
import { traceReading } from "../src/workflows/resource-run-trace.ts";

// How a run's history and its trace read the steps the run host runs a
// step again in under its catch's retry policy (host.ts, `#retried`):
// `$grasp:wait:<key>:retry:<round>:decide`, `…:wait` and `…:run`, by the
// step's key. Each round's run is more attempts of the step, its backoff
// a wait of the step's, its decision nothing a person reads. Parsers of
// the engine's own records, so the records are the engine's shape.

/** The engine's step of `name`, first reached at `ordinal`. */
const stepOf = (
  ordinal: number,
  name: string,
  kind: "do" | "sleep" = "do"
): NonNullable<ReadableHistoryRecord["step"]> => ({
  ordinal,
  name,
  occurrence: 1,
  kind,
  eventType: null,
});

/** The step's identity, as a history read lists it. */
const identityOf = (
  ordinal: number,
  name: string,
  kind: "do" | "sleep",
  attempt: number
): StepIdentity => ({ ordinal, name, occurrence: 1, kind, attempt });

/** Any number, as a matcher. */
const anyNumber: unknown = expect.any(Number);

let eventId = 0;

/** A record of `type` of the step at `ordinal`, as the engine journals it. */
const recordOf = (
  type: ReadableHistoryRecord["type"],
  step: NonNullable<ReadableHistoryRecord["step"]>,
  extra: Partial<
    Pick<ReadableHistoryRecord, "attempt" | "final" | "error" | "durationMs">
  > = {}
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

const roundError = {
  name: "Error",
  message: "not yet",
  code: "internal.unexpected",
};

/**
 * The journal of a sealed run's step `fetch:task`, failing its first
 * round and retried in a second, as far as `second` says: still backing
 * off before it, or its run completed or failed.
 */
const retriedJournal = async (
  second: "completed" | "failed" | "backingOff"
) => {
  const base = "fetch:task";
  const prefix = waitStep(await waitKeyOf(base), "retry", 2);
  const own = stepOf(1, base);
  const decide = stepOf(2, `${prefix}:decide`);
  const backoff = stepOf(3, `${prefix}:wait`, "sleep");
  const run = stepOf(4, `${prefix}:run`);
  const records = [
    recordOf("attempt_started", own, { attempt: 1 }),
    recordOf("attempt_errored", own, {
      attempt: 1,
      final: true,
      error: roundError,
    }),
    recordOf("step_errored", own, {
      attempt: 1,
      final: true,
      error: roundError,
    }),
    recordOf("attempt_started", decide, { attempt: 1 }),
    recordOf("attempt_completed", decide, { attempt: 1 }),
    recordOf("sleep_started", backoff, { durationMs: 1000 }),
  ];
  if (second === "backingOff") {
    const steps = [
      identityOf(1, base, "do", 1),
      identityOf(2, decide.name, "do", 1),
    ];
    const waits = [
      identityOf(2, decide.name, "do", 1),
      identityOf(3, backoff.name, "sleep", 0),
    ];
    return { records, waits, steps };
  }
  records.push(
    recordOf("sleep_completed", backoff),
    recordOf("attempt_started", run, { attempt: 1 }),
    ...(second === "completed"
      ? [recordOf("attempt_completed", run, { attempt: 1 })]
      : [
          recordOf("attempt_errored", run, {
            attempt: 1,
            final: true,
            error: roundError,
          }),
          recordOf("step_errored", run, {
            attempt: 1,
            final: true,
            error: roundError,
          }),
        ])
  );
  const doSteps = [
    identityOf(1, base, "do", 1),
    identityOf(2, decide.name, "do", 1),
    identityOf(4, run.name, "do", 1),
  ];
  const waits = [
    identityOf(2, decide.name, "do", 1),
    identityOf(3, backoff.name, "sleep", 0),
    identityOf(4, run.name, "do", 1),
  ];
  return { records, waits, steps: doSteps };
};

/** What a page of the run's history tells of `journal`. */
const told = async (journal: Awaited<ReturnType<typeof retriedJournal>>) => {
  const tell = await historyTeller(journal, {
    sees: false,
    taskOf: (name) => (name === "fetch:task" ? "fetch" : null),
  });
  return journal.records.flatMap((record) => {
    const entry = tell(record);
    if (entry === undefined) {
      return [];
    }
    const { id: _id, sequence: _sequence, at: _at, ...shown } = entry;
    return [shown];
  });
};

describe("a step its catch's retry policy runs again", () => {
  it("is told in its run's history as more attempts of its step, retrying after a round failed, waiting while it backs off", async () => {
    const failedText: unknown = expect.any(String);
    const backingOff = await told(await retriedJournal("backingOff"));
    expect({
      // Its round's failure is retried from the start of its backoff.
      backingOff: backingOff.map((entry) =>
        "state" in entry ? entry.state : entry.kind
      ),
      completed: await told(await retriedJournal("completed")),
      failed: await told(await retriedJournal("failed")),
    }).toStrictEqual({
      backingOff: ["started", "retrying", "opened"],
      completed: [
        {
          taskId: "fetch",
          kind: "step",
          stepId: "step-1",
          state: "started",
          attempt: 1,
        },
        {
          taskId: "fetch",
          kind: "step",
          stepId: "step-1",
          state: "retrying",
          attempt: 1,
        },
        {
          taskId: "fetch",
          kind: "wait",
          waitId: "step-1",
          waitKind: "timer",
          state: "opened",
          deadline: anyNumber,
        },
        {
          taskId: "fetch",
          kind: "wait",
          waitId: "step-1",
          waitKind: "timer",
          state: "closed",
          deadline: null,
        },
        {
          taskId: "fetch",
          kind: "step",
          stepId: "step-1",
          state: "started",
          attempt: 2,
        },
        {
          taskId: "fetch",
          kind: "step",
          stepId: "step-1",
          state: "completed",
          attempt: 2,
        },
      ],
      // Its last round's failure is the step's, as no retry follows it.
      failed: [
        {
          taskId: "fetch",
          kind: "step",
          stepId: "step-1",
          state: "started",
          attempt: 1,
        },
        {
          taskId: "fetch",
          kind: "step",
          stepId: "step-1",
          state: "retrying",
          attempt: 1,
        },
        {
          taskId: "fetch",
          kind: "wait",
          waitId: "step-1",
          waitKind: "timer",
          state: "opened",
          deadline: anyNumber,
        },
        {
          taskId: "fetch",
          kind: "wait",
          waitId: "step-1",
          waitKind: "timer",
          state: "closed",
          deadline: null,
        },
        {
          taskId: "fetch",
          kind: "step",
          stepId: "step-1",
          state: "started",
          attempt: 2,
        },
        {
          taskId: "fetch",
          kind: "step",
          stepId: "step-1",
          state: "failed",
          attempt: 2,
          error: { code: "internal.unexpected", message: failedText },
        },
      ],
    });
  });

  it("is traced as rounds of its task's step, waiting while it backs off", async () => {
    // The trace reads today's generator's step names (`task:<id>`); a
    // retry's rounds under core's prefix go by the step's key alike.
    const base = "task:fetch";
    const prefix = waitStep(await waitKeyOf(base), "retry", 2);
    const own = stepOf(1, base);
    const run = stepOf(4, `${prefix}:run`);
    const backoff = stepOf(3, `${prefix}:wait`, "sleep");
    const reading = traceReading();
    const states: string[] = [];
    for (const record of [
      recordOf("step_started", own, { attempt: 1 }),
      recordOf("step_errored", own, { attempt: 1, error: roundError }),
      recordOf("attempt_completed", stepOf(2, `${prefix}:decide`), {
        attempt: 1,
      }),
      recordOf("sleep_started", backoff, { durationMs: 1000 }),
      recordOf("sleep_completed", backoff),
      recordOf("step_started", run, { attempt: 1 }),
      recordOf("step_completed", run, { attempt: 1 }),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- in the order the run journaled them
      await reading.fold(record);
      states.push(
        reading
          .steps()
          .map(({ state }) => state)
          .join(",")
      );
    }
    expect({
      states,
      steps: reading
        .steps()
        .map(({ ordinal, task, state, attempts, errorCode }) => ({
          ordinal,
          task,
          state,
          attempts,
          errorCode,
        })),
    }).toStrictEqual({
      states: [
        "running",
        "failed",
        "failed",
        "waiting",
        "running",
        "running",
        "reached",
      ],
      steps: [
        {
          ordinal: 1,
          task: "fetch",
          state: "reached",
          attempts: 2,
          errorCode: null,
        },
      ],
    });
  });
});
