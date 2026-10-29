/**
 * The admin's workflow runs as tests drive them from outside: through
 * each run's own object (Workerflow, src/workflow-runs.ts), as time
 * passing, a crash or a duplicate delivery would.
 */
import type { InstanceStatus } from "@grasp-os/workerflow/contracts";
import { runObjectName } from "@grasp-os/workerflow/identity";
import type { Journal, StartCommand } from "@grasp-os/workerflow/run";
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

/**
 * Times out the attempt run `id` has out, as if its timeout had passed:
 * its deadline moved to now and its alarm delivered, so the engine ends
 * it as timed out; then its retry made due at once, and delivered
 * (`retried`). The attempt itself goes on wherever it is, as one that
 * timed out does.
 */
export const timeOutAttempt = async (
  workflow: AdminWorkflow,
  id: string
): Promise<{ retried: Promise<void> }> => {
  const stub = runObject(workflow, id);
  await runInDurableObject(stub, (_object, state) => {
    state.storage.sql.exec(
      "UPDATE attempts SET deadline = ? WHERE ended_at IS NULL",
      Date.now() - 1
    );
  });
  await deliverAlarm(workflow, id);
  await vi.waitFor(async () => {
    const { attempts } = await journalOf(workflow, id);
    if (!attempts.some((row) => row.ended === "timed_out")) {
      throw new Error(`Run ${id}'s attempt hasn't timed out yet`);
    }
  }, waitFor);
  await runInDurableObject(stub, (_object, state) => {
    state.storage.sql.exec(
      "UPDATE attempts SET retry_at = ? WHERE ended = 'timed_out' AND retry_at IS NOT NULL",
      Date.now()
    );
  });
  // Delivered here: the host holds the run's own alarm back while the
  // activation the attempt is out in still runs. It settles once the
  // retry's activation is done, which a test may hold.
  return { retried: deliverAlarm(workflow, id) };
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

/** A run's write whose result its activation never gets (`holdFirstBatch`). */
export interface LostWrite {
  /** Settles once the write has committed. */
  committed: Promise<unknown>;
  /** Fails the held call, as an activation lost after the write would. */
  lose: () => void;
}

/** A run's object, as a test reaches it. */
type RunStub = ReturnType<typeof runObject>;

/**
 * Has the first D1 batch of the run in `stub` after which `when` holds (of
 * the run's own database) commit and then hang until lost, when it fails:
 * the effect of the step that made it is left, and its result never
 * reaches the run, as when the activation is lost right after the step's
 * write. Set up before the run starts. Every other batch of the run goes
 * through.
 */
export const holdBatchOf = async (
  stub: RunStub,
  when: (database: D1Database) => Promise<boolean>
): Promise<LostWrite> => {
  const lost = Promise.withResolvers<unknown>();
  let first = true;
  let wrote = false;
  await runInDurableObject(stub, (object) => {
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
        if (first && (await when(database))) {
          first = false;
          wrote = true;
          await lost.promise;
          throw new Error("The activation was lost after its write");
        }
        return results;
      },
    });
    host.env = { ...host.env, DB: held };
  });
  // Polled from the test, not settled from the run's object: a test that
  // awaited a promise the object settled would go on in the object's I/O
  // context, and lose its own bindings' clients.
  return {
    committed: vi.waitFor(() => {
      if (!wrote) {
        throw new Error("The run hasn't written yet");
      }
    }, waitFor),
    lose: () => {
      lost.resolve(true);
    },
  };
};

/** `holdBatchOf` for the run's first batch, whatever it wrote. */
export const holdFirstBatchOf = async (stub: RunStub): Promise<LostWrite> =>
  await holdBatchOf(stub, async () => await Promise.resolve(true));

/** `holdFirstBatchOf` for run `id` of `workflow`. */
export const holdFirstBatch = async (
  workflow: AdminWorkflow,
  id: string
): Promise<LostWrite> => await holdFirstBatchOf(runObject(workflow, id));

/** The runs of a workflow a test started, in order, while it records. */
export interface Starts extends Disposable {
  readonly started: readonly string[];
}

/**
 * Records each run of `workflow` the engine creates from now on, until
 * disposed: what a test reads the attempts it started from, as the engine
 * lists no runs. `beforeStart` gets each run's object before its start
 * reaches it, to set up what the run will meet.
 */
export const startsOf = (
  workflow: AdminWorkflow,
  beforeStart: (stub: RunStub) => Promise<unknown> = async () => {
    await Promise.resolve();
  }
): Starts => {
  const started: string[] = [];
  const namespace = env.ADMIN_RUNS;
  const get = namespace.get.bind(namespace);
  const spy = vi.spyOn(namespace, "get").mockImplementation((id, options) => {
    const stub = get(id, options);
    return new Proxy(stub, {
      get: (target, property): unknown => {
        if (property === "start") {
          return async (command: StartCommand) => {
            if (command.definition === workflow) {
              await beforeStart(target);
            }
            const outcome = await target.start(command);
            if (outcome === "created" && command.definition === workflow) {
              started.push(command.instanceId);
            }
            return outcome;
          };
        }
        const value: unknown = Reflect.get(target, property);
        return value;
      },
    });
  });
  return {
    started,
    [Symbol.dispose]: () => {
      spy.mockRestore();
    },
  };
};
