import { delegateActorOf } from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId, ChatId, WorkspaceId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Authority } from "@grasp-os/shared/permissions";
import {
  coreStartKeyPrefix,
  workflowResourceErrors,
  workflowStartIntentSchema,
} from "@grasp-os/shared/workflow-resources";
import type {
  WorkflowStart,
  WorkflowStartIntent,
} from "@grasp-os/shared/workflow-resources";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { chatAuthority, chatContext } from "./agent-scope.ts";
import { startAppBinding } from "./app-workflow-bindings.ts";
import { auditedBatch, outboxed } from "./audit-outbox.ts";
import { permissions } from "./db/core/schema.ts";
import { appHost } from "./durable-objects.ts";
import type { WorkflowStarts } from "./operations.ts";
import { defaultMaxAttempts } from "./outbox-delivery.ts";
import type {
  OutboxConsumer,
  OutboxConsumers,
  OutboxEntry,
} from "./outbox-delivery.ts";
import { allowingPermissionSql, grantedPermissions } from "./permissions.ts";
import { isStaleRefusal, receiptOf } from "./workflow-starts.ts";

// Starting workflows from an App's server functions (spec 7.4, 9.5): an
// action's `ctx.startWorkflow`, made as it runs, and a mutation's
// `ctx.afterCommit.start`, staged in its store's outbox with its commit
// and made from there by this dispatch. Both are App starts of the
// workflow version the App binds under an alias (app-workflow-bindings.ts),
// decided and admitted as every start is (workflow-starts.ts). Threat
// model, and how each is closed:
//
// - An implicit App-owner or admin start: the run acts for the person the
//   function's call acted for, the invocation's principal, and the App is
//   only the invoker. Nothing here names the App's owner, the workflow's,
//   or anyone else; the intent carries the principal core resolved as the
//   mutation ran, and App code can't set it.
// - A start on authority that changed: the App's own `start` grant, from
//   the App version whose code made or staged the start, that version's
//   release not revoked, the person's role in the App, the binding, and
//   everything the workflow's version needs are all read again as each
//   start is admitted, by the one admitting statement. A start an agent's
//   call staged needs the agent's permission on the App again too, in its
//   chat, read by that same statement (`agentAllowedSql`). A
//   mutation's start, dispatched later, is decided then: authority lost
//   since the commit starts nothing, and the refusal is audited.
// - Restricted data carried into a run: an App that read restricted data
//   starts no workflow (`workflow.start_restricted`), now or from its
//   outbox, until independent runs carry the flag themselves (GRA-570).
//   An agent in a restricted chat restricts the App before it writes
//   there (agent-apps.ts), so the same holds for its calls.
// - A benign change racing a dispatch (a parameter edit, a member added):
//   the admitting statement refuses a start whose decision went stale as
//   `workflow.start_denied`, so the dispatch decides again before it
//   takes that for an answer; only a refusal a fresh decision makes
//   settles the entry. Decisions that all went stale answer nothing: the
//   entry is handed over again later (`isStaleRefusal`).
// - An undeclared workflow: the operation host starts only an alias the
//   function lists and the App declares (operations.ts); an alias the App
//   doesn't bind is `workflow.app_binding_unavailable`.
// - A rolled-back, failed or superseded mutation that still starts: its
//   starts are outbox entries written in its commit's transaction, so a
//   commit the store refuses (a stale fence, a deadline, a revision guard,
//   stale reads) writes none (store-host.ts).
// - A dispatch that dies after the start, before its entry is settled:
//   the entry is handed over again, under the same ID, and its start's key
//   is that ID (which names the commit, so a mutation key the store lets
//   commit again long after never meets an earlier start): the same start
//   again, which answers the receipt already admitted and the run under
//   it, sending that run to the engine if it never got there. Two
//   dispatches at once land one receipt (the receipts' key is unique). A
//   dispatch refused after an earlier one admitted the start (a grant
//   revoked in between) finds the receipt and settles as delivered.
// - A hand-over that timed out: the dispatch stops at its signal before it
//   starts or audits anything, so the one handed over again decides.
// - A start dropped unrecorded: an intent that doesn't read as one, a
//   refused one, and one whose last attempt failed are each audited.

/** The agent whose call of the App a start comes from (agent-apps.ts). */
export interface CallingAgent {
  readonly agentId: string;
  readonly workspaceId: WorkspaceId;
  readonly chatId: ChatId;
}

/** The handle of an App start, as App code gets it. */
const handleOf = (start: WorkflowStart) => ({
  startId: start.id,
  runId: start.runId,
  version: start.version,
});

/** The start key core derives, for an action's start or a commit's. */
export const coreStartKey = (
  kind: "action" | "after-commit",
  key: string
): string => `${coreStartKeyPrefix}${kind}:${key}`;

/** What a start's audit events say of the agent behind it, if any. */
const notedOf = (agent: CallingAgent | null): Record<string, string> =>
  agent === null ? {} : { agent: agent.agentId };

