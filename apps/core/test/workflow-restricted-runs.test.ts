import type { EndedRuns } from "@grasp-os/shared/connect";
import {
  agentIdSchema,
  chatIdSchema,
  workflowResourceIdSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { personOf } from "../src/connections.ts";
import { appHost, workspace } from "../src/durable-objects.ts";
import { confirmPendingAction } from "../src/pending-actions.ts";
import { revokeWorkflowBinding } from "../src/workflow-bindings.ts";
import type { CallingAgent } from "../src/workflow-start-intents.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { runEngine } from "../src/workflows/engine.ts";
import {
  resourceRunFor,
  terminateResourceRun,
} from "../src/workflows/resource-runs.ts";
import {
  startDetailsPerSweep,
  sweepRunDetails,
} from "../src/workflows/retention.ts";
import { mockIdp } from "./idp.ts";
import { withQuotas } from "./quota-limits.ts";
import { runInstance } from "./runs.ts";
import { unique } from "./sign-in.ts";
import {
  adaStart,
  chooseModel,
  ended,
  endOf,
  granted,
  heldFor,
  hold,
  mailingWorkflow,
  person,
  published,
  settledCode,
  started,
  startingApp,
} from "./workflow-calls.ts";

// The calls of grasp-workflow/2 workflows on the run host (sealed-run.ts,
// resource-calls.ts and resource-authority.ts), from their threat model:
// a call reaches only the target its start froze; authority revoked while
// a run runs stops its next call; a replay repeats no effect; a sensitive
// parameter reaches connect as a connector argument and nothing the run
// records; and a run's model calls stay within its ceiling. Everything runs for
// real, through the dispatcher, the engine, connect and the App's own
// code; only the mail server and the model provider behind connect are
// faked.

mockIdp();

/** What run `runId`'s receipt and row pin of its restricted mode. */
const pinnedRestricted = async (runId: string) =>
  await env.DB.prepare(
    "SELECT receipt.restricted AS receipt, run.restricted AS run FROM workflow_start_receipts AS receipt JOIN workflow_resource_runs AS run ON run.id = receipt.id WHERE receipt.id = ?"
  )
    .bind(runId)
    .first<{ receipt: number; run: number }>();

describe("runs started by a restricted App", () => {
  beforeAll(chooseModel);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("are restricted for good: a side effect waits for its person across replays, is sent once they confirm, and the workflow's later runs aren't restricted", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    // The send runs in a later activation than the start, and a replay
    // after it walks past the send again.
    const { workflow, mail, serving } = await mailingWorkflow(ada, admin, {
      before: [hold],
    });
    const starter = await startingApp(ada, admin, workflow.id, {
      restricted: true,
    });
    const runId = await starter.start(serving);
    const held = await heldFor(ada, runId);
    const mailWhileHeld = await mail.did();
    const runWhileHeld = await resourceRunFor(env, ada, workflow.id, runId);
    const whileHeld = {
      calls: mailWhileHeld.calls,
      status: runWhileHeld.status,
      // Pinned once, never changed: the database refuses it, whatever
      // asks, retention's removal of its details included.
      unpinReceipt: await settledCode(
        env.DB.prepare(
          "UPDATE workflow_start_receipts SET restricted = 0, input = NULL, params = NULL, details_removed_at = ? WHERE id = ?"
        )
          .bind(Date.now(), runId)
          .run()
      ),
      unpinRun: await settledCode(
        env.DB.prepare(
          "UPDATE workflow_resource_runs SET restricted = 0 WHERE id = ?"
        )
          .bind(runId)
          .run()
      ),
    };
    await confirmPendingAction(env, ada, held.id, held.inputHash);
    const run = await ended(ada, workflow.id, runId);
    // A later run of the same workflow, Ada's own start: not restricted.
    const later = await started(ada, workflow.id, serving);
    const laterRun = await ended(ada, workflow.id, later);
    const sent = await mail.did();
    expect({
      pinned: await pinnedRestricted(runId),
      held: {
        subject: held.subject.type,
        mode: held.mode,
        restricted: held.restricted,
      },
      calls: whileHeld.calls,
      status: whileHeld.status,
      unpinned: [
        String(whileHeld.unpinReceipt).includes("immutable"),
        String(whileHeld.unpinRun).includes("pin what they run"),
      ],
      end: endOf(run),
      laterPinned: await pinnedRestricted(later),
      laterEnd: endOf(laterRun),
      // Once for the confirmed run, its replays sending nothing again, and
      // once for the later run, never held.
      sent: sent.calls,
    }).toStrictEqual({
      pinned: { receipt: 1, run: 1 },
      held: { subject: "workflow", mode: "workflow", restricted: true },
      calls: 0,
      status: "running",
      unpinned: [true, true],
      end: { status: "completed", output: { status: "message-1" } },
      laterPinned: { receipt: 0, run: 0 },
      laterEnd: { status: "completed", output: { status: "message-2" } },
      sent: 2,
    });
  });

  it("refuse confirming a side effect while its run is paused, then send it once and complete once resumed", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow, mail, serving } = await mailingWorkflow(ada, admin, {
      before: [hold],
    });
    const starter = await startingApp(ada, admin, workflow.id, {
      restricted: true,
    });
    const runId = await starter.start(serving);
    const held = await heldFor(ada, runId);
    // Paused while it waits for its person, as a page's pause asks it.
    await runEngine(env).pause(runId, 1);
    await vi.waitFor(
      async () => {
        await expect(
          resourceRunFor(env, ada, workflow.id, runId)
        ).resolves.toMatchObject({ status: "paused" });
      },
      { timeout: 30_000, interval: 50 }
    );
    const whilePaused = await settledCode(
      confirmPendingAction(env, ada, held.id, held.inputHash)
    );
    const { calls: sentWhilePaused } = await mail.did();
    // Resumed: its next activation may read its row before it hears of the
    // resume, and goes on all the same.
    await runEngine(env).resume(runId, 2);
    await vi.waitFor(
      async () => {
        await expect(
          resourceRunFor(env, ada, workflow.id, runId)
        ).resolves.not.toMatchObject({ status: "paused" });
      },
      { timeout: 30_000, interval: 50 }
    );
    await confirmPendingAction(env, ada, held.id, held.inputHash);
    const run = await ended(ada, workflow.id, runId);
    const { calls: sent } = await mail.did();
    expect({
      whilePaused,
      sentWhilePaused,
      end: endOf(run),
      sent,
    }).toStrictEqual({
      whilePaused: "workflow.run_paused",
      sentWhilePaused: 0,
      end: { status: "completed", output: { status: "message-1" } },
      sent: 1,
    });
  });

  it("send nothing their person declines, nor anything confirmed once the run's own authority for its alias is gone, whatever other alias shares its permission", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const declined = await mailingWorkflow(ada, admin);
    // Another alias shares its permission, and stays approved: it never
    // stands in for the alias its call went through.
    const revoked = await mailingWorkflow(ada, admin, { sharing: "draft" });
    const declinedStarter = await startingApp(
      ada,
      admin,
      declined.workflow.id,
      {
        restricted: true,
      }
    );
    const revokedStarter = await startingApp(ada, admin, revoked.workflow.id, {
      restricted: true,
    });
    const declinedRun = await declinedStarter.start(declined.serving);
    const revokedRun = await revokedStarter.start(revoked.serving);
    const adaPerson = await personOf(env, ada);
    const declinedHeld = await heldFor(ada, declinedRun);
    await env.CONNECT.declineAction({ person: adaPerson, id: declinedHeld.id });
    const revokedHeld = await heldFor(ada, revokedRun);
    // Its approval revoked as it waits: confirming sends nothing.
    await revokeWorkflowBinding(
      env,
      admin,
      revoked.workflow.id,
      revoked.approval.id
    );
    const confirmed = await settledCode(
      confirmPendingAction(env, ada, revokedHeld.id, revokedHeld.inputHash)
    );
    const stillHeld = await heldFor(ada, revokedRun);
    // Its person declines it after all: the run ends.
    await env.CONNECT.declineAction({ person: adaPerson, id: stillHeld.id });
    const declinedEnd = await ended(ada, declined.workflow.id, declinedRun);
    const revokedEnd = await ended(ada, revoked.workflow.id, revokedRun);
    const declinedMail = await declined.mail.did();
    const revokedMail = await revoked.mail.did();
    expect({
      declined: endOf(declinedEnd),
      confirmed,
      revoked: endOf(revokedEnd),
      calls: [declinedMail.calls, revokedMail.calls],
    }).toStrictEqual({
      declined: { status: "failed", code: "connect.declined" },
      confirmed: "workflow.call_denied",
      // Its next run of the call is refused before connect is asked.
      revoked: { status: "failed", code: "workflow.call_denied" },
      calls: [0, 0],
    });
  });

  it("leave nothing held in connect once they end: confirming one refused, and the rest swept with their details", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const confirmed = await mailingWorkflow(ada, admin);
    const swept = await mailingWorkflow(ada, admin);
    const confirmedStarter = await startingApp(
      ada,
      admin,
      confirmed.workflow.id,
      { restricted: true }
    );
    const sweptStarter = await startingApp(ada, admin, swept.workflow.id, {
      restricted: true,
    });
    const confirmedRun = await confirmedStarter.start(confirmed.serving);
    const sweptRun = await sweptStarter.start(swept.serving);
    const confirmedHeld = await heldFor(ada, confirmedRun);
    await heldFor(ada, sweptRun);
    // Both cancelled while their send waits for Ada.
    await terminateResourceRun(env, ada, confirmed.workflow.id, confirmedRun);
    await terminateResourceRun(env, ada, swept.workflow.id, sweptRun);
    await ended(ada, confirmed.workflow.id, confirmedRun);
    await ended(ada, swept.workflow.id, sweptRun);
    const confirming = await settledCode(
      confirmPendingAction(env, ada, confirmedHeld.id, confirmedHeld.inputHash)
    );
    const adaPerson = await personOf(env, ada);
    const heldOf = async (runId: string) => {
      const waiting = await env.CONNECT.listPendingActions(adaPerson);
      return waiting.filter(
        ({ context }) =>
          context.type === "workflowRun" && context.runId === runId
      ).length;
    };
    const beforeSweep = await heldOf(sweptRun);
    // An unrestricted run, Ada's own: an App its calls reached may hold
    // under its key too (one entering restricted mode as it ran), so the
    // sweep asks connect to drop what it holds of it as well.
    const ownRun = await started(ada, confirmed.workflow.id, confirmed.serving);
    await ended(ada, confirmed.workflow.id, ownRun);
    const asked: string[] = [];
    const recording: Env = {
      ...env,
      CONNECT: new Proxy(env.CONNECT, {
        get: (target, name): unknown =>
          name === "dropForEndedRuns"
            ? async (request: EndedRuns) => {
                asked.push(...request.runs.map(({ runId }) => runId));
                await target.dropForEndedRuns(request);
              }
            : Reflect.get(target, name),
      }),
    };
    // Past the run's retention, the sweep removes what connect holds of it.
    await sweepRunDetails(recording, new Date(Date.now() + 31 * 86_400_000));
    const confirmedMail = await confirmed.mail.did();
    const sweptMail = await swept.mail.did();
    expect({
      confirming,
      confirmedHeld: await heldOf(confirmedRun),
      beforeSweep,
      afterSweep: await heldOf(sweptRun),
      sweptOwn: asked.includes(ownRun),
      calls: [confirmedMail.calls, sweptMail.calls],
    }).toStrictEqual({
      confirming: "connect.run_ended",
      confirmedHeld: 0,
      beforeSweep: 1,
      afterSweep: 0,
      sweptOwn: true,
      // Ada's own run's send; the cancelled ones sent nothing.
      calls: [1, 0],
    });
  });

  it("leave nothing held of runs a sweep marks, when two sweeps overlap", async () => {
    const ada = await person("builder");
    const { workflow } = await published(ada, { steps: [] });
    // More ended runs due than one sweep takes, long ago.
    const longAgo = Date.now() - 400 * 86_400_000;
    const prefix = `overlap-${unique()}`;
    await env.DB.batch([
      env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
        INSERT INTO workflow_start_receipts (id, invoker_type, invoker_id, idempotency_key, workflow_resource_id, workflow_resource_version, manifest_hash, principal_id, authority_generation, input, input_hash, params, params_revision, bindings, bindings_hash, created_at, restricted)
        SELECT ? || '-' || i, 'person', ?, ? || '-' || i, ?, 1, 'manifest', ?, 0, '{}', 'hash', '{}', 0, '[]', '', ?, 1 FROM n`
      ).bind(
        startDetailsPerSweep + 1,
        prefix,
        ada.userId,
        prefix,
        workflow.id,
        ada.userId,
        longAgo
      ),
      env.DB.prepare(
        `INSERT INTO workflow_resource_runs (id, workflow_resource_id, version, manifest_hash, build_hash, principal_id, status, created_at, ended_at, restricted)
        SELECT id, workflow_resource_id, 1, 'manifest', 'build', principal_id, 'completed', created_at, created_at, 1
        FROM workflow_start_receipts WHERE id LIKE ? || '-%'`
      ).bind(prefix),
    ]);
    const asked = new Set<string>();
    const later = new Date(Date.now() + 31 * 86_400_000);
    const recording = (onFirstDrop?: () => Promise<void>): Env => {
      let onDrop = onFirstDrop;
      return {
        ...env,
        CONNECT: new Proxy(env.CONNECT, {
          get: (target, name): unknown =>
            name === "dropForEndedRuns"
              ? async (request: EndedRuns) => {
                  for (const { runId } of request.runs) {
                    asked.add(runId);
                  }
                  await target.dropForEndedRuns(request);
                  const then = onDrop;
                  onDrop = undefined;
                  await then?.();
                }
              : Reflect.get(target, name),
        }),
      };
    };
    // A second sweep runs whole as the first asks connect to drop.
    await sweepRunDetails(
      recording(async () => {
        await sweepRunDetails(recording(), later);
      }),
      later
    );
    const { results } = await env.DB.prepare(
      "SELECT id FROM workflow_start_receipts WHERE id LIKE ? || '-%' AND details_removed_at IS NOT NULL"
    )
      .bind(prefix)
      .all<{ id: string }>();
    expect({
      marked: results.length > 0,
      markedUnasked: results.filter(({ id }) => !asked.has(id)).length,
    }).toStrictEqual({ marked: true, markedUnasked: 0 });
  });

  it("collect a held send's outcome once confirmed, though their lineage has no host calls left", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow, mail, serving } = await mailingWorkflow(ada, admin, {
      to: "Ada",
      plain: true,
    });
    const starter = await startingApp(ada, admin, workflow.id, {
      restricted: true,
    });
    // Two host calls: the send's own, which the attempt that was held
    // takes, and one more. The rerun that collects what Ada decided takes
    // none: it repeats the held attempt's work, sending nothing new. So
    // the lineage still has one as the run's output step is admitted
    // (a step past the lineage's host calls is admitted no more).
    const { runId, run } = await withQuotas(
      { lineageHostCalls: 2 },
      async () => {
        const id = await starter.start(serving);
        const held = await heldFor(ada, id);
        await confirmPendingAction(env, ada, held.id, held.inputHash);
        return { runId: id, run: await ended(ada, workflow.id, id) };
      }
    );
    const lineage = await env.DB.prepare(
      "SELECT host_calls AS hostCalls FROM run_lineages WHERE root_run_id = ?"
    )
      .bind(runId)
      .first<{ hostCalls: number }>();
    const sent = await mail.did();
    expect({
      end: endOf(run),
      calls: sent.calls,
      hostCalls: lineage?.hostCalls,
    }).toStrictEqual({
      end: { status: "completed", output: { status: "message-1" } },
      calls: 1,
      hostCalls: 1,
    });
  });

  it("wait for their person when a send that failed for a moment is held on its retry, then send it once confirmed", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    // Its first round can't reach the mail server for a moment, through
    // its step's own attempts (connect lists the server's tools before it
    // holds anything), so the try's retry calls again under the send's
    // key, which connect holds for Ada.
    const { workflow, mail, serving } = await mailingWorkflow(ada, admin, {
      to: "Ada",
      plain: true,
      plan: ["unavailable", "unavailable", "unavailable"],
      retry: { attempts: 2, delay: "1 second", backoff: "constant" },
    });
    const starter = await startingApp(ada, admin, workflow.id, {
      restricted: true,
    });
    const runId = await starter.start(serving);
    const held = await heldFor(ada, runId);
    // Long enough for a host that rerun the held call at once to spend
    // the run's steps on it.
    await scheduler.wait(3000);
    const runWhileHeld = await resourceRunFor(env, ada, workflow.id, runId);
    const mailWhileHeld = await mail.did();
    const whileHeld = {
      status: runWhileHeld.status,
      calls: mailWhileHeld.calls,
    };
    await confirmPendingAction(env, ada, held.id, held.inputHash);
    const run = await ended(ada, workflow.id, runId);
    // The steps the run started: one rerun of the held call, once Ada
    // decided, never one for each check while she hadn't.
    using events = await runInstance(runId).subscribe({
      filter: ["attempt_started"],
    });
    const steps: string[] = [];
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- one event at a time, in order
      const { done, value } = await events.next();
      if (done === true) {
        break;
      }
      if (value.type === "attempt_started") {
        steps.push(value.stepName);
      }
    }
    const sent = await mail.did();
    expect({
      whileHeld,
      end: endOf(run),
      calls: sent.calls,
      // The retry's round, as the run host names it after the send's key.
      retried: steps.some((name) =>
        /^\$grasp:wait:[0-9a-f]{16}:retry:2:run-1$/u.test(name)
      ),
      heldReruns: steps.filter((name) =>
        /^\$grasp:wait:[0-9a-f]{16}:held:\d+:run-/u.test(name)
      ).length,
    }).toStrictEqual({
      whileHeld: { status: "running", calls: 0 },
      end: { status: "completed", output: { status: "sent" } },
      calls: 1,
      retried: true,
      heldReruns: 1,
    });
  });

  it("start restricted from an agent's restricted chat, or one that names none, and not from an open chat", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow } = await published(ada, { steps: [] });
    const starter = await startingApp(ada, admin, workflow.id, {
      restricted: false,
    });
    const workspaceId = workspaceIdSchema.parse(crypto.randomUUID());
    const stub = workspace(env, workspaceId);
    // The workspace's agent: its id is the workspace's.
    const open = await stub.createChat("Questions", ada.userId, workspaceId);
    const shut = await stub.createChat("Questions", ada.userId, workspaceId);
    await stub.restrictChat(shut.id);
    await granted(ada, admin, {
      subject: { type: "agent", agentId: agentIdSchema.parse(workspaceId) },
      object: { type: "app", appId: starter.app },
      actions: ["write"],
      binding: `DESK_${unique().toUpperCase().replaceAll("-", "_")}`,
    });
    const agentIn = (chatId: string): CallingAgent => ({
      agentId: workspaceId,
      workspaceId,
      chatId: chatIdSchema.parse(chatId),
    });
    const fromOpen = await starter.start(env, agentIn(open.id));
    const fromShut = await starter.start(env, agentIn(shut.id));
    // An agent's own start that names no chat: nothing to read, so
    // restricted.
    const agent = agentIdSchema.parse(workspaceId);
    await granted(ada, admin, {
      subject: { type: "agent", agentId: agent },
      object: {
        type: "workflow",
        workflowId: workflowResourceIdSchema.parse(workflow.id),
      },
      actions: ["start"],
      binding: `START_${unique().toUpperCase().replaceAll("-", "_")}`,
    });
    const { runId: unnamed } = await startWorkflow(
      env,
      {
        type: "agent",
        authority: {
          subject: { type: "agent", agentId: agent },
          onBehalfOf: ada.userId,
          mode: "interactive",
        },
      },
      workflow.id,
      adaStart()
    );
    expect({
      open: await pinnedRestricted(fromOpen),
      shut: await pinnedRestricted(fromShut),
      unnamed: await pinnedRestricted(unnamed ?? ""),
      appRestricted: await appHost(env, starter.app).isRestricted(),
    }).toStrictEqual({
      open: { receipt: 0, run: 0 },
      shut: { receipt: 1, run: 1 },
      unnamed: { receipt: 1, run: 1 },
      appRestricted: false,
    });
  });
});
