import { actorOf } from "@grasp-os/shared/audit";
import { appIdSchema } from "@grasp-os/shared/ids";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { callApp } from "../src/app.ts";
import { markRunCancelled } from "../src/workflows/engine.ts";
import { busyRefusalsIn } from "../src/workflows/run-object.ts";
import { cancelRun } from "../src/workflows/runs.ts";
import { allEvents } from "./audit-events.ts";
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
import { appWith, workflowFiles } from "./workflow-apps.ts";

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
    while ((await env.APP.call("hits", "gate")) === 0) {
      await env.APP.call("hit", "round");
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

  it("refuses every call of a cancelled run's attempt from the cancel on, even when the engine fails to terminate it", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, looping);
    const rounds = async () =>
      Number(
        await callApp(
          env,
          appIdSchema.parse(app),
          { userId: builder.userId, mode: "interactive" },
          "hits",
          ["round"]
        )
      );
    const { id: run } = await builder.api.workflows.start(app, "looping");
    await vi.waitFor(
      async () => {
        await expect(rounds()).resolves.toBeGreaterThan(1);
      },
      { timeout: 20_000, interval: 100 }
    );

    // The engine can't be reached to terminate it: the cancel fails after
    // its mark and its tombstone, and the activation goes on.
    const cancelled = await aroundEngine(
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
      cancelled,
      roundsStopped: later === afterCancel,
      refused: events.some(
        ({ action, target, detail }) =>
          action === "workflow.call.refused" &&
          target?.id === run &&
          detail.errorCode === "execution.stale_attempt"
      ),
    }).toStrictEqual({
      cancelled: "internal.unexpected",
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
});
