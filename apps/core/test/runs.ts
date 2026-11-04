/**
 * Workflow runs as tests drive them from outside: through the engine's own
 * run objects (Workerflow), as a crash, a deploy or time passing would.
 */
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { decode, encode } from "@grasp-os/workerflow/codec";
import { runObjectName } from "@grasp-os/workerflow/identity";
import { WorkflowInstance } from "@grasp-os/workerflow/instance";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, vi } from "vite-plus/test";
import { z } from "zod";

import { runDefinition } from "../src/workflows/engine.ts";
import type { AttemptAdmission } from "../src/workflows/quotas.ts";
import { allEvents } from "./audit-events.ts";

/** The ID of the run's object, as the engine names it (engine.ts). */
export const runObjectId = (run: string): DurableObjectId =>
  env.WORKFLOW_RUNS.idFromName(runObjectName(runDefinition, run));

/** The run's object: by name, so `aroundEngine` leaves the test's calls be. */
export const runObject = (run: string) =>
  env.WORKFLOW_RUNS.getByName(runObjectName(runDefinition, run));

/** The run, as the engine's instance API holds it. */
export const runInstance = (run: string): WorkflowInstance =>
  new WorkflowInstance(run, runObject(run));

/** Where the engine has a run now. */
export const liveStatus = async (run: string): Promise<string> => {
  const { status } = await runInstance(run).status();
  return status;
};

/**
 * Stops a run's activation, as a crash or a deploy does; resuming it runs
 * the workflow again from its start, loaded anew, finished steps replayed.
 * The engine lets a run stop at a safe boundary: between steps, or while
 * it waits.
 */
export const stopped = async (run: string): Promise<void> => {
  const instance = runInstance(run);
  await instance.pause();
  await vi.waitFor(
    async () => {
      await expect(instance.status()).resolves.toMatchObject({
        status: "paused",
      });
    },
    { timeout: 10_000, interval: 100 }
  );
};

/** Resumes a run `stopped` stopped. */
export const resumed = async (run: string): Promise<void> => {
  await runInstance(run).resume();
};

const endedStatuses = new Set(["complete", "errored", "terminated"]);

/** Once the run has ended, however it ended, waiting up to `timeout` ms. */
export const finished = async (
  run: string,
  timeout = 20_000
): Promise<void> => {
  await vi.waitFor(
    async () => {
      expect(endedStatuses).toContain(await liveStatus(run));
    },
    { timeout, interval: 200 }
  );
};

/**
 * Once the engine reports that the run began its sleep `step`, from the
 * run's own event stream, which the engine writes as the sleep begins.
 */
export const sleeping = async (run: string, step: string): Promise<void> => {
  using events = await runInstance(run).subscribe({
    filter: ["sleep_started"],
  });
  await vi.waitFor(
    async () => {
      const { done, value } = await events.next();
      if (done === true) {
        throw new Error(`Run ${run} ended before it slept in ${step}`);
      }
      // The engine names a sleep after its step, with a count behind.
      expect(
        value.type === "sleep_started" && value.stepName.startsWith(step)
      ).toBeTruthy();
    },
    { timeout: 10_000, interval: 100 }
  );
};

/**
 * Once the run, `stopped` and `resumed`, began a sleep in a step whose
 * name starts with `step` in the resumed activation: as `sleeping`, but
 * only a sleep the engine reports after it resumed the run counts. The
 * resumed activation has then replayed every step before that sleep.
 */
export const sleepingOnceResumed = async (
  run: string,
  step: string
): Promise<void> => {
  using events = await runInstance(run).subscribe({
    filter: ["workflow_paused", "workflow_running", "sleep_started"],
  });
  let paused = false;
  let resumedRun = false;
  await vi.waitFor(
    async () => {
      const { done, value } = await events.next();
      if (done === true) {
        throw new Error(`Run ${run} ended before it slept in ${step}`);
      }
      if (value.type === "workflow_paused") {
        paused = true;
        resumedRun = false;
      } else if (value.type === "workflow_running" && paused) {
        resumedRun = true;
      }
      expect(
        resumedRun &&
          value.type === "sleep_started" &&
          value.stepName.startsWith(step)
      ).toBeTruthy();
    },
    { timeout: 10_000, interval: 100 }
  );
};

/** Where a run stands with its sleep `step`, as its journal has it. */
type SleepState = "ended" | "passed" | "asleep" | "not_yet";

