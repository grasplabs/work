import { workflowResourceIdSchema } from "@grasp-os/shared/ids";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { runEngine } from "../src/workflows/engine.ts";
import {
  repairResourceStarts,
  repairResourceTerminations,
  resourceRunFor,
  runOf,
  settleControl,
  terminateResourceRun,
} from "../src/workflows/resource-runs.ts";
import { removedText } from "../src/workflows/retention.ts";
import { endLiveResourceRuns } from "./json-workflow-apps.ts";
import { aroundEngine, whileEngineRefuses } from "./runs.ts";
import {
  builder,
  definitionOf,
  failingDefinition,
  published,
  start,
  ended,
  runColumn,
  engineStatus,
  settledInEngine,
  waitingWorkflow,
  repairWhileLookupsFail,
  runEvents,
  holdNotifications,
} from "./workflow-resource-runs-harness.ts";

// Runs of independent workflows (workflows/resource-runs.ts and
// sealed-run.ts), from their threat model: a start's receipt admits a
// run of exactly the version's sealed build, which runs with the
// parameters the start froze, carries the definition's text only as
// data, refuses a build that isn't the one it was admitted for, and
// keeps its workflow from being deleted until it ends.
//
// Here: whose word a run's row takes, and whose clock; the rest in the
// other workflow-resource-run*.test.ts files.

