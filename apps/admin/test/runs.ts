/**
 * The admin's workflow runs as tests drive them from outside: through
 * each run's own object (Workerflow, src/workflow-runs.ts), as time
 * passing, a crash or a duplicate delivery would.
 */
import { decode } from "@grasp-os/workerflow/codec";
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
  id: string,
  timeoutMs: number = waitFor.timeout
): Promise<InstanceStatus> => {
  const instance = await adminWorkflow(env, workflow).get(id);
  return await vi.waitFor(
    async () => {
      const status = await instance.status();
      if (!endedStatuses.has(status.status)) {
        throw new Error(`Run ${id} is ${status.status}`);
      }
      return status;
    },
    { ...waitFor, timeout: timeoutMs }
  );
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

/**
 * Makes run `id`'s due retries and sleeps due now, as Cloudflare
 * Workflows' test pool did with `disableRetryDelays` and `disableSleeps`:
 * a retry's time and a sleep's deadline moved to now, and the run's alarm
 * set, when it moved one. Event waits keep their deadlines.
 */
export const hurry = async (
  workflow: AdminWorkflow,
  id: string
): Promise<void> => {
  await runInDurableObject(runObject(workflow, id), async (_object, state) => {
    const { sql } = state.storage;
    const now = Date.now();
    const retries = sql.exec(
      "UPDATE attempts SET retry_at = ? WHERE retry_at IS NOT NULL AND retry_at > ?",
      now,
      now
    ).rowsWritten;
    const sleeps = sql.exec(
      "UPDATE steps SET deadline = ? WHERE type = 'sleep' AND state = 'waiting' AND deadline > ?",
      now,
      now
    ).rowsWritten;
    // Moved now, or before by an earlier call while an activation ran and
    // then suspended until the old time: either way the run is due.
    const [due] = sql
      .exec<{ due: number }>(
        "SELECT COUNT(*) AS due FROM steps WHERE (type = 'sleep' AND state = 'waiting' AND deadline <= ?) OR (state = 'retrying' AND EXISTS (SELECT 1 FROM attempts WHERE attempts.ordinal = steps.ordinal AND attempts.retry_at <= ?))",
        now,
        now
      )
      .toArray();
    const [run] = sql
      .exec<{ status: string; wake_at: number | null }>(
        "SELECT status, wake_at FROM run"
      )
      .toArray();
    const late =
      run?.status === "waiting" &&
      (run.wake_at === null || run.wake_at > now) &&
      (due?.due ?? 0) > 0;
    if (retries + sleeps > 0 || late) {
      sql.exec(
        "UPDATE run SET wake_at = ? WHERE wake_at IS NULL OR wake_at > ?",
        now,
        now
      );
      await state.storage.setAlarm(now);
    }
  });
};

/** A run of the admin's a test started. */
export interface StartedRun {
  workflow: AdminWorkflow;
  id: string;
}

/** The admin's runs a test started, as `followAdminRuns` records them. */
export interface FollowedRuns extends AsyncDisposable {
  /** Every run started since, in order. */
  readonly started: readonly StartedRun[];
  /** The ids of the runs of `workflow` started since, in order. */
  of: (workflow: AdminWorkflow) => string[];
}

/** How often followed runs are hurried (`hurry`). */
const hurryEveryMs = 50;

/**
 * Records each run of any of the admin's workflows the engine creates
 * from now on, and keeps their retries and sleeps due at once (`hurry`),
 * until disposed: what a test of runs that start runs of their own (a
 * rollout's fleet clients) follows them by.
 */
export const followAdminRuns = (): FollowedRuns => {
  const started: StartedRun[] = [];
  const done = new Set<string>();
  const namespace = env.ADMIN_RUNS;
  const get = namespace.get.bind(namespace);
  const spy = vi.spyOn(namespace, "get").mockImplementation((id, options) => {
    const stub = get(id, options);
    return new Proxy(stub, {
      get: (target, property): unknown => {
        if (property === "start") {
          return async (command: StartCommand) => {
            const outcome = await target.start(command);
            if (outcome === "created") {
              started.push({
                // SAFETY: only the admin's definitions start runs here.
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
                workflow: command.definition as AdminWorkflow,
                id: command.instanceId,
              });
            }
            return outcome;
          };
        }
        const value: unknown = Reflect.get(target, property);
        return value;
      },
    });
  });
  // Each run hurried on its own: one whose object is busy (its activation
  // held by the test) never holds up the others.
  const busy = new Set<string>();
  // Each hurry still running, so disposing waits for them: none outlives
  // the test that started it.
  const pending = new Set<Promise<void>>();
  const hurryOne = async (run: StartedRun): Promise<void> => {
    busy.add(run.id);
    try {
      await hurry(run.workflow, run.id);
      const instance = await adminWorkflow(env, run.workflow).get(run.id);
      const { status } = await instance.status();
      if (endedStatuses.has(status)) {
        done.add(run.id);
      }
    } catch {
      // A run mid-activation, or gone: tried again next time.
    } finally {
      busy.delete(run.id);
    }
  };
  const timer = setInterval(() => {
    for (const run of started) {
      if (!done.has(run.id) && !busy.has(run.id)) {
        const hurried = (async () => {
          await hurryOne(run);
        })();
        pending.add(hurried);
        void (async () => {
          await hurried;
          pending.delete(hurried);
        })();
      }
    }
  }, hurryEveryMs);
  return {
    started,
    of: (workflow) =>
      started.filter((run) => run.workflow === workflow).map(({ id }) => id),
    [Symbol.asyncDispose]: async () => {
      clearInterval(timer);
      await Promise.all(pending);
      spy.mockRestore();
    },
  };
};

/**
 * Once run `id` of `workflow` is in `status`; refused once it ended in
 * another, which it can never leave.
 */
export const reached = async (
  workflow: AdminWorkflow,
  id: string,
  status: InstanceStatus["status"]
): Promise<void> => {
  const instance = await adminWorkflow(env, workflow).get(id);
  const final = await vi.waitFor(
    async () => {
      const now = await instance.status();
      if (now.status === status || endedStatuses.has(now.status)) {
        return now.status;
      }
      throw new Error(`Run ${id} is ${now.status}`);
    },
    { ...waitFor, timeout: 30_000 }
  );
  if (final !== status) {
    throw new Error(
      `Run ${id} has reached status '${final}', a finite status that prevents it from ever reaching '${status}'`
    );
  }
};

/** Once run `id` has a step named `name` that succeeded, what it returned. */
export const stepResult = async (
  workflow: AdminWorkflow,
  id: string,
  name: string
): Promise<unknown> =>
  await vi.waitFor(
    async () => {
      const { steps } = await journalOf(workflow, id);
      const step = steps.find(
        (row) => row.name === name && row.state === "succeeded"
      );
      if (step === undefined) {
        throw new Error(`Run ${id} has no step ${name} that succeeded yet`);
      }
      return step.value === null ? undefined : decode(step.value);
    },
    { ...waitFor, timeout: 30_000 }
  );