/**
 * Ends the run's sleep `step` now, as its time passing would: a workflow
 * under test sleeps a day where the test acts on it while it is live, and
 * this lets it go on. The sleep's deadline, as the engine journaled it, is
 * moved to now, and the run's alarm with it: the next activation replays
 * the steps before it, and passes it. A run a test stopped is resumed,
 * its sleep due as it resumes; one that never gets to the sleep (it fails
 * as it loads, say) is left to end.
 */
export const woken = async (run: string, step = "go"): Promise<void> => {
  const object = runObject(run);
  if ((await liveStatus(run)) === "paused") {
    // Resuming moves each deadline on by the time the run was paused: one
    // set to when it paused comes due as it resumes.
    await runInDurableObject(object, (_object, state) => {
      state.storage.sql.exec(
        "UPDATE steps SET deadline = (SELECT paused_at FROM run) WHERE type = 'sleep' AND state = 'waiting' AND name = ?",
        step
      );
    });
    await resumed(run);
  }
  await vi.waitFor(
    async () => {
      const found = await runInDurableObject(
        object,
        async (_object, state): Promise<SleepState> => {
          const { sql } = state.storage;
          const [current] = sql
            .exec<{ status: string }>("SELECT status FROM run")
            .toArray();
          if (current === undefined || endedStatuses.has(current.status)) {
            return "ended";
          }
          const [sleep] = sql
            .exec<{ state: string; deadline: number | null }>(
              "SELECT state, deadline FROM steps WHERE type = 'sleep' AND name = ?",
              step
            )
            .toArray();
          if (sleep?.state === "succeeded") {
            return "passed";
          }
          if (sleep?.state !== "waiting" || current.status !== "waiting") {
            return "not_yet";
          }
          const now = Date.now();
          sql.exec(
            "UPDATE steps SET deadline = ? WHERE type = 'sleep' AND state = 'waiting' AND name = ?",
            now,
            step
          );
          sql.exec("UPDATE run SET wake_at = ?", now);
          await state.storage.setAlarm(now);
          return "asleep";
        }
      );
      expect(found).not.toBe("not_yet");
    },
    { timeout: 10_000, interval: 100 }
  );
};

/**
 * A look a decision wait records (resource-host.ts and host.ts, `look`):
 * when it looked, by the clock, and whether anyone had answered.
 */
const decisionLook = /(?::reached|:decision:reminded|:woken:\d+)$/u;
const lookedSchema = z.looseObject({ at: z.number() });
/**
 * An enter step's journal with its task's deadline (resource-host.ts,
 * `#entered`): its record's `until`.
 */
const deadlineSchema = z.looseObject({
  record: z.looseObject({ until: z.number() }),
});

/**
 * What step `name` recorded (`value`), its instants of a decision moved
 * back by `ms`: a look's `at`, an enter step's deadline. Nothing else.
 */
const movedBack = (name: string, value: unknown, ms: number): unknown => {
  const looked = lookedSchema.safeParse(value);
  if (decisionLook.test(name) && looked.success) {
    return { ...looked.data, at: looked.data.at - ms };
  }
  const entered = deadlineSchema.safeParse(value);
  if (entered.success) {
    const { record } = entered.data;
    return { ...entered.data, record: { ...record, until: record.until - ms } };
  }
  return undefined;
};

/**
 * Whether the run is parked on an event wait (a decision's): suspended
 * on it, or stopped while in it.
 */
const parkedIn = (sql: SqlStorage): "waiting" | "paused" | "not_yet" => {
  const [current] = sql
    .exec<{ status: string }>("SELECT status FROM run")
    .toArray();
  const waiting = sql
    .exec(
      "SELECT 1 FROM steps WHERE type = 'waitForEvent' AND state = 'waiting'"
    )
    .toArray();
  if (
    waiting.length === 0 ||
    (current?.status !== "waiting" && current?.status !== "paused")
  ) {
    return "not_yet";
  }
  return current.status;
};

/**
 * Lets `ms` pass for the decision run `run` waits on, as its clock would,
 * without the test waiting for it: every instant the run recorded of it
 * (each look's `at`, a task's deadline) and the decision's own deadline
 * are moved back by `ms`, so each wait keeps its length on replay, and
 * the wait it is in comes due now. The next activation replays the run,
 * on those moved instants, and goes on as it would have `ms` later. A run
 * a test stopped is resumed, its wait due as it resumes.
 */
