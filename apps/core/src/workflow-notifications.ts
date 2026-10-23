import {
  declaredWorkflows,
  eventFingerprint,
  schemaFromDescriptor,
} from "@grasp-os/sdk/host";
import { delegateActorOf } from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import { isExpectedError, issuesOf } from "@grasp-os/shared/errors";
import { appIdSchema, workflowResourceIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { operationInputMaxBytes } from "@grasp-os/shared/operation-limits";
import { operationErrors } from "@grasp-os/shared/operations";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Authority } from "@grasp-os/shared/permissions";
import {
  workflowResourceErrors,
  workflowStartIntentSchema,
} from "@grasp-os/shared/workflow-resources";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import type { Release } from "./app-releases.ts";
import { bindingPinnedSql } from "./app-workflow-bindings.ts";
import { auditedBatch, outboxed } from "./audit-outbox.ts";
import { appHost } from "./durable-objects.ts";
import { defaultMaxAttempts } from "./outbox-delivery.ts";
import type { OutboxEntry } from "./outbox-delivery.ts";
import { requireAgentAllowed, requireLive } from "./workflow-start-intents.ts";
import type { CallingAgent } from "./workflow-start-intents.ts";
import { appSendHoldsSql } from "./workflow-starts.ts";
import { admitRunEvent, unlessAccepted } from "./workflows/run-events.ts";
import type { RunEventDelivery } from "./workflows/run-events.ts";

// A mutation's workflow notifications (spec 10.7.4): `ctx.notify(event,
// { runId, data })`, staged as an intent of its commit in its store's
// outbox (operations.ts) and delivered from there, after the commit, into
// the run's inbox (workflows/run-events.ts), the inbox a screen's send
// reaches too (screen-workflows.ts). Threat model, and how each is closed:
//
// - A notification outliving a mutation that didn't commit: it is an
//   outbox entry written in its commit's transaction with its records and
//   receipt, or not at all (a rerun for stale reads stages its own from
//   nothing), so a mutation refused, rolled back or superseded notifies
//   nothing (store-host.ts).
// - A notification delivered twice, or lost: the outbox hands an entry
//   over until it is settled, under the same ID, which names the receipt,
//   the commit and the intent's place among its intents; that ID is the
//   event's delivery key, so a dispatch that died after the inbox took the
//   event, or two at once, deliver one event, its ID the same. One the run
//   took before it ended or before the grant went is delivered, not
//   refused (`unlessAccepted`).
// - An event the App doesn't send, or to a run that isn't one of the
//   App's. The function must list the event in its sealed `uses`, by its
//   workflow's alias, its own, its type and its fingerprint, and the
//   release the call runs must resolve exactly that event for the
//   workflow (`resource.not_allowed` otherwise); its data must be what the
//   event's declared contract takes (`contract.invalid_args`); the run
//   must be one the App started through its binding of the workflow, of
//   the version the binding names now, not yet ended. The App needs its
//   own `send` grant on the workflow, for the person the call acts for,
//   with their role in the App and the release not revoked
//   (`appSendHoldsSql`). Each is read as the notification is staged
//   (anything that doesn't hold is `resource.unavailable`, never saying
//   which, and fails the mutation), and again as it is delivered, with
//   the run's own binding authority (`admitRunEvent`): a commit's success
//   is its local commit, never the run taking the event.
// - A run of another person's. The App is the sender, for the person the
//   call acts for: a run it started for anyone through the binding is one
//   it may notify, as its code decides (the App's own grant, which an admin
//   approved), as its mutations write records anyone in it reads. The
//   event names the person and the mutation in its source.
// - Restricted data carried into a run that isn't restricted: an App in
//   restricted mode notifies only a run restricted itself, read as it is
//   staged and again as it is delivered (restricted.ts).
// - Forged provenance: App code names the event's reference, the run and
//   the data, nothing else. The host mints the envelope: its source from
//   the App, its release and the person (`sourceOf`), its ID from the run,
//   binding, source and delivery key, its time as the run accepts it.
// - One sender filling the run's inbox: the App and the person are one
//   sender, as their screen's sends are (`senderOf`), held to that
//   sender's share of the inbox.
// - A notification dropped unrecorded: one refused for good (the run
//   ended, the grant revoked, the run's inbox refusing it as invalid) is
//   settled undeliverable with its sanitized code, in the store's outbox,
//   and audited (`workflow.notify_intent.refused`), the mutation standing;
//   one refused for now (an inbox at its limit, a run the engine doesn't
//   know yet) is handed over again, audited once its last attempt fails
//   (`workflow.notify_intent.abandoned`); one unreadable is audited too.

