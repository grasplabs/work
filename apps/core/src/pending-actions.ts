import { connectErrors, wasTaken } from "@grasp-os/shared/connect";
import type {
  ConnectionPerson,
  ConnectResult,
  PendingAction,
  PendingActionsApi,
} from "@grasp-os/shared/connect";
import { isExpectedError } from "@grasp-os/shared/errors";
import { errorFields, log } from "@grasp-os/shared/log";
import { operationErrors } from "@grasp-os/shared/operations";
import { authoritySchema } from "@grasp-os/shared/permissions";
import type {
  Authority,
  CodeSubject,
  WorkContext,
} from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { runOfStepKey } from "@grasp-os/shared/workflows";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { personOf } from "./connections.ts";
import { workflowResourceRuns, workflowRuns } from "./db/core/schema.ts";
import { reauthorizedCapability, refusedForBinding } from "./decided-calls.ts";
import { workspace } from "./durable-objects.ts";
import { isProviderUnreachable } from "./resource-adapter.ts";
import { isRestricted } from "./restricted.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import { loadWorkflowBuild } from "./workflow-builds.ts";
import {
  callingRunOf,
  requireCallAuthority,
} from "./workflows/resource-authority.ts";
import type { CallingRun } from "./workflows/resource-authority.ts";
import { wakingHeld } from "./workflows/wakes.ts";
import type { HeldOutcome } from "./workspace.ts";

// Side effects that connect holds for their person (threat model R7, R12):
// from chat, from a person using an App, and every one of a context that
// read restricted data; as core shows them to that person and lets them
// decide. Connect keeps the held actions; core names the person from their session, read
// fresh on every call, as it does for connecting accounts. Confirming is
// the one way a held action runs: core checks the App's or agent's
// permission and its context's restricted mode again, as for any call, and
// signs a capability that confirms exactly that action for that person. A
// held action of a context that read restricted data runs on confirmation
// too; the list warns of it, and connect records it on every event.
// Nothing an App or agent holds reaches this: it is only on `/rpc`, behind
// the person's session (CN8).

/** Runs that have ended: none of their steps runs again. */
const endedStatuses: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * The independent run whose step called App `held.subject`'s export, as
 * the App's held call's key names it (resource-calls.ts passes the
 * step's key to the export, and the App's code takes no other), if the
 * key names one: none for an App's own run's call, nor for a key of no
 * step.
 */
const exportRunOf = async (env: Env, held: PendingAction) => {
  const runId = runOfStepKey(held.idempotencyKey);
  const named = held.subject.type === "app" ? runId : undefined;
  const run =
    named === undefined
      ? undefined
      : await drizzle(env.DB)
          .select({
            id: workflowResourceRuns.id,
            workflowId: workflowResourceRuns.workflowResourceId,
            version: workflowResourceRuns.version,
            manifestHash: workflowResourceRuns.manifestHash,
            principal: workflowResourceRuns.principalId,
            status: workflowResourceRuns.status,
          })
          .from(workflowResourceRuns)
          .where(eq(workflowResourceRuns.id, named))
          .get();
  return run;
};

/**
 * Whether the workflow run a held action came from has ended (or isn't
 * the App's, or the workflow's): its step's key names the run, whichever
 * of its App's code made the call. A paused run hasn't: it may be resumed.
 */
const runEnded = async (env: Env, held: PendingAction): Promise<boolean> => {
  const runId = runOfStepKey(held.idempotencyKey);
  if (runId !== undefined && held.subject.type === "workflow") {
    // A run of an independent workflow (a restricted one's call).
    const run = await drizzle(env.DB)
      .select({
        workflowId: workflowResourceRuns.workflowResourceId,
        status: workflowResourceRuns.status,
      })
      .from(workflowResourceRuns)
      .where(eq(workflowResourceRuns.id, runId))
      .get();
    return (
      run === undefined ||
      run.workflowId !== held.subject.workflowId ||
      endedStatuses.has(run.status)
    );
  }
  if (runId === undefined || held.subject.type !== "app") {
    return true;
  }
  const run = await drizzle(env.DB)
    .select({ appId: workflowRuns.appId, status: workflowRuns.status })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId))
    .get();
  if (run === undefined) {
    // The App's call an independent run's step made through its export:
    // the key is that step's (`exportRunOf`).
    const exporting = await exportRunOf(env, held);
    return exporting === undefined || endedStatuses.has(exporting.status);
  }
  return run.appId !== held.subject.appId || endedStatuses.has(run.status);
};