export const decisionTimePassed = async (
  run: string,
  ms: number
): Promise<void> => {
  const object = runObject(run);
  // Parked first: a run that hasn't reached its wait yet would read the
  // decision's moved deadline (host.ts reads it as it waits) and not wait.
  // Once parked, nothing of it moves until its wait comes due.
  await vi.waitFor(
    async () => {
      const state = await runInDurableObject(object, (_object, durable) =>
        parkedIn(durable.storage.sql)
      );
      expect(state).not.toBe("not_yet");
    },
    { timeout: 10_000, interval: 100 }
  );
  await env.DB.prepare(
    "UPDATE workflow_decisions SET expires_at = expires_at - ? WHERE run_id = ? OR resource_run_id = ?"
  )
    .bind(ms, run, run)
    .run();
  const found = await runInDurableObject(object, async (_object, durable) => {
    const { sql } = durable.storage;
    const state = parkedIn(sql);
    if (state === "not_yet") {
      throw new Error(`Run ${run} went on before its time passed`);
    }
    const recorded = sql
      .exec<{ ordinal: number; name: string; value: string }>(
        "SELECT ordinal, name, value FROM steps WHERE type = 'do' AND state = 'succeeded' AND value IS NOT NULL"
      )
      .toArray();
    for (const { ordinal, name, value } of recorded) {
      const moved = movedBack(name, decode(value), ms);
      if (moved !== undefined) {
        sql.exec(
          "UPDATE steps SET value = ? WHERE ordinal = ?",
          encode(moved),
          ordinal
        );
      }
    }
    if (state === "paused") {
      // Resuming moves each deadline on by the time the run was paused:
      // one set to when it paused comes due as it resumes.
      sql.exec(
        "UPDATE steps SET deadline = (SELECT paused_at FROM run) WHERE type = 'waitForEvent' AND state = 'waiting'"
      );
      return state;
    }
    const now = Date.now();
    sql.exec(
      "UPDATE steps SET deadline = ? WHERE type = 'waitForEvent' AND state = 'waiting'",
      now
    );
    sql.exec("UPDATE run SET wake_at = ?", now);
    await durable.storage.setAlarm(now);
    return state;
  });
  if (found === "paused") {
    await resumed(run);
  }
};

/**
 * Runs `run` with every call core makes on a run object going through
 * `around`, which makes it (`call`) or doesn't: the engine as a slow or
 * failing outside system would be. Calls through the test's own
 * `runObject` go straight to the run.
 */
export const aroundEngine = async <T>(
  around: (
    method: string,
    call: () => Promise<unknown>,
    object: DurableObjectId
  ) => Promise<unknown>,
  run: () => Promise<T>
): Promise<T> => {
  const namespace = env.WORKFLOW_RUNS;
  const get = namespace.get.bind(namespace);
  const intercepted = vi
    .spyOn(namespace, "get")
    .mockImplementation((id, options) => {
      const stub = get(id, options);
      return new Proxy(stub, {
        get: (target, property) => {
          const value: unknown = Reflect.get(target, property);
          if (typeof value !== "function" || typeof property !== "string") {
            return value;
          }
          return async (...args: unknown[]): Promise<unknown> =>
            await around(
              property,
              async (): Promise<unknown> => {
                const result: unknown = await Reflect.apply(
                  value,
                  target,
                  args
                );
                return result;
              },
              id
            );
        },
      });
    });
  try {
    return await run();
  } finally {
    intercepted.mockRestore();
  }
};

/**
 * Runs `run` while the engine fails each call `refused` names on a run
 * object, as when its storage is down: the call rejects, and nothing of
 * it reaches the run.
 */
export const whileEngineRefuses = async <T>(
  refused: (method: string) => boolean,
  run: () => Promise<T>
): Promise<T> =>
  await aroundEngine(async (method, call) => {
    if (refused(method)) {
      throw new Error("The engine is unavailable");
    }
    return await call();
  }, run);

/** Once the run's step `step` has completed, as the audit log has it. */
export const stepDone = async (run: string, step: string): Promise<void> => {
  await vi.waitFor(
    async () => {
      const events = await allEvents();
      expect(
        events.some(
          ({ action, target, detail }) =>
            action === "workflow.step.completed" &&
            target?.id === run &&
            detail.step === step
        )
      ).toBeTruthy();
    },
    { timeout: 10_000, interval: 100 }
  );
};

