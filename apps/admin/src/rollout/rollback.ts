/**
 * Rolling a client back from a rollout: its one operation taken back to
 * the release it last ran whole before the rollout reached it (`previous`
 * on its target, src/rollout/targets.ts), and run again for it
 * (src/hosting/operation.ts). Every step of the operation runs, onto the
 * same stable scripts and the client's own resources, with the client's
 * secrets as they are now: a rollback never brings back a key that was
 * rotated or replaced, so no check of what the previous versions ran is
 * needed. What does stop it, before it claims the client:
 * - the release before's code doesn't work with what the client runs, or
 *   with its databases as the rollout's migrations left them
 *   (`incompatible`, `schema_incompatible`, src/deploy/compatibility.ts);
 * - the rollout's release added a Durable Object migration, which a script
 *   never goes back past (`rollback_past_migration`);
 * - something other than the rollout's release or the one before runs
 *   now (`superseded`);
 * - a secrets rollout ran the same release, so there's nothing to go back
 *   to that keeps the secrets current (`nothing_to_roll_back`).
 *
 * A rollback is a runner like the others (src/runners.ts): a Workflow
 * instance, `RollbackClient`, that claims the client, taking it from the
 * rollout it rolls back even while that rollout is running its operation:
 * the rollout's next check finds it lost the client and changes nothing
 * more (`runner_replaced`), and the operation it left running is
 * superseded by the rollback's. Its operation's probe passes before the
 * client's hostname moves, as for any release. Rolling a client back stops
 * its rollout, and ends its run while it deploys no client (as when it
 * waits for approval).
 */
import { log } from "@grasp-os/shared/log";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { and, eq, inArray } from "drizzle-orm";

import type { Staff } from "../access.ts";
import { actIfChanged, adminDatabase } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import {
  clientProvisions,
  clientRuns,
  clientWorkers,
  rollouts,
  rolloutTargets,
} from "../db/schema.ts";
import {
  appliedSchema,
  currentReleases,
  incompatibility,
} from "../deploy/compatibility.ts";
import {
  activityKeys,
  clientDomain,
  deployContext,
} from "../deploy/context.ts";
import { errorCode } from "../deploy/deploy.ts";
import { importedManifest } from "../deploy/release.ts";
import { deployOrder } from "../deploy/versions.ts";
import { InventoryError } from "../hosting/inventory.ts";
import {
  assertCanRollBack,
  ProvisionOperationError,
  runClientProvision,
  settledSends,
  startClientRelease,
  startedAs,
} from "../hosting/operation.ts";
import {
  claimRun,
  currentRun,
  hasEnded,
  instanceStatus,
  releaseRun,
  stillHolds,
} from "../runners.ts";
import type { HeldClient } from "../runners.ts";
import {
  deployStepConfig,
  guarded,
  isEngineAbort,
  quickStep,
  stop,
  stopReason,
} from "../workflow-steps.ts";
import { tellCore } from "./activity.ts";
import { RolloutError } from "./errors.ts";
import { parsePrevious, targetClient } from "./targets.ts";

/**
 * A target's statuses once a step of the rollout's started on it: what can
 * be rolled back (`check`).
 */
const reached = ["deploying", "done", "failed", "stopped"] as const;

/** Whether a target in `status` was reached by its rollout. */
const wasReached = (status: string): boolean =>
  reached.some((each) => each === status);