/** How a task's step is named, and so its call's key (resource-host.ts). */
const taskStepPrefix = "task:";

/**
 * The alias of the binding task `step` (a step's name, `task:<id>`) of
 * run `run` calls, as its sealed build has it: only a connector call's.
 */
const heldAliasOf = async (
  env: Env,
  run: CallingRun,
  step: string
): Promise<string | undefined> => {
  if (!step.startsWith(taskStepPrefix)) {
    return undefined;
  }
  const taskId = step.slice(taskStepPrefix.length);
  const pinned = await drizzle(env.DB)
    .select({ manifestHash: workflowResourceRuns.manifestHash })
    .from(workflowResourceRuns)
    .where(eq(workflowResourceRuns.id, run.runId))
    .get();
  if (pinned === undefined) {
    return undefined;
  }
  const build = await loadWorkflowBuild(
    env,
    run.workflowId,
    run.version,
    pinned.manifestHash
  );
  const task = build.tasks.find(({ id }) => id === taskId);
  return task?.kind === "call" && task.call.name === "grasp.connector"
    ? task.call.binding
    : undefined;
};

/**
 * Refuses (`workflow.call_denied`) a decision on a connector call a run
 * of an independent workflow held for its person (pending-actions.ts)
 * unless that run is still going, acts for `person`, its call's key names
 * it and the task that made it, and the binding that task's call goes
 * through, as the run's sealed build names it, is the call's permission's
 * and allowed now (`requireCallAuthority`): confirming sends the call, so
 * it is decided as the call itself would be, through its own alias only,
 * never another that shares the permission.
 */
