import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

import { Workflow } from "../src/binding.ts";
import type { InstanceStatus } from "../src/contracts.ts";
import { runObjectName } from "../src/identity.ts";
import type { Journal } from "../src/journal.ts";
import { WorkflowRun } from "../src/run.ts";
import type { TestRuns } from "./worker.ts";

const pollMs = 10;
const deadlineMs = 10_000;

/** Where a test's runs live: `RUNS`, unless it says otherwise. */
type Runs = DurableObjectNamespace<TestRuns>;

export const workflow = (definition: string, runs: Runs = env.RUNS): Workflow =>
  new Workflow(runs, definition);

/** The run's own object, for its journal and its alarm. */
export const runObject = (
  definition: string,
  id: string,
  runs: Runs = env.RUNS
): DurableObjectStub<TestRuns> =>
  runs.get(runs.idFromName(runObjectName(definition, id)));

export const journalOf = async (
  definition: string,
  id: string,
  runs: Runs = env.RUNS
): Promise<Journal> => {
  const journal = await runObject(definition, id, runs).journal();
  if (journal === undefined) {
    throw new Error(`run ${id} has no journal`);
  }
  return journal;
};

/** Polls `check` until it returns something, or fails at the deadline. */
export const until = async <T>(
  what: string,
  check: () => Promise<T | undefined> | T | undefined
): Promise<T> => {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    // oxlint-disable-next-line no-await-in-loop -- polling, one check at a time
    const value = await check();
    if (value !== undefined) {
      return value;
    }
    // oxlint-disable-next-line no-await-in-loop -- polling, one check at a time
    await scheduler.wait(pollMs);
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** Awaits `promise`, or fails at the deadline. */
export const within = async <T>(
  what: string,
  promise: Promise<T>
): Promise<T> => {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    deadline.reject(new Error(`timed out waiting for ${what}`));
  }, deadlineMs);
  try {
    return await Promise.race([promise, deadline.promise]);
  } finally {
    clearTimeout(timer);
  }
};

/** Waits until the run has ended, and returns how. */
export const ended = async (
  definition: string,
  id: string,
  runs: Runs = env.RUNS
): Promise<InstanceStatus> => {
  const instance = await workflow(definition, runs).get(id);
  return await until(`run ${id} to end`, async () => {
    const status = await instance.status();
    return status.status === "complete" || status.status === "errored"
      ? status
      : undefined;
  });
};

export const newId = (): string => crypto.randomUUID();

/** When the run's alarm is due, or null when it has none. */
export const alarmOf = async (
  definition: string,
  id: string
): Promise<number | null> =>
  await runInDurableObject(
    runObject(definition, id),
    async (_, state) => await state.storage.getAlarm()
  );

/** Waits until the run is suspended, and returns its journal then. */
export const suspendedOn = async (
  definition: string,
  id: string,
  step: string
): Promise<{ journal: Journal; deadline: number }> =>
  await until(`run ${id} to wait at ${step}`, async () => {
    const journal = await journalOf(definition, id);
    const waiting = journal.steps.find(
      (row) => row.name === step && row.state === "waiting"
    );
    return journal.run.status === "waiting" &&
      typeof waiting?.deadline === "number"
      ? { journal, deadline: waiting.deadline }
      : undefined;
  });

/** Waits until the clock is past `time`. */
export const pastTime = async (time: number): Promise<void> => {
  await until(`the clock to pass ${time}`, () =>
    Date.now() > time ? true : undefined
  );
};

/**
 * Holds back the run's alarm until `time`, as a host that delivers it late
 * would; `before` runs first, with no event of the object in between.
 */
export const holdAlarmUntil = async (
  definition: string,
  id: string,
  time: number,
  before: (run: WorkflowRun) => Promise<unknown> = async () => {
    await Promise.resolve();
  }
): Promise<void> => {
  await runInDurableObject(runObject(definition, id), async (run, state) => {
    if (!(run instanceof WorkflowRun)) {
      throw new TypeError("the object isn't a run object");
    }
    await state.blockConcurrencyWhile(async () => {
      await before(run);
      await state.storage.setAlarm(time);
    });
  });
};

/** Sends the run an alarm of its own, as a duplicate delivery would. */
export const deliverAlarm = async (
  definition: string,
  id: string
): Promise<void> => {
  await runInDurableObject(runObject(definition, id), async (run) => {
    if (run.alarm === undefined) {
      throw new Error("the run object has no alarm handler");
    }
    await run.alarm();
  });
};
