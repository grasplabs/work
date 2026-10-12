import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { runEngine } from "../src/workflows/engine.ts";
import { repairStarts, startRun } from "../src/workflows/runs.ts";
import { allEvents } from "./audit-events.ts";
import { runCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import { planOf, recordedQueries } from "./query-plans.ts";
import {
  aroundEngine,
  endLiveRuns,
  liveStatus,
  runObjectId,
  stepDone,
} from "./runs.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { appWith, runEvents, workflowFiles } from "./workflow-apps.ts";

// A run's row keeps the start it is to send the engine until the engine
// confirms it. A start that stopped in between (core stopped) leaves a
// row starting with that start pending. Core's cron trigger sends it again
// once it's old enough, under the run's ID, so the engine creates the run
// once, or finds the one it has; one it still can't send a quarter of an
// hour on is marked failed. Live runs have no start pending, so the
// repair never looks at them.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);
type Person = Awaited<ReturnType<typeof personApi>>;

const minute = 60_000;
const day = 24 * 60 * minute;

/** The repair's query of the starts still pending. */
const sweepQuery = /from "workflow_runs" where .*"pending_start" is not null/u;

/**
 * A workflow that does one step, then sleeps a day:
 * a live run.
 */
const waiting = workflowFiles(
  "waits",
  `  await step.do("work", { description: "Work" }, async () => null);
  await step.sleep("go", { description: "Wait", duration: "1 day" });
  return null;`,
  { work: null }
);

/** A run's row as a start leaves it that stopped `age` ago. */
const orphanOf = async (
  person: Person | null,
  app: string,
  age: number,
  triggerKey: string | null = null,
  run: string = crypto.randomUUID()
): Promise<string> => {
  await env.DB.prepare(
    "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, trigger_key, pending_start) VALUES (?, ?, 'waits', 1, ?, 'starting', ?, ?, '{}')"
  )
    .bind(run, app, person?.userId ?? null, Date.now() - age, triggerKey)
    .run();
  return run;
};

/** Sets how long ago a run's row was written. */
const setAge = async (run: string, age: number): Promise<void> => {
  await env.DB.prepare("UPDATE workflow_runs SET created_at = ? WHERE id = ?")
    .bind(Date.now() - age, run)
    .run();
};

/** Whether a run's row still has its start pending. */
const pending = async (run: string): Promise<boolean> => {
  const row = await env.DB.prepare(
    "SELECT pending_start IS NOT NULL AS pending FROM workflow_runs WHERE id = ?"
  )
    .bind(run)
    .first<{ pending: number }>();
  return row?.pending === 1;
};

/** A run's status as its row has it. */
const rowStatus = async (run: string): Promise<string | undefined> => {
  const row = await env.DB.prepare(
    "SELECT status FROM workflow_runs WHERE id = ?"
  )
    .bind(run)
    .first<{ status: string }>();
  return row?.status;
};

/** Once the run's row says `status`. */
const rowSays = async (run: string, status: string): Promise<void> => {
  await vi.waitFor(
    async () => {
      await expect(rowStatus(run)).resolves.toBe(status);
    },
    { timeout: 10_000, interval: 100 }
  );
};

/** The actions of the audit events of `run`. */
const actionsOf = async (run: string): Promise<string[]> => {
  const events = await allEvents();
  return events
    .filter(({ target }) => target?.id === run)
    .map(({ action }) => action);
};

/** Whether the audit log has `run` failing. */
const failedAtAll = async (run: string): Promise<boolean> => {
  const actions = await actionsOf(run);
  return actions.includes("workflow.run.failed");
};

/** `target`'s `key`, a method bound to it, as a proxy passes it through. */
const through = (target: object, key: PropertyKey): unknown => {
  const value: unknown = Reflect.get(target, key);
  if (typeof value !== "function") {
    return value;
  }
  const bound: unknown = value.bind(target);
  return bound;
};

/** What runs a statement against the database. */
const statementRuns = new Set<PropertyKey>(["run", "all", "raw", "first"]);

/** Forgetting a start the engine confirmed, as drizzle writes it. */
const confirmsStart = 'update "workflow_runs" set "pending_start" = ? where ';

/**
 * Core's database, refusing to forget a start the engine confirmed, as D1
 * can (overloaded, timed out); everything else goes through. `refused`
 * counts the writes it refused.
 */
const refusingConfirmation = (): {
  db: D1Database;
  refused: () => number;
} => {
  let refused = 0;
  const refusing = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get: (target, key) => {
        if (statementRuns.has(key)) {
          return async () => {
            refused += 1;
            await Promise.resolve();
            throw new Error("D1_ERROR: broken for the test");
          };
        }
        if (key === "bind") {
          return (...values: unknown[]) => refusing(target.bind(...values));
        }
        return through(target, key);
      },
    });
  const db = new Proxy(env.DB, {
    get: (target, key) => {
      if (key === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          return query.startsWith(confirmsStart)
            ? refusing(statement)
            : statement;
        };
      }
      return through(target, key);
    },
  });
  return { db, refused: () => refused };
};