/** A new rollback's runner id: its Workflow instance's. */
const newRollbackId = (): string =>
  `rollback-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

/**
 * Throws unless release `back`'s code works with client `clientId` as the
 * rollout's release `from` left it: with what it runs, its Workers taken
 * back one at a time in the order its operation uploads them (connect,
 * then core, which binds it), and on its databases' schemas
 * (src/deploy/compatibility.ts); and unless a script of it ran a Durable
 * Object migration `back` doesn't have, as each was seen
 * (`assertCanRollBack`).
 */
const assertCanGoBack = async (
  db: AdminDatabase,
  clientId: string,
  from: string,
  back: string
): Promise<void> => {
  const [before, rolledOut] = await Promise.all([
    importedManifest(db, back),
    importedManifest(db, from),
  ]);
  if (before === null) {
    throw new RolloutError(
      "release_not_imported",
      `Release ${back} isn't imported`
    );
  }
  try {
    await assertCanRollBack(db, clientId, back);
  } catch (error) {
    if (
      error instanceof ProvisionOperationError &&
      error.code === "rollback_past_migration"
    ) {
      throw new RolloutError("rollback_past_migration", error.message);
    }
    throw error;
  }
  const current = await currentReleases(db, clientId);
  const apps = deployOrder(before.workers);
  for (const app of apps) {
    current.set(app, rolledOut);
  }
  const refused = incompatibility(
    current,
    before,
    apps,
    await appliedSchema(db, clientId)
  );
  if (refused !== null) {
    throw new RolloutError(
      refused.code === "schema_incompatible"
        ? "schema_incompatible"
        : "incompatible",
      `${clientId} can't go back to ${back}: ${refused.message}`
    );
  }
};

/**
 * The release client `clientId`'s rollback from rollout `rolloutId` takes
 * it back to, once everything that stops it is ruled out (see the header).
 * Refused (`nothing_to_roll_back`) when the rollout didn't reach it or
 * recorded nothing to go back to, or it's no placed active client.
 */
const check = async (
  db: AdminDatabase,
  rolloutId: string,
  clientId: string
): Promise<string> => {
  const [target] = await db
    .select({
      status: rolloutTargets.status,
      deployId: rolloutTargets.deployId,
      change: rolloutTargets.change,
      rollbackChange: rolloutTargets.rollbackChange,
      previous: rolloutTargets.previous,
      releaseId: rollouts.releaseId,
    })
    .from(rolloutTargets)
    .innerJoin(rollouts, eq(rollouts.id, rolloutTargets.rolloutId))
    .where(
      and(
        eq(rolloutTargets.rolloutId, rolloutId),
        eq(rolloutTargets.clientId, clientId)
      )
    );
  const previous = parsePrevious(target?.previous ?? null);
  const back = previous?.release ?? null;
  const client = await targetClient(db, clientId);
  const operation = client?.operation ?? null;
  if (
    target === undefined ||
    back === null ||
    target.deployId === null ||
    !wasReached(target.status) ||
    operation === null ||
    client?.status !== "active"
  ) {
    throw new RolloutError(
      "nothing_to_roll_back",
      `Rollout ${rolloutId} has nothing of ${clientId}'s to roll back`
    );
  }
  // A secrets rollout ran the release the client ran: going back to it
  // with the secrets current changes nothing.
  const rolledOut = target.releaseId ?? back;
  if (rolledOut === back) {
    throw new RolloutError(
      "nothing_to_roll_back",
      `${clientId} ran ${back} before rollout ${rolloutId} too`
    );
  }
  // Only while the change the rollout started is still the client's
  // latest: any release, run again or rollback since raised it, whatever
  // release it went to. Or the latest is this rollback's own, which
  // failed: retried, it goes on with that change (`runBack`).
  const rollbacksOwn =
    target.rollbackChange !== null &&
    operation.change === target.rollbackChange;
  if (
    !rollbacksOwn &&
    (target.change === null || operation.change !== target.change)
  ) {
    throw new RolloutError(
      "superseded",
      `${clientId} changed after rollout ${rolloutId}`
    );
  }
  await assertCanGoBack(db, clientId, rolledOut, back);
  return back;
};

/** Releases client `clientId` from runner `runId`, logging a failure to. */
const releaseQuietly = async (
  db: AdminDatabase,
  clientId: string,
  runId: string
): Promise<void> => {
  try {
    await releaseRun(db, clientId, runId);
  } catch (releaseError) {
    log.error("rollback.release_failed", {
      clientId,
      error: errorCode(releaseError),
    });
  }
};