/**
 * That `agent` still holds `write` on App `app` for `principal`, in its
 * chat, as SQL the admitting statement reads (`requireAgentAllowed`'s
 * rule): an agent's permission revoked after that check, before the
 * receipt is written, admits nothing.
 */
const agentAllowedSql = (
  app: AppId,
  principal: string,
  agent: CallingAgent
): SQL => {
  const { subject } = chatAuthority({
    agentId: agent.agentId,
    personId: principal,
  });
  if (subject.type !== "agent") {
    return sql`0`;
  }
  const allowing = allowingPermissionSql(
    subject,
    undefined,
    { type: "app", appId: app },
    "write",
    true,
    { context: chatContext(agent), onBehalfOf: principal }
  );
  return sql`EXISTS (SELECT 1 FROM ${permissions} WHERE ${allowing})`;
};

/** Throws once the hand-over's time is up: another has it now. */
const requireLive = (signal: AbortSignal): void => {
  if (signal.aborted) {
    throw new Error("The hand-over's time ran out");
  }
};

/**
 * Starts the workflow App `authority` binds under `alias`: refused while
 * the App is restricted (see the header), audited naming `agent`. Stops,
 * starting nothing, once `requireGoing` (a call's cancel or deadline, a
 * dispatch's hand-over) throws, asked again just before it is admitted.
 */
const startAsApp = async (
  env: Env,
  authority: Authority,
  alias: string,
  request: { input: Json; key: string },
  agent: CallingAgent | null,
  requireGoing?: () => void
): Promise<WorkflowStart> => {
  if (authority.subject.type !== "app") {
    throw workflowResourceErrors.create("workflow.start_denied");
  }
  if (await appHost(env, authority.subject.appId).isRestricted()) {
    throw workflowResourceErrors.create("workflow.start_restricted");
  }
  requireGoing?.();
  return await startAppBinding(
    env,
    authority,
    alias,
    request,
    notedOf(agent),
    agent === null
      ? undefined
      : agentAllowedSql(authority.subject.appId, authority.onBehalfOf, agent),
    requireGoing
  );
};

/**
 * How many times a start that a decision gone stale refused is decided
 * again, before the refusal is taken as the answer: an action's start at
 * once, a commit's as it is dispatched.
 */
const decisions = 3;

/**
 * `startAsApp`, decided again while a decision gone stale refuses it (an
 * edit or a member landing between its decision and its admission), up
 * to `decisions` times: a fresh decision's refusal is the answer.
 */
const startDecided = async (
  ...args: Parameters<typeof startAsApp>
): Promise<WorkflowStart> => {
  let refusal: unknown;
  for (let decision = 1; decision <= decisions; decision += 1) {
    try {
      // One decision after the other: each only once the last went stale.
      // oxlint-disable-next-line no-await-in-loop -- see above
      return await startAsApp(...args);
    } catch (error) {
      refusal = error;
      if (!isStaleRefusal(error)) {
        break;
      }
    }
  }
  throw refusal;
};

/**
 * How core starts the workflows App code binds, for an invocation acting
 * as `authority` (the App, its version, the person), made by `agent`'s
 * call when an agent made it: each through the App's binding of the
 * alias, with the key the operation host derived.
 */
export const appWorkflowStarts = (
  env: Env,
  authority: Authority,
  agent: CallingAgent | null = null
): WorkflowStarts => ({
  start: async (alias, input, key, requireGoing) =>
    handleOf(
      await startDecided(
        env,
        authority,
        alias,
        { input, key: coreStartKey("action", key) },
        agent,
        requireGoing
      )
    ),
  intent: (alias, input): Json => {
    if (
      authority.subject.type !== "app" ||
      authority.appVersion === undefined
    ) {
      throw new Error("Only an App's call stages a workflow's start.");
    }
    const intent: Json = {
      app: authority.subject.appId,
      appVersion: authority.appVersion,
      principal: authority.onBehalfOf,
      alias,
      input,
      agent:
        agent === null
          ? null
          : {
              agentId: agent.agentId,
              workspaceId: agent.workspaceId,
              chatId: agent.chatId,
            },
    };
    // As its dispatch will read it, or not staged at all.
    workflowStartIntentSchema.parse(intent);
    return intent;
  },
});

/** Settled as never deliverable, for `code`. */
const undeliverable = (code: string) => ({ undeliverable: code });

/**
 * Refuses (`workflow.start_denied`) a start an agent's call staged, once
 * the agent no longer holds `write` on App `app` for the person, as it
 * needed to make the call.
 */
