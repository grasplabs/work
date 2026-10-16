/**
 * Workflow runs as tests drive them from outside: through the engine's own
 * run objects (Workerflow), as a crash, a deploy or time passing would.
 */
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { runObjectName } from "@grasp-os/workerflow/identity";
import { WorkflowInstance } from "@grasp-os/workerflow/instance";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, vi } from "vite-plus/test";

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

/** Once the run has ended, however it ended. */
export const finished = async (run: string): Promise<void> => {
  await vi.waitFor(
    async () => {
      expect(endedStatuses).toContain(await liveStatus(run));
    },
    { timeout: 20_000, interval: 200 }
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
        // none, and terminating it does nothing. Terminating a run that
        // ended meanwhile does nothing either.
        const status = await runObject(id).status();
        if (status !== undefined && !endedStatuses.has(status.status)) {
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
 * What `run` returns, with core's database failing the first read of the
 * quota policy meanwhile, as D1 can for a moment, and whether one failed.
 */
export const withPolicyReadFailingOnce = async <Result>(
  run: () => Promise<Result>
): Promise<{ failed: boolean; value: Result }> => {
  const database = env.DB;
  let failed = false;
  env.DB = new Proxy(database, {
    get: (target, property) => {
      if (property === "prepare") {
        return (query: string) => {
          if (!failed && query.includes("quota_policies")) {
            failed = true;
            return target.prepare("SELECT broken_for_the_test()");
          }
          return target.prepare(query);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
  try {
    return { value: await run(), failed };
  } finally {
    env.DB = database;
  }
};