/** What a rollback's run is started with: identifiers only. */
export interface RollbackParams {
  rolloutId: string;
  clientId: string;
  /** The staff member who asked for it. */
  startedBy: Staff;
}

/**
 * Rolls client `clientId` back from rollout `rolloutId`, as `staff`:
 * claims the client, audited as `rollout.rollback`, and starts the
 * rollback's run (`RollbackClient`), whose id it returns. Refused when the
 * client can't be (`check`), and while a runner other than this rollout
 * has it (`client_busy`).
 */
export const rollbackClient = async (
  env: Env,
  staff: Staff,
  rolloutId: string,
  clientId: string
): Promise<string> => {
  const db = adminDatabase(env.DB);
  const back = await check(db, rolloutId, clientId);
  const busy = new RolloutError(
    "client_busy",
    `${clientId} has another runner`
  );
  const run = await currentRun(env, clientId);
  if (run !== null && run.runId !== rolloutId && !hasEnded(run.status)) {
    throw busy;
  }
  const runId = await claimRun(
    db,
    staff,
    clientId,
    run?.runId ?? null,
    {
      action: "rollout.rollback",
      clientId,
      target: rolloutId,
      detail: { release: back },
    },
    { kind: "rollback", runId: newRollbackId() }
  );
  if (runId === undefined) {
    throw busy;
  }
  const params: RollbackParams = {
    rolloutId,
    clientId,
    startedBy: { email: staff.email, sub: staff.sub },
  };
  try {
    await env.ROLLBACK_CLIENT.create({ id: runId, params });
  } catch (error) {
    // Its run never started: the client is free again, the error stands.
    await releaseQuietly(db, clientId, runId);
    throw error;
  }
  return runId;
};

/**
 * Takes client `held.clientId`'s operation back to release `back` as
 * rollback `held`, and runs it, by what its operation recorded first, so
 * a retry after any part of it does the rest and nothing twice:
 * - the rollout's change still the latest: once any call the rollout's
 *   run sent to the client's Workers has landed (`settledSends`), the
 *   rollout's operation, if still running, is stopped (the rollout lost
 *   the client), and the rollback started, a change of its own,
 *   recorded on the target in the batch that starts it;
 * - its own change, as recorded, still the latest on `back`: already
 *   started, it's run (resumed, or nothing left to do once done), a
 *   rollback that failed and is asked again included;
 * - anything else changed it since: refused (`superseded`).
 * The operation's own failures and the inventory's stop the step at once.
 */