const endedStatuses = new Set(["complete", "errored", "terminated"]);

/** The run's engine instance, created as its start would have. */
const createInstance = async (app: string, run: string): Promise<void> => {
  await runEngine(env).create({
    id: run,
    pinned: {
      app: appIdSchema.parse(app),
      workflow: workflowIdSchema.parse("waits"),
      version: 1,
    },
    input: undefined,
  });
};

/**
 * Runs `run` while the engine can't be reached for the runs `runs`: it
 * answers nothing for them, not even where they are.
 */
const whileUnreachable = async <T>(
  runs: readonly string[],
  run: () => Promise<T>
): Promise<T> => {
  const objects = runs.map((id) => runObjectId(id));
  return await aroundEngine(async (_method, call, object) => {
    if (objects.some((id) => id.equals(object))) {
      throw new Error("The engine can't be reached");
    }
    return await call();
  }, run);
};

/**
 * Runs `run` while the engine won't take the starts of the runs `runs`
 * (its storage is down for them, say), and answers where they are: that
 * it has no record of them.
 */
const whileRefusingStarts = async <T>(
  runs: readonly string[],
  run: () => Promise<T>
): Promise<T> => {
  const objects = runs.map((id) => runObjectId(id));
  return await aroundEngine(async (method, call, object) => {
    if (method === "start" && objects.some((id) => id.equals(object))) {
      throw new Error("The engine is unavailable");
    }
    return await call();
  }, run);
};

