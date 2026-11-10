import { v } from "@grasp-os/runtime";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { repairResourceTerminations } from "../src/workflows/resource-runs.ts";
import { tellQueryFollowers } from "../src/workflows/run-changes.ts";
import { mockIdpWith } from "./idp.ts";
import {
  called,
  controlCommand,
  endLiveResourceRuns,
  keyOf,
  outcomeOf,
  pageOf,
  queryCall,
  settles,
  staged,
  startCommand,
} from "./json-workflow-apps.ts";
import type { Person } from "./json-workflow-apps.ts";
import {
  askingOf,
  boundApp,
  callOn,
  idp,
  pageRuns,
  refusalOf,
  signedIn,
  twoSleepsOf,
  waitsListed,
} from "./page-typed-workflows-harness.ts";
import { auditedDuring, unique } from "./sign-in.ts";

// A page's typed `useWorkflow` through the real host (spec 10.4,
// page-workflows.ts; the threat model is on GRA-626): its starts and
// controls as calls of the workflow reference's mutations, relayed over
// core's function route, and its run and whether it may start one as the
// reference's `run` and `canStart` queries, followed live through the
// frame's own capability (`pages.frame`), each answer and push checked by
// the descriptors the SDK generates.

mockIdpWith(idp);

describe(
  "a page's typed workflow through the real host",
  { timeout: 120_000 },
  () => {
    afterEach(endLiveResourceRuns);

    it("starts a run once per key, follows it to its end with its result, and tells the person they may start one", async () => {
      const fixture = await boundApp();
      const { builder, app, reference } = fixture;
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const stopBinding = channel.followBinding(() => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekBinding().value).toStrictEqual({ canRun: true });
      }, settles);

      // The same start sent twice under one key, as a lost answer's resend:
      // one run.
      const start = startCommand(reference, { who: "Ada" });
      const first = outcomeOf(await called(builder, app, lease, start));
      const again = outcomeOf(await called(builder, app, lease, start));
      const handle = z
        .object({
          runId: z.string(),
          workflowId: z.string(),
          workflowVersion: z.number(),
        })
        .parse(first);
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("completed");
      }, settles);
      const shown = channel.peekRun(handle.runId);
      stopRun();
      stopBinding();

      expect({
        again,
        handle: {
          workflowId: handle.workflowId,
          workflowVersion: handle.workflowVersion,
        },
        shown: {
          result: shown.value?.result,
          control: shown.value?.control,
          waits: shown.value?.waits,
        },
      }).toStrictEqual({
        again: first,
        handle: { workflowId: fixture.workflow, workflowVersion: 1 },
        shown: {
          result: { status: "Hello, Ada" },
          control: {
            canPause: false,
            canResume: false,
            canCancel: false,
            pendingControl: null,
          },
          waits: [],
        },
      });
    });

    it("publishes what a run waits on with its status: its task's sleep while it runs, nothing once it has ended", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      // Running, and asleep in its `hold` task: one snapshot says both.
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.waits).toHaveLength(1);
      }, settles);
      const asleep = channel.peekRun(handle.runId);
      await channel.control(handle.runId, "cancel", () => {
        // Answered below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("cancelled");
      }, settles);
      const ended = channel.peekRun(handle.runId);
      stopRun();
      const [wait] = asleep.value?.waits ?? [];

      expect({
        status: asleep.value?.status,
        wait:
          wait === undefined
            ? undefined
            : {
                kind: wait.kind,
                purpose: "purpose" in wait ? wait.purpose : undefined,
                key: wait.key,
                taskId: wait.taskId,
                // An hour's sleep (in seconds), from when it was first reached.
                length:
                  wait.deadline === null
                    ? null
                    : Math.round((wait.deadline - wait.openedAt) / 1000),
              },
        ended: {
          waits: ended.value?.waits,
          later: ended.revision > asleep.revision,
        },
      }).toStrictEqual({
        status: "running",
        wait: {
          kind: "timer",
          purpose: "sleep",
          key: "hold",
          taskId: "hold",
          length: 3600,
        },
        ended: { waits: [], later: true },
      });
    });

    it("lists a decision its run waits on as a wait its starter can't answer, and none once the run ended", async () => {
      const admin = await signedIn("admin");
      const builder = await signedIn("builder");
      const key = `approval-${unique()}`;
      await publishCatalogContract(env, admin.acting, {
        key,
        kind: "decision",
        input: JSON.stringify(v.object({ who: v.string() }).descriptor),
        response: JSON.stringify(v.object({ comment: v.string() }).descriptor),
      });
      const workflow = await createWorkflowResource(
        env,
        builder.acting,
        `ask-${unique()}`
      );
      await publishWorkflowVersion(env, builder.acting, workflow.id, {
        definition: askingOf(key, "role:admin"),
        basedOn: null,
      });
      await approveWorkflowBinding(env, admin.acting, workflow.id, {
        alias: "approval",
        target: { kind: "decision", deciders: ["role:admin"] },
        reviewed: { version: 1 },
      });
      const { app, reference } = await boundApp({
        sharing: { admin, builder, workflow },
      });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      // Asking the admins, its run waits on the decision: one snapshot.
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.waits).toHaveLength(1);
      }, settles);
      const asked = channel.peekRun(handle.runId);
      await channel.control(handle.runId, "cancel", () => {
        // Answered below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("cancelled");
      }, settles);
      const ended = channel.peekRun(handle.runId);
      stopRun();
      const { decision } = z
        .object({ decision: z.string() })
        .parse(
          await env.DB.prepare(
            "SELECT id AS decision FROM workflow_decisions WHERE resource_run_id = ?"
          )
            .bind(handle.runId)
            .first()
        );
      expect({
        asked: waitsListed(asked.value),
        ended: {
          waits: ended.value?.waits,
          later: ended.revision > asked.revision,
        },
      }).toStrictEqual({
        // Metadata only, and never theirs to answer: a run's own person
        // answers none of its decisions (R8).
        asked: [
          {
            kind: "decision",
            id: decision,
            key: "approval",
            taskId: "ask",
            canRespond: false,
          },
        ],
        ended: { waits: [], later: true },
      });
    });

    it("shows a reviewer the real decision wait that asks them, answerable, where its starter sees it unanswerable", async () => {
      const admin = await signedIn("admin");
      const builder = await signedIn("builder");
      const key = `approval-${unique()}`;
      await publishCatalogContract(env, admin.acting, {
        key,
        kind: "decision",
        input: JSON.stringify(v.object({ who: v.string() }).descriptor),
        response: JSON.stringify(v.object({ comment: v.string() }).descriptor),
      });
      const workflow = await createWorkflowResource(
        env,
        builder.acting,
        `ask-${unique()}`
      );
      await publishWorkflowVersion(env, builder.acting, workflow.id, {
        definition: askingOf(key, "role:admin"),
        basedOn: null,
      });
      await approveWorkflowBinding(env, admin.acting, workflow.id, {
        alias: "approval",
        target: { kind: "decision", deciders: ["role:admin"] },
        reviewed: { version: 1 },
      });
      const { app, reference } = await boundApp({
        sharing: { admin, builder, workflow },
      });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      // The engine runs it to its decision, asking the admins.
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.waits).toHaveLength(1);
      }, settles);
      stopRun();
      /** The waits `who` is shown of the run. */
      const waitsShownTo = async (who: Person) => {
        const shown = await callOn(
          env,
          who,
          app,
          queryCall(reference, "run", { runId: handle.runId })
        );
        return waitsListed(shown).map(({ kind, key: asked, canRespond }) => ({
          kind,
          key: asked,
          canRespond,
        }));
      };

      expect({
        starter: await waitsShownTo(builder),
        reviewer: await waitsShownTo(admin),
      }).toStrictEqual({
        // Its own person sees what it waits on, theirs to answer or not.
        starter: [{ kind: "decision", key: "approval", canRespond: false }],
        // The admin it asks watches it for that decision alone, which the
        // reviewer's filter keeps: answerable, so not dropped.
        reviewer: [{ kind: "decision", key: "approval", canRespond: true }],
      });
    });

    it("shows a run's next wait in a push of its own, though it was running all along", async () => {
      const { builder, app, reference } = await boundApp({
        definition: twoSleepsOf,
      });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const shown: { revision: number; keys: string[] }[] = [];
      const stopRun = channel.followRun(handle.runId, () => {
        const now = channel.peekRun(handle.runId);
        if (now.value !== undefined && now.value !== null) {
          shown.push({
            revision: now.revision,
            keys: now.value.waits.map(({ key }) => key),
          });
        }
      });
      await vi.waitFor(() => {
        expect(shown.at(-1)?.keys).toStrictEqual(["second"]);
      }, settles);
      stopRun();
      const first = shown.find(({ keys }) => keys.includes("first"));
      const second = shown.find(({ keys }) => keys.includes("second"));

      expect({
        sawFirst: first !== undefined,
        later:
          first !== undefined &&
          second !== undefined &&
          second.revision > first.revision,
      }).toStrictEqual({ sawFirst: true, later: true });
    });

    it("cancels a run with a receipt answered again under its key", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("running");
      }, settles);
      const running = channel.peekRun(handle.runId).value?.control;
      // The cancel, then sent again under its key, as its resend.
      const cancel = controlCommand(reference, "cancel", handle.runId, keyOf());
      const receipt = outcomeOf(await called(builder, app, lease, cancel));
      const resent = outcomeOf(await called(builder, app, lease, cancel));
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("cancelled");
      }, settles);
      const ended = channel.peekRun(handle.runId);
      stopRun();

      expect({
        running,
        receipt: staged(receipt),
        resent: staged(resent),
        ended: ended.value?.control,
      }).toStrictEqual({
        running: {
          canPause: true,
          canResume: false,
          canCancel: true,
          pendingControl: null,
        },
        receipt: { kind: "cancel", state: "applied" },
        resent: { kind: "cancel", state: "applied" },
        ended: {
          canPause: false,
          canResume: false,
          canCancel: false,
          pendingControl: null,
        },
      });
    });

    it("pauses and resumes a run, each receipt answered again under its key and audited under the App's page for the person", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("running");
      }, settles);
      const commandOf = (command: "pause" | "resume") =>
        controlCommand(reference, command, handle.runId, keyOf());
      const pauseCommand = commandOf("pause");
      let paused = channel.peekRun(handle.runId);
      let pauseAgain: unknown;
      let resumed: unknown;
      let resumedAgain: unknown;
      const events = await auditedDuring(async () => {
        await called(builder, app, lease, pauseCommand);
        await vi.waitFor(() => {
          expect(channel.peekRun(handle.runId).value?.status).toBe("paused");
        }, settles);
        paused = channel.peekRun(handle.runId);
        // Sent again under its key, as a lost answer's resend: the same.
        pauseAgain = outcomeOf(await called(builder, app, lease, pauseCommand));
        resumed = outcomeOf(
          await called(builder, app, lease, commandOf("resume"))
        );
        await vi.waitFor(() => {
          expect(channel.peekRun(handle.runId).value?.status).toBe("running");
        }, settles);
        // A resume of a run already running: applied as it is written.
        resumedAgain = outcomeOf(
          await called(builder, app, lease, commandOf("resume"))
        );
      });
      const running = channel.peekRun(handle.runId);
      stopRun();

      expect({
        paused: paused.value?.control,
        pauseAgain: staged(pauseAgain),
        resumed: staged(resumed),
        resumedAgain: staged(resumedAgain),
        running: running.value?.control,
        later: running.revision > paused.revision,
        audited: events
          .filter(({ target }) => target?.id === handle.runId)
          .map(({ action, actor, detail }) => ({
            action,
            actor: actor.type,
            kind: detail.kind,
            already: detail.already,
            onBehalfOf: detail.onBehalfOf,
          })),
      }).toStrictEqual({
        paused: {
          canPause: false,
          canResume: true,
          canCancel: true,
          pendingControl: null,
        },
        pauseAgain: { kind: "pause", state: "applied" },
        resumed: { kind: "resume", state: "applied" },
        resumedAgain: { kind: "resume", state: "applied" },
        running: {
          canPause: true,
          canResume: false,
          canCancel: true,
          pendingControl: null,
        },
        later: true,
        // Each asked, under the App's page for the person, and each
        // settled, by the system; the resume already done, asked only.
        audited: [
          {
            action: "workflow.run.pause_requested",
            actor: "app",
            kind: undefined,
            already: undefined,
            onBehalfOf: builder.userId,
          },
          {
            action: "workflow.run.control_applied",
            actor: "system",
            kind: "pause",
            already: undefined,
            onBehalfOf: builder.userId,
          },
          {
            action: "workflow.run.resume_requested",
            actor: "app",
            kind: undefined,
            already: undefined,
            onBehalfOf: builder.userId,
          },
          {
            action: "workflow.run.control_applied",
            actor: "system",
            kind: "resume",
            already: undefined,
            onBehalfOf: builder.userId,
          },
          {
            action: "workflow.run.resume_requested",
            actor: "app",
            kind: undefined,
            already: true,
            onBehalfOf: builder.userId,
          },
        ],
      });
    });

    it("keeps a stalled pause applying until a snapshot settles it, refuses a resume meanwhile, and lets a cancel supersede it", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("running");
      }, settles);
      const asked = async (command: "pause" | "resume" | "cancel") =>
        outcomeOf(
          await called(
            builder,
            app,
            lease,
            controlCommand(reference, command, handle.runId, keyOf())
          )
        );
      // A pause admitted a while ago, whose request ended before it asked
      // the engine: stalled, as the repair would find it.
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE workflow_resource_runs SET control_generation = control_generation + 1, summary_revision = summary_revision + 1 WHERE id = ?"
        ).bind(handle.runId),
        env.DB.prepare(
          "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, generation, created_at, next_at) SELECT ?, id, ?, ?, ?, 'pause', 'admitted', control_generation, ?, ? FROM workflow_resource_runs WHERE id = ?"
        ).bind(
          crypto.randomUUID(),
          app,
          builder.userId,
          keyOf(),
          Date.now() - 120_000,
          Date.now() + 3_600_000,
          handle.runId
        ),
      ]);
      await tellQueryFollowers(env, handle.runId);
      await vi.waitFor(() => {
        expect(
          channel.peekRun(handle.runId).value?.control.pendingControl
        ).toStrictEqual({ kind: "pause", stage: "applying" });
      }, settles);
      const applying = channel.peekRun(handle.runId).value;
      let resume: unknown;
      const refusedEvents = await auditedDuring(async () => {
        resume = await refusalOf(
          channel.control(handle.runId, "resume", () => {
            // Never recovering.
          })
        );
      });
      const cancelled = await asked("cancel");
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("cancelled");
      }, settles);
      stopRun();
      const receipts = await env.DB.prepare(
        "SELECT kind, state FROM workflow_resource_run_controls WHERE run_id = ? ORDER BY generation"
      )
        .bind(handle.runId)
        .all<{ kind: string; state: string }>();

      expect({
        applying: { status: applying?.status, control: applying?.control },
        resume,
        refused: refusedEvents
          .filter(({ target }) => target?.id === handle.runId)
          .map(({ action, detail }) => ({
            action,
            kind: detail.kind,
            code: detail.code,
          })),
        cancelled: staged(cancelled),
        receipts: receipts.results,
      }).toStrictEqual({
        applying: {
          status: "running",
          control: {
            canPause: false,
            canResume: false,
            canCancel: true,
            pendingControl: { kind: "pause", stage: "applying" },
          },
        },
        resume: "workflow.control_conflict",
        refused: [
          {
            action: "workflow.run.control_refused",
            kind: "resume",
            code: "workflow.control_conflict",
          },
        ],
        cancelled: { kind: "cancel", state: "applied" },
        receipts: [
          { kind: "pause", state: "superseded" },
          { kind: "cancel", state: "applied" },
        ],
      });
    });

    it("joins a pause still applying when asked again under another key, applying the one receipt", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("running");
      }, settles);
      const asked = async (command: "pause" | "resume" | "cancel") =>
        outcomeOf(
          await called(
            builder,
            app,
            lease,
            controlCommand(reference, command, handle.runId, keyOf())
          )
        );
      // A pause admitted a while ago, whose request ended before it asked
      // the engine: stalled, as the repair would find it.
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE workflow_resource_runs SET control_generation = control_generation + 1, summary_revision = summary_revision + 1 WHERE id = ?"
        ).bind(handle.runId),
        env.DB.prepare(
          "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, generation, created_at, next_at) SELECT ?, id, ?, ?, ?, 'pause', 'admitted', control_generation, ?, ? FROM workflow_resource_runs WHERE id = ?"
        ).bind(
          crypto.randomUUID(),
          app,
          builder.userId,
          keyOf(),
          Date.now() - 120_000,
          Date.now() + 3_600_000,
          handle.runId
        ),
      ]);
      await tellQueryFollowers(env, handle.runId);
      await vi.waitFor(() => {
        expect(
          channel.peekRun(handle.runId).value?.control.pendingControl
        ).toStrictEqual({ kind: "pause", stage: "applying" });
      }, settles);
      const joined = await asked("pause");
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("paused");
      }, settles);
      stopRun();
      const receipts = await env.DB.prepare(
        "SELECT kind, state FROM workflow_resource_run_controls WHERE run_id = ?"
      )
        .bind(handle.runId)
        .all<{ kind: string; state: string }>();

      expect({
        joined: staged(joined),
        receipts: receipts.results,
      }).toStrictEqual({
        joined: { kind: "pause", state: "applied" },
        receipts: [{ kind: "pause", state: "applied" }],
      });
    });

    it("answers a retry of a pause that joined another that pause's receipt, never undoing a resume admitted since", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      const statusIs = async (status: string): Promise<void> => {
        await vi.waitFor(() => {
          expect(channel.peekRun(handle.runId).value?.status).toBe(status);
        }, settles);
      };
      await statusIs("running");
      const asked = async (command: "pause" | "resume", key: string) =>
        outcomeOf(
          await called(
            builder,
            app,
            lease,
            controlCommand(reference, command, handle.runId, key)
          )
        );
      // Pause A, admitted a while ago and not yet sent: stalled.
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE workflow_resource_runs SET control_generation = control_generation + 1, summary_revision = summary_revision + 1 WHERE id = ?"
        ).bind(handle.runId),
        env.DB.prepare(
          "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, generation, created_at, next_at) SELECT ?, id, ?, ?, ?, 'pause', 'admitted', control_generation, ?, ? FROM workflow_resource_runs WHERE id = ?"
        ).bind(
          crypto.randomUUID(),
          app,
          builder.userId,
          keyOf(),
          Date.now() - 120_000,
          Date.now() + 3_600_000,
          handle.runId
        ),
      ]);
      await tellQueryFollowers(env, handle.runId);
      await vi.waitFor(() => {
        expect(
          channel.peekRun(handle.runId).value?.control.pendingControl
        ).toStrictEqual({ kind: "pause", stage: "applying" });
      }, settles);

      // Pause B joins A, which settles; B's answer is lost. Another
      // page resumes the run; then B is sent again under its key.
      const keyB = keyOf();
      const joined = await asked("pause", keyB);
      await statusIs("paused");
      const resumed = await asked("resume", keyOf());
      await statusIs("running");
      const retried = await asked("pause", keyB);
      stopRun();
      const receipts = await env.DB.prepare(
        "SELECT kind, state FROM workflow_resource_run_controls WHERE run_id = ? ORDER BY generation"
      )
        .bind(handle.runId)
        .all<{ kind: string; state: string }>();

      expect({
        joined: staged(joined),
        resumed: staged(resumed),
        retried: staged(retried),
        receipts: receipts.results,
      }).toStrictEqual({
        joined: { kind: "pause", state: "applied" },
        resumed: { kind: "resume", state: "applied" },
        retried: { kind: "pause", state: "applied" },
        receipts: [
          { kind: "pause", state: "applied" },
          { kind: "resume", state: "applied" },
        ],
      });
    });

    it("supersedes a stalled pause a newer control overtook, never sending it", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("running");
      }, settles);
      // A pause admitted, then a newer control's generation taken after it.
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, generation, created_at, next_at) SELECT ?, id, ?, ?, ?, 'pause', 'admitted', control_generation + 1, ?, ? FROM workflow_resource_runs WHERE id = ?"
        ).bind(
          crypto.randomUUID(),
          app,
          builder.userId,
          keyOf(),
          Date.now() - 120_000,
          Date.now() - 60_000,
          handle.runId
        ),
        env.DB.prepare(
          "UPDATE workflow_resource_runs SET control_generation = control_generation + 2, summary_revision = summary_revision + 1 WHERE id = ?"
        ).bind(handle.runId),
      ]);
      await repairResourceTerminations(env, new Date());
      await vi.waitFor(async () => {
        await expect(
          env.DB.prepare(
            "SELECT state FROM workflow_resource_run_controls WHERE run_id = ?"
          )
            .bind(handle.runId)
            .first<string>("state")
        ).resolves.toBe("superseded");
      }, settles);
      // Asked of the run's engine again: still running, never paused.
      await tellQueryFollowers(env, handle.runId);
      await vi.waitFor(() => {
        expect(
          channel.peekRun(handle.runId).value?.control.pendingControl
        ).toBeNull();
      }, settles);
      const shown = channel.peekRun(handle.runId).value?.status;
      stopRun();
      expect(shown).toBe("running");
    });

    it("lets a cancel that lost its write to a pause admitted at once win all the same", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("running");
      }, settles);
      // Just before the cancel's write, a pause's: its receipt stalled, and
      // the run's generation taken.
      let raced = false;
      const racing: Env = {
        ...env,
        DB: new Proxy(env.DB, {
          get: (target, property) => {
            const value: unknown = Reflect.get(target, property);
            if (property === "batch" && typeof value === "function") {
              return async (statements: D1PreparedStatement[]) => {
                if (!raced) {
                  raced = true;
                  await target.batch([
                    target
                      .prepare(
                        "UPDATE workflow_resource_runs SET control_generation = control_generation + 1, summary_revision = summary_revision + 1 WHERE id = ?"
                      )
                      .bind(handle.runId),
                    target
                      .prepare(
                        "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, generation, created_at, next_at) SELECT ?, id, ?, ?, ?, 'pause', 'admitted', control_generation, ?, ? FROM workflow_resource_runs WHERE id = ?"
                      )
                      .bind(
                        crypto.randomUUID(),
                        app,
                        builder.userId,
                        keyOf(),
                        Date.now(),
                        Date.now() + 3_600_000,
                        handle.runId
                      ),
                  ]);
                }
                const answer: unknown = await Reflect.apply(value, target, [
                  statements,
                ]);
                return answer;
              };
            }
            return typeof value === "function"
              ? (...args: unknown[]): unknown =>
                  Reflect.apply(value, target, args)
              : value;
          },
        }),
      };
      const value = await callOn(
        racing,
        builder,
        app,
        controlCommand(reference, "cancel", handle.runId)
      );
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("cancelled");
      }, settles);
      stopRun();
      const receipts = await env.DB.prepare(
        "SELECT kind, state FROM workflow_resource_run_controls WHERE run_id = ? ORDER BY generation"
      )
        .bind(handle.runId)
        .all<{ kind: string; state: string }>();

      expect({
        raced,
        cancel: staged(value),
        receipts: receipts.results,
      }).toStrictEqual({
        raced: true,
        cancel: { kind: "cancel", state: "applied" },
        receipts: [
          { kind: "pause", state: "superseded" },
          { kind: "cancel", state: "applied" },
        ],
      });
    });

    it("never applies a resume at once over a pause that reached the engine while the resume was being decided", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("running");
      }, settles);
      // A pause admitted, not yet sent: due at the repair.
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE workflow_resource_runs SET control_generation = control_generation + 1, summary_revision = summary_revision + 1 WHERE id = ?"
        ).bind(handle.runId),
        env.DB.prepare(
          "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, generation, created_at, next_at) SELECT ?, id, ?, ?, ?, 'pause', 'admitted', control_generation, ?, ? FROM workflow_resource_runs WHERE id = ?"
        ).bind(
          crypto.randomUUID(),
          app,
          builder.userId,
          keyOf(),
          Date.now() - 120_000,
          Date.now() - 60_000,
          handle.runId
        ),
      ]);
      // The resume reads the engine's status; right after, the pause
      // reaches the engine and settles.
      let raced = false;
      const racingStub = <T extends object>(stub: T): T =>
        new Proxy(stub, {
          get: (target, property) => {
            const value: unknown = Reflect.get(target, property);
            if (property === "status" && typeof value === "function") {
              return async (...args: unknown[]) => {
                const status: unknown = await Reflect.apply(
                  value,
                  target,
                  args
                );
                if (!raced) {
                  raced = true;
                  await repairResourceTerminations(env, new Date());
                }
                return status;
              };
            }
            return typeof value === "function"
              ? (...args: unknown[]): unknown =>
                  Reflect.apply(value, target, args)
              : value;
          },
        });
      type Runs = Env["WORKFLOW_RUNS"];
      const racingRuns = (namespace: Runs): Runs =>
        new Proxy(namespace, {
          get: (target, property) => {
            if (property === "jurisdiction") {
              return (jurisdiction: DurableObjectJurisdiction) =>
                racingRuns(target.jurisdiction(jurisdiction));
            }
            if (property === "get") {
              return (id: DurableObjectId) => racingStub(target.get(id));
            }
            const value: unknown = Reflect.get(target, property);
            return typeof value === "function"
              ? (...args: unknown[]): unknown =>
                  Reflect.apply(value, target, args)
              : value;
          },
        });
      const racing: Env = {
        ...env,
        WORKFLOW_RUNS: racingRuns(env.WORKFLOW_RUNS),
      };
      const resume = await refusalOf(
        callOn(
          racing,
          builder,
          app,
          controlCommand(reference, "resume", handle.runId)
        )
      );
      await tellQueryFollowers(env, handle.runId);
      await vi.waitFor(() => {
        const shown = channel.peekRun(handle.runId).value;
        expect(shown?.status).toBe("paused");
        expect(shown?.control.pendingControl).toBeNull();
      }, settles);
      stopRun();
      const receipts = await env.DB.prepare(
        "SELECT kind, state FROM workflow_resource_run_controls WHERE run_id = ? ORDER BY generation"
      )
        .bind(handle.runId)
        .all<{ kind: string; state: string }>();

      // Refused while the pause was still unresolved as it was decided,
      // to be asked again; never answered as done with the run paused.
      expect({ raced, resume, receipts: receipts.results }).toStrictEqual({
        raced: true,
        resume: "workflow.control_conflict",
        receipts: [{ kind: "pause", state: "applied" }],
      });
    });

    it("writes one receipt and one audit event for two overlapping requests under one key of a pause the run is already past", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("running");
      }, settles);
      const pauseOf = (key: string) =>
        controlCommand(reference, "pause", handle.runId, key);
      await callOn(env, builder, app, pauseOf(keyOf()));
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("paused");
      }, settles);
      // The same pause, sent twice: the second runs whole just before the
      // first writes, both having found the run paused and no receipt.
      const retriedKey = keyOf();
      const retried = pauseOf(retriedKey);
      let twin: unknown;
      const racing: Env = {
        ...env,
        DB: new Proxy(env.DB, {
          get: (target, property) => {
            const value: unknown = Reflect.get(target, property);
            if (property === "batch" && typeof value === "function") {
              return async (statements: D1PreparedStatement[]) => {
                if (twin === undefined) {
                  twin = await callOn(env, builder, app, retried);
                }
                const answer: unknown = await Reflect.apply(value, target, [
                  statements,
                ]);
                return answer;
              };
            }
            return typeof value === "function"
              ? (...args: unknown[]): unknown =>
                  Reflect.apply(value, target, args)
              : value;
          },
        }),
      };
      let first: unknown;
      const events = await auditedDuring(async () => {
        first = await callOn(racing, builder, app, retried);
      });
      stopRun();
      const receipts = await env.DB.prepare(
        "SELECT kind, state FROM workflow_resource_run_controls WHERE run_id = ? AND key = ?"
      )
        .bind(handle.runId, retriedKey)
        .all<{ kind: string; state: string }>();

      expect({
        first: staged(first),
        twin: staged(twin),
        receipts: receipts.results,
        audited: events
          .filter(({ target }) => target?.id === handle.runId)
          .map(({ action, detail }) => ({ action, already: detail.already })),
      }).toStrictEqual({
        first: { kind: "pause", state: "applied" },
        twin: { kind: "pause", state: "applied" },
        receipts: [{ kind: "pause", state: "applied" }],
        audited: [{ action: "workflow.run.pause_requested", already: true }],
      });
    });

    it("applies a stalled pause at the next repair, the run's snapshot moving on from applying to paused", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("running");
      }, settles);
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE workflow_resource_runs SET control_generation = control_generation + 1, summary_revision = summary_revision + 1 WHERE id = ?"
        ).bind(handle.runId),
        env.DB.prepare(
          "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, generation, created_at, next_at) SELECT ?, id, ?, ?, ?, 'pause', 'admitted', control_generation, ?, ? FROM workflow_resource_runs WHERE id = ?"
        ).bind(
          crypto.randomUUID(),
          app,
          builder.userId,
          keyOf(),
          Date.now() - 120_000,
          Date.now() - 60_000,
          handle.runId
        ),
      ]);
      await tellQueryFollowers(env, handle.runId);
      await vi.waitFor(() => {
        expect(
          channel.peekRun(handle.runId).value?.control.pendingControl
        ).toStrictEqual({ kind: "pause", stage: "applying" });
      }, settles);
      const applying = channel.peekRun(handle.runId);
      await repairResourceTerminations(env, new Date());
      await vi.waitFor(() => {
        const shown = channel.peekRun(handle.runId).value;
        expect(shown?.status).toBe("paused");
        expect(shown?.control.pendingControl).toBeNull();
      }, settles);
      const paused = channel.peekRun(handle.runId);
      stopRun();

      expect({
        later: paused.revision > applying.revision,
        state: await env.DB.prepare(
          "SELECT state FROM workflow_resource_run_controls WHERE run_id = ?"
        )
          .bind(handle.runId)
          .first<string>("state"),
      }).toStrictEqual({ later: true, state: "applied" });
    });

    it("refuses a cancel of a run that completed", async () => {
      const { builder, app, reference } = await boundApp();
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("completed");
      }, settles);
      stopRun();
      await expect(
        refusalOf(
          channel.control(handle.runId, "cancel", () => {
            // Never recovering.
          })
        )
      ).resolves.toBe("workflow.control_refused");
    });
  }
);