const runBack = async (
  env: Env,
  params: RollbackParams,
  held: HeldClient,
  back: string
): Promise<void> => {
  const db = adminDatabase(env.DB);
  const [target] = await db
    .select({
      change: rolloutTargets.change,
      rollbackChange: rolloutTargets.rollbackChange,
    })
    .from(rolloutTargets)
    .where(
      and(
        eq(rolloutTargets.rolloutId, params.rolloutId),
        eq(rolloutTargets.clientId, held.clientId)
      )
    );
  const operation = await db
    .select({
      releaseId: clientProvisions.releaseId,
      change: clientProvisions.change,
    })
    .from(clientProvisions)
    .where(eq(clientProvisions.clientId, held.clientId))
    .get();
  const rolloutsChange = target?.change ?? null;
  // Its own change, recorded on the target in the batch that started it.
  const rollbacksChange = target?.rollbackChange ?? null;
  const started =
    rollbacksChange !== null &&
    operation?.change === rollbacksChange &&
    operation.releaseId === back;
  if (!started && operation?.change !== rolloutsChange) {
    throw stop(
      "superseded",
      `${held.clientId} changed after rollout ${params.rolloutId}`
    );
  }
  try {
    const context = await deployContext(env);
    if (!started) {
      // A call the rollout's run sent before the rollback took the client
      // can't be stopped, only waited for: it lands before the rollback's
      // own, so none lands after them and undoes them.
      await settledSends(context, held.clientId, rolloutsChange ?? -1);
      await db
        .update(clientProvisions)
        .set({ status: "failed", error: "rolled_back", updatedAt: new Date() })
        .where(
          and(
            eq(clientProvisions.clientId, held.clientId),
            eq(clientProvisions.status, "running"),
            eq(clientProvisions.change, rolloutsChange ?? -1),
            stillHolds(held)
          )
        );
      await startClientRelease(db, params.startedBy, held, {
        releaseId: back,
        rollback: true,
        alongside: (begun) => [
          db
            .update(rolloutTargets)
            .set({ rollbackChange: begun.change, updatedAt: new Date() })
            .where(
              and(
                eq(rolloutTargets.rolloutId, params.rolloutId),
                eq(rolloutTargets.clientId, held.clientId),
                stillHolds(held),
                startedAs(begun)
              )
            ),
        ],
      });
    }
    // A rollback isn't rolled back on its own: staff see it fail.
    await runClientProvision(context, held, {
      rollBackOnProbe: false,
    });
  } catch (error) {
    if (
      error instanceof ProvisionOperationError ||
      error instanceof InventoryError
    ) {
      throw stop(error.code, error.message);
    }
    throw error;
  }
};

/**
 * Records client `clientId`'s rollback from rollout `rolloutId`, audited
 * once: its target `rolled_back` and the rollout stopped (`cancelled`). Its
 * operation, done on the release before, released the client already.
 */
const recordRollback = async (
  db: AdminDatabase,
  params: RollbackParams,
  back: string
): Promise<void> => {
  const { rolloutId, clientId, startedBy } = params;
  const now = new Date();
  await actIfChanged(
    db,
    startedBy,
    db
      .update(rolloutTargets)
      .set({ status: "rolled_back", error: null, updatedAt: now })
      .where(
        and(
          eq(rolloutTargets.rolloutId, rolloutId),
          eq(rolloutTargets.clientId, clientId),
          inArray(rolloutTargets.status, [...reached])
        )
      ),
    {
      action: "rollout.client_rolled_back",
      clientId,
      target: rolloutId,
      detail: { release: back },
    },
    [
      db
        .update(rollouts)
        .set({ status: "cancelled", updatedAt: now })
        .where(
          and(
            eq(rollouts.id, rolloutId),
            inArray(rollouts.status, ["running", "waiting"])
          )
        ),
    ]
  );
};

/**
 * Resumes cancelled rollout `rolloutId`'s run if staff paused it (or asked
 * to), so it goes on to its next step, where it finds the rollout
 * cancelled and ends the client it's on by the cancellation rule
 * (src/rollout/workflow.ts). Paused, it would never get there, and would
 * hold the client and leave the rollout open. Whichever of a pause and a
 * rollback's cancel lands second calls it, so the run can't stay paused.
 */
export const goOnToStop = async (
  env: Env,
  rolloutId: string,
  createdAt: Date
): Promise<void> => {
  const { instance, status } = await instanceStatus(
    env.ROLLOUT,
    rolloutId,
    createdAt
  );
  if (
    instance !== null &&
    (status === "paused" || status === "waitingForPause")
  ) {
    await instance.resume();
  }
};

/**
 * Ends rollout `rolloutId`'s run if the rollout is cancelled, its run
 * hasn't ended, and it's working on none of its clients: none deploying,
 * and none claimed, as while it waits for approval, when it would only
 * idle until its wait timed out. A run working on a client is left to
 * stop by itself at its next step (src/rollout/workflow.ts), releasing the
 * client; one staff paused would never reach that step, so it's resumed
 * to (`goOnToStop`).
 */
