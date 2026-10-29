/**
 * The admin's workflow runs as tests drive them from outside: through
 * each run's own object (Workerflow, src/workflow-runs.ts), as time
 * passing, a crash or a duplicate delivery would.
 */
import type { InstanceStatus } from "@grasp-os/workerflow/contracts";
import { runObjectName } from "@grasp-os/workerflow/identity";
import type { Journal } from "@grasp-os/workerflow/run";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vite-plus/test";

import type { AdminWorkflow } from "../src/workflow-runs.ts";
import { adminWorkflow } from "../src/workflow-runs.ts";

const waitFor = { timeout: 10_000, interval: 50 } as const;

/** The object run `id` of `workflow` lives in. */
export const runObject = (workflow: AdminWorkflow, id: string) =>
  env.ADMIN_RUNS.getByName(runObjectName(workflow, id));

/** Run `id`'s journal, as its object keeps it. */
export const journalOf = async (
  workflow: AdminWorkflow,
  id: string
): Promise<Journal> => {
  const journal = await runObject(workflow, id).journal();
  if (journal === undefined) {
    throw new Error(`Run ${id} has no journal`);
  }
  return journal;
};

/** Once run `id` has a step named `name` that succeeded. */
export const stepSucceeded = async (
  workflow: AdminWorkflow,
  id: string,
  name: string
): Promise<void> => {
  await vi.waitFor(async () => {
    const { steps } = await journalOf(workflow, id);
    if (!steps.some((row) => row.name === name && row.state === "succeeded")) {
      throw new Error(`Run ${id} has no step ${name} that succeeded yet`);
    }
  }, waitFor);
};

const endedStatuses = new Set(["complete", "errored", "terminated"]);

/** Once run `id` has ended, how it ended. */
export const ended = async (
  workflow: AdminWorkflow,
  id: string
): Promise<InstanceStatus> => {
  const instance = await adminWorkflow(env, workflow).get(id);
  return await vi.waitFor(async () => {
    const status = await instance.status();
    if (!endedStatuses.has(status.status)) {
      throw new Error(`Run ${id} is ${status.status}`);
    }
    return status;
  }, waitFor);
};

/**
 * Once run `id` waits for an event in step `step`: its timeout moved to
 * now, and the run's alarm with it, so the wait times out as if its time
 * had passed.
 */
export const timedOut = async (
  workflow: AdminWorkflow,
  id: string,
  step: string
): Promise<void> => {
  await vi.waitFor(async () => {
    const waiting = await runInDurableObject(
      runObject(workflow, id),
      async (_object, state) => {
        const { sql } = state.storage;
        const [run] = sql
          .exec<{ status: string }>("SELECT status FROM run")
          .toArray();
        const [wait] = sql
          .exec<{ state: string }>(
            "SELECT state FROM steps WHERE type = 'waitForEvent' AND name = ?",
            step
          )
          .toArray();
        if (run?.status !== "waiting" || wait?.state !== "waiting") {
          return false;
        }
        const now = Date.now();
        sql.exec(
          "UPDATE steps SET deadline = ? WHERE type = 'waitForEvent' AND state = 'waiting' AND name = ?",
          now,
          step
        );
        sql.exec("UPDATE run SET wake_at = ?", now);
        await state.storage.setAlarm(now);
        return true;
      }
    );
    if (!waiting) {
      throw new Error(`Run ${id} doesn't wait in ${step} yet`);
    }
  }, waitFor);
};

/** Delivers run `id` its alarm again, as a duplicate delivery would. */
export const deliverAlarm = async (
  workflow: AdminWorkflow,
  id: string
): Promise<void> => {
  await runInDurableObject(runObject(workflow, id), async (object) => {
    await object.alarm();
  });
};

/** What a test reaches of a run's object: the env its definitions get. */
interface WithEnv {
  env: Env;
}

/**
 * Whether `object` keeps an env: a Durable Object keeps the one it was
 * made with as `env`, where a run's definitions read it
 * (src/run-object.ts).
 */
const hasEnv = (object: object): object is WithEnv =>
  "env" in object && typeof object.env === "object" && object.env !== null;

/**
 * Has run `id`'s first D1 batch commit and then hang until released: the
 * effect of the step that made it is left, and its result held back, as
 * when the activation is lost right after the step's write. Set up
 * before the run starts. Every later batch of the run goes through.
 */
export const holdFirstBatch = async (
  workflow: AdminWorkflow,
  id: string
): Promise<{ committed: Promise<unknown>; release: () => void }> => {
  const committed = Promise.withResolvers<unknown>();
  const released = Promise.withResolvers<unknown>();
  let first = true;
  await runInDurableObject(runObject(workflow, id), (object) => {
    if (!hasEnv(object)) {
      throw new TypeError("The run's object keeps no env");
    }
    const host = object;
    const database = host.env.DB;
    // SAFETY: an object whose prototype is `database` is a database: it
    // has every member, and the ones the run calls are replaced below.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const held = Object.assign(Object.create(database) as D1Database, {
      prepare: (query: string) => database.prepare(query),
      exec: async (query: string) => await database.exec(query),
      withSession: (constraint?: Parameters<D1Database["withSession"]>[0]) =>
        database.withSession(constraint),
      batch: async <T>(statements: D1PreparedStatement[]) => {
        const results = await database.batch<T>(statements);
        if (first) {
          first = false;
          committed.resolve(true);
          await released.promise;
        }
        return results;
      },
    });
    host.env = { ...host.env, DB: held };
  });
  return {
    committed: committed.promise,
    release: () => {
      released.resolve(true);
    },
  };
};
