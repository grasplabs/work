import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

import { Workflow } from "../src/binding.ts";
import type { InstanceStatus } from "../src/contracts.ts";
import { runObjectName } from "../src/identity.ts";
import type { Journal } from "../src/journal.ts";
import type { TestRuns } from "./worker.ts";

const pollMs = 10;
const deadlineMs = 5000;

export const workflow = (definition: string): Workflow =>
  new Workflow(env.RUNS, definition);

/** The run's own object, for its journal and its alarm. */
export const runObject = (
  definition: string,
  id: string
): DurableObjectStub<TestRuns> =>
  env.RUNS.get(env.RUNS.idFromName(runObjectName(definition, id)));

export const journalOf = async (
  definition: string,
  id: string
): Promise<Journal> => {
  const journal = await runObject(definition, id).journal();
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

/** Waits until the run has ended, and returns how. */
export const ended = async (
  definition: string,
  id: string
): Promise<InstanceStatus> => {
  const instance = await workflow(definition).get(id);
  return await until(`run ${id} to end`, async () => {
    const status = await instance.status();
    return status.status === "complete" || status.status === "errored"
      ? status
      : undefined;
  });
};

export const newId = (): string => crypto.randomUUID();

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