const endIdleRollout = async (env: Env, rolloutId: string): Promise<void> => {
  const db = adminDatabase(env.DB);
  const [rollout] = await db
    .select({ status: rollouts.status, createdAt: rollouts.createdAt })
    .from(rollouts)
    .where(eq(rollouts.id, rolloutId));
  const [deploying] = await db
    .select({ clientId: rolloutTargets.clientId })
    .from(rolloutTargets)
    .where(
      and(
        eq(rolloutTargets.rolloutId, rolloutId),
        eq(rolloutTargets.status, "deploying")
      )
    )
    .limit(1);
  const [claimed] = await db
    .select({ clientId: clientRuns.clientId })
    .from(rolloutTargets)
    .innerJoin(clientRuns, eq(clientRuns.clientId, rolloutTargets.clientId))
    .where(
      and(
        eq(rolloutTargets.rolloutId, rolloutId),
        eq(clientRuns.runId, rolloutId)
      )
    )
    .limit(1);
  if (rollout?.status !== "cancelled") {
    return;
  }
  if (deploying !== undefined || claimed !== undefined) {
    await goOnToStop(env, rolloutId, rollout.createdAt);
    return;
  }
  const { instance, status } = await instanceStatus(
    env.ROLLOUT,
    rolloutId,
    rollout.createdAt
  );
  if (instance !== null && !hasEnded(status)) {
    await instance.terminate();
  }
};

/** The core version client `clientId` runs, as its operation's probe recorded it. */
const coreVersionOf = async (
  db: AdminDatabase,
  clientId: string
): Promise<string | null> => {
  const row = await db
    .select({ versionId: clientWorkers.versionId })
    .from(clientWorkers)
    .where(
      and(
        eq(clientWorkers.clientId, clientId),
        eq(clientWorkers.worker, "core")
      )
    )
    .get();
  return row?.versionId ?? null;
};

/**
 * Rolling a client back, as a Cloudflare Workflow: an instance per
 * rollback, a runner of the client (src/runners.ts). It checks the client
 * can go back, runs its operation for the release before (`runBack`),
 * records it, ends the rollout's run while it deploys no client
 * (`endIdleRollout`), and tells the client's core for its Activity. A
 * rollback that fails, or lost the client, releases it (if it still holds
 * it) and records nothing.
 */
export class RollbackClient extends WorkflowEntrypoint<Env, RollbackParams> {
  override async run(
    event: WorkflowEvent<RollbackParams>,
    step: WorkflowStep
  ): Promise<void> {
    const { payload: params } = event;
    const { rolloutId, clientId } = params;
    const held: HeldClient = { clientId, runId: event.instanceId };
    const db = adminDatabase(this.env.DB);
    try {
      const back = await step.do(
        "plan",
        quickStep,
        guarded(async () => await check(db, rolloutId, clientId))
      );
      await step.do(
        "run",
        deployStepConfig,
        guarded(async () => {
          await runBack(this.env, params, held, back);
        })
      );
      await step.do(
        "record",
        quickStep,
        guarded(async () => {
          await recordRollback(db, params, back);
        })
      );
      await step.do(
        "end the rollout's run",
        quickStep,
        guarded(async () => {
          await endIdleRollout(this.env, rolloutId);
        })
      );
      // In the client's own Activity too, as the platform update it is:
      // told once it's done, of the core version live, and never failing
      // it (`tellCore`).
      await step.do("tell core", quickStep, async () => {
        await tellCore(
          {
            db,
            secrets: async () => await activityKeys(this.env),
            router: {
              hosts: this.env.ROUTER_HOSTS,
              domain: clientDomain(this.env),
              dispatcher: this.env.DISPATCHER,
            },
          },
          clientId,
          await coreVersionOf(db, clientId),
          {
            by: params.startedBy.email,
            what: "rollback",
            release: back,
            at: new Date(event.timestamp).toISOString(),
          }
        );
      });
    } catch (error) {
      if (isEngineAbort(error)) {
        throw error;
      }
      await step.do("release", quickStep, async () => {
        log.warn("rollback.stopped", { clientId, error: stopReason(error) });
        await releaseQuietly(db, clientId, held.runId);
      });
      throw error;
    }
  }
}