/** A notification as its commit stages it, and its dispatch reads it. */
const notifyIntentSchema = z.strictObject({
  app: appIdSchema,
  appVersion: z.int().min(1),
  principal: z.string().min(1).max(256),
  /** The App's alias for the workflow. */
  workflow: z.string().min(1).max(64),
  workflowId: workflowResourceIdSchema,
  version: z.int().min(1),
  /** The event binding's alias in the workflow. */
  event: z.string().min(1).max(64),
  type: z.string().min(1).max(256),
  runId: z.string().min(1).max(128),
  data: z.json(),
  agent: workflowStartIntentSchema.shape.agent,
});
type NotifyIntent = z.infer<typeof notifyIntentSchema>;

/** The event a function's sealed `uses` lists, as the host read it. */
export interface ListedEvent {
  readonly alias: string;
  readonly type: string;
  readonly fingerprint: string;
}

/** How core stages a mutation's notifications, for one invocation. */
export interface WorkflowNotifications {
  /**
   * The intent a commit stages to notify run `runId` of the workflow the
   * App binds under `workflow` with `event` (as the function's sealed
   * `uses` lists it) and `data`, checked as the header says; refused
   * otherwise.
   */
  readonly intent: (
    workflow: string,
    event: ListedEvent,
    runId: unknown,
    data: unknown
  ) => Promise<Json>;
}

/** Who a notification comes from, as its event's source. */
const sourceOf = (intent: NotifyIntent): string =>
  `urn:grasp:app:${intent.app}:version:${intent.appVersion}:person:${encodeURIComponent(intent.principal)}:mutation`;

/**
 * Who a notification counts against in a run's inbox: the App and the
 * person, as their screen's sends do.
 */
const senderOf = (intent: Pick<NotifyIntent, "app" | "principal">): string =>
  `app:${intent.app}:person:${intent.principal}`;

/**
 * That run `runId` is one App `app` started through its binding of
 * `alias`, of exactly the version it names now, and hasn't ended; and that
 * the App may send it events for `principal` now, as SQL.
 */
const maySendSql = (
  app: AppId,
  appVersion: number,
  principal: string,
  alias: string,
  pin: { workflowId: string; version: number },
  runId: string
): SQL => {
  const workflow = workflowResourceIdSchema.safeParse(pin.workflowId);
  if (!workflow.success) {
    return sql`0`;
  }
  return sql`(EXISTS (SELECT 1 FROM workflow_resource_runs AS run
      JOIN workflow_start_receipts AS receipt ON receipt.id = run.id
      WHERE run.id = ${runId}
        AND run.workflow_resource_id = ${pin.workflowId}
        AND run.version = ${pin.version}
        AND run.status IN ('starting', 'running')
        AND receipt.invoker_type = 'app' AND receipt.invoker_id = ${app})
    AND ${appSendHoldsSql(app, appVersion, principal, workflow.data)}
    AND ${bindingPinnedSql(app, alias, pin)})`;
};

/** Whether `condition` holds now. */
const holds = async (env: Env, condition: SQL): Promise<boolean> => {
  const row = await drizzle(env.DB).get<{ holds: number }>(
    sql`SELECT ${condition} AS holds`
  );
  return row.holds === 1;
};

