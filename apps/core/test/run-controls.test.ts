import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { runEngine } from "../src/workflows/engine.ts";
import {
  projectResourceRun,
  repairResourceStarts,
  repairResourceTerminations,
  settleResourceControls,
} from "../src/workflows/resource-runs.ts";
import { mockIdp } from "./idp.ts";
import {
  called,
  controlCommand,
  endedRun,
  endLiveResourceRuns,
  jsonWorkflowAppsOf,
  keyOf,
  outcomeOf,
  wireOf,
  runFor,
  screenOf,
  settles,
  staged,
  startCommand,
  startedOf,
} from "./json-workflow-apps.ts";
import type { Person, WorkflowReference } from "./json-workflow-apps.ts";
import {
  aroundEngine,
  liveStatus,
  runObject,
  runObjectId,
  sleeping,
  whileEngineRefuses,
} from "./runs.ts";
import { auditedDuring } from "./sign-in.ts";

// Pausing, resuming and cancelling an independent JSON workflow's run from
// an App's screen, as the host admits each request with a durable receipt
// and settles it from the engine's own fenced word (screen-workflows.ts,
// workflows/resource-runs.ts). The everyday paths (receipts answered again
// under their key, joins, conflicts, a cancel superseding a pause, the
// repair applying a stalled one, other people's and other Apps' runs) are
// in screen-typed-workflows.test.ts. What could still go wrong, tried
// below: a pause that stops time; a pause of a run still starting that
// ends the run, gets lost, or outlives a start given up; a resume judged
// by a row that lags behind the engine; a control of a run the engine has
// ended; a pause delivered late undoing a newer resume; a receipt settled
// from a stale read or a late notification rather than the engine's
// fence; a receipt of a run that has ended sent to the engine anyway; a
// control verb the host doesn't know admitted; and receipts that never
// settle crowding a live run's out of the repair. Runs are real, on the
// engine. Moved elsewhere, not dropped: a cancelled run's calls refused
// from the cancel on, and never coming back: covered by GRA-1460's tests.

const idp = mockIdp();

const { boundApp } = jsonWorkflowAppsOf(idp);

/** Receipts due before a repair's turn: more than one repair takes (20). */
const moreThanOneRepairTakes = 25;

/** A minute and more from now: past when an admitted receipt is first due. */
const pastFirstRepair = (): Date => new Date(Date.now() + 2 * 60_000);

/** Past the longest a run may say `starting` before its start is given up. */
const pastStarting = (): Date => new Date(Date.now() + 7 * 3_600_000);

/** A screen of `person`'s on `app`, and what it asks of the workflow. */
const screenAsking = async (
  person: Person,
  app: string,
  reference: WorkflowReference
) => {
  const lease = await screenOf(person, app);
  return {
    start: async (): Promise<string> =>
      startedOf(await called(person, app, lease, startCommand(reference)))
        .runId,
    control: async (
      command: "pause" | "resume" | "cancel",
      runId: string
    ): Promise<unknown> =>
      outcomeOf(
        await called(
          person,
          app,
          lease,
          controlCommand(reference, command, runId)
        )
      ),
  };
};

/** The run's receipts, oldest generation first, as their kind and state. */
const receiptStates = async (run: string): Promise<string[][]> => {
  const { results } = await env.DB.prepare(
    "SELECT kind, state FROM workflow_resource_run_controls WHERE run_id = ? ORDER BY generation, created_at"
  )
    .bind(run)
    .all<{ kind: string; state: string }>();
  return results.map(({ kind, state }) => [kind, state]);
};

/** Whether every receipt of the run is applied. */
const allApplied = async (run: string): Promise<boolean> => {
  const receipts = await receiptStates(run);
  return receipts.every(([, state]) => state === "applied");
};

/** The run's status as its row has it, read as `person` reads the run. */
const rowStatus = async (
  person: Person,
  workflow: string,
  run: string
): Promise<string> => {
  const { status } = await runFor(person, workflow, run);
  return status;
};

/**
 * Whether the engine holds the run paused, or pausing at its next safe
 * boundary. A run in its hold may otherwise be waiting, or running a
 * moment as it is woken to check its share.
 */