const requireHeldRunCallAllowed = async (
  env: Env,
  held: {
    readonly subject: CodeSubject;
    readonly context: WorkContext;
    readonly idempotencyKey: string;
    readonly permissionId: string;
  },
  person: string
): Promise<void> => {
  const { subject, context, idempotencyKey } = held;
  const run =
    subject.type === "workflow" &&
    context.type === "workflowRun" &&
    context.workflowId === subject.workflowId &&
    runOfStepKey(idempotencyKey) === context.runId
      ? await callingRunOf(env, subject.workflowId, context.runId)
      : undefined;
  const alias =
    run?.principal === person
      ? await heldAliasOf(
          env,
          run,
          idempotencyKey.slice(idempotencyKey.indexOf(":") + 1)
        )
      : undefined;
  const binding = alias === undefined ? undefined : run?.bindings.get(alias);
  if (
    run === undefined ||
    binding?.kind !== "connector" ||
    !("permissionId" in binding.target) ||
    binding.target.permissionId !== held.permissionId
  ) {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  await requireCallAuthority(env, run, binding);
};

/**
 * Refuses (`workflow.call_denied`) a decision on an App's call that an
 * independent run's step made through the App's export (`exportRunOf`),
 * unless that run acts for `person` and the step the key names is a
 * `grasp.operation` task of the run's sealed build: an export's call,
 * which is how the App's code came to run with that key. The App's own
 * authority for the call is checked as for any App's held call
 * (`reauthorizedCapability`). No step waits on it: an export's step is
 * tried once, and failed as held (resource-host.ts); the person confirms
 * the action they were shown, as for an interactive App's.
 */
const requireHeldExportCallAllowed = async (
  env: Env,
  run: NonNullable<Awaited<ReturnType<typeof exportRunOf>>>,
  idempotencyKey: string,
  person: string
): Promise<void> => {
  const step = idempotencyKey.slice(idempotencyKey.indexOf(":") + 1);
  const taskId = step.startsWith(taskStepPrefix)
    ? step.slice(taskStepPrefix.length)
    : undefined;
  if (run.principal !== person || taskId === undefined) {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  const build = await loadWorkflowBuild(
    env,
    run.workflowId,
    run.version,
    run.manifestHash
  );
  const task = build.tasks.find(({ id }) => id === taskId);
  if (task?.kind !== "call" || task.call.name !== "grasp.operation") {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
};

/** Whether connect still holds the held action `id` for `person`. */
const stillHeld = async (
  env: Env,
  person: ConnectionPerson,
  id: string
): Promise<boolean> =>
  (await env.CONNECT.pendingAction({ person, id })) !== null;

/**
 * What a held action's run waits on it by (`wakingHeld`): a workflow
 * run's, of an App or of an independent workflow.
 */
const heldWaitOf = (held: PendingAction) => ({
  subject: held.mode === "workflow" ? held.subject : undefined,
  idempotencyKey: held.idempotencyKey,
});

/**
 * Tells the chat a held action came from how it ended, for its agent's
 * next turn (`Workspace.heldDecided`): only the agent that asked for it, in
 * the chat it asked from, and only that chat's own person's decision. Right
 * after the decision, which connect keeps: the two can't be one write. A
 * failure is logged, and the decision stands.
 */
const tellChat = async (
  env: Env,
  held: PendingAction,
  userId: string,
  outcome: HeldOutcome
): Promise<void> => {
  if (held.context.type !== "chat") {
    return;
  }
  const { workspaceId, chatId } = held.context;
  try {
    await workspace(env, workspaceId).heldDecided(
      chatId,
      userId,
      { id: held.id, action: held.action },
      outcome
    );
  } catch (error) {
    log.warn("chat.held_outcome_failed", { chatId, ...errorFields(error) });
  }
};

/** `confirmPendingAction`, for the held action connect found (`held`). */
const confirmHeld = async (
  env: Env,
  identity: Identity,
  held: PendingAction,
  request: { person: ConnectionPerson; id: unknown; inputHash: unknown }
): Promise<ConnectResult> => {
  const { person } = request;
  let capability: string;
  try {
    // A binding connect can no longer read is refused, never skipped.
    if (held.binding === "unreadable") {
      throw operationErrors.create("resource.unavailable");
    }
    // A run of an independent workflow's call: only while the run's own
    // authority for it holds, as its next call would need.
    if (held.subject.type === "workflow") {
      await requireHeldRunCallAllowed(env, held, identity.userId);
    }
    // An App's call made through its export by an independent run's step:
    // only for that run's person, and only an export call's key.
    const exporting =
      held.mode === "workflow" ? await exportRunOf(env, held) : undefined;
    if (exporting !== undefined) {
      await requireHeldExportCallAllowed(
        env,
        exporting,
        held.idempotencyKey,
        identity.userId
      );
    }
    capability = await reauthorizedCapability(
      env,
      identity,
      {
        ...held,
        binding: held.binding ?? undefined,
      },
      { kind: "confirm", pendingActionId: held.id }
    );
  } catch (error) {
    // Refused here (the permission is gone, the person has left, the
    // context is invalid): recorded as connect records its own refusals,
    // and the action keeps waiting, unless its binding is stale (below).
    await env.CONNECT.refuseConfirmation({
      person,
      id: held.id,
      reason: isExpectedError(error) ? error.code : "internal.unexpected",
    }).catch((auditError: unknown) => {
      log.error("audit.record_failed", errorFields(auditError));
    });
    // Its binding no longer serves it (revoked, replaced, drifted, a
    // version that changed the declaration): dropped, recorded, its key
    // left free, so the same call made again is decided afresh. One whose
    // provider couldn't be reached to say isn't known to be stale: it
    // keeps waiting, for the person to confirm once it can be checked.
    const staleBinding =
      held.binding === "unreadable" || refusedForBinding(error);
    if (staleBinding && !isProviderUnreachable(error)) {
      await env.CONNECT.dropStaleBinding({ person, id: held.id }).catch(
        (dropError: unknown) => {
          log.error("pending.stale_drop_failed", errorFields(dropError));
        }
      );
    }
    throw error;
  }
  let result: ConnectResult;
  try {
    result = await env.CONNECT.confirmAction({ ...request, capability });
  } catch (error) {
    // Only when this confirmation took it (`markTaken`): a refused one
    // tells nothing, whatever another decision did meanwhile.
    if (wasTaken(error)) {
      // Sent, with no answer: it may have been carried out, which a
      // failure would deny.
      await tellChat(
        env,
        held,
        identity.userId,
        connectErrors.codeOf(error) === "connect.outcome_unknown"
          ? "unknown"
          : "failed"
      );
    }
    throw error;
  }
  await tellChat(env, held, identity.userId, "confirmed");
  return result;
};

/**
 * Runs the held action `id` for the signed-in person it waits for, with
 * the input they were shown (`inputHash`): its answer, as the call would
 * have had it. Refused like any call once the App's or agent's permission
 * is gone, its context is restricted, or the person has left; and by
 * connect for anyone the action doesn't wait for, Grasp staff included,
 * which it records. A chat's agent is told how it ended (`tellChat`).
 */
export const confirmPendingAction = async (
  env: Env,
  identity: Identity,
  id: unknown,
  inputHash: unknown
): Promise<ConnectResult> => {
  const person = await personOf(env, identity);
  const request = { person, id, inputHash };
  // Connect finds none for staff, and only the person's own.
  const parsedId = z.uuid().safeParse(id);
  const held = parsedId.success
    ? await env.CONNECT.pendingAction({ person, id: parsedId.data })
    : null;
  if (held === null) {
    // Connect refuses it, and records who tried: nothing confirms it,
    // whatever connect answers.
    await env.CONNECT.confirmAction({ ...request, capability: null });
    throw connectErrors.create("connect.pending_not_found");
  }
  // A run that has ended can't take the answer: its held action goes.
  // Accepted: a run cancelled between this check and connect taking the
  // action still gets it run, as the person confirmed exactly that action,
  // and the window is one request long.
  if (held.mode === "workflow" && (await runEnded(env, held))) {
    await env.CONNECT.dropForEndedRun({ person, id: held.id });
    throw connectErrors.create("connect.run_ended");
  }
  // Its run's step waits on it: woken once it no longer waits, whatever
  // happened (workflows/wakes.ts).
  return await wakingHeld(
    env,
    heldWaitOf(held),
    async () => await confirmHeld(env, identity, held, request),
    async () => await stillHeld(env, person, held.id)
  );
};

/**
 * Drops the held action `id` for the signed-in person it waits for: it
 * never runs. Connect refuses anyone the action doesn't wait for, and
 * records it. A chat's agent is told (`tellChat`).
 */
const declinePendingAction = async (
  env: Env,
  identity: Identity,
  id: string
): Promise<void> => {
  const person = await personOf(env, identity);
  // Read before it goes, to know which chat to tell: only the person's own.
  const held = z.uuid().safeParse(id).success
    ? await env.CONNECT.pendingAction({ person, id })
    : null;
  await (held === null
    ? env.CONNECT.declineAction({ person, id })
    : wakingHeld(
        env,
        heldWaitOf(held),
        async () => {
          await env.CONNECT.declineAction({ person, id });
        },
        async () => await stillHeld(env, person, held.id)
      ));
  if (held !== null) {
    await tellChat(env, held, identity.userId, "declined");
  }
};

/** `isRestricted`, or `true` for a context that can no longer be read. */
const restrictedOrUnknown = async (
  env: Env,
  authority: Authority,
  context: WorkContext
): Promise<boolean> => {
  try {
    return await isRestricted(env, authority, context);
  } catch {
    return true;
  }
};

/**
 * `waiting`, each marked restricted also when its context has read
 * restricted data since it was held: the person is warned before
 * confirming what would now go out from there. A context that can no
 * longer be read is shown as restricted too. Each context (and the App or
 * agent in it) is looked up once, however many actions it holds.
 */
const withRestricted = async (
  env: Env,
  userId: string,
  waiting: PendingAction[]
): Promise<PendingAction[]> => {
  const lookups = new Map<string, Promise<boolean>>();
  const restrictedNow = async (held: PendingAction): Promise<boolean> => {
    const key = JSON.stringify([held.subject, held.context, held.appVersion]);
    let lookup = lookups.get(key);
    if (lookup === undefined) {
      // An App's action names the version whose code asked for it; one
      // that doesn't can't be confirmed, and counts as restricted.
      lookup =
        held.subject.type === "app" && held.appVersion === null
          ? Promise.resolve(true)
          : restrictedOrUnknown(
              env,
              authoritySchema.parse({
                subject: held.subject,
                onBehalfOf: userId,
                mode: held.mode,
                ...(held.appVersion === null
                  ? {}
                  : { appVersion: held.appVersion }),
              }),
              held.context
            );
      lookups.set(key, lookup);
    }
    return await lookup;
  };
  return await Promise.all(
    waiting.map(async (held) =>
      held.restricted
        ? held
        : { ...held, restricted: await restrictedNow(held) }
    )
  );
};

/** A signed-in person's held actions, over `/rpc`. */
export class PendingActionsRpc
  extends CoreRpcTarget
  implements PendingActionsApi
{
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(): Promise<PendingAction[]> {
    return await withPerson(this.#check, async (person) => {
      if (person.staff) {
        return [];
      }
      const waiting = await this.#env.CONNECT.listPendingActions(
        await personOf(this.#env, person)
      );
      return await withRestricted(this.#env, person.userId, waiting);
    });
  }

  async confirm(id: string, inputHash: string): Promise<ConnectResult> {
    return await withPerson(
      this.#check,
      async (person) =>
        await confirmPendingAction(this.#env, person, id, inputHash)
    );
  }

  async decline(id: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await declinePendingAction(this.#env, person, id);
    });
  }
}
