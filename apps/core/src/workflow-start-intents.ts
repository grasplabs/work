import { delegateActorOf } from "@grasp-os/shared/audit";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Authority } from "@grasp-os/shared/permissions";
import {
  workflowResourceErrors,
  workflowStartIntentSchema,
} from "@grasp-os/shared/workflow-resources";
import { drizzle } from "drizzle-orm/d1";

import { startAppBinding } from "./app-workflow-bindings.ts";
import { auditedBatch, outboxed } from "./audit-outbox.ts";
import type { WorkflowStarts } from "./operations.ts";
import type {
  OutboxConsumer,
  OutboxConsumers,
  OutboxEntry,
} from "./outbox-delivery.ts";

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
//   the App version whose code made or staged the start, the person's
//   role in the App, the binding, and everything the workflow's version
//   needs are all read again as each start is admitted, by the one
//   admitting statement. A mutation's start, dispatched later, is decided
//   then: a grant revoked or a person removed since the commit starts
//   nothing, and the refusal is audited.
// - An undeclared workflow: the operation host starts only an alias the
//   function lists and the App declares (operations.ts); an alias the App
//   doesn't bind is `workflow.app_binding_unavailable`.
// - A rolled-back, failed or superseded mutation that still starts: its
//   starts are outbox entries written in its commit's transaction, so a
//   commit the store refuses (a stale fence, a deadline, a revision guard,
//   stale reads) writes none (store-host.ts).
// - A dispatch that dies after the start, before its entry is settled:
//   the entry is handed over again, under the same ID and with the same
//   intent, and its start's key, derived from the mutation's receipt and
//   its place among the commit's starts, makes the same start again,
//   which answers the receipt already admitted and the run under it,
//   sending that run to the engine if it never got there
//   (`startResourceRun`). Two dispatches at once land one receipt (the
//   receipts' key is unique).
// - An intent that doesn't read as one (a store's row damaged, a kind
//   staged by something else): settled as `outbox.unreadable`, never
//   guessed at.

/** The handle of an App start, as App code gets it. */
const handleOf = (start: {
  id: string;
  runId: string | null;
  version: number;
}) => ({ startId: start.id, runId: start.runId, version: start.version });

/**
 * How core starts the workflows App code binds, for an invocation acting
 * as `authority` (the App, its version, the person): each through the
 * App's binding of the alias, with the key the operation host derived.
 */
export const appWorkflowStarts = (
  env: Env,
  authority: Authority
): WorkflowStarts => ({
  start: async (alias, input, key) =>
    handleOf(await startAppBinding(env, authority, alias, { input, key })),
  intent: (alias, input, key): Json => {
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
      key,
      input,
    };
    // As its dispatch will read it, or not staged at all.
    workflowStartIntentSchema.parse(intent);
    return intent;
  },
});

/** Settled as never deliverable, for `code`. */
const undeliverable = (code: string) => ({ undeliverable: code });

/**
 * Makes the start a committed mutation staged (see the header): delivered
 * once its start is admitted, or was already; settled undeliverable for a
 * start the workflow's configuration or the App's authority refuses now,
 * with its code, and that refusal audited; handed over again later for
 * anything else, the person's live runs at their limit included.
 */
export const dispatchStartIntent = async (
  env: Env,
  entry: Pick<OutboxEntry, "id" | "intent">
): Promise<"delivered" | { undeliverable: string }> => {
  const read =
    entry.intent.kind === "workflow.start"
      ? workflowStartIntentSchema.safeParse(entry.intent.data)
      : undefined;
  const app = appIdSchema.safeParse(read?.data?.app);
  if (read?.success !== true || !app.success) {
    log.error("workflow.start_intent_unreadable", { entry: entry.id });
    return undeliverable("outbox.unreadable");
  }
  const { appVersion, principal, alias, key, input } = read.data;
  const authority: Authority = {
    subject: { type: "app", appId: app.data },
    onBehalfOf: principal,
    mode: "interactive",
    appVersion,
  };
  try {
    await startAppBinding(env, authority, alias, { input, key });
    return "delivered";
  } catch (error) {
    const code = workflowResourceErrors.codeOf(error);
    if (code === undefined || code === "workflow.run_limit") {
      if (code === undefined) {
        log.error("workflow.start_intent_failed", {
          entry: entry.id,
          ...errorFields(error),
        });
      }
      throw error;
    }
    const db = drizzle(env.DB);
    await auditedBatch(env, db, [
      outboxed(db, {
        actor: delegateActorOf(authority),
        action: "workflow.start_intent.refused",
        target: { type: "app", id: app.data },
        detail: {
          entry: entry.id,
          appVersion,
          principal,
          alias,
          reason: code,
        },
      }),
    ]);
    return undeliverable(code);
  }
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