/** Whether App `app`, restricted, would carry what it read into run `runId`. */
const restrictsRun = async (
  env: Env,
  app: AppId,
  runId: string
): Promise<boolean> => {
  const row = await env.DB.prepare(
    "SELECT restricted FROM workflow_resource_runs WHERE id = ?"
  )
    .bind(runId)
    .first<{ restricted: number }>();
  return row?.restricted !== 1 && (await appHost(env, app).isRestricted());
};

/** A notification the App may not make now: never saying why. */
const unavailable = () => operationErrors.create("resource.unavailable");

/**
 * How core stages the notifications of an invocation acting as
 * `authority` (the App, its version, the person) under `release`, made by
 * `agent`'s call when an agent made it.
 */
export const appWorkflowNotifications = (
  env: Env,
  authority: Authority,
  release: Release,
  agent: CallingAgent | null
): WorkflowNotifications => ({
  intent: async (workflow, event, runId, data) => {
    const { subject, appVersion, onBehalfOf } = authority;
    if (subject.type !== "app" || appVersion === undefined) {
      throw new Error("Only an App's call stages a notification.");
    }
    const declared = declaredWorkflows(release.app, release.workflows).find(
      (each) => each.alias === workflow
    );
    const resolved =
      declared !== undefined && Object.hasOwn(declared.events, event.alias)
        ? declared.events[event.alias]
        : undefined;
    if (
      declared === undefined ||
      resolved === undefined ||
      resolved.type !== event.type ||
      (await eventFingerprint(resolved)) !== event.fingerprint
    ) {
      throw operationErrors.create("resource.not_allowed");
    }
    const checked = schemaFromDescriptor(JSON.stringify(resolved.data))[
      "~standard"
    ].validate(data);
    if ("then" in checked) {
      throw new Error("An event's data schema validated asynchronously");
    }
    if (checked.issues !== undefined) {
      throw operationErrors.create("contract.invalid_args", {
        issues: issuesOf({
          issues: checked.issues.map(({ path, message }) => ({
            path: (path ?? []).map(String),
            message,
          })),
        }),
      });
    }
    const accepted = z.json().parse(checked.value);
    if (
      new TextEncoder().encode(canonicalJson(accepted)).byteLength >
      operationInputMaxBytes
    ) {
      throw operationErrors.create("contract.input_too_large", {
        maxBytes: operationInputMaxBytes,
      });
    }
    const pin = declared.pinned;
    if (
      typeof runId !== "string" ||
      runId.length === 0 ||
      runId.length > 128 ||
      pin === undefined
    ) {
      throw unavailable();
    }
    const app = subject.appId;
    if (
      !(await holds(
        env,
        maySendSql(app, appVersion, onBehalfOf, workflow, pin, runId)
      )) ||
      (await restrictsRun(env, app, runId))
    ) {
      throw unavailable();
    }
    const intent: NotifyIntent = {
      app,
      appVersion,
      principal: onBehalfOf,
      workflow,
      workflowId: workflowResourceIdSchema.parse(pin.workflowId),
      version: pin.version,
      event: event.alias,
      type: event.type,
      runId,
      data: accepted,
      agent:
        agent === null
          ? null
          : {
              agentId: agent.agentId,
              workspaceId: agent.workspaceId,
              chatId: agent.chatId,
            },
    };
    return intent;
  },
});

/** Records what became of a notification, in the audit log. */
const audited = async (
  env: Env,
  actor: AuditActor,
  action: string,
  target: { type: string; id: string },
  detail: Record<string, string | number | boolean | null>
): Promise<void> => {
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    outboxed(db, { actor, action, target, detail }),
  ]);
};

/** Refusals no later attempt would turn into a delivery. */
const settledRefusals: ReadonlySet<string> = new Set([
  "workflow.run_ended",
  "workflow.run_unavailable",
  "workflow.event_denied",
  "workflow.event_invalid",
  "workflow.event_conflict",
  "permission.restricted",
]);