const pausedInEngine = async (run: string): Promise<boolean> =>
  ["paused", "waitingForPause"].includes(await liveStatus(run));

/** Once `check` holds, polling. */
const until = async (check: () => Promise<boolean>): Promise<void> => {
  await vi.waitFor(async () => {
    await expect(check()).resolves.toBeTruthy();
  }, settles);
};

/** The journaled deadline of the run's hold. */
const holdDeadline = async (run: string): Promise<number | undefined> =>
  await runInDurableObject(
    runObject(run),
    (_object, state) =>
      state.storage.sql
        .exec<{ deadline: number }>(
          "SELECT deadline FROM steps WHERE type = 'sleep' AND name = 'task:hold'"
        )
        .toArray()[0]?.deadline
  );

/** A run of the workflow, asleep in its hold of an hour. */
const holding = async () => {
  const bound = await boundApp({ hold: "1 hour" });
  const screen = await screenAsking(bound.builder, bound.app, bound.reference);
  const runId = await screen.start();
  await sleeping(runId, "hold:task");
  return { ...bound, screen, runId };
};

/** A run of the workflow whose start the engine never took: still starting. */
const neverStarted = async () => {
  const bound = await boundApp({ hold: "1 hour" });
  const screen = await screenAsking(bound.builder, bound.app, bound.reference);
  const runId = await whileEngineRefuses(
    () => true,
    async () => await screen.start()
  );
  return { ...bound, screen, runId };
};