/** Runs `endLiveRuns` has ended or found ended; it skips them after. */
const seenEnded = new Set<string>();

/**
 * Terminates every run a test left waiting, sleeping or paused. The
 * engine keeps those in the project's one workerd across test files, and
 * would go on in the background of whatever runs next: a decision's
 * week-long wait, a run paused, or one waiting while a feature was off.
 * Work that outlives its test is how a test file came to wait forever in
 * CI (see apps/core/vite.config.ts), so each test ends its runs.
 */
export const endLiveRuns = async (): Promise<void> => {
  // Only rows that may still have a live run: one that ended otherwise
  // (completed or failed) ended in the engine first. A cancelled one may
  // have a live run left, whose termination failed.
  const { results } = await env.DB.prepare(
    "SELECT id FROM workflow_runs WHERE status IN ('starting', 'running', 'paused', 'cancelled')"
  ).all<{ id: string }>();
  await Promise.all(
    results
      .filter(({ id }) => !seenEnded.has(id))
      .map(async ({ id }) => {
        // A row whose run never started has no run object: its status is
        // none, and there is nothing to terminate yet. It isn't skipped
        // after: its start is still pending, and a later repair can send
        // it (repairStarts), starting a run that would outlive its test.
        // Terminating a run that ended meanwhile does nothing.
        const status = await runObject(id).status();
        if (status === undefined) {
          return;
        }
        if (!endedStatuses.has(status.status)) {
          await runObject(id).terminate({ rollback: false });
        }
        seenEnded.add(id);
      })
  );
};

/** Removes a person from the organization; returns how to bring them back. */
export const leave = async (userId: string): Promise<() => Promise<void>> => {
  const membership = await env.DB.prepare(
    "SELECT * FROM members WHERE user_id = ?"
  )
    .bind(userId)
    .first<Record<string, string | number>>();
  await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
    .bind(userId)
    .run();
  return async () => {
    await env.DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(
        membership?.id,
        membership?.organization_id,
        membership?.user_id,
        membership?.role,
        membership?.created_at
      )
      .run();
  };
};

/**
 * The admission of a run host built by hand, for a run core has no row
 * of: every attempt admitted, nothing counted. The quotas have tests of
 * their own, against real runs.
 */
export const admittedFreely = async (): Promise<AttemptAdmission> =>
  await Promise.resolve({
    attemptsAllowed: platformLimits.workflowAttemptsPerStep,
    hostCall: async () => {
      await Promise.resolve();
    },
    settle: async () => {
      await Promise.resolve();
    },
  });

/**
 * The rows of an App's workflows or runs among `rows`, which list
 * independent workflows' too.
 */
export const ofApps = <Row extends { type: "app" | "resource" }>(
  rows: readonly Row[]
): Extract<Row, { type: "app" }>[] =>
  rows.filter(
    (row): row is Extract<Row, { type: "app" }> => row.type === "app"
  );

/** A run of an independent workflow, as core keeps it. */
export interface SeededResourceRun {
  workflow: string;
  principal: string;
  status: "starting" | "running" | "completed" | "failed" | "cancelled";
  createdAt: number;
  /** When it ended; when it started, for one that ended, unless given. */
  endedAt?: number | null;
}

/**
 * A run of an independent workflow, with the start receipt it was admitted
 * on, as core keeps them: its ID.
 */
export const seedResourceRun = async (
  run: SeededResourceRun
): Promise<string> => {
  const id = crypto.randomUUID();
  const ended =
    run.status === "starting" || run.status === "running"
      ? null
      : run.createdAt;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO workflow_start_receipts (id, invoker_type, invoker_id, idempotency_key, workflow_resource_id, workflow_resource_version, manifest_hash, principal_id, authority_generation, input_hash, created_at) VALUES (?, 'person', ?, ?, ?, 1, 'm', ?, 1, 'h', ?)"
    ).bind(
      id,
      run.principal,
      `key-${id}`,
      run.workflow,
      run.principal,
      run.createdAt
    ),
    env.DB.prepare(
      "INSERT INTO workflow_resource_runs (id, workflow_resource_id, version, manifest_hash, build_hash, principal_id, status, created_at, ended_at) VALUES (?, ?, 1, 'm', 'b', ?, ?, ?, ?)"
    ).bind(
      id,
      run.workflow,
      run.principal,
      run.status,
      run.createdAt,
      run.endedAt === undefined ? ended : run.endedAt
    ),
  ]);
  return id;
};