/** A client's rollback in a ring's: started, or why it was refused. */
export interface RingRollback {
  clientId: string;
  /** The rollback's run, once started. */
  runId: string | null;
  refused: string | null;
}

/**
 * Rolls back, as `staff`, every client of rollout `rolloutId`'s ring
 * `ring` the rollout reached (`rollbackClient`); a client that's refused
 * doesn't stop the others.
 */
export const rollbackRing = async (
  env: Env,
  staff: Staff,
  rolloutId: string,
  ring: number
): Promise<RingRollback[]> => {
  const db = adminDatabase(env.DB);
  const targets = await db
    .select({ clientId: rolloutTargets.clientId })
    .from(rolloutTargets)
    .where(
      and(
        eq(rolloutTargets.rolloutId, rolloutId),
        eq(rolloutTargets.ring, ring),
        inArray(rolloutTargets.status, [...reached])
      )
    );
  const results: RingRollback[] = [];
  for (const { clientId } of targets) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one client at a time
      const runId = await rollbackClient(env, staff, rolloutId, clientId);
      results.push({ clientId, runId, refused: null });
    } catch (error) {
      if (!(error instanceof RolloutError)) {
        throw error;
      }
      results.push({ clientId, runId: null, refused: error.code });
    }
  }
  return results;
};

/** How long staff's rollback waits for its run, and how often it looks. */
const rollbackWaitMs = 60_000;
const rollbackPollMs = 500;

/** A rollback run's statuses once it ended without finishing. */
const failedRuns: ReadonlySet<string> = new Set(["errored", "terminated"]);

/**
 * Waits for rollback run `runId` to end, up to `rollbackWaitMs`, and
 * returns whether it failed: errored, or ended before it finished. One
 * still going after that isn't failed, and the page shows it as it is.
 */
const rollbackFailed = async (env: Env, runId: string): Promise<boolean> => {
  const instance = await env.ROLLBACK_CLIENT.get(runId);
  for (let waited = 0; waited < rollbackWaitMs; waited += rollbackPollMs) {
    // oxlint-disable-next-line no-await-in-loop -- polled until it ends
    const { status } = await instance.status();
    if (hasEnded(status)) {
      return failedRuns.has(status);
    }
    // oxlint-disable-next-line no-await-in-loop -- polled until it ends
    await scheduler.wait(rollbackPollMs);
  }
  return false;
};

/**
 * Rolls client `clientId` back from rollout `rolloutId`, as `staff`
 * (`rollbackClient`), and waits for its run, so staff read what it did.
 * Refused as `rollbackClient` refuses, and when its run failed
 * (`rollback_failed`).
 */
export const rollbackClientAndWait = async (
  env: Env,
  staff: Staff,
  rolloutId: string,
  clientId: string
): Promise<string> => {
  const runId = await rollbackClient(env, staff, rolloutId, clientId);
  if (await rollbackFailed(env, runId)) {
    throw new RolloutError(
      "rollback_failed",
      `The rollback of ${clientId} didn't finish`
    );
  }
  return runId;
};

/**
 * Rolls ring `ring` of rollout `rolloutId` back, as `staff`
 * (`rollbackRing`), and waits for each client's run: one whose run failed
 * is listed as refused (`rollback_failed`), like one refused to begin
 * with.
 */
export const rollbackRingAndWait = async (
  env: Env,
  staff: Staff,
  rolloutId: string,
  ring: number
): Promise<RingRollback[]> => {
  const results = await rollbackRing(env, staff, rolloutId, ring);
  return await Promise.all(
    results.map(async (result) =>
      result.runId !== null && (await rollbackFailed(env, result.runId))
        ? { ...result, refused: "rollback_failed" }
        : result
    )
  );
};
