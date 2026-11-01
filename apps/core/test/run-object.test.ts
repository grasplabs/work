import { actorOf } from "@grasp-os/shared/audit";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { cancelRun } from "../src/workflows/controls.ts";
import { markRunCancelled } from "../src/workflows/engine.ts";
import { busyRefusalsIn, triedOnceIn } from "../src/workflows/run-object.ts";
import { allEvents } from "./audit-events.ts";
import { asking, confirmedAnswer } from "./decisions.ts";
import { mockIdp } from "./idp.ts";
import {
  aroundEngine,
  endLiveRuns,
  finished,
  liveStatus,
  runObject,
  sleeping,
} from "./runs.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import {
  appWith,
  hitCall,
  hitsCall,
  hitsOf,
  workflowFiles,
} from "./workflow-apps.ts";

// What core keeps in a run's object beside the engine's journal goes when
// the engine removes the run: a step's last busy-budget refusal outlives
// neither the run's retention nor its purge, though its start's tombstone
// stays. And a cancel marks the run in its object before anything else:
// no attempt of it holds from then on, even should the engine never
// terminate it.

const idp = mockIdp();

const napper = workflowFiles(
  "napper",
  `  await step.do("first", { description: "First" }, async () => null);
  await step.sleep("go", { description: "Wait", duration: "1 day" });
  return null;`,
  { first: null }
);

/** A step that counts each round, until the App counts `gate`. */
const looping = workflowFiles(
  "looping",
  `  await step.do("loop", { description: "Loop" }, async () => {
    while ((await ${hitsCall(`"gate"`)}) === 0) {
      await ${hitCall(`"round"`)};
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return null;
  });
  return null;`,
  { loop: null }
);

/** The object's tables, and what its key-value storage holds. */
const leftIn = async (run: string) =>
  await runInDurableObject(runObject(run), (_object, state) => ({
    tables: state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
      )
      .toArray()
      .map(({ name }) => name),
    kv: [...state.storage.kv.list()].length,
  }));

/** How often the audit log has `run` cancelled. */
const cancelsOf = async (run: string) => {
  const events = await allEvents();
  return events.filter(
    ({ action, target }) =>
      action === "workflow.run.cancelled" && target?.id === run
  ).length;
};

/** Once `run`'s row says it was cancelled. */
const ended = async (run: string) => {
  await vi.waitFor(
    async () => {
      const row = await env.DB.prepare(
        "SELECT status FROM workflow_runs WHERE id = ?"
      )
        .bind(run)
        .first<string>("status");
      if (row !== "cancelled") {
        throw new Error(`The run is ${String(row)}`);
      }
    },
    { timeout: 15_000, interval: 100 }
  );
};

/** A step that takes two seconds, then a day's sleep. */
const slowNapper = workflowFiles(
  "slow",
  `  await step.do("first", { description: "First" }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return null;
  });
  await step.sleep("go", { description: "Wait", duration: "1 day" });
  return null;`,
  { first: null }
);

/** A step that asks its App for rounds until the App refuses, no retry. */
const refusedLoop = workflowFiles(
  "refused",
  `  await step.do("loop", { description: "Loop", retries: { limit: 0 } }, async () => {
    for (;;) {
      await ${hitCall(`"round"`)};
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
  return null;`,
  { loop: null }
);

/** `run`'s row status, and who its cancel and failure audits name. */
const endingOf = async (run: string) => {
  const status = await env.DB.prepare(
    "SELECT status FROM workflow_runs WHERE id = ?"
  )
    .bind(run)
    .first<string>("status");
  const events = await allEvents();
  const of = (action: string) =>
    events
      .filter((event) => event.action === action && event.target?.id === run)
      .map(({ actor }) =>
        actor.type === "person" ? actor.userId : actor.type
      );
  return {
    status,
    cancelled: of("workflow.run.cancelled"),
    failed: of("workflow.run.failed"),
  };
};

/** Once `run`'s row has ended, within `ms`. */
const rowEnded = async (run: string, ms: number) => {
  await vi.waitFor(
    async () => {
      const status = await env.DB.prepare(
        "SELECT status FROM workflow_runs WHERE id = ?"
      )
        .bind(run)
        .first<string>("status");
      if (status === "running" || status === "queued" || status === "waiting") {
        throw new Error(`The run is ${status}`);
      }
    },
    { timeout: ms, interval: 100 }
  );
};