const requireAgentAllowed = async (
  env: Env,
  app: AppId,
  principal: string,
  agent: WorkflowStartIntent["agent"]
): Promise<void> => {
  if (agent === null) {
    return;
  }
  const granted = await grantedPermissions(
    env,
    chatAuthority({ agentId: agent.agentId, personId: principal }),
    chatContext(agent)
  );
  const allowed = granted.some(
    ({ object, actions }) =>
      object.type === "app" && object.appId === app && actions.includes("write")
  );
  if (!allowed) {
    throw workflowResourceErrors.create("workflow.start_denied");
  }
};

/** Records what became of an intent its dispatch didn't deliver. */
const audited = async (
  env: Env,
  actor: AuditActor,
  action: string,
  target: { type: string; id: string },
  detail: Record<string, string | number | null>
): Promise<void> => {
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    outboxed(db, { actor, action, target, detail }),
  ]);
};

/** Whether a refusal is one a later attempt may not repeat. */
const isTransient = (error: unknown): boolean =>
  !isExpectedError(error) ||
  workflowResourceErrors.codeOf(error) === "workflow.run_limit";

/**
 * Makes the start a committed mutation staged (see the header): delivered
 * once its start is admitted, or was already; settled undeliverable for a
 * start refused now, with its code, and that refusal audited; handed over
 * again later for anything else, the person's live runs at their limit
 * included, audited once its last attempt fails.
 */
export const dispatchStartIntent = async (
  env: Env,
  entry: Pick<OutboxEntry, "id" | "intent" | "attempts" | "signal">
): Promise<"delivered" | { undeliverable: string }> => {
  const read =
    entry.intent.kind === "workflow.start"
      ? workflowStartIntentSchema.safeParse(entry.intent.data)
      : undefined;
  const app = appIdSchema.safeParse(read?.data?.app);
  if (read?.success !== true || !app.success) {
    log.error("workflow.start_intent_unreadable", { entry: entry.id });
    requireLive(entry.signal);
    await audited(
      env,
      { type: "system" },
      "workflow.start_intent.unreadable",
      { type: "outbox_entry", id: entry.id },
      { entry: entry.id }
    );
    return undeliverable("outbox.unreadable");
  }
  const { appVersion, principal, alias, input, agent } = read.data;
  const authority: Authority = {
    subject: { type: "app", appId: app.data },
    onBehalfOf: principal,
    mode: "interactive",
    appVersion,
  };
  const key = coreStartKey("after-commit", entry.id);
  const detail = {
    entry: entry.id,
    appVersion,
    principal,
    alias,
    ...notedOf(agent),
  };
  const target = { type: "app", id: app.data };
  let refusal: unknown;
  for (let decision = 1; decision <= decisions; decision += 1) {
    requireLive(entry.signal);
    try {
      // One decision after the other: each only once the last went stale.
      // oxlint-disable-next-line no-await-in-loop -- see above
      await requireAgentAllowed(env, app.data, principal, agent);
      // Its hand-over may have run out as that was read.
      requireLive(entry.signal);
      // oxlint-disable-next-line no-await-in-loop -- see above
      await startAsApp(env, authority, alias, { input, key }, agent, () => {
        requireLive(entry.signal);
      });
      return "delivered";
    } catch (error) {
      refusal = error;
      // Only a refusal of a decision gone stale is decided again; one a
      // fresh decision made is the answer.
      if (!isStaleRefusal(error)) {
        break;
      }
    }
  }
  // Every decision went stale (edits racing each one): no answer yet, so
  // the outbox hands it over again later, as for any transient refusal.
  if (isTransient(refusal) || isStaleRefusal(refusal)) {
    if (!isExpectedError(refusal)) {
      log.error("workflow.start_intent_failed", {
        entry: entry.id,
        ...errorFields(refusal),
      });
    }
    // Its last attempt: recorded before the outbox gives it up.
    if (entry.attempts + 1 >= defaultMaxAttempts) {
      requireLive(entry.signal);
      await audited(
        env,
        delegateActorOf(authority),
        "workflow.start_intent.abandoned",
        target,
        detail
      );
    }
    throw refusal;
  }
  // Admitted by an earlier dispatch that died before settling: delivered.
  const admitted = await receiptOf(
    env,
    { type: "app", id: app.data },
    principal,
    key
  );
  if (admitted !== undefined) {
    return "delivered";
  }
  const code = isExpectedError(refusal) ? refusal.code : "internal.unexpected";
  requireLive(entry.signal);
  await audited(
    env,
    delegateActorOf(authority),
    "workflow.start_intent.refused",
    target,
    { ...detail, reason: code }
  );
  return undeliverable(code);
};

/** The consumer of a store outbox's workflow starts. */
const startConsumer =
  (env: Env): OutboxConsumer =>
  async (entry) =>
    await dispatchStartIntent(env, entry);

/**
 * The consumers of each business store's outbox (data-store.ts): its
 * mutations' workflow starts. Notifications have none yet, so a commit
 * staging one is refused rather than left for nobody.
 */
export const storeOutboxConsumers = (env: Env): OutboxConsumers => ({
  "workflow.start": startConsumer(env),
});
