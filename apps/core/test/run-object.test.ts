import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  cancelRepairAfterMs,
  repairResourceTerminations,
} from "../src/workflows/resource-runs.ts";
import { triedOnceIn } from "../src/workflows/run-object.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import {
  called,
  controlCommand,
  endedRun,
  endLiveResourceRuns,
  greetingTasks,
  jsonWorkflowAppsOf,
  outcomeOf,
  publishedWorkflow,
  screenOf,
  staged,
  startCommand,
  startedBy,
  startedOf,
} from "./json-workflow-apps.ts";
import {
  finished,
  liveStatus,
  runObject,
  sleeping,
  whileEngineRefuses,
} from "./runs.ts";

// An independent workflow's run in its object, and the ways it could
// outlive what it should:
//
// - What core keeps in the object beside the engine's journal (the
//   attempts of steps tried once that never ran, and what one that ran
//   failed with) outliving the run: it goes with the run's purge, only
//   the start's tombstone left, so nothing of a removed run is read again.
// - A screen's cancel lost on the way to the engine (the engine refusing
//   the stop): its receipt stays admitted, never shown as done, and is
//   finished by the cancel asked again or by the clock's repair, the stop
//   audited once whichever finishes it, the run terminated in the engine.
// - A cancelled run's calls refused from the cancel on, even when the
//   engine fails to terminate it: covered by GRA-1460's tests.

const idp = mockIdp();
const { signedIn, boundApp } = jsonWorkflowAppsOf(idp);

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

/** How often the audit log has `run` stopped, and by whom. */
const stopsOf = async (run: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, target }) =>
        action === "workflow.run.terminated" && target?.id === run
    )
    .map(({ actor }) => actor.type);
};

/** Where `run`'s screen cancel receipt stands. */
const receiptOf = async (run: string) =>
  await env.DB.prepare(
    "SELECT state FROM workflow_resource_run_controls WHERE run_id = ?"
  )
    .bind(run)
    .first<string>("state");

describe("an independent workflow's run object", { timeout: 60_000 }, () => {
  afterEach(endLiveResourceRuns);

  it("keeps which tried-once attempts never ran and what one that ran failed with, and drops them with the run's purge", async () => {
    const builder = await signedIn("builder");
    const { id } = await publishedWorkflow(builder, greetingTasks("PT1H"));
    const run = await startedBy(builder, id);
    await sleeping(run, "task:hold");

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
    await builder.api.workflowResources.terminateRun(id, run);
    await endedRun(builder, id, run);
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

  it("finishes a screen's cancel the engine refused to stop, once asked again or at the next repair, audited once", async () => {
    const { builder, app, workflow, reference } = await boundApp({
      hold: "PT1H",
    });
    const lease = await screenOf(builder, app);
    const runIn = async () => {
      const { runId } = startedOf(
        await called(builder, app, lease, startCommand(reference))
      );
      await sleeping(runId, "task:hold");
      return runId;
    };
    const cancelled = async (runId: string) =>
      staged(
        outcomeOf(
          await called(
            builder,
            app,
            lease,
            controlCommand(reference, "cancel", runId)
          )
        )
      );
    const refusedCancel = async (runId: string) =>
      await whileEngineRefuses(
        (method) => method === "terminate",
        async () => await cancelled(runId)
      );

    // Refused, then asked again under a new key: that finishes it.
    const retried = await runIn();
    const retriedRefused = await refusedCancel(retried);
    const retriedAgain = await cancelled(retried);
    const retriedEnd = await endedRun(builder, workflow, retried);
    // Refused, and never asked again: the repair, once it is due, does.
    const repaired = await runIn();
    const repairedRefused = await refusedCancel(repaired);
    await repairResourceTerminations(
      env,
      new Date(Date.now() + cancelRepairAfterMs + 1000)
    );
    const repairedEnd = await endedRun(builder, workflow, repaired);
    // A repair again, well after: nothing more is stopped or audited.
    await repairResourceTerminations(env, new Date(Date.now() + 3_600_000));

    expect({
      answered: [retriedRefused, retriedAgain, repairedRefused],
      receipts: [await receiptOf(retried), await receiptOf(repaired)],
      status: [retriedEnd.status, repairedEnd.status],
      stops: [await stopsOf(retried), await stopsOf(repaired)],
      engine: [await liveStatus(retried), await liveStatus(repaired)],
    }).toStrictEqual({
      answered: [
        { kind: "cancel", state: "admitted" },
        { kind: "cancel", state: "applied" },
        { kind: "cancel", state: "admitted" },
      ],
      receipts: ["applied", "applied"],
      status: ["cancelled", "cancelled"],
      stops: [["app"], ["app"]],
      engine: ["terminated", "terminated"],
    });
  });
});
