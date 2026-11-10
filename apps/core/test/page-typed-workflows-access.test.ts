import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import { revokePermission } from "../src/permissions.ts";
import { publishWorkflowVersion } from "../src/workflow-resources.ts";
import { grantReviewed } from "./apps.ts";
import { mockIdpWith } from "./idp.ts";
import {
  called,
  controlCommand,
  endLiveResourceRuns,
  following,
  greetingOf,
  keyOf,
  mutationCall,
  outcomeOf,
  pageOf,
  queryCall,
  settles,
  startCommand,
  workflowQuery,
} from "./json-workflow-apps.ts";
import type { Person } from "./json-workflow-apps.ts";
import {
  boundApp,
  callOn,
  idp,
  pageRuns,
  racingRunRead,
  refusalOf,
  shownOf,
  signedIn,
  waitsShown,
  widerOf,
} from "./page-typed-workflows-harness.ts";

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

    it("shows a run only to the person the App started it for: another member of the App, an admin and a made-up ID see none", async () => {
      const { builder, admin, app, reference } = await boundApp({
        hold: "1 hour",
      });
      const colleague = await signedIn("builder");
      await env.DB.prepare(
        "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'user', ?, ?)"
      )
        .bind(app, colleague.userId, builder.userId, Date.now())
        .run();
      const lease = await pageOf(builder, app);
      const handle = await pageRuns(builder, app, lease, reference).start({
        who: "Ada",
      });
      const seenBy = async (person: Person, runId: string) => {
        const watched = await following(
          person,
          app,
          await pageOf(person, app),
          workflowQuery(reference, "run", { runId })
        );
        await vi.waitFor(() => {
          expect(watched.received.length).toBeGreaterThan(0);
        }, settles);
        await watched.subscription.release();
        return watched.received[0]?.outcome;
      };
      const cancelBy = async (person: Person) =>
        outcomeOf(
          await called(
            person,
            app,
            await pageOf(person, app),
            controlCommand(reference, "cancel", handle.runId, keyOf())
          )
        );

      expect({
        colleague: await seenBy(colleague, handle.runId),
        admin: await seenBy(admin, handle.runId),
        madeUp: await seenBy(builder, crypto.randomUUID()),
        colleagueCancels: await cancelBy(colleague),
        adminCancels: await cancelBy(admin),
      }).toStrictEqual({
        // Not seen, alike whether it exists: nothing of it shown.
        colleague: null,
        admin: null,
        madeUp: null,
        colleagueCancels: "workflow.run_unavailable",
        adminCancels: "workflow.run_unavailable",
      });
    });

    it("refuses a mutation of a workflow the release doesn't declare or doesn't have, args the declaration doesn't take, a query sent as a mutation and a mutation followed as a query, starting nothing", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const startWatched = await following(builder, app, lease, {
        reference: {
          name: `${reference.name}.mutations.start`,
          kind: "query",
        },
        args: { args: { who: "Ada" } },
      });
      await vi.waitFor(() => {
        expect(startWatched.received.length).toBeGreaterThan(0);
      }, settles);
      await startWatched.subscription.release();
      const startOf = async (request: string) =>
        outcomeOf(await called(builder, app, lease, request));

      expect({
        unknownAlias: await startOf(startCommand({ name: "workflows.other" })),
        unknownMutation: await startOf(
          JSON.stringify({
            reference: {
              name: `${reference.name}.mutations.restart`,
              kind: "mutation",
            },
            args: { runId: "run-1" },
            idempotencyKey: keyOf(),
          })
        ),
        badInput: await startOf(startCommand(reference, { who: " " })),
        inputNotUnderInput: await startOf(
          mutationCall(reference, "start", { who: "Ada" })
        ),
        // Keyed as the App's own mutations are: 1 to 128 printable ASCII.
        badKeys: await Promise.all(
          ["", "k".repeat(129), "line\nbreak"].map(
            async (key) =>
              await startOf(startCommand(reference, { who: "Ada" }, key))
          )
        ),
        queryAsMutation: await startOf(
          JSON.stringify({
            reference: {
              name: `${reference.name}.queries.canStart`,
              kind: "mutation",
            },
            args: {},
            idempotencyKey: keyOf(),
          })
        ),
        mutationAsQuery: startWatched.received[0]?.outcome,
        runs: await env.DB.prepare(
          "SELECT COUNT(*) AS runs FROM workflow_start_receipts WHERE invoker_id = ?"
        )
          .bind(app)
          .first<number>("runs"),
      }).toStrictEqual({
        unknownAlias: "function.not_found",
        unknownMutation: "function.not_found",
        badInput: "contract.invalid_args",
        inputNotUnderInput: "contract.invalid_args",
        badKeys: Array.from({ length: 3 }, () => "submission.key_invalid"),
        queryAsMutation: "function.kind_mismatch",
        mutationAsQuery: "function.not_found",
        runs: 0,
      });
    });

    it("offers nothing once the App's start grant is revoked, and refuses its starts and cancels then", async () => {
      const { builder, admin, app, grant, reference } = await boundApp({
        hold: "1 hour",
      });
      const lease = await pageOf(builder, app);
      const handle = await pageRuns(builder, app, lease, reference).start({
        who: "Ada",
      });
      await revokePermission(env, admin.acting, grant);
      // A page that follows them now: a fresh client, as a new tab's.
      const channel = pageRuns(builder, app, lease, reference);
      const stopBinding = channel.followBinding(() => {
        // Read below.
      });
      const stopRun = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(channel.peekBinding().value).toBeDefined();
        expect(channel.peekRun(handle.runId).value).toBeDefined();
      }, settles);
      const offered = {
        canRun: channel.peekBinding().value?.canRun,
        canCancel: channel.peekRun(handle.runId).value?.control.canCancel,
      };
      stopBinding();
      stopRun();

      expect({
        offered,
        start: await refusalOf(channel.start({ who: "Ada" })),
        cancel: await refusalOf(
          channel.control(handle.runId, "cancel", () => {
            // Never recovering.
          })
        ),
      }).toStrictEqual({
        offered: { canRun: false, canCancel: false },
        start: "workflow.start_denied",
        cancel: "workflow.start_denied",
      });
    });

    it("starts and shows nothing of another version the alias was bound to since the seal", async () => {
      const fixture = await boundApp({ hold: "1 hour" });
      const { builder, app, reference } = fixture;
      const lease = await pageOf(builder, app);
      const handle = await pageRuns(builder, app, lease, reference).start({
        who: "Ada",
      });
      // Version 2, bound with no seal: the release's references were made
      // for version 1.
      await publishWorkflowVersion(env, builder.acting, fixture.workflow, {
        definition: greetingOf(undefined, "Version 2"),
        basedOn: 1,
      });
      await bindWorkflowToApp(env, builder.acting, fixture.workflow, {
        app,
        alias: "followUp",
        version: 2,
      });
      const channel = pageRuns(builder, app, lease, reference);
      const stopBinding = channel.followBinding(() => {
        // Read below.
      });
      const watched = await following(
        builder,
        app,
        lease,
        workflowQuery(reference, "run", { runId: handle.runId })
      );
      await vi.waitFor(() => {
        expect(channel.peekBinding().value).toBeDefined();
        expect(watched.received.length).toBeGreaterThan(0);
      }, settles);
      const { canRun } = channel.peekBinding().value ?? {};
      stopBinding();
      await watched.subscription.release();

      expect({
        canRun,
        run: watched.received[0]?.outcome,
        start: await refusalOf(channel.start({ who: "Ada" })),
      }).toStrictEqual({
        canRun: false,
        run: null,
        start: "workflow.start_denied",
      });
    });

    it("tells a page already following a run as the App's start grant is revoked and given again", async () => {
      const fixture = await boundApp({ hold: "1 hour" });
      const { builder, admin, app, reference } = fixture;
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stop = channel.followRun(handle.runId, () => {
        // Read below.
      });
      const canCancel = () =>
        channel.peekRun(handle.runId).value?.control.canCancel;
      await vi.waitFor(() => {
        expect(canCancel()).toBeTruthy();
      }, settles);
      await revokePermission(env, admin.acting, fixture.grant);
      await vi.waitFor(() => {
        expect(canCancel()).toBeFalsy();
      }, settles);
      const asked = await builder.api.permissions.request({
        subject: { type: "app", appId: app },
        object: { type: "workflow", workflowId: fixture.workflow },
        actions: ["start"],
        binding: "FOLLOW_UP",
      });
      await grantReviewed(admin.api, asked.id);
      await vi.waitFor(() => {
        expect(canCancel()).toBeTruthy();
      }, settles);
      stop();
    });

    it("never shows a run as cancellable in a read the grant's revocation landed in", async () => {
      const fixture = await boundApp({ hold: "1 hour" });
      const { builder, admin, app, reference } = fixture;
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const handle = await channel.start({ who: "Ada" });
      const stop = channel.followRun(handle.runId, () => {
        // Read below.
      });
      await vi.waitFor(() => {
        expect(
          channel.peekRun(handle.runId).value?.control.canCancel
        ).toBeTruthy();
      }, settles);
      // The revocation lands while a snapshot is being read.
      const inFlight = await callOn(
        racingRunRead(async () => {
          await revokePermission(env, admin.acting, fixture.grant);
        }),
        builder,
        app,
        queryCall(reference, "run", { runId: handle.runId })
      );
      await vi.waitFor(() => {
        expect(
          channel.peekRun(handle.runId).value?.control.canCancel
        ).toBeFalsy();
      }, settles);
      stop();
      expect(
        z
          .object({ control: z.object({ canCancel: z.boolean() }) })
          .parse(inFlight).control.canCancel
      ).toBeFalsy();
    });

    it("refuses what a run returned when it is more than the App declares", async () => {
      const { builder, app, reference } = await boundApp({
        definition: widerOf,
      });
      const lease = await pageOf(builder, app);
      const handle = await pageRuns(builder, app, lease, reference).start({
        who: "Ada",
      });
      const watched = await following(
        builder,
        app,
        lease,
        workflowQuery(reference, "run", { runId: handle.runId })
      );
      await vi.waitFor(() => {
        expect(watched.received.at(-1)?.outcome).toBeTypeOf("string");
      }, settles);
      await watched.subscription.release();
      expect({
        shown: watched.received.at(-1)?.outcome,
        leaks: JSON.stringify(watched.received).includes("ultramarine"),
      }).toStrictEqual({ shown: "contract.invalid_return", leaks: false });
    });

    it("gives a second subscription to a run the revision the first already has", async () => {
      const { builder, app, reference } = await boundApp({ hold: "1 hour" });
      const lease = await pageOf(builder, app);
      const handle = await pageRuns(builder, app, lease, reference).start({
        who: "Ada",
      });
      const watch = workflowQuery(reference, "run", { runId: handle.runId });
      const first = await following(builder, app, lease, watch);
      await vi.waitFor(() => {
        expect(shownOf(first.received.at(-1)?.outcome)).toBe("running");
      }, settles);
      // The same run on the same connection: one reading, shared.
      const second = await following(builder, app, lease, watch);
      await vi.waitFor(() => {
        expect(second.received.length).toBeGreaterThan(0);
      }, settles);
      await first.subscription.release();
      await second.subscription.release();
      expect(second.received.map(({ revision }) => revision)).toStrictEqual([
        first.received.at(-1)?.revision,
      ]);
    });

    it("shows nothing of a run and offers no start once the alias is rebound, then shows both again once rebound back, with nothing else changing", async () => {
      const fixture = await boundApp({ hold: "1 hour" });
      const { builder, app, reference } = fixture;
      const lease = await pageOf(builder, app);
      const channel = pageRuns(builder, app, lease, reference);
      const watched = await channel.start({ who: "Ada" });
      const watch = workflowQuery(reference, "run", { runId: watched.runId });
      const first = await following(builder, app, lease, watch);
      const binding = await following(
        builder,
        app,
        lease,
        workflowQuery(reference, "canStart", {})
      );
      const canRun = () =>
        z.boolean().safeParse(binding.received.at(-1)?.outcome).data;
      await vi.waitFor(() => {
        expect(shownOf(first.received.at(-1)?.outcome)).toBe("running");
        expect(waitsShown(first.received.at(-1)?.outcome)).toBe(1);
        expect(canRun()).toBeTruthy();
      }, settles);
      // Rebound away: the page is told at once, nothing else needed.
      await publishWorkflowVersion(env, builder.acting, fixture.workflow, {
        definition: greetingOf("1 hour", "Version 2"),
        basedOn: 1,
      });
      await bindWorkflowToApp(env, builder.acting, fixture.workflow, {
        app,
        alias: "followUp",
        version: 2,
      });
      await vi.waitFor(() => {
        expect(first.received.at(-1)?.outcome).toBeNull();
        expect(canRun()).toBeFalsy();
      }, settles);
      // Bound back: shown again, at the same stage, and startable again.
      await bindWorkflowToApp(env, builder.acting, fixture.workflow, {
        app,
        alias: "followUp",
        version: 1,
      });
      await vi.waitFor(() => {
        expect(shownOf(first.received.at(-1)?.outcome)).toBe("running");
        expect(canRun()).toBeTruthy();
      }, settles);
      const second = await following(builder, app, lease, watch);
      await vi.waitFor(() => {
        expect(second.received.length).toBeGreaterThan(0);
      }, settles);
      await first.subscription.release();
      await second.subscription.release();
      await binding.subscription.release();
      expect({
        // What it showed in turn, each read again as the binding changed,
        // from the run running on (it may first have shown it queued).
        first: first.received
          .map(({ outcome: shown }) => shownOf(shown))
          .filter((shown) => shown !== "queued")
          .filter((shown, at, all) => at === 0 || shown !== all[at - 1]),
        // The same push to a page that only now asks: one read, shared.
        sameRevision: new Set([
          first.received.at(-1)?.revision,
          second.received.at(0)?.revision,
        ]).size,
        second: second.received.map(({ outcome: shown }) => shownOf(shown)),
      }).toStrictEqual({
        first: ["running", "unavailable", "running"],
        sameRevision: 1,
        second: ["running"],
      });
    });

    it("answers a page that subscribes after a run's result passed its retention with no result, whatever another page still shows", async () => {
      const { builder, app, reference } = await boundApp();
      const lease = await pageOf(builder, app);
      const handle = await pageRuns(builder, app, lease, reference).start({
        who: "Ada",
      });
      const watch = workflowQuery(reference, "run", { runId: handle.runId });
      const first = await following(builder, app, lease, watch);
      await vi.waitFor(() => {
        expect(shownOf(first.received.at(-1)?.outcome)).toBe("completed");
      }, settles);
      // Its details removed, as the retention sweep removes them.
      await env.DB.prepare(
        "UPDATE workflow_start_receipts SET details_removed_at = ?, input = NULL, params = NULL WHERE id = ?"
      )
        .bind(Date.now(), handle.runId)
        .run();
      const second = await following(builder, app, lease, watch);
      await vi.waitFor(() => {
        expect(second.received.length).toBeGreaterThan(0);
      }, settles);
      await first.subscription.release();
      await second.subscription.release();
      expect({
        second: second.received.map(({ outcome: shown }) => shown),
        leaks: JSON.stringify(second.received).includes("Hello, Ada"),
      }).toStrictEqual({
        second: ["workflow.run_details_removed"],
        leaks: false,
      });
    });
  }
);