/**
 * Delivers the notification a committed mutation staged (see the header):
 * delivered once its run's inbox took the event, or had; settled
 * undeliverable, with the refusal's code and that refusal audited, for one
 * refused for good; handed over again later for anything else, audited
 * once its last attempt fails.
 */
export const dispatchNotifyIntent = async (
  env: Env,
  entry: Pick<OutboxEntry, "id" | "intent" | "attempts" | "signal">
): Promise<"delivered" | { undeliverable: string }> => {
  const read =
    entry.intent.kind === "workflow.notify"
      ? notifyIntentSchema.safeParse(entry.intent.data)
      : undefined;
  if (read?.success !== true) {
    log.error("workflow.notify_intent_unreadable", { entry: entry.id });
    requireLive(entry.signal);
    await audited(
      env,
      { type: "system" },
      "workflow.notify_intent.unreadable",
      { type: "outbox_entry", id: entry.id },
      { entry: entry.id }
    );
    return { undeliverable: "outbox.unreadable" };
  }
  const intent = read.data;
  const authority: Authority = {
    subject: { type: "app", appId: intent.app },
    onBehalfOf: intent.principal,
    mode: "interactive",
    appVersion: intent.appVersion,
  };
  const actor = delegateActorOf(authority);
  const target = { type: "workflow_run", id: intent.runId };
  const detail = {
    entry: entry.id,
    app: intent.app,
    appVersion: intent.appVersion,
    principal: intent.principal,
    workflow: intent.workflowId,
    version: intent.version,
    binding: intent.event,
    type: intent.type,
    ...(intent.agent === null ? {} : { agent: intent.agent.agentId }),
  };
  const delivery: RunEventDelivery = {
    workflowId: intent.workflowId,
    runId: intent.runId,
    binding: intent.event,
    type: intent.type,
    data: intent.data,
    // The receipt, the commit and the intent's place among its intents.
    key: entry.id,
    source: sourceOf(intent),
    sender: senderOf(intent),
  };
  try {
    requireLive(entry.signal);
    let admitted;
    try {
      await requireAgentAllowed(
        env,
        intent.app,
        intent.principal,
        intent.agent
      );
      if (
        !(await holds(
          env,
          sql`(${appSendHoldsSql(intent.app, intent.appVersion, intent.principal, intent.workflowId)} AND ${bindingPinnedSql(intent.app, intent.workflow, { workflowId: intent.workflowId, version: intent.version })})`
        ))
      ) {
        throw workflowResourceErrors.create("workflow.event_denied");
      }
      if (await restrictsRun(env, intent.app, intent.runId)) {
        throw permissionErrors.create("permission.restricted");
      }
    } catch (error) {
      // An agent's permission gone reads as the start's refusal does.
      const refusal =
        workflowResourceErrors.codeOf(error) === "workflow.start_denied"
          ? workflowResourceErrors.create("workflow.event_denied")
          : error;
      admitted = await unlessAccepted(env, delivery, refusal);
    }
    requireLive(entry.signal);
    admitted ??= await admitRunEvent(env, delivery);
    requireLive(entry.signal);
    await audited(env, actor, "workflow.event.sent", target, {
      ...detail,
      event: admitted.id,
      via: "mutation",
      redelivered: !admitted.accepted,
    });
    return "delivered";
  } catch (error) {
    const code = isExpectedError(error) ? error.code : undefined;
    if (code !== undefined && settledRefusals.has(code)) {
      requireLive(entry.signal);
      await audited(env, actor, "workflow.notify_intent.refused", target, {
        ...detail,
        reason: code,
      });
      return { undeliverable: code };
    }
    if (code === undefined) {
      log.error("workflow.notify_intent_failed", {
        entry: entry.id,
        ...errorFields(error),
      });
    }
    // Its last attempt: recorded before the outbox gives it up.
    if (entry.attempts + 1 >= defaultMaxAttempts) {
      requireLive(entry.signal);
      await audited(env, actor, "workflow.notify_intent.abandoned", target, {
        ...detail,
        reason: code ?? "internal.unexpected",
      });
    }
    throw error;
  }
};