describe("starts core stopped in the middle of", () => {
  afterEach(endLiveRuns);

  it("are sent again once they're old enough, however long ago, and run once", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, waiting);
    const orphan = await orphanOf(builder, app, 20 * minute);
    // Left by a start as core went down for a month.
    const afterOutage = await orphanOf(builder, app, 30 * day);
    const young = await orphanOf(builder, app, 30_000);

    await runCron();
    await rowSays(orphan, "running");
    await rowSays(afterOutage, "running");
    const youngShown = await builder.api.workflows.status(young);
    // Once more: each is the run it was, sent again or not.
    await runCron();

    const ongoing = new Set(["running", "waiting"]);
    expect({
      orphan: ongoing.has(await liveStatus(orphan)),
      outage: ongoing.has(await liveStatus(afterOutage)),
      pending: [await pending(orphan), await pending(afterOutage)],
      // Its start may still be under way; it shows as running meanwhile.
      young: await rowStatus(young),
      youngPending: await pending(young),
      youngShown: youngShown.status,
      failed: await failedAtAll(orphan),
    }).toStrictEqual({
      orphan: true,
      outage: true,
      pending: [false, false],
      young: "starting",
      youngPending: true,
      youngShown: "running",
      failed: false,
    });
  });

  it("are found by an index, reading no table whole and sorting nothing", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, waiting);
    await orphanOf(builder, app, 20 * minute);
    // A fresh D1 has no statistics: SQLite goes by the queries alone.
    const stats = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE name LIKE 'sqlite_stat%'"
    ).all();

    const queries = await recordedQueries(async () => {
      await runCron();
    });
    const plans = await Promise.all(
      queries
        .filter(({ query }) => sweepQuery.test(query))
        .map(async (recorded) => await planOf(recorded))
    );

    expect({ stats: stats.results, plans }).toStrictEqual({
      stats: [],
      // From a random ID on, then, one row being fewer than a repair
      // takes, up to it.
      plans: [
        [
          "SEARCH workflow_runs USING INDEX workflow_runs_pending_start_idx (id>?)",
        ],
        [
          "SEARCH workflow_runs USING INDEX workflow_runs_pending_start_idx (id<?)",
        ],
      ],
    });
  });

  it("never include a run started as ever, however old", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, waiting);
    const live = await builder.api.workflows.start(app, "waits");
    await rowSays(live.id, "running");
    await setAge(live.id, 20 * day);

    const queries = await recordedQueries(async () => {
      await runCron();
    });

    expect({
      pending: await pending(live.id),
      row: await rowStatus(live.id),
      ended: endedStatuses.has(await liveStatus(live.id)),
      failed: await failedAtAll(live.id),
      resent: queries.some(({ query }) => sweepQuery.test(query)),
    }).toStrictEqual({
      pending: false,
      row: "running",
      ended: false,
      failed: false,
      resent: true,
    });
  });

  it("take a start the engine already has as the run it is: sent again, nothing runs twice", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, waiting);
    const slow = await orphanOf(builder, app, 20 * minute);
    // The start reached the engine; its answer never reached core.
    await createInstance(app, slow);
    await rowSays(slow, "running");
    await env.DB.prepare(
      "UPDATE workflow_runs SET status = 'starting', pending_start = '{}' WHERE id = ?"
    )
      .bind(slow)
      .run();

    await runCron();

    expect({
      pending: await pending(slow),
      ended: endedStatuses.has(await liveStatus(slow)),
      failed: await failedAtAll(slow),
      steps: await runEvents(slow, "workflow.step.completed"),
    }).toStrictEqual({
      pending: false,
      ended: false,
      failed: false,
      steps: [
        "workflow.step.completed $params",
        "workflow.step.completed work",
      ],
    });
  });

  it("are marked failed once the engine still can't take them a quarter of an hour on, audited once, for their person to see", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, waiting);
    const orphan = await orphanOf(builder, app, 20 * minute);
    const recent = await orphanOf(builder, app, 5 * minute);

    await whileRefusingStarts([orphan, recent], async () => {
      await runCron();
      await runCron();
    });
    const { status, failure } = await builder.api.workflows.status(orphan);

    expect({
      status,
      error: failure?.error,
      recent: await rowStatus(recent),
      audited: await runEvents(orphan, "workflow.run.failed"),
    }).toStrictEqual({
      status: "failed",
      error: {
        code: "workflow.run_failed",
        message: "The engine has no record of this run.",
      },
      // Still tried again by the next repairs.
      recent: "starting",
      // Its person is told, as of any failed run.
      audited: [
        "workflow.run.failed no_instance workflow.run_failed",
        "workflow.run.notified",
      ],
    });
  });

  it("take no step when the engine gets their start after they were marked failed", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, waiting);
    const orphan = await orphanOf(builder, app, 20 * minute);

    await whileRefusingStarts([orphan], async () => {
      await runCron();
    });
    // The start that stopped goes on after all, and reaches the engine.
    await createInstance(app, orphan);
    await vi.waitFor(
      async () => {
        expect(endedStatuses.has(await liveStatus(orphan))).toBeTruthy();
      },
      { timeout: 10_000, interval: 100 }
    );

    expect({
      row: await rowStatus(orphan),
      engine: await liveStatus(orphan),
      actions: await actionsOf(orphan),
    }).toStrictEqual({
      row: "failed",
      // The dispatcher refused it before its first step.
      engine: "errored",
      actions: ["workflow.run.failed", "workflow.run.notified"],
    });
  });

  it("give up a triggered run's key once marked failed, so its trigger delivered again starts a new run", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, waiting);
    // A delivery whose start stopped, with nothing delivering it again
    // since (triggers were off), and the engine unreachable for it.
    const key = `event:${crypto.randomUUID()}`;
    const orphan = await orphanOf(null, app, 20 * minute, key);

    await whileRefusingStarts([orphan], async () => {
      await runCron();
    });
    const again = await startRun(env, {
      app: appIdSchema.parse(app),
      workflow: workflowIdSchema.parse("waits"),
      input: undefined,
      startedBy: null,
      actor: { type: "system" },
      trigger: { type: "schedule", key, version: 1 },
    });
    await rowSays(again.id, "running");

    expect({
      orphan: await rowStatus(orphan),
      newRun: again.id !== orphan,
    }).toStrictEqual({ orphan: "failed", newRun: true });
  });

  it("start a run whose start's confirmation can't be recorded, and let the engine record it", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, waiting);
    const { db, refused } = refusingConfirmation();

    const run = await startRun(
      { ...env, DB: db },
      {
        app: appIdSchema.parse(app),
        workflow: workflowIdSchema.parse("waits"),
        input: undefined,
        startedBy: builder.userId,
        actor: { type: "system" },
      }
    );
    // The engine's first notification records it.
    await rowSays(run.id, "running");

    expect({
      status: run.status,
      refused: refused(),
      pending: await pending(run.id),
      ended: endedStatuses.has(await liveStatus(run.id)),
      failed: await failedAtAll(run.id),
    }).toStrictEqual({
      status: "running",
      refused: 1,
      pending: false,
      ended: false,
      failed: false,
    });
  });

  it("keep a start whose answer was lost as the one run, its trigger delivered again finding it", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, waiting);
    const key = `event:${crypto.randomUUID()}`;
    const start = async () =>
      await startRun(env, {
        app: appIdSchema.parse(app),
        workflow: workflowIdSchema.parse("waits"),
        input: undefined,
        startedBy: null,
        actor: { type: "system" },
        trigger: { type: "schedule", key, version: 1 },
      });

    // The engine takes the start; its answer never reaches core.
    const first = await aroundEngine(async (method, call) => {
      const answer = await call();
      if (method === "start") {
        throw new Error("The answer was lost");
      }
      return answer;
    }, start);
    await rowSays(first.id, "running");
    const again = await start();

    expect({
      again: again.id,
      failed: await failedAtAll(first.id),
      ended: endedStatuses.has(await liveStatus(first.id)),
      pending: await pending(first.id),
    }).toStrictEqual({
      again: first.id,
      failed: false,
      ended: false,
      pending: false,
    });
  });

  it("never give up a start the engine can't say it has no record of, however old", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, waiting);
    const orphan = await orphanOf(builder, app, 20 * minute);

    await whileUnreachable([orphan], async () => {
      await runCron();
    });
    const whileUnreachableRow = await rowStatus(orphan);
    // Reachable again, the repair sends it, and it runs.
    await runCron();
    await rowSays(orphan, "running");

    expect({
      whileUnreachable: whileUnreachableRow,
      failed: await failedAtAll(orphan),
    }).toStrictEqual({ whileUnreachable: "starting", failed: false });
  });

  it("don't take a confirmation D1 couldn't record for a failed start, a quarter of an hour on", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, waiting);
    const orphan = await orphanOf(builder, app, 20 * minute);
    const { db, refused } = refusingConfirmation();

    await repairStarts({ ...env, DB: db }, orphan);
    await rowSays(orphan, "running");

    expect({
      refused: refused() > 0,
      failed: await failedAtAll(orphan),
      ended: endedStatuses.has(await liveStatus(orphan)),
    }).toStrictEqual({ refused: true, failed: false, ended: false });
  });

  it("stop a run whose start reached the engine just after it said it had none, once marked failed", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, waiting);
    const run = crypto.randomUUID();
    // The run's ID, as the start draws it.
    const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(run);
    let refusedOnce = false;
    let landed = false;
    const started = await aroundEngine(
      async (method, call) => {
        if (method === "start" && !refusedOnce) {
          refusedOnce = true;
          throw new Error("The engine is unavailable");
        }
        const answer = await call();
        if (method === "status" && answer === undefined && !landed) {
          landed = true;
          // The start that failed reaches the engine after all, right
          // after it said it had no record, and runs its first step
          // before core marks the run failed; its notifications are still
          // on their way (the row takes none of them yet).
          await env.DB.prepare(
            "UPDATE workflow_runs SET engine_sequence = ? WHERE id = ?"
          )
            .bind(1_000_000_000, run)
            .run();
          await createInstance(app, run);
          await stepDone(run, "work");
        }
        return answer;
      },
      async () =>
        await outcome(
          startRun(env, {
            app: appIdSchema.parse(app),
            workflow: workflowIdSchema.parse("waits"),
            input: undefined,
            startedBy: builder.userId,
            actor: { type: "system" },
          })
        )
    );
    uuid.mockRestore();
    await vi.waitFor(
      async () => {
        expect(endedStatuses.has(await liveStatus(run))).toBeTruthy();
      },
      { timeout: 10_000, interval: 100 }
    );

    expect({
      started,
      row: await rowStatus(run),
      engine: await liveStatus(run),
    }).toStrictEqual({
      started: "Error: The engine is unavailable",
      row: "failed",
      // Stopped at once, not left sleeping until its next activation.
      engine: "terminated",
    });
  });

  it("end a run cancelled just after the engine said it had none as cancelled, keeping its key, with no failure notice", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, waiting);
    const key = `event:${crypto.randomUUID()}`;
    const run = crypto.randomUUID();
    const start = async () =>
      await startRun(env, {
        app: appIdSchema.parse(app),
        workflow: workflowIdSchema.parse("waits"),
        input: undefined,
        startedBy: null,
        actor: { type: "system" },
        trigger: { type: "schedule", key, version: 1 },
      });
    const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(run);
    let cancelled = false;
    const first = await aroundEngine(
      async (method, call) => {
        if (method === "start") {
          throw new Error("The engine is unavailable");
        }
        const answer = await call();
        if (method === "status" && answer === undefined && !cancelled) {
          cancelled = true;
          // The person cancels it right after the engine said it had no
          // record of it, before core marks it failed.
          await env.DB.prepare(
            "UPDATE workflow_runs SET cancel_requested_at = ? WHERE id = ?"
          )
            .bind(Date.now(), run)
            .run();
        }
        return answer;
      },
      async () => await outcome(start())
    );
    uuid.mockRestore();
    // Its trigger delivered again.
    const again = await start();
    const row = await env.DB.prepare(
      "SELECT status, failure, trigger_key AS key FROM workflow_runs WHERE id = ?"
    )
      .bind(run)
      .first();
    const actions = await actionsOf(run);

    expect({
      first,
      row,
      again: again.id,
      failed: await failedAtAll(run),
      notified: actions.includes("workflow.run.notified"),
    }).toStrictEqual({
      first: "Error: The engine is unavailable",
      row: { status: "cancelled", failure: null, key },
      // The cancelled run, not a new one doing the work it was to do.
      again: run,
      failed: false,
      notified: false,
    });
  });

  it("reach a later start past ones the engine keeps failing to take", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, waiting);
    // As many as a repair takes, first in ID order, young enough to be
    // tried again rather than given up.
    const unanswered = await Promise.all(
      Array.from(
        { length: 50 },
        async (_, index) =>
          await orphanOf(
            builder,
            app,
            5 * minute,
            null,
            `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
          )
      )
    );
    const orphan = await orphanOf(
      builder,
      app,
      5 * minute,
      null,
      "80000000-0000-4000-8000-000000000000"
    );
    const fromFirst = await whileUnreachable(unanswered, async () => {
      // From the first ID, the starts it can't send fill the repair.
      await repairStarts(env, "00000000-0000-4000-8000-000000000000");
      const first = await pending(orphan);
      // From an ID past them, the later start comes first.
      await repairStarts(env, "40000000-0000-4000-8000-000000000000");
      return first;
    });
    const stillPending = await Promise.all(
      unanswered.map(async (run) => await pending(run))
    );

    expect({
      fromFirst,
      fromLater: await pending(orphan),
      unanswered: new Set(stillPending),
    }).toStrictEqual({
      fromFirst: true,
      fromLater: false,
      unanswered: new Set([true]),
    });
  });
});