describe(
  "controls of a JSON workflow's run from an App's screen",
  { timeout: 60_000 },
  () => {
    afterEach(endLiveResourceRuns);

    it("keeps a hold's deadline where it was across a pause and its resume, so time passes while the run is paused", async () => {
      const { screen, runId } = await holding();
      await until(async () => (await holdDeadline(runId)) !== undefined);
      const deadline = await holdDeadline(runId);

      const paused = await screen.control("pause", runId);
      await until(async () => (await liveStatus(runId)) === "paused");
      await scheduler.wait(50);
      const resumed = await screen.control("resume", runId);

      expect({
        paused: staged(paused),
        resumed: staged(resumed),
        kept: (await holdDeadline(runId)) === deadline,
        stillPaused: await pausedInEngine(runId),
      }).toStrictEqual({
        paused: { kind: "pause", state: "applied" },
        resumed: { kind: "resume", state: "applied" },
        kept: true,
        stillPaused: false,
      });
    });

    it("keeps a pause of a run still starting admitted, never ending the run, and applies it once the run started", async () => {
      const { screen, runId } = await neverStarted();

      const pause = await screen.control("pause", runId);
      const whileStarting = {
        row: await env.DB.prepare(
          "SELECT status, ended_at IS NOT NULL AS ended FROM workflow_resource_runs WHERE id = ?"
        )
          .bind(runId)
          .first(),
        receipts: await receiptStates(runId),
      };
      // The repair sends the start again, then the pause once it started.
      await repairResourceStarts(env, pastFirstRepair());
      await sleeping(runId, "hold:task");
      await repairResourceTerminations(env, pastFirstRepair());
      await until(async () => (await liveStatus(runId)) === "paused");
      await until(async () => await allApplied(runId));

      expect({
        pause: staged(pause),
        whileStarting,
        receipts: await receiptStates(runId),
      }).toStrictEqual({
        pause: { kind: "pause", state: "admitted" },
        whileStarting: {
          row: { status: "starting", ended: 0 },
          receipts: [["pause", "admitted"]],
        },
        receipts: [["pause", "applied"]],
      });
    });

    it("supersedes a pause of a run still starting the moment its start is given up, leaving none admitted behind the failed run", async () => {
      const { builder, workflow, screen, runId } = await neverStarted();
      await screen.control("pause", runId);

      // The engine never takes the start: the repair gives it up, and
      // settles the pause with it, no other repair after.
      await repairResourceStarts(env, pastStarting());

      expect({
        status: await rowStatus(builder, workflow, runId),
        receipts: await receiptStates(runId),
      }).toStrictEqual({
        status: "failed",
        receipts: [["pause", "superseded"]],
      });
    });

    it("resumes a run the engine has paused though its row still says running, judged by the engine", async () => {
      const { screen, runId } = await holding();
      await screen.control("pause", runId);
      await until(async () => (await liveStatus(runId)) === "paused");
      // The row behind the engine, as while its notification is on the way.
      await env.DB.prepare(
        "UPDATE workflow_resource_runs SET status = 'running' WHERE id = ?"
      )
        .bind(runId)
        .run();

      const resumed = await screen.control("resume", runId);

      expect({
        resumed: staged(resumed),
        stillPaused: await pausedInEngine(runId),
        receipts: await receiptStates(runId),
      }).toStrictEqual({
        resumed: { kind: "resume", state: "applied" },
        stillPaused: false,
        receipts: [
          ["pause", "applied"],
          ["resume", "applied"],
        ],
      });
    });

    it("refuses a pause or a resume of a run the engine has ended, its row still to hear of it, keeping no receipt", async () => {
      const { builder, workflow, screen, runId } = await holding();
      // The row deaf to the engine's notifications from now on, as while
      // they are on the way; then the engine ends the run.
      await env.DB.prepare(
        "UPDATE workflow_resource_runs SET engine_sequence = ? WHERE id = ?"
      )
        .bind(Number.MAX_SAFE_INTEGER, runId)
        .run();
      await runObject(runId).terminate({ rollback: false });
      await until(async () => (await liveStatus(runId)) === "terminated");

      expect({
        row: await rowStatus(builder, workflow, runId),
        pause: await screen.control("pause", runId),
        resume: await screen.control("resume", runId),
        receipts: await receiptStates(runId),
      }).toStrictEqual({
        row: "running",
        pause: "workflow.control_refused",
        resume: "workflow.control_refused",
        receipts: [],
      });
    });

    it("leaves a run unpaused when a pause older than its resume reaches the engine late", async () => {
      const { screen, runId } = await holding();
      await screen.control("pause", runId);
      await until(async () => (await liveStatus(runId)) === "paused");
      await screen.control("resume", runId);
      const pause = await env.DB.prepare(
        "SELECT generation FROM workflow_resource_run_controls WHERE run_id = ? AND kind = 'pause'"
      )
        .bind(runId)
        .first<number>("generation");

      // The pause's call to the engine, delivered again after the resume.
      await runEngine(env).pause(runId, pause ?? 0);

      expect({
        paused: await pausedInEngine(runId),
        receipts: await receiptStates(runId),
      }).toStrictEqual({
        paused: false,
        receipts: [
          ["pause", "applied"],
          ["resume", "applied"],
        ],
      });
    });

    it("settles no pause the engine hasn't taken, from a read of the run paused before it or a late notification of it paused", async () => {
      const { screen, runId } = await holding();
      await screen.control("pause", runId);
      await until(async () => (await liveStatus(runId)) === "paused");
      // Read while it is paused, and handed on late.
      const read = await runEngine(env).controlState(runId);
      await screen.control("resume", runId);
      // A newer pause admitted, its call to the engine failing.
      const newer = await whileEngineRefuses(
        (method) => method === "pause",
        async () => await screen.control("pause", runId)
      );

      // A "paused" from before it, delivered late, the row taking it.
      await projectResourceRun(env, runId, {
        status: "paused",
        at: Date.now(),
        sequence: 1_000_000,
      });
      const afterNotification = await receiptStates(runId);
      await settleResourceControls(env, runId, read);

      expect({
        newer: staged(newer),
        afterNotification,
        afterRead: await receiptStates(runId),
        paused: await pausedInEngine(runId),
      }).toStrictEqual({
        newer: { kind: "pause", state: "admitted" },
        afterNotification: [
          ["pause", "applied"],
          ["resume", "applied"],
          ["pause", "admitted"],
        ],
        afterRead: [
          ["pause", "applied"],
          ["resume", "applied"],
          ["pause", "admitted"],
        ],
        paused: false,
      });
    });

    it("refuses a control verb the host doesn't know as invalid, keeping no receipt and auditing nothing of the run", async () => {
      const { builder, app, reference, screen, runId } = await holding();
      const lease = await screenOf(builder, app);
      let answer: unknown;
      const events = await auditedDuring(async () => {
        answer = outcomeOf(
          await called(
            builder,
            app,
            lease,
            JSON.stringify({
              workflow: wireOf(reference),
              command: "restart",
              runId,
              idempotencyKey: keyOf(),
            })
          )
        );
      });

      expect({
        answer,
        receipts: await receiptStates(runId),
        audited: events.filter(({ target }) => target?.id === runId),
        stillPaused: await pausedInEngine(runId),
        // The screen's real controls still work after it.
        pause: staged(await screen.control("pause", runId)),
      }).toStrictEqual({
        answer: "contract.invalid_request",
        receipts: [],
        audited: [],
        stillPaused: false,
        pause: { kind: "pause", state: "applied" },
      });
    });

    it("supersedes at the repair a pause and a resume of a run that has ended, sending neither to the engine", async () => {
      const { builder, app, reference, workflow } = await boundApp();
      const screen = await screenAsking(builder, app, reference);
      const runId = await screen.start();
      await endedRun(builder, workflow, runId);
      // Receipts admitted under the run's newest generation, never
      // overtaken, left behind its end and due at the repair.
      const old = Date.now() - 120_000;
      await env.DB.batch(
        (["pause", "resume"] as const).map((kind) =>
          env.DB.prepare(
            "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, generation, created_at, next_at) SELECT ?, id, ?, ?, ?, ?, 'admitted', control_generation + 1, ?, ? FROM workflow_resource_runs WHERE id = ?"
          ).bind(
            crypto.randomUUID(),
            app,
            builder.userId,
            keyOf(),
            kind,
            old,
            old,
            runId
          )
        )
      );
      const sent: string[] = [];
      const run = runObjectId(runId);

      await aroundEngine(
        async (method, call, object) => {
          if (object.equals(run)) {
            sent.push(method);
          }
          return await call();
        },
        async () => {
          await repairResourceTerminations(env, new Date());
        }
      );

      // Admitted together, in either order: by kind.
      const settled = await receiptStates(runId);
      const byKind = Object.fromEntries(
        settled.map(([kind, state]): [string, string | undefined] => [
          String(kind),
          state,
        ])
      );

      expect({
        receipts: byKind,
        sent: sent.filter(
          (method) => method === "pause" || method === "resume"
        ),
      }).toStrictEqual({
        receipts: { pause: "superseded", resume: "superseded" },
        sent: [],
      });
    });

    it("reaches a live run's stalled pause within two repairs, past more receipts that never settle than one repair takes", async () => {
      const stuck = await neverStarted();
      const { screen, runId } = await holding();
      const { app, builder } = stuck;
      // Receipts of a run the engine has no record of, so none ever
      // settles, each due before the live run's.
      const old = Date.now() - 120_000;
      await env.DB.batch(
        Array.from({ length: moreThanOneRepairTakes }, (_, index) =>
          env.DB.prepare(
            "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, generation, created_at, next_at) VALUES (?, ?, ?, ?, ?, 'pause', 'admitted', 1000, ?, ?)"
          ).bind(
            crypto.randomUUID(),
            stuck.runId,
            app,
            builder.userId,
            keyOf(),
            old,
            old + index
          )
        )
      );
      // The live run's pause admitted, the engine's answer lost.
      const lost = await whileEngineRefuses(
        (method) => method === "pause",
        async () => await screen.control("pause", runId)
      );
      await env.DB.prepare(
        "UPDATE workflow_resource_run_controls SET next_at = ? WHERE run_id = ?"
      )
        .bind(Date.now() - 60_000, runId)
        .run();

      await repairResourceTerminations(env, new Date());
      await repairResourceTerminations(env, new Date());
      await until(async () => (await liveStatus(runId)) === "paused");
      await until(async () => await allApplied(runId));

      expect({
        lost: staged(lost),
        live: await receiptStates(runId),
      }).toStrictEqual({
        lost: { kind: "pause", state: "admitted" },
        live: [["pause", "applied"]],
      });
    });
  }
);
