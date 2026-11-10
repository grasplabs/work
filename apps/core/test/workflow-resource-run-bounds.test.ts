import { workflowResourceIdSchema } from "@grasp-os/shared/ids";
import { maxLiveRunsPerPrincipal } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import {
  deleteWorkflowResource,
  shareWorkflowResource,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { runEngine } from "../src/workflows/engine.ts";
import {
  listResourceRuns,
  repairResourceStarts,
  resourceRunFor,
  terminateResourceRun,
} from "../src/workflows/resource-runs.ts";
import { allEvents } from "./audit-events.ts";
import { endLiveResourceRuns } from "./json-workflow-apps.ts";
import { whileEngineRefuses } from "./runs.ts";
import { outcome, refusal, unique } from "./sign-in.ts";
import {
  builder,
  definitionOf,
  published,
  start,
  ended,
  runColumn,
  engineStatus,
  settledInEngine,
  waitingWorkflow,
  runEvents,
} from "./workflow-resource-runs-harness.ts";

// Runs of independent workflows (workflows/resource-runs.ts and
// sealed-run.ts), from their threat model: a start's receipt admits a
// run of exactly the version's sealed build, which runs with the
// parameters the start froze, carries the definition's text only as
// data, refuses a build that isn't the one it was admitted for, and
// keeps its workflow from being deleted until it ends.
//
// Here: the bounds on runs; the rest in the other
// workflow-resource-run*.test.ts files.

describe("the bounds on runs of JSON workflows", () => {
  afterEach(endLiveResourceRuns);

  it("refuses a person's start past their live runs of the workflow, audited as refused", async () => {
    const ada = await builder();
    const reader = await builder("user");
    const workflow = await waitingWorkflow(ada);
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: reader.userId,
      role: "user",
    });
    for (let index = 0; index < maxLiveRunsPerPrincipal; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one start after another
      await start(reader, workflow.id);
    }
    const refused = await refusal(start(reader, workflow.id));
    // The cap is each person's: Ada's start still runs.
    const own = await start(ada, workflow.id);
    const logged = await allEvents();
    const events = logged.filter(({ target }) => target?.id === workflow.id);
    expect({
      refused,
      own: own.runId === null ? "none" : "run",
      admitted: events.filter(
        ({ action }) => action === "workflow.start.admitted"
      ).length,
      refusals: events
        .filter(({ action }) => action === "workflow.start.refused")
        .map(({ detail }) => detail?.reason),
    }).toMatchObject({
      refused: {
        code: "workflow.run_limit",
        details: { limit: maxLiveRunsPerPrincipal },
      },
      own: "run",
      admitted: maxLiveRunsPerPrincipal + 1,
      refusals: ["workflow.run_limit"],
    });
  });

  it("says a start refused at the cap on live runs as such, whatever ends after", async () => {
    const ada = await builder();
    const workflow = await waitingWorkflow(ada);
    const runs: (string | null)[] = [];
    for (let index = 0; index < maxLiveRunsPerPrincipal; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one start after another
      const started = await start(ada, workflow.id);
      runs.push(started.runId);
    }
    const real = env.DB;
    const seen = { batches: 0 };
    // One of Ada's runs ends just after the refused admission commits, as
    // anything asked afterwards would read it.
    const db: D1Database = {
      prepare: (statement) => real.prepare(statement),
      batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
        const results = await real.batch<T>(statements);
        seen.batches += 1;
        if (seen.batches === 1) {
          await real
            .prepare(
              "UPDATE workflow_resource_runs SET status = 'completed', ended_at = ? WHERE id = ?"
            )
            .bind(Date.now(), runs[0] ?? "")
            .run();
        }
        return results;
      },
      exec: async (statement) => await real.exec(statement),
      // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
      dump: async () => await real.dump(),
      withSession: (constraint) => real.withSession(constraint),
    };
    const refused = await refusal(
      startWorkflow(
        { ...env, DB: db },
        { type: "person", person: ada },
        workflow.id,
        {
          version: 1,
          args: { who: "Ada" },
          key: unique(),
        }
      )
    );
    expect(refused).toMatchObject({ code: "workflow.run_limit" });
  });

  it("lets a builder stop a run, audited under them, and the workflow go after", async () => {
    const ada = await builder();
    const reader = await builder("user");
    const workflow = await waitingWorkflow(ada);
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: reader.userId,
      role: "user",
    });
    const { runId } = await start(ada, workflow.id);
    const byReader = await outcome(
      terminateResourceRun(env, reader, workflow.id, runId)
    );
    const stopped = await terminateResourceRun(env, ada, workflow.id, runId);
    const again = await outcome(
      terminateResourceRun(env, ada, workflow.id, runId)
    );
    const audited = await runEvents(runId, "workflow.run.terminated");
    expect({
      byReader,
      status: stopped.status,
      ended: stopped.endedAt !== null,
      again,
      audited: audited.map(({ actor }) => actor),
      deleted: await outcome(deleteWorkflowResource(env, ada, workflow.id)),
    }).toMatchObject({
      byReader: "role.forbidden",
      status: "cancelled",
      ended: true,
      again: "workflow.run_ended",
      audited: [{ type: "person", userId: ada.userId }],
      deleted: "ok",
    });
  });

  it("audits a stop the engine took, though it couldn't say where the run is after", async () => {
    const ada = await builder();
    const workflow = await waitingWorkflow(ada);
    const { runId } = await start(ada, workflow.id);
    // The engine's, its row running: stopped by the engine.
    await settledInEngine(runId);
    await vi.waitFor(
      async () => {
        await expect(runColumn(runId, "status")).resolves.toBe("running");
      },
      { timeout: 10_000, interval: 50 }
    );
    // The engine takes the terminate, then can't answer the lookup.
    const stopped = await whileEngineRefuses(
      (method) => method === "status",
      async () =>
        await outcome(terminateResourceRun(env, ada, workflow.id, runId))
    );
    await settledInEngine(runId);
    const audited = await runEvents(runId, "workflow.run.terminated");
    expect({
      stopped,
      inEngine: await engineStatus(runId),
      audited: audited.map(({ actor }) => actor),
    }).toMatchObject({
      stopped: "ok",
      inEngine: "terminated",
      audited: [{ type: "person", userId: ada.userId }],
    });
  });

  it("stops a run the engine refuses to terminate from the stop on: it runs nothing more, and ends cancelled with no repair", async () => {
    const ada = await builder();
    // Its wait is over well before a minute's repair would come.
    const workflow = await published(
      ada,
      definitionOf([{ id: "pause", type: "wait", for: "2 seconds" }])
    );
    const { runId } = await start(ada, workflow.id);
    await settledInEngine(runId);
    await vi.waitFor(
      async () => {
        await expect(runColumn(runId, "status")).resolves.toBe("running");
      },
      { timeout: 10_000, interval: 50 }
    );
    const stopped = await whileEngineRefuses(
      (method) => method === "terminate",
      async () =>
        await outcome(terminateResourceRun(env, ada, workflow.id, runId))
    );
    const meanwhile = await engineStatus(runId);
    // No repair of core's runs: the run's own object ends it.
    const run = await ended(ada, workflow.id, runId);
    // And past its wait again: it never comes back.
    await scheduler.wait(2500);
    const after = await resourceRunFor(env, ada, workflow.id, runId);
    const asked = await runEvents(runId, "workflow.run.stop_requested");
    const terminated = await runEvents(runId, "workflow.run.terminated");
    const cancelled = await runEvents(runId, "workflow.run.cancelled");
    expect({
      stopped,
      meanwhile,
      status: run.status,
      after: after.status,
      inEngine: await engineStatus(runId),
      completed: await runEvents(runId, "workflow.run.completed"),
      asked: asked.map(({ actor }) => actor),
      terminated: terminated.length,
      cancelled: cancelled.map(({ actor }) => actor),
    }).toStrictEqual({
      // Answered: the stop is the run's, whatever the engine said.
      stopped: "ok",
      meanwhile: "waiting",
      status: "cancelled",
      after: "cancelled",
      inEngine: "terminated",
      completed: [],
      // The stop audited as asked, under Ada, never as a termination
      // before anything terminated; the termination as it happened, when
      // the run's object ended it.
      asked: [{ type: "person", userId: ada.userId }],
      terminated: 0,
      cancelled: [{ type: "system" }],
    });
  });

  it("shows a person's run to them and the workflow's builders, never to its other users", async () => {
    const ada = await builder();
    const reader = await builder("user");
    const other = await builder("user");
    const workflow = await waitingWorkflow(ada);
    for (const person of [reader, other]) {
      // oxlint-disable-next-line no-await-in-loop -- one share after another
      await shareWorkflowResource(env, ada, workflow.id, {
        type: "person",
        id: person.userId,
        role: "user",
      });
    }
    const { runId } = await start(reader, workflow.id);
    expect({
      own: await outcome(resourceRunFor(env, reader, workflow.id, runId)),
      builder: await outcome(resourceRunFor(env, ada, workflow.id, runId)),
      other: await outcome(resourceRunFor(env, other, workflow.id, runId)),
    }).toStrictEqual({
      own: "ok",
      builder: "ok",
      other: "workflow.run_unavailable",
    });
  });

  it("lists a workflow's runs newest first: every run to its builders, a user's own to them, none to anyone without a role, and never what one returned", async () => {
    const ada = await builder();
    const reader = await builder("user");
    const other = await builder("user");
    const outsider = await builder("user");
    const workflow = await published(ada, definitionOf([]));
    for (const person of [reader, other]) {
      // oxlint-disable-next-line no-await-in-loop -- one share after another
      await shareWorkflowResource(env, ada, workflow.id, {
        type: "person",
        id: person.userId,
        role: "user",
      });
    }
    const first = await start(reader, workflow.id);
    const second = await start(ada, workflow.id);
    const third = await start(reader, workflow.id);
    // Ended with an output, which the list never carries.
    await vi.waitFor(
      async () => {
        const run = await resourceRunFor(env, reader, workflow.id, third.runId);
        expect(run.result).toStrictEqual({ status: "done" });
      },
      { timeout: 30_000, interval: 100 }
    );
    const idsOf = async (by: Acting) => {
      const runs = await listResourceRuns(env, by, workflow.id);
      return runs.map(({ id }) => id);
    };
    const listed = await listResourceRuns(env, ada, workflow.id);

    expect({
      builder: listed.map(({ id }) => id),
      reader: await idsOf(reader),
      other: await idsOf(other),
      outsider: await outcome(listResourceRuns(env, outsider, workflow.id)),
      details: listed.some((run) => "output" in run || "error" in run),
    }).toStrictEqual({
      builder: [third.runId, second.runId, first.runId],
      reader: [third.runId, first.runId],
      other: [],
      outsider: "workflow.resource_unavailable",
      details: false,
    });
  });

  it("sends a start the engine refused again, backing off, then fails the run and lets the workflow go", async () => {
    const by = await builder();
    const workflow = await waitingWorkflow(by);
    const { runId } = await whileEngineRefuses(
      () => true,
      async () => await start(by, workflow.id)
    );
    const createdAt = Number(await runColumn(runId, "created_at"));
    const at = (minutes: number) => new Date(createdAt + minutes * 60_000);
    // The engine still refuses every start; it only says it has no run.
    const attemptsAt = async (minutes: number) =>
      await whileEngineRefuses(
        (method) => method !== "status",
        async () => {
          await repairResourceStarts(env, at(minutes));
          return await runColumn(runId, "start_attempts");
        }
      );
    const attempts = [
      await attemptsAt(2),
      // Within the minute it backs off for after its first try.
      await attemptsAt(2.5),
      await attemptsAt(3.1),
    ];
    // Six hours on, it hasn't started: failed, and its workflow free to go.
    await attemptsAt(7 * 60);
    const failed = await runEvents(runId, "workflow.run.failed");
    // A start that was on its way all along reaches the engine after, and
    // its instance fails on the ended row: the row's reason stands.
    await runEngine(env).createResource({
      id: runId ?? "",
      pinned: {
        workflow: workflowResourceIdSchema.parse(workflow.id),
        version: 1,
        manifest: String(await runColumn(runId, "manifest_hash")),
      },
      input: { who: "Ada" },
    });
    await settledInEngine(runId);
    // Its person reads why, though the engine never had it.
    const read = await resourceRunFor(env, by, workflow.id, runId);
    expect({
      attempts,
      status: read.status,
      code: read.error?.code,
      reason: failed.map(({ detail }) => detail?.reason),
      deleted: await outcome(deleteWorkflowResource(env, by, workflow.id)),
    }).toStrictEqual({
      attempts: [1, 1, 2],
      status: "failed",
      code: "workflow.start_unconfirmed",
      reason: ["workflow.start_unconfirmed"],
      deleted: "ok",
    });
  });

  it("keeps an ended run as it ended", async () => {
    const by = await builder();
    const workflow = await published(by, definitionOf([]));
    const { runId } = await start(by, workflow.id);
    await ended(by, workflow.id, runId);
    const reopened = await outcome(
      env.DB.prepare(
        "UPDATE workflow_resource_runs SET status = 'running', ended_at = NULL WHERE id = ?"
      )
        .bind(runId)
        .run()
    );
    expect({
      reopened: reopened.includes("an ended run stays ended"),
      status: await runColumn(runId, "status"),
    }).toStrictEqual({ reopened: true, status: "completed" });
  });
});
