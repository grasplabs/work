import { expectedMessageOf } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction } from "../src/app-functions.ts";
import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import { appHost } from "../src/durable-objects.ts";
import { revokeRelease } from "../src/release-retention.ts";
import { publishWorkflowVersion } from "../src/workflow-resources.ts";
import {
  repairResourceTerminations,
  terminateResourceRun,
} from "../src/workflows/resource-runs.ts";
import { mockIdpWith } from "./idp.ts";
import {
  called,
  controlCommand,
  endLiveResourceRuns,
  following,
  greetingOf,
  keyOf,
  outcomeOf,
  pageOf,
  queryCall,
  settles,
  staged,
  startCommand,
  startedOf,
  workflowQuery,
} from "./json-workflow-apps.ts";
import {
  boundApp,
  failingOf,
  failureShown,
  idp,
  pageRuns,
  shownOf,
} from "./page-typed-workflows-harness.ts";
import { sleeping, whileEngineRefuses } from "./runs.ts";
import { person as actingPerson } from "./sealed-apps.ts";
import { auditedDuring, outcome } from "./sign-in.ts";

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

    it("shows nothing of a page's run while its alias is bound elsewhere, and the run again once bound back", async () => {
      const fixture = await boundApp({ hold: "1 hour" });
      const { builder, app, reference } = fixture;
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const watched = await channel.start({ who: "Ada" });
      const other = await channel.start({ who: "Bo" });
      const stopRun = channel.followRun(watched.runId, () => {
        // Read below.
      });
      const shown = () => channel.peekRun(watched.runId);
      await vi.waitFor(() => {
        expect(shown().value?.status).toBe("running");
      }, settles);
      const before = shown();
      // Bound away: the next read, which another run's end causes, shows
      // nothing of it.
      await publishWorkflowVersion(env, builder.acting, fixture.workflow, {
        definition: greetingOf("1 hour", "Version 2"),
        basedOn: 1,
      });
      await bindWorkflowToApp(env, builder.acting, fixture.workflow, {
        app,
        alias: "followUp",
        version: 2,
      });
      await terminateResourceRun(
        env,
        builder.acting,
        fixture.workflow,
        other.runId
      );
      await vi.waitFor(() => {
        expect(shown().value).toBeNull();
      }, settles);
      const away = shown();
      // Bound back, and read again as a new run starts: shown again.
      await bindWorkflowToApp(env, builder.acting, fixture.workflow, {
        app,
        alias: "followUp",
        version: 1,
      });
      await channel.start({ who: "Cy" });
      await vi.waitFor(() => {
        expect(shown().value).not.toBeNull();
      }, settles);
      const back = shown();
      stopRun();

      expect({
        before: before.value?.control,
        // Losing it is a state, no error.
        away: { value: away.value, error: away.error },
        back: back.value?.control,
      }).toStrictEqual({
        before: {
          canPause: true,
          canResume: false,
          canCancel: true,
          pendingControl: null,
        },
        away: { value: null, error: undefined },
        back: before.value?.control,
      });
    });

    it("shows a failed run only a code the platform defines, in its own words, never what the run read", async () => {
      const { builder, app, reference } = await boundApp({
        definition: failingOf,
      });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stop = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("failed");
      }, settles);
      const { error } = channel.peekRun(handle.runId).value ?? {};
      stop();
      // A code the platform defines, in the platform's own words: nothing
      // of what the run read.
      expect({
        code: error?.code,
        message: error?.message,
        leaks: JSON.stringify(error).includes("Ada"),
      }).toStrictEqual({
        code: "expression.failed",
        message: expectedMessageOf("expression.failed"),
        leaks: false,
      });
    });

    it("words a failure the platform doesn't define as a step's, but a raise as the workflow declares it", () => {
      const stepFailed = {
        code: "workflow.step_failed",
        message: expectedMessageOf("workflow.step_failed"),
      };
      expect({
        // A run fails with a code of the workflow's own only as a raise
        // its build seals, with that raise's sealed words.
        raised: failureShown({
          code: "invoice.rejected",
          message: "The invoice was rejected.",
        }),
        inANamespace: failureShown({
          code: "workflow.secret_42",
          message: "The secret is 42.",
        }),
        none: failureShown({ code: null, message: "The secret is 42." }),
        platform: failureShown({
          code: "expression.failed",
          message: "It read Ada's salary.",
        }),
      }).toStrictEqual({
        raised: {
          code: "invoice.rejected",
          message: "The invoice was rejected.",
        },
        inANamespace: stepFailed,
        none: stepFailed,
        platform: {
          code: "expression.failed",
          message: expectedMessageOf("expression.failed"),
        },
      });
    });

    it("shows what a restricted run returned only through an App still in restricted mode", async () => {
      const { builder, app, reference } = await boundApp();
      // Restricted as the start is decided, so its run is restricted for good.
      await appHost(env, appIdSchema.parse(app)).restrict();
      const lease = await pageOf(builder, app);
      const handle = await pageRuns(builder, app, lease, reference).start({
        who: "Ada",
      });
      const shownOnce = async () => {
        const watched = await following(
          builder,
          app,
          lease,
          workflowQuery(reference, "run", { runId: handle.runId })
        );
        // Until it shows the run ended, or is refused.
        await vi.waitFor(() => {
          const last = watched.received.at(-1);
          expect(
            typeof last?.outcome === "string" ||
              ["completed", "failed", "cancelled"].includes(
                String(shownOf(last?.outcome))
              )
          ).toBeTruthy();
        }, settles);
        await watched.subscription.release();
        const shown = watched.received.at(-1)?.outcome;
        return typeof shown === "string"
          ? shown
          : z.object({ result: z.unknown() }).parse(shown).result;
      };
      const restricted = await shownOnce();
      // As only a write around the platform could: the App out of it again.
      await runInDurableObject(
        appHost(env, appIdSchema.parse(app)),
        async (_instance, state) => {
          await state.storage.delete("restricted");
        }
      );
      expect({ restricted, unrestricted: await shownOnce() }).toStrictEqual({
        restricted: { status: "Hello, Ada" },
        unrestricted: "permission.restricted",
      });
    });

    it("shows App B nothing of App A's run of the same workflow, and refuses its cancel", async () => {
      const appA = await boundApp({ hold: "1 hour" });
      const appB = await boundApp({ sharing: appA.sharing });
      const { builder } = appA;
      const leaseA = await pageOf(builder, appA.app);
      const handle = await pageRuns(
        builder,
        appA.app,
        leaseA,
        appA.reference
      ).start({ who: "Ada" });
      const leaseB = await pageOf(builder, appB.app);
      const watched = await following(
        builder,
        appB.app,
        leaseB,
        workflowQuery(appB.reference, "run", { runId: handle.runId })
      );
      await vi.waitFor(() => {
        expect(watched.received.length).toBeGreaterThan(0);
      }, settles);
      await watched.subscription.release();
      expect({
        seen: watched.received[0]?.outcome,
        cancel: outcomeOf(
          await called(
            builder,
            appB.app,
            leaseB,
            controlCommand(appB.reference, "cancel", handle.runId, keyOf())
          )
        ),
      }).toStrictEqual({
        seen: null,
        cancel: "workflow.run_unavailable",
      });
    });

    it("shows a chat's preview no run and nothing it may start, and starts nothing from it", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      // A real run of the App's, which the preview never shows.
      const live = await pageOf(builder, app);
      const { runId } = startedOf(
        await called(builder, app, live, startCommand(reference))
      );
      const { id: chat } = await builder.api.chats.forApp(app);
      const { lease } = await builder.api.chats.preview(chat, app);
      if (lease === undefined) {
        throw new Error("The preview opened with no lease.");
      }
      const previewed = async (request: string) =>
        outcomeOf(await called(builder, app, lease, request));
      expect({
        // As `useWorkflow` reads them before a first start: the page
        // renders as it does published, never at its error boundary.
        canStart: await previewed(queryCall(reference, "canStart", {})),
        run: await previewed(queryCall(reference, "run", { runId })),
        runs: await previewed(
          queryCall(reference, "runs", { pagination: { cursor: null } })
        ),
        start: await previewed(startCommand(reference)),
        runsStarted: await env.DB.prepare(
          "SELECT COUNT(*) AS runs FROM workflow_start_receipts WHERE invoker_id = ?"
        )
          .bind(app)
          .first<number>("runs"),
      }).toStrictEqual({
        canStart: false,
        run: null,
        runs: "resource.unavailable",
        start: "app.preview_side_effect",
        runsStarted: 1,
      });
    });

    it("refuses an App's workflows to its own server code's callers", async () => {
      const { builder, app, reference } = await boundApp({
        hold: "1 hour",
      });
      const start = startCommand(reference, { who: "Ada" });
      expect({
        // An agent's or another App's call of the App, as its server takes it:
        // a workflow's mutations, and the run and whether one may start, are
        // a page's alone, no function of the App's.
        agent: outcomeOf(
          await callAppFunction(env, builder.acting, app, start)
        ),
        read: await Promise.all(
          [
            queryCall(reference, "run", { runId: "run-1" }),
            queryCall(reference, "canStart", {}),
          ].map(async (read) =>
            outcomeOf(await callAppFunction(env, builder.acting, app, read))
          )
        ),
        runs: await env.DB.prepare(
          "SELECT COUNT(*) AS runs FROM workflow_start_receipts WHERE invoker_id = ?"
        )
          .bind(app)
          .first<number>("runs"),
      }).toStrictEqual({
        agent: "function.not_found",
        read: ["function.not_found", "function.not_found"],
        runs: 0,
      });
    });

    it("fences a page whose release was revoked at its run's next change", async () => {
      const fixture = await boundApp({ hold: "1 hour" });
      const { builder, app, reference } = fixture;
      const { lease, version } = await builder.api.pages.open(app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stop = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("running");
      }, settles);
      await revokeRelease(
        env,
        await actingPerson("admin"),
        { app: appIdSchema.parse(app), version },
        "Leaks data"
      );
      await terminateResourceRun(
        env,
        builder.acting,
        fixture.workflow,
        handle.runId
      );
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).error?.code).toBe("page.revoked");
      }, settles);
      const fenced = channel.peekRun(handle.runId);
      stop();
      expect({ value: fenced.value, code: fenced.error?.code }).toStrictEqual({
        value: undefined,
        code: "page.revoked",
      });
    });

    it("applies a cancel whose stop never went out at the next repair, settling its receipt", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stop = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("running");
      }, settles);
      // Admitted a while ago, its request ended before it asked the engine.
      await env.DB.prepare(
        "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, created_at, next_at) VALUES (?, ?, ?, ?, ?, 'cancel', 'admitted', ?, ?)"
      )
        .bind(
          crypto.randomUUID(),
          handle.runId,
          app,
          builder.userId,
          keyOf(),
          Date.now() - 120_000,
          Date.now() - 60_000
        )
        .run();
      const events = await auditedDuring(async () => {
        await repairResourceTerminations(env, new Date());
        await vi.waitFor(() => {
          expect(channel.peekRun(handle.runId).value?.status).toBe("cancelled");
        }, settles);
        // A repair again, well after: nothing more is stopped or audited.
        await repairResourceTerminations(env, new Date(Date.now() + 3_600_000));
      });
      stop();
      expect({
        state: await env.DB.prepare(
          "SELECT state FROM workflow_resource_run_controls WHERE run_id = ?"
        )
          .bind(handle.runId)
          .first<string>("state"),
        // The stop audited once, under the App's page, for the person.
        terminated: events
          .filter(
            ({ action, target }) =>
              action === "workflow.run.terminated" &&
              target?.id === handle.runId
          )
          .map(({ actor, detail }) => ({
            actor,
            onBehalfOf: detail.onBehalfOf,
          })),
      }).toStrictEqual({
        state: "applied",
        terminated: [
          {
            actor: { type: "app", appId: app, part: "page" },
            onBehalfOf: builder.userId,
          },
        ],
      });
    });

    it("cancels a run the engine refuses to terminate at once: it runs nothing more, and ends cancelled with its receipt applied, with no repair", async () => {
      // Its wait is over well before a minute's repair would come.
      const { builder, app, reference } = await boundApp({ hold: "2 seconds" });
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stop = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await sleeping(handle.runId, "hold:task");
      const events = await auditedDuring(async () => {
        const answered = await whileEngineRefuses(
          (method) => method === "terminate",
          async () =>
            await channel.control(handle.runId, "cancel", () => {
              // Never recovering.
            })
        );
        expect(staged(answered)).toStrictEqual({
          kind: "cancel",
          state: "admitted",
        });
        // No repair of core's runs: the run's own object ends it.
        await vi.waitFor(() => {
          expect(channel.peekRun(handle.runId).value?.status).toBe("cancelled");
        }, settles);
        // And past its wait again: it never comes back.
        await scheduler.wait(2500);
      });
      const shown = channel.peekRun(handle.runId).value;
      stop();
      expect({
        shown: { status: shown?.status, result: shown?.result },
        receipt: await env.DB.prepare(
          "SELECT state FROM workflow_resource_run_controls WHERE run_id = ?"
        )
          .bind(handle.runId)
          .first<string>("state"),
        ended: events
          .filter(
            ({ action, target }) =>
              [
                "workflow.run.completed",
                "workflow.run.cancelled",
                "workflow.run.terminated",
              ].includes(action) && target?.id === handle.runId
          )
          .map(({ action, actor }) => ({ action, actor })),
      }).toStrictEqual({
        shown: { status: "cancelled", result: undefined },
        receipt: "applied",
        ended: [
          { action: "workflow.run.cancelled", actor: { type: "system" } },
          {
            action: "workflow.run.terminated",
            actor: { type: "app", appId: app, part: "page" },
          },
        ],
      });
    });

    it("settles a cancel as superseded, auditing no stop, when its run completed before the stop went out", async () => {
      const { builder, app, reference } = await boundApp();
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stop = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekRun(handle.runId).value?.status).toBe("completed");
      }, settles);
      stop();
      // Admitted while it ran, its request ended before it asked the engine.
      await env.DB.prepare(
        "INSERT INTO workflow_resource_run_controls (id, run_id, app_id, principal_id, key, kind, state, created_at, next_at) VALUES (?, ?, ?, ?, ?, 'cancel', 'admitted', ?, ?)"
      )
        .bind(
          crypto.randomUUID(),
          handle.runId,
          app,
          builder.userId,
          keyOf(),
          Date.now() - 120_000,
          Date.now() - 60_000
        )
        .run();
      const events = await auditedDuring(async () => {
        await repairResourceTerminations(env, new Date());
      });
      expect({
        state: await env.DB.prepare(
          "SELECT state FROM workflow_resource_run_controls WHERE run_id = ?"
        )
          .bind(handle.runId)
          .first<string>("state"),
        terminated: events.filter(
          ({ action, target }) =>
            action === "workflow.run.terminated" && target?.id === handle.runId
        ).length,
      }).toStrictEqual({ state: "superseded", terminated: 0 });
    });

    it("starts one run for a key sent twice at once, and keeps one cancel receipt for a run however many keys ask, never changed after", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const start = startCommand(reference, { who: "Ada" });
      const [one, two] = await Promise.all([
        called(builder, app, lease, start),
        called(builder, app, lease, start),
      ]);
      const handle = z.object({ runId: z.string() }).parse(outcomeOf(one));
      const cancel = () =>
        controlCommand(reference, "cancel", handle.runId, keyOf());
      const cancels = await Promise.all([
        called(builder, app, lease, cancel()),
        called(builder, app, lease, cancel()),
      ]);
      const receipts = await env.DB.prepare(
        "SELECT id, state FROM workflow_resource_run_controls WHERE run_id = ?"
      )
        .bind(handle.runId)
        .all<{ id: string; state: string }>();
      const id = receipts.results[0]?.id ?? "";
      expect({
        same: outcomeOf(two),
        cancels: cancels.map((answer) => staged(outcomeOf(answer))),
        receipts: receipts.results.map(({ state }) => state),
        reopened:
          (await outcome(
            env.DB.prepare(
              "UPDATE workflow_resource_run_controls SET state = 'admitted', settled_at = NULL WHERE id = ?"
            )
              .bind(id)
              .run()
          )) === "ok",
        deleted:
          (await outcome(
            env.DB.prepare(
              "DELETE FROM workflow_resource_run_controls WHERE id = ?"
            )
              .bind(id)
              .run()
          )) === "ok",
      }).toStrictEqual({
        same: outcomeOf(one),
        cancels: [
          { kind: "cancel", state: "applied" },
          { kind: "cancel", state: "applied" },
        ],
        receipts: ["applied"],
        reopened: false,
        deleted: false,
      });
    });
  }
);