describe("a run's object", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("keeps a step's busy-budget refusal with the run, and drops it with the run's purge", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, napper);
    const { id: run } = await builder.api.workflows.start(app, "napper");
    await sleeping(run, "go");

    const kept = await runInDurableObject(runObject(run), (_object, state) => {
      const refusals = busyRefusalsIn(state.storage.sql);
      refusals.set("first", {
        at: 1,
        details: { reason: "model.budget_busy" },
      });
      return refusals.get("first");
    });
    await builder.api.workflows.cancel(run);
    await finished(run);
    // Its retention over: the purge's alarm comes due.
    await runInDurableObject(runObject(run), (_object, state) => {
      state.storage.sql.exec("UPDATE run SET purge_at = ?", Date.now() - 1);
    });
    await runDurableObjectAlarm(runObject(run));

    expect({ kept, left: await leftIn(run) }).toStrictEqual({
      kept: { at: 1, details: { reason: "model.budget_busy" } },
      // Only the start's tombstone, which the engine keeps for 30 days.
      left: { tables: ["tombstones"], kv: 0 },
    });
  });

  it("keeps which tried-once attempts never ran and what one that ran failed with, and drops them with the run's purge", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, napper);
    const { id: run } = await builder.api.workflows.start(app, "napper");
    await sleeping(run, "go");

    const kept = await runInDurableObject(runObject(run), (_object, state) => {
      const marks = triedOnceIn(state.storage.sql);
      marks.markUnstarted("key:greet", 1);
      marks.keepFailure("key:greet", 2, {
        name: "Error",
        message: "The provider refused it.",
        code: "model.unavailable",
      });
      // A mark and a failure of one attempt both stay.
      marks.markUnstarted("key:greet", 3);
      marks.keepFailure("key:greet", 3, { name: "Error", message: "Late" });
      return {
        unstarted: [1, 2, 3, 4].map((attempt) =>
          marks.unstarted("key:greet", attempt)
        ),
        failures: [1, 2, 3].map((attempt) =>
          marks.failureOf("key:greet", attempt)
        ),
        otherStep: marks.unstarted("key:other", 1),
      };
    });
    await builder.api.workflows.cancel(run);
    await finished(run);
    await runInDurableObject(runObject(run), (_object, state) => {
      state.storage.sql.exec("UPDATE run SET purge_at = ?", Date.now() - 1);
    });
    await runDurableObjectAlarm(runObject(run));
    // Once the run is gone, nothing is kept any more.
    const afterPurge = await runInDurableObject(
      runObject(run),
      (_object, state) => {
        const marks = triedOnceIn(state.storage.sql);
        marks.markUnstarted("key:greet", 1);
        return marks.unstarted("key:greet", 1);
      }
    );

    expect({ kept, afterPurge, left: await leftIn(run) }).toStrictEqual({
      kept: {
        unstarted: [true, false, true, false],
        failures: [
          undefined,
          {
            name: "Error",
            message: "The provider refused it.",
            code: "model.unavailable",
          },
          { name: "Error", message: "Late" },
        ],
        otherStep: false,
      },
      afterPurge: false,
      left: { tables: ["tombstones"], kv: 0 },
    });
  });

  it("refuses every call of a cancelled run's attempt from the cancel on, even when the engine fails to terminate it", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, looping);
    const rounds = async () => await hitsOf(builder, app, "round");
    const { id: run } = await builder.api.workflows.start(app, "looping");
    await vi.waitFor(
      async () => {
        await expect(rounds()).resolves.toBeGreaterThan(1);
      },
      { timeout: 20_000, interval: 100 }
    );

    // The engine can't be reached to terminate it, from the cancel's
    // request: the activation goes on, unless the run, its calls refused,
    // ends first (the request then finds nothing to terminate).
    await aroundEngine(
      async (method, call) => {
        if (method === "terminate") {
          throw new Error("The engine is unavailable");
        }
        return await call();
      },
      async () => await outcome(builder.api.workflows.cancel(run))
    );
    await scheduler.wait(500);
    const afterCancel = await rounds();
    await scheduler.wait(1000);
    const later = await rounds();
    const events = await allEvents();

    expect({
      roundsStopped: later === afterCancel,
      refused: events.some(
        ({ action, target, detail }) =>
          action === "workflow.call.refused" &&
          target?.id === run &&
          detail.errorCode === "execution.stale_attempt"
      ),
    }).toStrictEqual({
      roundsStopped: true,
      refused: true,
    });
  });

  it("finishes a cancel whose database write failed, or whose request died, from the run's object, audited once", async () => {
    const builder = await signedInApi(idp, "builder");
    const identity = await builder.api.whoami();
    const app = await appWith(builder, napper);
    const runIn = async () => {
      const { id } = await builder.api.workflows.start(app, "napper");
      await sleeping(id, "go");
      return id;
    };
    // Core's database, refusing every write batch, as D1 can.
    const failing = new Proxy(env.DB, {
      get: (target, key) => {
        if (key === "batch") {
          return async () => {
            await Promise.resolve();
            throw new Error("D1_ERROR: broken for the test");
          };
        }
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== "function") {
          return value;
        }
        const bound: unknown = value.bind(target);
        return bound;
      },
    });

    // The database write fails after the mark: the object's alarm finishes it.
    const failed = await runIn();
    const refused = await outcome(
      cancelRun({ ...env, DB: failing }, identity, failed)
    );
    await runDurableObjectAlarm(runObject(failed));
    await ended(failed);
    // The request dies right after the mark: the same.
    const died = await runIn();
    await markRunCancelled(env, died, actorOf(identity));
    await runDurableObjectAlarm(runObject(died));
    await ended(died);
    // The write fails, and the cancel is asked for again: that finishes it.
    const retried = await runIn();
    await outcome(cancelRun({ ...env, DB: failing }, identity, retried));
    await cancelRun(env, identity, retried);
    await ended(retried);
    // Written, but the engine can't be told: the alarm terminates it, and
    // audits nothing again.
    const unterminated = await runIn();
    await aroundEngine(
      async (method, call) => {
        if (method === "terminate") {
          throw new Error("The engine is unavailable");
        }
        return await call();
      },
      async () => await outcome(cancelRun(env, identity, unterminated))
    );
    await runDurableObjectAlarm(runObject(unterminated));
    await ended(unterminated);

    expect({
      refused,
      audited: [
        await cancelsOf(failed),
        await cancelsOf(died),
        await cancelsOf(retried),
        await cancelsOf(unterminated),
      ],
      engine: [
        await liveStatus(failed),
        await liveStatus(died),
        await liveStatus(retried),
        await liveStatus(unterminated),
      ],
    }).toStrictEqual({
      refused: "Error: D1_ERROR: broken for the test",
      audited: [1, 1, 1, 1],
      engine: ["terminated", "terminated", "terminated", "terminated"],
    });
  });

  it("ends a run cancelled, as its canceller's, when it errors before its cancel's request recorded it", async () => {
    const builder = await signedInApi(idp, "builder");
    const identity = await builder.api.whoami();
    const app = await appWith(builder, refusedLoop);
    const { id: run } = await builder.api.workflows.start(app, "refused");
    await vi.waitFor(
      async () => {
        const rounds = await hitsOf(builder, app, "round");
        expect(rounds).toBeGreaterThan(0);
      },
      { timeout: 20_000, interval: 100 }
    );
    // The cancel's request dies once its mark is kept: the step's next App
    // call is refused, and the run errors well before the object's repair.
    await markRunCancelled(env, run, actorOf(identity));
    await rowEnded(run, 4000);

    await expect(endingOf(run)).resolves.toStrictEqual({
      status: "cancelled",
      cancelled: [identity.userId],
      failed: [],
    });
  });

  it("finishes a cancel, rather than run on, when an event wakes the run after its mark", async () => {
    const builder = await signedInApi(idp, "builder");
    const decider = await signedInApi(idp, "user");
    const identity = await builder.api.whoami();
    const { run, decision } = await asking(builder, {
      from: `person:${decider.userId}`,
      timeout: 7 * 24 * 60 * 60 * 1000,
    });
    await markRunCancelled(env, run.id, actorOf(identity));
    // The answer wakes the run: its activation finishes the cancel, well
    // before the object's repair would.
    const answered = await outcome(
      confirmedAnswer(decider, decision, { approved: true })
    );
    await rowEnded(run.id, 2500);

    expect({
      answered,
      ending: await endingOf(run.id),
      engine: await liveStatus(run.id),
    }).toStrictEqual({
      answered: "ok",
      ending: {
        status: "cancelled",
        cancelled: [identity.userId],
        failed: [],
      },
      engine: "terminated",
    });
  });

  it("repairs a cancel whose request died, though the run then suspends on a day's sleep", async () => {
    const builder = await signedInApi(idp, "builder");
    const identity = await builder.api.whoami();
    const app = await appWith(builder, slowNapper);
    const { id: run } = await builder.api.workflows.start(app, "slow");
    // Marked while the first step runs; the run then sets its alarm for
    // its sleep, a day off.
    await markRunCancelled(env, run, actorOf(identity));
    await vi.waitFor(
      async () => {
        await expect(liveStatus(run)).resolves.toBe("terminated");
      },
      { timeout: 20_000, interval: 200 }
    );

    await expect(endingOf(run)).resolves.toStrictEqual({
      status: "cancelled",
      cancelled: [identity.userId],
      failed: [],
    });
  });
});