describe("whose word a run's row takes, and whose clock", () => {
  afterEach(endLiveResourceRuns);

  it("audits a control settled once, though a page and the engine settle it in the same millisecond", async () => {
    const by = await builder();
    const waiting = await waitingWorkflow(by);
    const { runId } = await start(by, waiting.id);
    // Asleep, its row running: nothing but the settlers moves its snapshot.
    await settledInEngine(runId);
    await vi.waitFor(
      async () => {
        await expect(runColumn(runId, "status")).resolves.toBe("running");
      },
      { timeout: 10_000, interval: 50 }
    );
    const app = crypto.randomUUID();
    const control = crypto.randomUUID();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO apps (id, name, description, owner_id, created_at) VALUES (?, 'Desk', '', ?, ?)"
      ).bind(app, by.userId, now),
      env.DB.prepare(
        "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, created_at, next_at, generation) VALUES (?, ?, ?, ?, ?, 'pause', 'admitted', ?, ?, 1)"
      ).bind(control, runId, app, by.userId, "0".repeat(32), now, now),
    ]);
    const row = await runOf(env, runId ?? "");
    if (row === undefined) {
      throw new Error("No run");
    }
    // Both settlers read the same clock: the page's apply and the
    // engine's notification, landing together.
    vi.useFakeTimers({ toFake: ["Date"], now });
    try {
      await Promise.all([
        settleControl(
          env,
          row,
          { id: control, kind: "pause", principalId: by.userId },
          "applied"
        ),
        settleControl(
          env,
          row,
          { id: control, kind: "pause", principalId: by.userId },
          "applied"
        ),
      ]);
    } finally {
      vi.useRealTimers();
    }
    const settled = await env.DB.prepare(
      "SELECT state FROM workflow_resource_run_controls WHERE id = ?"
    )
      .bind(control)
      .first<{ state: string }>();
    const audited = await runEvents(runId, "workflow.run.control_applied");
    expect({
      state: settled?.state,
      audited: audited.length,
    }).toStrictEqual({
      state: "applied",
      audited: 1,
    });
  });

  it("shows what a run returned only within its retention", async () => {
    const by = await builder();
    const done = await published(by, definitionOf([]));
    const failing = await published(by, failingDefinition);
    const completed = await start(by, done.id);
    const failed = await start(by, failing.id);
    await ended(by, done.id, completed.runId);
    await ended(by, failing.id, failed.runId);
    // A day before their retention is over, and a day after: the engine
    // still holds both, as it purges an ended run on its own clock.
    const within = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + 29 * 86_400_000);
    let kept: WorkflowResourceRun;
    try {
      kept = await resourceRunFor(env, by, done.id, completed.runId);
    } finally {
      within.mockRestore();
    }
    const later = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + 31 * 86_400_000);
    let reads: WorkflowResourceRun[];
    try {
      reads = [
        // Past its retention, read with the engine unreachable: the row
        // alone says it all.
        await whileEngineRefuses(
          () => true,
          async () => await resourceRunFor(env, by, done.id, completed.runId)
        ),
        await resourceRunFor(env, by, failing.id, failed.runId),
        // The engine's record of it gone too, its retention over there: the
        // code the row kept as it failed.
        await aroundEngine(
          async (method, call) =>
            method === "status" ? undefined : await call(),
          async () => await resourceRunFor(env, by, failing.id, failed.runId)
        ),
        // Or unreachable: the row alone says it.
        await whileEngineRefuses(
          () => true,
          async () => await resourceRunFor(env, by, failing.id, failed.runId)
        ),
      ];
    } finally {
      later.mockRestore();
    }
    const [removed, removedFailure, purgedFailure, unreachable] = reads;
    expect({
      kept: kept.result,
      removed: removed?.result,
      failure: removedFailure?.error,
      purged: purgedFailure?.error,
      unreachable: unreachable?.error,
    }).toStrictEqual({
      kept: { status: "done" },
      removed: undefined,
      failure: { code: "expression.failed", message: removedText },
      purged: { code: "expression.failed", message: removedText },
      unreachable: { code: "expression.failed", message: removedText },
    });
  });

  it("cancels a run still starting before the engine hears, so a start already on its way runs nothing", async () => {
    const by = await builder();
    const workflow = await waitingWorkflow(by);
    const { runId } = await whileEngineRefuses(
      () => true,
      async () => await start(by, workflow.id)
    );
    const manifest = String(await runColumn(runId, "manifest_hash"));
    // A start sent before the terminate reaches the engine just after the
    // engine was told of it.
    const stopped = await aroundEngine(
      async (method, call) => {
        const answer = await call();
        if (method === "terminate") {
          await runEngine(env).createResource({
            id: runId ?? "",
            pinned: {
              workflow: workflowResourceIdSchema.parse(workflow.id),
              version: 1,
              manifest,
            },
            input: { who: "Ada" },
          });
          await settledInEngine(runId);
        }
        return answer;
      },
      async () => await terminateResourceRun(env, by, workflow.id, runId)
    );
    const inEngine = await engineStatus(runId);
    // Its person reads it cancelled, nothing of what the late start did.
    const read = await resourceRunFor(env, by, workflow.id, runId);
    expect({
      status: stopped.status,
      inEngine,
      read: { status: read.status, error: read.error, output: read.result },
    }).toStrictEqual({
      status: "cancelled",
      inEngine: "errored",
      read: { status: "cancelled", error: undefined, output: undefined },
    });
  });

  it("keeps telling the engine to terminate a run cancelled while starting until the engine takes it", async () => {
    const by = await builder();
    const workflow = await waitingWorkflow(by);
    const { runId } = await whileEngineRefuses(
      () => true,
      async () => await start(by, workflow.id)
    );
    const id = runId ?? "";
    const manifest = String(await runColumn(id, "manifest_hash"));
    // A start sent before the cancel made an instance, asleep now; its
    // first notification is still on its way to core.
    const released = Promise.withResolvers<null>();
    await holdNotifications(id, released.promise);
    await runEngine(env).createResource({
      id,
      pinned: {
        workflow: workflowResourceIdSchema.parse(workflow.id),
        version: 1,
        manifest,
      },
      input: { who: "Ada" },
    });
    await settledInEngine(id);
    const stopped = await whileEngineRefuses(
      (method) => method === "terminate",
      async () => await terminateResourceRun(env, by, workflow.id, id)
    );
    const meanwhile = await engineStatus(id);
    await repairResourceTerminations(env, new Date(Date.now() + 60_000));
    released.resolve(null);
    expect({
      status: stopped.status,
      meanwhile,
      inEngine: await engineStatus(id),
    }).toStrictEqual({
      status: "cancelled",
      meanwhile: "waiting",
      inEngine: "terminated",
    });
  });

  it("moves a run whose engine lookup fails back in the repair's queue, neither sent again nor counted, until it is abandoned", async () => {
    const by = await builder();
    const workflow = await waitingWorkflow(by);
    const { runId } = await whileEngineRefuses(
      () => true,
      async () => await start(by, workflow.id)
    );
    const id = runId ?? "";
    const createdAt = Number(await runColumn(id, "created_at"));
    const at = createdAt + 2 * 60_000;
    // The engine can't say where the run is: every lookup fails.
    await repairWhileLookupsFail(at);
    const meanwhile = {
      attempts: await runColumn(id, "start_attempts"),
      nextAt: Number(await runColumn(id, "next_start_at")) > at,
      status: await runColumn(id, "status"),
    };
    // Six hours on, the engine still can't say: failed, never left starting.
    await repairWhileLookupsFail(createdAt + 7 * 3_600_000);
    // Its person reads why while the engine still can't answer.
    const read = await whileEngineRefuses(
      (method) => method === "status",
      async () => await resourceRunFor(env, by, workflow.id, id)
    );
    expect({
      meanwhile,
      status: await runColumn(id, "status"),
      code: await runColumn(id, "failure_code"),
      read: { status: read.status, code: read.error?.code },
    }).toStrictEqual({
      meanwhile: { attempts: 0, nextAt: true, status: "starting" },
      status: "failed",
      code: "workflow.start_unconfirmed",
      read: { status: "failed", code: "workflow.start_unconfirmed" },
    });
  });

  it("terminates a run the repair abandons when a start sent again made an instance after the repair asked", async () => {
    const by = await builder();
    const workflow = await waitingWorkflow(by);
    const { runId } = await whileEngineRefuses(
      () => true,
      async () => await start(by, workflow.id)
    );
    const id = runId ?? "";
    const manifest = String(await runColumn(id, "manifest_hash"));
    const createdAt = Number(await runColumn(id, "created_at"));
    const released = Promise.withResolvers<null>();
    await holdNotifications(id, released.promise);
    // The repair finds no instance; a start sent again makes one just
    // after, which reads the row (still starting) before the repair ends it.
    const raced = { done: false };
    await aroundEngine(
      async (method, call) => {
        const answer = await call();
        if (method === "status" && !raced.done) {
          raced.done = true;
          await runEngine(env).createResource({
            id,
            pinned: {
              workflow: workflowResourceIdSchema.parse(workflow.id),
              version: 1,
              manifest,
            },
            input: { who: "Ada" },
          });
          await settledInEngine(id);
        }
        return answer;
      },
      async () => {
        await repairResourceStarts(env, new Date(createdAt + 7 * 3_600_000));
      }
    );
    const abandoned = await runColumn(id, "status");
    const meanwhile = await engineStatus(id);
    await repairResourceTerminations(env, new Date(createdAt + 8 * 3_600_000));
    released.resolve(null);
    expect({
      abandoned,
      meanwhile,
      inEngine: await engineStatus(id),
    }).toStrictEqual({
      abandoned: "failed",
      meanwhile: "waiting",
      inEngine: "terminated",
    });
  });

  it("leaves a run that ended in the engine before its terminate to its end's notification, at the engine's time", async () => {
    const by = await builder();
    const workflow = await published(by, definitionOf([]));
    const { runId } = await whileEngineRefuses(
      () => true,
      async () => await start(by, workflow.id)
    );
    const id = runId ?? "";
    const createdAt = Number(await runColumn(id, "created_at"));
    const released = Promise.withResolvers<null>();
    await holdNotifications(id, released.promise);
    // The engine runs it to its end and tells core nothing of it yet; the
    // repair finds the engine has it.
    await repairResourceStarts(env, new Date(createdAt + 2 * 60_000));
    await settledInEngine(id);
    await repairResourceStarts(env, new Date(createdAt + 4 * 60_000));
    const asked = Date.now();
    await terminateResourceRun(env, by, workflow.id, id);
    const meanwhile = await runColumn(id, "status");
    released.resolve(null);
    const run = await ended(by, workflow.id, id);
    expect({
      meanwhile,
      status: run.status,
      atEngineTime: Date.parse(run.endedAt ?? "") < asked,
    }).toStrictEqual({
      meanwhile: "running",
      status: "completed",
      atEngineTime: true,
    });
  });

  it("ends a run the repair finds ended in the engine at the engine's time, not the repair's", async () => {
    const by = await builder();
    const workflow = await published(by, definitionOf([]));
    const { runId } = await whileEngineRefuses(
      () => true,
      async () => await start(by, workflow.id)
    );
    const id = runId ?? "";
    const createdAt = Number(await runColumn(id, "created_at"));
    const released = Promise.withResolvers<null>();
    await holdNotifications(id, released.promise);
    // The repair sends its start; the engine runs it to its end, and tells
    // core nothing of it yet.
    await repairResourceStarts(env, new Date(createdAt + 2 * 60_000));
    await settledInEngine(id);
    // The next repair, minutes on, finds the engine has it.
    await repairResourceStarts(env, new Date(createdAt + 4 * 60_000));
    const meanwhile = await runColumn(id, "status");
    released.resolve(null);
    const run = await ended(by, workflow.id, id);
    expect({
      meanwhile,
      status: run.status,
      atEngineTime: Date.parse(run.endedAt ?? "") < createdAt + 2 * 60_000,
    }).toStrictEqual({
      meanwhile: "running",
      status: "completed",
      atEngineTime: true,
    });
  });
});
