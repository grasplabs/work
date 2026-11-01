/**
 * Rolling a release out to clients, as a run on Workerflow
 * (src/workflow-runs.ts): one per rollout, its id the rollout's. It reaches its first ring
 * (ring 0, Grasp's own deployments) first, then waits for one staff
 * member's approval (src/rollout/control.ts) and rolls out to the fleet,
 * every ring after in turn, with no approval between them (spec 40.1).
 * It deploys its first ring's clients itself, one at a time. Each fleet
 * client is deployed by a run of its own (`rolloutClientRun`,
 * src/rollout/fleet-client.ts), at most `fleetConcurrency` at once, ring
 * by ring: "all clients" is one approved operation, not a burst of API
 * requests, and the run's steps grow by a few per fleet client rather
 * than by every step of its deploy.
 *
 * Each client is deployed gradually: its resources and migrations first,
 * then each Worker in turn (connect before core, which binds it) uploaded
 * as a new version, sent a share of the traffic that grows by stages with
 * a pause at each (`gradualStages`), then all of it; then the smoke check
 * and the router's map (src/deploy/deploy.ts). A Worker's first upload,
 * or one with Durable Object migrations, goes live at once, and so does
 * every Worker whose new version has other secrets than the one before
 * (a rotation still to go live, or shared secrets changed in Secrets
 * Store): versions with different secrets can't share traffic. So does a
 * client on the release already, deployed again for a config change
 * (src/clients/settings.ts): the same code, so nothing to roll out gradually.
 *
 * A secrets rollout (no release) takes the shared secrets in Secrets
 * Store now to clients without a code release: it deploys each client's
 * own release again, as a `secrets` deploy, every Worker live at once.
 * Everything else is a release rollout's: claims, rings, approvals,
 * cancelling, rollbacks and audit.
 *
 * One runner per client: the rollout claims each client in D1 before it
 * deploys it and releases it after (src/runners.ts), so it never
 * deploys beside the client's provisioning run or another rollout; a
 * client with another runner is tried again for a while, then the
 * rollout stops. Before and after each change it makes live it checks
 * that it still holds the client (`runner_replaced` otherwise): a
 * rollback takes the client from it (src/rollout/rollback.ts), and once
 * it has lost the client it never touches its traffic again: the
 * rollback, as its holder, puts right a change of the rollout's that
 * landed late. A fleet client's child claims it in the rollout's name
 * (the rollout's id as its runner), so a rollback takes it from the child
 * as it would from the rollout, and the claim is held while the rollout's
 * run is: which never ends while a child it started is still going.
 *
 * Staff pause and resume the run (it stops after the step it's in), and
 * stop the rollout by rolling a client back or, between rings, by
 * cancelling it (src/rollout/control.ts). A paused rollout starts no
 * fleet client; one a child is deploying already is finished, or stopped
 * by a rollback, so a pause never leaves a fleet client's traffic split
 * for as long as staff take to resume (`deployFleet`). One rule stops
 * the run once the rollout is cancelled, and a child once its rollout
 * failed (its run is gone, `stoppedAs`): every step of a client checks
 * first, in the rollout's run and in a child alike (`clientStep`), and
 * ends the client there, `skipped` while nothing of it has started and
 * `stopped` once anything has (`endIfCancelled`). A
 * client pinned to another release is skipped.
 *
 * Every step can run again: a claim the rollout holds already is kept, a
 * deploy it started is resumed, and each deploy phase finds what it made
 * before. A failure a retry can't fix (src/workflow-steps.ts) in the
 * first ring stops the rollout where it is, recorded on the rollout and
 * its client, so the fleet is never reached. In the fleet it ends only
 * its client, recorded on its target, and the others go on; the rollout
 * ends failed once it reached them all. Either way it's for staff to act
 * on: nothing rolls back on its own.
 */
import { log } from "@grasp-os/shared/log";
import type {
  WorkflowDefinition,
  WorkflowStep,
} from "@grasp-os/workerflow/contracts";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";

import type { Staff } from "../access.ts";
import { actIfChanged, adminDatabase } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import {
  clientProvisions,
  releases,
  rollouts,
  rolloutTargets,
} from "../db/schema.ts";
import { deployContext } from "../deploy/context.ts";
import { errorCode } from "../deploy/errors.ts";
import type { DeployErrorCode } from "../deploy/errors.ts";
import { InventoryError } from "../hosting/inventory.ts";
import {
  ProvisionOperationError,
  runClientProvision,
  startClientRelease,
  startedAs,
} from "../hosting/operation.ts";
import type { ChangeKind } from "../hosting/operation.ts";
import {
  claimRun,
  currentRun,
  hasEnded,
  instanceStatus,
  releaseRun,
  stillHolds,
  takeAttempt,
} from "../runners.ts";
import { adminWorkflow, adminWorkflows } from "../workflow-runs.ts";
import {
  guarded,
  quickStep,
  stop,
  stopReason,
  deployStepConfig,
} from "../workflow-steps.ts";
import { ClientEndedError } from "./client-ended.ts";
import {
  parsePrevious,
  previousRunOf,
  ringsOf,
  runningRelease,
  skipReason,
  targetClient,
} from "./targets.ts";
import type { TargetClient } from "./targets.ts";

/** What a rollout's run is started with: identifiers only, since its journal keeps them. */
export interface RolloutParams {
  rolloutId: string;
  /**
   * The release it rolls out; null for a secrets rollout, which deploys
   * each client's own release again with the secrets in Secrets Store now.
   */
  releaseId: string | null;
  /** The staff member who started it. */
  startedBy: Staff;
}

/** `RolloutParams`, as a run reads its payload back. */
export const rolloutParamsSchema = z.object({
  rolloutId: z.string(),
  releaseId: z.string().nullable(),
  startedBy: z.object({ email: z.string(), sub: z.string() }),
});

/** The event staff send to retry a rollout's failed fleet clients, as round `round`. */
export const retryEvent = (round: number): string => `retry-${round}`;

/** The event staff send to approve the fleet, from its first ring, `ring`. */
export const approvalEvent = (ring: number): string => `approve-ring-${ring}`;

/**
 * The most steps a rollout's run may be expected to take. Workerflow sets
 * no limit of its own, but a run's journal and every activation's replay
 * grow with its steps: a synthetic run of 1,000 steps on the admin's host
 * takes seconds (test/workflow-budget.test.ts). A rollout over it is
 * refused when it starts (src/rollout/control.ts). A fleet client's deploy
 * takes steps of its own run, not of the rollout's (`rolloutClientRun`).
 */
export const stepBudget = 900;

/**
 * The steps of one client deployed by the rollout's run itself, however
 * many Workers its release has: its claim, its operation's run, done, and
 * a failure recorded.
 */
const clientSteps = (_apps: number): number => 4;

/**
 * The steps of the rollout's run a fleet client takes, however many
 * Workers it has: the wait its child's end wakes and the check that
 * follows, and as many again for a wait that times out
 * (`fleetWaitTimeout`) while it deploys.
 */
const fleetClientSteps = 4;

/** How many clients rollout `rolloutSteps` counts: its first ring's, and the fleet's after it. */
export interface RolloutSize {
  /** Its rings, the first included. */
  rings: number;
  /** The clients of its first ring, which the run deploys itself. */
  internal: number;
  /** The clients of every ring after, each deployed by a child. */
  fleet: number;
  /** The Workers of its release. */
  apps: number;
}

/**
 * The steps a rollout's run takes: its own (the targets, the check for
 * failed clients, done, a stop recorded), three for the fleet's approval
 * (waiting, approved, the wait), one for each ring of the fleet after its
 * first, and the first check of each fleet ring (`deployFleet`); for each
 * client of its first ring its claim, prepare, finish and done, or its
 * failure, with each Worker's upload, a traffic change and a hold per
 * stage, and all of its traffic; and `fleetClientSteps` for each fleet
 * client. A step's retries are the same step.
 */
export const rolloutSteps = ({
  rings,
  internal,
  fleet,
  apps,
}: RolloutSize): number =>
  4 +
  (rings > 1 ? 3 + (rings - 2) + (rings - 1) : 0) +
  internal * clientSteps(apps) +
  fleet * fleetClientSteps;

/**
 * The steps a retry of `clientCount` failed fleet clients adds: the wait
 * for it (waiting, asked, the wait, its targets), its first check, and
 * each client's.
 */
export const retrySteps = (clientCount: number): number =>
  5 + clientCount * fleetClientSteps;

/**
 * How many fleet clients a rollout deploys at once, each in a child of
 * its own. Cloudflare's API takes 1,200 requests per 5 minutes for one
 * token, and the deployer's token is the same on every client's account.
 * One client's deploy makes about 60 to 100 calls (src/deploy/deploy.ts):
 * its resources and migrations about 20, and per Worker about 20 more to
 * check what runs, upload its assets and version, move its traffic by
 * stages and make it live; with the router and retries on top. Moved by
 * stages, a deploy takes over 20 minutes (`gradualStages`); all at once
 * (a secrets rollout, a settings change) about 3. So 4 at once is about
 * 600 calls in 5 minutes at worst, half the limit, leaving room for
 * retries and the rest of the admin's calls. A deliberately
 * conservative default until GRA-389 measures the real limits; a 429
 * still waits out its Retry-After, then retries its step
 * (src/cloudflare/api.ts, src/workflow-steps.ts).
 */
export const fleetConcurrency = 4;

/**
 * The event each fleet client's child sends the rollout's run when it
 * ends, which wakes it to start the next (`deployFleet`).
 */
export const clientEndedEvent = "client-ended";

/**
 * How long the rollout's run waits for a child's end before it checks on
 * its children anyway: a child terminated from the dashboard, or whose
 * event was lost, ends without telling it.
 */
const fleetWaitTimeout = "10 minutes";

/** How long a rollout waits for the fleet's approval before it stops. */
const approvalTimeout = "30 days";

/**
 * Claiming a client: tried again for a while (about half an hour) when
 * another runner has it, such as its provisioning run finishing.
 */
const claimStep = {
  retries: { limit: 5, delay: "1 minute", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

/**
 * What the claim step leaves for the rest: identifiers only, the
 * client's operation the rollout runs for its release among them.
 */
type Claimed =
  | { state: "skipped" }
  | { state: "cancelled" }
  | { state: "claimed"; operationId: string };

/** How rollout `rolloutId` ended while still deploying clients. */
type StoppedAs = "cancelled" | "failed";

/**
 * How rollout `rolloutId` was stopped, if it was: `cancelled` by staff (a
 * rollback, or a cancel), or `failed` once its run stopped (it recorded
 * its own failure, or staff found it ended, src/rollout/control.ts). A
 * failed rollout's run is gone, so no child of it goes on deploying.
 */
const stoppedAs = async (
  db: AdminDatabase,
  rolloutId: string
): Promise<StoppedAs | null> => {
  const [row] = await db
    .select({ status: rollouts.status })
    .from(rollouts)
    .where(eq(rollouts.id, rolloutId));
  return row?.status === "cancelled" || row?.status === "failed"
    ? row.status
    : null;
};

/** Rollout `rolloutId`'s target client `clientId`. */
const targetWhere = (rolloutId: string, clientId: string) =>
  and(
    eq(rolloutTargets.rolloutId, rolloutId),
    eq(rolloutTargets.clientId, clientId)
  );

/**
 * The client's operation `operationId` marked failed (`cancelled`) if it's
 * still running the change the rollout started (`change`) and the rollout
 * still holds the client, as a statement to batch: a cancelled rollout
 * never finishes it, and never touches a change another runner made since.
 * Started again, it resumes (src/hosting/operation.ts).
 */
const cancelDeploy = (
  db: AdminDatabase,
  held: { clientId: string; runId: string },
  { operationId, change }: { operationId: string; change: number }
) =>
  db
    .update(clientProvisions)
    .set({ status: "failed", error: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(clientProvisions.id, operationId),
        eq(clientProvisions.status, "running"),
        eq(clientProvisions.change, change),
        stillHolds(held)
      )
    );

/**
 * Marks client `clientId` skipped in the rollout for `reason`, audited
 * once, while nothing of it has started (`pending`), then releases it if
 * the rollout claimed it: one it never got to, or one it claimed and then
 * found the rollout cancelled before any step of it began (`cancelled`).
 * `following` goes in the same batch, before the release.
 */
const skipTarget = async (
  db: AdminDatabase,
  rolloutId: string,
  clientId: string,
  reason: string,
  following: ReturnType<typeof cancelDeploy>[] = []
): Promise<void> => {
  await actIfChanged(
    db,
    "system",
    db
      .update(rolloutTargets)
      .set({ status: "skipped", error: reason, updatedAt: new Date() })
      .where(
        and(
          targetWhere(rolloutId, clientId),
          eq(rolloutTargets.status, "pending")
        )
      ),
    {
      action: "rollout.client_skip",
      clientId,
      target: rolloutId,
      detail: { reason },
    },
    [...following, releaseRun(db, clientId, rolloutId)]
  );
};

/**
 * Ends the rollout's work on client `clientId` if the rollout was
 * stopped (`stoppedAs`), and returns whether it did: the one rule, checked at the start
 * of every step of a client (`clientStep`), a retry's too. What the target
 * ends as depends only on whether anything of the client started (its
 * prepare step marks it `deploying` before it begins, `markStarted`):
 * `skipped` while nothing has, `stopped` once a step has. A stopped
 * target counts as reached, so staff can roll it back if its traffic
 * moved (src/rollout/rollback.ts). Either way, audited once, its deploy
 * is cancelled and then the client released, in the same batch as its
 * end: never released before its end is recorded.
 */
const endIfCancelled = async (
  db: AdminDatabase,
  rolloutId: string,
  clientId: string
): Promise<boolean> => {
  const reason = await stoppedAs(db, rolloutId);
  if (reason === null) {
    return false;
  }
  const [target] = await db
    .select({
      status: rolloutTargets.status,
      deployId: rolloutTargets.deployId,
      change: rolloutTargets.change,
    })
    .from(rolloutTargets)
    .where(targetWhere(rolloutId, clientId));
  const operationId = target?.deployId ?? null;
  const change = target?.change ?? null;
  const cancelling =
    operationId === null || change === null
      ? []
      : [
          cancelDeploy(
            db,
            { clientId, runId: rolloutId },
            { operationId, change }
          ),
        ];
  if (target?.status !== "deploying") {
    // Nothing of it started, or its target ended already (a rollback of
    // this client): skipped only while pending, released either way.
    await skipTarget(db, rolloutId, clientId, reason, cancelling);
    return true;
  }
  await actIfChanged(
    db,
    "system",
    db
      .update(rolloutTargets)
      .set({ status: "stopped", error: reason, updatedAt: new Date() })
      .where(
        and(
          targetWhere(rolloutId, clientId),
          eq(rolloutTargets.status, "deploying")
        )
      ),
    {
      action: "rollout.client_stop",
      clientId,
      target: rolloutId,
      detail: { reason },
    },
    [...cancelling, releaseRun(db, clientId, rolloutId)]
  );
  return true;
};

/**
 * Marks client `clientId` started in the rollout (`deploying`) while the
 * rollout still holds it, before the first step that changes anything of
 * it does: from then on a cancel stops it rather than skips it
 * (`endIfCancelled`), a retry of that step included.
 */
const markStarted = async (
  db: AdminDatabase,
  rolloutId: string,
  clientId: string
): Promise<void> => {
  await db
    .update(rolloutTargets)
    .set({ status: "deploying", updatedAt: new Date() })
    .where(
      and(
        targetWhere(rolloutId, clientId),
        eq(rolloutTargets.status, "pending"),
        stillHolds({ clientId, runId: rolloutId })
      )
    );
};

/**
 * Claims client `clientId` for rollout `rolloutId`, audited, unless the
 * rollout holds it already (the step running again). One whose runner
 * hasn't ended is refused for now (`client_busy`), and the step retried.
 */
const claimClient = async (
  env: Env,
  db: AdminDatabase,
  rolloutId: string,
  clientId: string
): Promise<void> => {
  const run = await currentRun(env, clientId);
  if (run?.runId === rolloutId) {
    return;
  }
  if (run !== null && !hasEnded(run.status)) {
    throw new Error(`client_busy: ${clientId} has another runner`);
  }
  const won = await claimRun(
    db,
    "system",
    clientId,
    run?.runId ?? null,
    { action: "rollout.client_start", clientId, target: rolloutId },
    { kind: "rollout", runId: rolloutId }
  );
  if (won === undefined) {
    throw new Error(`client_busy: ${clientId} was just claimed`);
  }
};

/**
 * Why rollout `params` skips `client` before claiming it, or null: one no
 * longer active (`not_active`); for a release rollout, what `skipReason`
 * says. A secrets rollout skips no active client here: it deploys the
 * release the client runs, whatever it's pinned to, read once it holds
 * the client (`claimTarget`).
 */
const skipFor = async (
  db: AdminDatabase,
  params: RolloutParams,
  client: TargetClient
): Promise<string | null> => {
  if (client.status !== "active") {
    return "not_active";
  }
  if (params.releaseId === null) {
    return null;
  }
  const [release] = await db
    .select({ id: releases.id, builtAt: releases.builtAt })
    .from(releases)
    .where(eq(releases.id, params.releaseId));
  if (release === undefined) {
    throw stop(
      "release_not_imported",
      `Release ${params.releaseId} isn't imported`
    );
  }
  return skipReason(client, release);
};

/**
 * What a run again of the release `client` runs takes live: new secrets
 * for a secrets rollout; otherwise what waits for it, its settings, new
 * secrets, or both.
 */
const againKind = (params: RolloutParams, client: TargetClient): ChangeKind => {
  if (params.releaseId === null) {
    return "secrets";
  }
  if (client.configPending && client.rotationPending) {
    return "settings_and_secrets";
  }
  return client.rotationPending ? "secrets" : "settings";
};

/**
 * Starts the rollout's change on client `clientId`, which it holds: its
 * rollback target saved first, then the operation started for the
 * release (or run again), and the change it started recorded, each while
 * the rollout holds the client.
 */
const startTarget = async (
  db: AdminDatabase,
  params: RolloutParams,
  clientId: string,
  {
    status,
    change: recorded,
    client,
  }: { status: string; change: number | null; client: TargetClient }
): Promise<Claimed> => {
  const { rolloutId } = params;
  // Read again now the rollout holds the client: no other runner changes
  // what it runs from here. What skips it is decided again on this read:
  // a newer release or a pin that landed between the rollout's first read
  // and its claim skips it too, while nothing of it has started.
  const held = (await targetClient(db, clientId)) ?? client;
  const skip = await skipFor(db, params, held);
  if (skip !== null && status === "pending") {
    await skipTarget(db, rolloutId, clientId, skip);
    return { state: "skipped" };
  }
  const running = runningRelease(held);
  const release = params.releaseId ?? running;
  if (release === null) {
    await skipTarget(db, rolloutId, clientId, "no_release");
    return { state: "skipped" };
  }
  const holder = { clientId, runId: rolloutId };
  // What a rollback goes back to, read now the rollout holds the client,
  // and recorded with the change it starts and its operation in the batch
  // that starts it: a step that dies before it started nothing and
  // recorded nothing, so its retry reads it again, from whatever staff
  // took the client to since. Each record lands only with that start.
  const previousRun = JSON.stringify(previousRunOf(held));
  // As the client's runner: the rollout claimed it above. Run again, it
  // takes live what waits: new secrets, its settings, or both.
  const { operationId, change } = await startClientRelease(
    db,
    params.startedBy,
    holder,
    {
      releaseId: release,
      again: release === running,
      what: againKind(params, held),
      alongside: (started) => [
        db
          .update(rolloutTargets)
          .set({
            previous: previousRun,
            deployId: started.operationId,
            change: started.change,
            updatedAt: new Date(),
          })
          .where(
            and(
              targetWhere(rolloutId, clientId),
              stillHolds(holder),
              startedAs(started)
            )
          ),
      ],
    }
  );
  // Started already, as a retry finds it (`hasAlready`): recorded. The way
  // back saved is kept only for the change this target recorded; one
  // someone else started and the rollout takes over goes back to what
  // the client ran before that one, read now.
  await db
    .update(rolloutTargets)
    .set({
      deployId: operationId,
      change,
      previous:
        change === recorded
          ? sql`coalesce(${rolloutTargets.previous}, ${previousRun})`
          : previousRun,
      updatedAt: new Date(),
    })
    .where(and(targetWhere(rolloutId, clientId), stillHolds(holder)));
  return { state: "claimed", operationId };
};

/**
 * The operation `target` started, if its change is still client
 * `clientId`'s latest, read once the rollout holds the client; else null.
 * What the rollout read before claiming it, another runner could have
 * changed since (a release or an apply that finished in between); held,
 * nothing else changes it.
 */
const stillResumed = async (
  db: AdminDatabase,
  clientId: string,
  target: { deployId: string | null; change: number | null }
): Promise<string | null> => {
  if (target.deployId === null || target.change === null) {
    return null;
  }
  const held = await targetClient(db, clientId);
  return held?.operation?.change === target.change ? target.deployId : null;
};

/**
 * Claims client `clientId` for the rollout, unless it skips it, and
 * returns its operation, taken to the release the rollout runs. A client
 * it skips (`skipFor`) is skipped, audited, unless the rollout is
 * deploying it already; a rollout staff stopped goes no further, and ends
 * the client as every later step does (`endIfCancelled`). A secrets
 * rollout runs the release the client runs again, read once it holds the
 * client, and skips (`no_release`) one that runs no release whole. So does
 * a release rollout reaching a client on the release already, for the
 * settings or rotated secrets it waits for. What a rollback takes it back
 * to (`previous`) is settled once, before its operation starts on the
 * release: the release it last ran whole (`previousRunOf`). The target
 * names the operation and `previous` once it started; a try of the step
 * that runs again finds the operation on the release already, and goes on
 * (`startClientRelease`). The target stays `pending` until its first step
 * starts (`markStarted`).
 */
const claimTarget = async (
  env: Env,
  db: AdminDatabase,
  params: RolloutParams,
  clientId: string
): Promise<Claimed> => {
  const { rolloutId } = params;
  if (await endIfCancelled(db, rolloutId, clientId)) {
    return { state: "cancelled" };
  }
  const [target] = await db
    .select({
      status: rolloutTargets.status,
      deployId: rolloutTargets.deployId,
      change: rolloutTargets.change,
      previous: rolloutTargets.previous,
    })
    .from(rolloutTargets)
    .where(targetWhere(rolloutId, clientId));
  if (target === undefined || target.status === "skipped") {
    return { state: "skipped" };
  }
  const client = await targetClient(db, clientId);
  // The change it started, while still the client's latest, is resumed,
  // whatever the client runs now; one since (a rollback after a failed
  // probe, or staff's) makes it start afresh.
  const resumes =
    target.deployId !== null &&
    client?.operation?.change === target.change &&
    target.change !== null;
  let skip: string | null = null;
  if (client?.operation === null || client === undefined) {
    skip = "not_active";
  } else if (!resumes) {
    skip = await skipFor(db, params, client);
  }
  if (
    client?.operation === null ||
    client === undefined ||
    (skip !== null && target.status === "pending")
  ) {
    await skipTarget(db, rolloutId, clientId, skip ?? "not_active");
    return { state: "skipped" };
  }
  await claimClient(env, db, rolloutId, clientId);
  const resumed = resumes ? await stillResumed(db, clientId, target) : null;
  if (resumed !== null) {
    return { state: "claimed", operationId: resumed };
  }
  return await startTarget(db, params, clientId, {
    status: target.status,
    change: target.change,
    client,
  });
};

/**
 * Whether rollout `rolloutId` finished client `clientId`'s operation
 * already, its change (`change`) or the rollback of it after a failed
 * probe: an earlier try completed it, giving the claim back as an
 * operation does, and its result was lost before the engine kept it.
 */
const finishedBy = async (
  db: AdminDatabase,
  rolloutId: string,
  clientId: string,
  change: number | null | undefined
): Promise<boolean> => {
  const operation = await db
    .select({
      status: clientProvisions.status,
      runId: clientProvisions.runId,
      change: clientProvisions.change,
    })
    .from(clientProvisions)
    .where(eq(clientProvisions.clientId, clientId))
    .get();
  return (
    operation?.status === "done" &&
    operation.runId === rolloutId &&
    change !== null &&
    change !== undefined &&
    operation.change >= change
  );
};

/**
 * Runs client `clientId`'s operation as rollout `params.rolloutId`, this
 * attempt of it alone: a try that timed out goes on beside its retry, and
 * once the retry takes the client every check and write of the older one
 * is refused (`takeAttempt`).
 */
const operateAs = async (
  env: Env,
  params: RolloutParams,
  clientId: string,
  {
    attempt,
    attemptKey,
    rollBackOnProbe,
  }: { attempt: number; attemptKey: string; rollBackOnProbe: boolean }
): Promise<void> => {
  const db = adminDatabase(env.DB);
  const held = { clientId, runId: params.rolloutId, attempt, attemptKey };
  if (!(await takeAttempt(db, held))) {
    throw stop(
      "runner_replaced",
      `${held.runId} no longer holds ${clientId} for attempt ${attempt}`
    );
  }
  try {
    await runClientProvision(await deployContext(env), held, {
      rollBackOnProbe,
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
 * Runs client `clientId`'s operation as rollout `rolloutId`, its runner:
 * the operation stops (`runner_replaced`) as soon as the rollout no longer
 * holds the client, and writes nothing to its record after. Its own
 * failures and the inventory's stop the step at once, as they stop a
 * provisioning attempt (src/hosting/workflow.ts); anything else is
 * retried, resuming the operation.
 *
 * Taking the client to another release than it ran, a probe failing once
 * live rolls it back on its own (src/hosting/operation.ts), staff told;
 * the rollout then counts it failed (`release_rolled_back`). Running the
 * release it runs again (a secrets rollout) is never rolled back.
 */
const runOperation = async (
  env: Env,
  params: RolloutParams,
  clientId: string,
  { attempt, attemptKey }: { attempt: number; attemptKey: string }
): Promise<void> => {
  const db = adminDatabase(env.DB);
  const target = await db
    .select({
      previous: rolloutTargets.previous,
      change: rolloutTargets.change,
    })
    .from(rolloutTargets)
    .where(targetWhere(params.rolloutId, clientId))
    .get();
  const ran = parsePrevious(target?.previous ?? null)?.release ?? null;
  const toAnother = params.releaseId !== null && ran !== params.releaseId;
  if (!(await finishedBy(db, params.rolloutId, clientId, target?.change))) {
    await operateAs(env, params, clientId, {
      attempt,
      attemptKey,
      rollBackOnProbe: toAnother,
    });
  }
  const operation = await db
    .select({
      releaseId: clientProvisions.releaseId,
      change: clientProvisions.change,
    })
    .from(clientProvisions)
    .where(eq(clientProvisions.clientId, clientId))
    .get();
  // Rolled back on its own: a change after the rollout's, on another release.
  const rolledBack =
    operation?.change !== target?.change ||
    operation?.releaseId !== params.releaseId;
  if (toAnother && rolledBack) {
    throw stop(
      "release_rolled_back",
      `${clientId} failed its probe on ${params.releaseId ?? ""} and was rolled back`
    );
  }
};

/** Marks client `clientId` done in the rollout and releases it, audited once. */
const completeTarget = async (
  db: AdminDatabase,
  rolloutId: string,
  clientId: string
): Promise<void> => {
  await actIfChanged(
    db,
    "system",
    db
      .update(rolloutTargets)
      .set({ status: "done", error: null, updatedAt: new Date() })
      .where(
        and(
          eq(rolloutTargets.rolloutId, rolloutId),
          eq(rolloutTargets.clientId, clientId),
          eq(rolloutTargets.status, "deploying")
        )
      ),
    { action: "rollout.client_done", clientId, target: rolloutId },
    [releaseRun(db, clientId, rolloutId)]
  );
};

/** What a client's step leaves: its work's result, unless it ended the client. */
type ClientStepResult<T> = { ended: true } | { ended: false; result: T };

/**
 * Runs `work` as step `name` of the rollout's work on client `clientId`,
 * unless the rollout is cancelled: then the step ends the client instead
 * (`endIfCancelled`), a retry of the step as much as its first try, and
 * `ClientEndedError` is thrown to the run, which goes no further.
 */
const clientStep = async <T>(
  step: WorkflowStep,
  db: AdminDatabase,
  { rolloutId, clientId }: { rolloutId: string; clientId: string },
  name: string,
  config: typeof quickStep | typeof deployStepConfig,
  work: (attempted: { attempt: number; attemptKey: string }) => Promise<T>
): Promise<T> => {
  const done = await step.do(
    name,
    config,
    guarded(
      async ({ attempt, idempotencyKey }): Promise<ClientStepResult<T>> => {
        if (await endIfCancelled(db, rolloutId, clientId)) {
          return { ended: true };
        }
        return {
          ended: false,
          result: await work({ attempt, attemptKey: idempotencyKey }),
        };
      }
    )
  );
  if (done.ended) {
    throw new ClientEndedError(`${rolloutId} ended ${clientId}: cancelled`);
  }
  return done.result;
};

/**
 * The steps of client `clientId` once the rollout claimed it, each of
 * them `clientStep`, named after `label`: its operation run for the
 * release (marked started first), then done. A placed client's stable
 * scripts go live as each is uploaded, connect before core, which binds
 * it; the operation's probe passes before its hostname moves.
 */
const deployClaimed = async (
  env: Env,
  step: WorkflowStep,
  params: RolloutParams,
  clientId: string,
  label: string
): Promise<void> => {
  const { rolloutId } = params;
  const db = adminDatabase(env.DB);
  const client = { rolloutId, clientId };
  await clientStep(
    step,
    db,
    client,
    `${label} run`,
    deployStepConfig,
    async (attempted) => {
      await markStarted(db, rolloutId, clientId);
      await runOperation(env, params, clientId, attempted);
    }
  );
  await clientStep(step, db, client, `${label} done`, quickStep, async () => {
    await completeTarget(db, rolloutId, clientId);
  });
};

/**
 * Deploys client `clientId`, as steps of the rollout's run: claimed, its
 * resources and migrations, each Worker by stages, the smoke check and
 * the router, then released, its steps named after `label` (a retry's
 * differ from its first try's). Returns whether the rollout goes on: not
 * once staff stopped it.
 */
export const deployClient = async (
  env: Env,
  step: WorkflowStep,
  params: RolloutParams,
  clientId: string,
  label = clientId
): Promise<boolean> => {
  const db = adminDatabase(env.DB);
  const claimed = await step.do(
    `${label} claim`,
    claimStep,
    guarded(async () => await claimTarget(env, db, params, clientId))
  );
  if (claimed.state !== "claimed") {
    return claimed.state === "skipped";
  }
  try {
    await deployClaimed(env, step, params, clientId, label);
    return true;
  } catch (error) {
    if (error instanceof ClientEndedError) {
      return false;
    }
    throw error;
  }
};

/**
 * Where ring `ring` of rollout `rolloutId` is: approved (a staff member
 * moved the rollout on to it, src/rollout/control.ts), still waiting, or
 * the rollout cancelled.
 */
const approvalOf = async (
  db: AdminDatabase,
  rolloutId: string,
  ring: number
): Promise<"approved" | "waiting" | "cancelled"> => {
  const [row] = await db
    .select({ status: rollouts.status, ring: rollouts.ring })
    .from(rollouts)
    .where(eq(rollouts.id, rolloutId));
  if (row?.status === "cancelled") {
    return "cancelled";
  }
  return row?.status === "running" && row.ring === ring
    ? "approved"
    : "waiting";
};

/**
 * Waits after ring `after` for a staff member to approve ring `next`:
 * the rollout marked waiting, audited, then an approval recorded
 * already, or the event the approval sends (one per ring, so an approval
 * of one ring never passes for the next). Returns whether the rollout
 * goes on: not once staff cancelled it.
 */
const awaitApproval = async (
  step: WorkflowStep,
  db: AdminDatabase,
  rolloutId: string,
  after: number,
  next: number
): Promise<boolean> => {
  await step.do(
    `ring ${after} waiting`,
    quickStep,
    guarded(async () => {
      await actIfChanged(
        db,
        "system",
        db
          .update(rollouts)
          .set({ status: "waiting", updatedAt: new Date() })
          .where(
            and(
              eq(rollouts.id, rolloutId),
              eq(rollouts.status, "running"),
              eq(rollouts.ring, after)
            )
          ),
        { action: "rollout.wait", target: rolloutId, detail: { ring: after } }
      );
    })
  );
  // Checked first: an approval recorded after this check reaches the run
  // as its event.
  const approval = await step.do(
    `ring ${next} approved`,
    quickStep,
    guarded(async () => await approvalOf(db, rolloutId, next))
  );
  if (approval === "waiting") {
    await step.waitForEvent(`ring ${next} approval`, {
      type: approvalEvent(next),
      timeout: approvalTimeout,
    });
  }
  return approval !== "cancelled";
};

/** The code at the front of a stop's reason (`<code>: <words>`). */
export const codeOf = (reason: string): string =>
  reason.split(":", 1)[0] ?? reason;

/**
 * Records that the rollout stopped with `reason` (its code and our
 * words), audited as `rollout.fail`, with the client it was on marked
 * failed and released. One stopped because another runner took its
 * client (a rollback) is `cancelled`, as the rollback marks it, whichever
 * records first, and audited as that: `rollout.cancel`. A failure to
 * record it is logged, not thrown, so the run fails with its own error.
 */
export const recordStop = async (
  db: AdminDatabase,
  rolloutId: string,
  clientId: string | null,
  reason: string
): Promise<void> => {
  const now = new Date();
  const code = codeOf(reason);
  const replaced: DeployErrorCode = "runner_replaced";
  const cancelled = code === replaced;
  try {
    await actIfChanged(
      db,
      "system",
      db
        .update(rollouts)
        .set({
          status: cancelled ? "cancelled" : "failed",
          updatedAt: now,
        })
        .where(
          and(
            eq(rollouts.id, rolloutId),
            inArray(rollouts.status, ["running", "waiting"])
          )
        ),
      {
        action: cancelled ? "rollout.cancel" : "rollout.fail",
        target: rolloutId,
        detail: {
          error: reason,
          ...(clientId === null ? {} : { client: clientId }),
        },
      },
      clientId === null
        ? []
        : [
            db
              .update(rolloutTargets)
              .set({ status: "failed", error: code, updatedAt: now })
              .where(
                and(
                  eq(rolloutTargets.rolloutId, rolloutId),
                  eq(rolloutTargets.clientId, clientId),
                  inArray(rolloutTargets.status, ["pending", "deploying"])
                )
              ),
            releaseRun(db, clientId, rolloutId),
          ]
    );
  } catch (recordError) {
    log.error("rollout.stop_unrecorded", {
      rollout: rolloutId,
      error: errorCode(recordError),
    });
  }
};

/**
 * Marks client `clientId` failed in the rollout with `reason` (its code
 * and our words), audited, and releases it: a fleet client that failed on
 * its own, while the others go on.
 */
export const failTarget = async (
  db: AdminDatabase,
  rolloutId: string,
  clientId: string,
  reason: string
): Promise<void> => {
  await actIfChanged(
    db,
    "system",
    db
      .update(rolloutTargets)
      .set({ status: "failed", error: codeOf(reason), updatedAt: new Date() })
      .where(
        and(
          targetWhere(rolloutId, clientId),
          inArray(rolloutTargets.status, ["pending", "deploying"])
        )
      ),
    {
      action: "rollout.client_fail",
      clientId,
      target: rolloutId,
      detail: { error: reason },
    },
    [releaseRun(db, clientId, rolloutId)]
  );
};

/** The fleet targets of rollout `rolloutId` (past its first ring) in `status`. */
export const fleetTargets = async (
  db: AdminDatabase,
  rolloutId: string,
  status: "failed" | "pending"
): Promise<string[]> => {
  const [internal, ...fleet] = await ringsOf(db, rolloutId);
  const rows = await db
    .select({ clientId: rolloutTargets.clientId })
    .from(rolloutTargets)
    .where(
      and(
        eq(rolloutTargets.rolloutId, rolloutId),
        eq(rolloutTargets.status, status)
      )
    );
  const inStatus = new Set(rows.map(({ clientId }) => clientId));
  return internal === undefined
    ? []
    : fleet.flatMap(({ clientIds }) =>
        clientIds.filter((clientId) => inStatus.has(clientId))
      );
};

/** What a fleet client's child run is started with: the rollout's, its client and the round. */
export interface RolloutClientParams extends RolloutParams {
  clientId: string;
  /** 0 for the fleet's first pass, then each retry's round. */
  round: number;
}

/**
 * The instance id of rollout `rolloutId`'s child for client `clientId` in
 * `round`: the same each time, so a check that runs again (the run
 * restarted, or the step retried) finds the child it started rather than
 * starting a second for the same client. A rollout id (36), a client id
 * (at most 50) and a round fit in a run's id.
 */
export const clientRunId = (
  rolloutId: string,
  clientId: string,
  round: number
): string => `${rolloutId}-${clientId}-${round}`;

/** Whether `error` is the engine saying a run of that id exists already. */
const isExistingInstance = (error: unknown): boolean =>
  error instanceof Error && error.message.includes("already_exists");

/**
 * Starts the child that deploys fleet client `clientId` in `round`, unless
 * it exists already: an earlier try of the check started it.
 */
const startClientRun = async (
  env: Env,
  params: RolloutParams,
  clientId: string,
  round: number
): Promise<void> => {
  const childParams: RolloutClientParams = { ...params, clientId, round };
  try {
    await adminWorkflow<RolloutClientParams>(
      env,
      adminWorkflows.rolloutClient
    ).create({
      id: clientRunId(params.rolloutId, clientId, round),
      params: childParams,
    });
  } catch (error) {
    if (!isExistingInstance(error)) {
      throw error;
    }
  }
};

/** The statuses of a target its child hasn't ended yet. */
const openStatuses = ["pending", "deploying"] as const;

/** Since when a child that doesn't exist counts as never started: always (`instanceStatus`). */
const neverStarting = new Date(0);

/** Where the fleet clients a `deployFleet` stage deploys are, after one check. */
interface FleetState {
  /** Every client's child has ended, or none more starts (the rollout is cancelled). */
  done: boolean;
  cancelled: boolean;
}

/**
 * One check of the fleet clients `clientIds` (in order) in `round`: each
 * ended child's client settled, then children started for the next
 * clients up to `fleetConcurrency` going at once, unless the rollout is
 * cancelled. Children start in order, so those started are the first of
 * the clients still open: the check reads them until it reaches one
 * with no child, which none after it has either. A child that ended
 * without ending its client (terminated from the dashboard, or failing
 * to record its end) leaves it to the check: stopped or skipped by the
 * cancellation rule if the rollout is cancelled (`endIfCancelled`),
 * failed otherwise (`run_ended`), so staff can retry it. A client never
 * started stays pending in a cancelled rollout, as when the rollout
 * deployed clients itself.
 */
const advanceFleet = async (
  env: Env,
  params: RolloutParams,
  clientIds: readonly string[],
  round: number
): Promise<FleetState> => {
  const { rolloutId } = params;
  const db = adminDatabase(env.DB);
  const cancelled = (await stoppedAs(db, rolloutId)) !== null;
  const rows = await db
    .select({ clientId: rolloutTargets.clientId })
    .from(rolloutTargets)
    .where(
      and(
        eq(rolloutTargets.rolloutId, rolloutId),
        inArray(rolloutTargets.status, [...openStatuses])
      )
    );
  const open = new Set(rows.map(({ clientId }) => clientId));
  const unended = clientIds.filter((clientId) => open.has(clientId));
  let going = 0;
  let unstarted: string[] = [];
  for (const [index, clientId] of unended.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- in order, to the first not started
    const { status } = await instanceStatus(
      adminWorkflow(env, adminWorkflows.rolloutClient),
      clientRunId(rolloutId, clientId, round),
      neverStarting
    );
    if (status === "gone") {
      unstarted = unended.slice(index);
      break;
    }
    if (!hasEnded(status)) {
      going += 1;
      continue;
    }
    // Its own end landed first if it recorded one: both write only while
    // the target is open.
    // oxlint-disable-next-line no-await-in-loop -- one ended child at a time
    await (cancelled
      ? endIfCancelled(db, rolloutId, clientId)
      : failTarget(
          db,
          rolloutId,
          clientId,
          `run_ended: its deploy's run is ${status}`
        ));
  }
  const starting = cancelled
    ? []
    : unstarted.slice(0, Math.max(0, fleetConcurrency - going));
  for (const clientId of starting) {
    // oxlint-disable-next-line no-await-in-loop -- in order, so those started stay the first
    await startClientRun(env, params, clientId, round);
  }
  going += starting.length;
  return {
    done: going === 0 && (cancelled || unstarted.length === 0),
    cancelled,
  };
};

/**
 * Deploys fleet clients `clientIds` in `round`, each by a child of its own
 * (`rolloutClientRun`), at most `fleetConcurrency` at once, as steps named
 * after `stage`: a check (`advanceFleet`), then a wait for a child's end,
 * again until every child has ended. Returns whether the rollout goes on:
 * not once it's cancelled, and then only after every child it started
 * has ended, since their claims last only while this run does.
 *
 * Children say when they end (`clientEndedEvent`) rather than this run
 * polling them: a poll costs steps for as long as a deploy takes (over
 * 20 minutes moved by stages), so the run's steps would grow with time;
 * an event costs a wait and a check per client. The wait times out
 * (`fleetWaitTimeout`) so a child that ends without telling it is still
 * noticed, and an event that wakes it for nothing costs only a check.
 *
 * Paused, the run starts no child, nor waits; children going already are
 * left to finish their client, each its own deploy to the end (or a
 * rollback stops it), so no client's traffic waits split on staff to
 * resume. Their ends wait for the run as events, and resumed it checks.
 */
const deployFleet = async (
  env: Env,
  step: WorkflowStep,
  params: RolloutParams,
  clientIds: readonly string[],
  { stage, round }: { stage: string; round: number }
): Promise<boolean> => {
  for (let check = 0; ; check += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one check at a time
    const state = await step.do(
      `${stage} ${check}`,
      quickStep,
      guarded(async () => await advanceFleet(env, params, clientIds, round))
    );
    if (state.done) {
      return !state.cancelled;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- woken by a child's end
      await step.waitForEvent(`${stage} ${check} wait`, {
        type: clientEndedEvent,
        timeout: fleetWaitTimeout,
      });
    } catch {
      // Timed out: checked all the same. Paused or ended, the run stops
      // there: the engine never settles its activation's calls.
    }
  }
};

/**
 * Where retry `round` of rollout `rolloutId` is: asked for (a staff
 * member set its failed clients going again, src/rollout/control.ts),
 * still waiting, or the rollout cancelled.
 */
const retryOf = async (
  db: AdminDatabase,
  rolloutId: string
): Promise<"asked" | "waiting" | "cancelled"> => {
  const [row] = await db
    .select({ status: rollouts.status })
    .from(rollouts)
    .where(eq(rollouts.id, rolloutId));
  if (row?.status === "cancelled") {
    return "cancelled";
  }
  return row?.status === "running" ? "asked" : "waiting";
};

/**
 * Waits, once the rollout reached every client, for staff to retry the
 * fleet clients that failed, as round `round`: the rollout marked
 * waiting, audited, then a retry recorded already, or the event it sends
 * (one per round). Returns the clients to deploy again, in ring order;
 * null when none failed, so there's nothing to wait for; `cancelled` once
 * staff cancelled the rollout instead.
 */
const awaitRetry = async (
  step: WorkflowStep,
  db: AdminDatabase,
  rolloutId: string,
  round: number
): Promise<string[] | "cancelled" | null> => {
  const failed = await step.do(
    `retry ${round} waiting`,
    quickStep,
    guarded(async () => {
      const clientIds = await fleetTargets(db, rolloutId, "failed");
      if (clientIds.length > 0) {
        await actIfChanged(
          db,
          "system",
          db
            .update(rollouts)
            .set({ status: "waiting", updatedAt: new Date() })
            .where(
              and(eq(rollouts.id, rolloutId), eq(rollouts.status, "running"))
            ),
          {
            action: "rollout.wait_retry",
            target: rolloutId,
            detail: { failed: clientIds.length },
          }
        );
      }
      return clientIds.length;
    })
  );
  if (failed === 0) {
    return null;
  }
  // Checked first: a retry recorded after this check reaches the run as
  // its event.
  const retry = await step.do(
    `retry ${round} asked`,
    quickStep,
    guarded(async () => await retryOf(db, rolloutId))
  );
  if (retry === "cancelled") {
    return "cancelled";
  }
  if (retry === "waiting") {
    await step.waitForEvent(`retry ${round}`, {
      type: retryEvent(round),
      timeout: approvalTimeout,
    });
  }
  return await step.do(
    `retry ${round} targets`,
    quickStep,
    guarded(async () => await fleetTargets(db, rolloutId, "pending"))
  );
};

/** Moves running rollout `rolloutId` on to ring `ring`, audited once. */
const moveToRing = async (
  db: AdminDatabase,
  rolloutId: string,
  ring: number
): Promise<void> => {
  await actIfChanged(
    db,
    "system",
    db
      .update(rollouts)
      .set({ ring, updatedAt: new Date() })
      .where(
        and(
          eq(rollouts.id, rolloutId),
          eq(rollouts.status, "running"),
          lt(rollouts.ring, ring)
        )
      ),
    { action: "rollout.ring", target: rolloutId, detail: { ring } }
  );
};

/**
 * Ends running rollout `rolloutId` once it reached every client: done,
 * or failed when a fleet client failed (each recorded on its target).
 */
const finishRollout = async (
  db: AdminDatabase,
  rolloutId: string
): Promise<void> => {
  const failed = await db.$count(
    rolloutTargets,
    and(
      eq(rolloutTargets.rolloutId, rolloutId),
      eq(rolloutTargets.status, "failed")
    )
  );
  await actIfChanged(
    db,
    "system",
    db
      .update(rollouts)
      .set({ status: failed === 0 ? "done" : "failed", updatedAt: new Date() })
      .where(and(eq(rollouts.id, rolloutId), eq(rollouts.status, "running"))),
    failed === 0
      ? { action: "rollout.done", target: rolloutId }
      : { action: "rollout.fail", target: rolloutId, detail: { failed } }
  );
};

/** What a rollout's run returns: counts only. */
export interface RolloutResult {
  rings: number;
}

/**
 * Rolling a release (or secrets) out, as a run on Workerflow
 * (src/workflow-runs.ts): the first ring client by client, one staff
 * approval, then the fleet ring by ring, each client in a run of its own
 * (`rolloutClientRun`, src/rollout/fleet-client.ts).
 */
export const rolloutRun = (env: Env): WorkflowDefinition => ({
  run: async (event, step): Promise<RolloutResult> => {
    const params: RolloutParams = rolloutParamsSchema.parse(event.payload);
    const { rolloutId } = params;
    const db = adminDatabase(env.DB);
    // The first ring's client being deployed, so a rollout that stops on
    // it, whatever stops it, records which. A fleet client's child records
    // its own (`rolloutClientRun`).
    let current: string | null = null;
    try {
      const rings = await step.do(
        "targets",
        quickStep,
        guarded(async () => await ringsOf(db, rolloutId))
      );
      const [internal, ...fleet] = rings;
      const result = { rings: rings.length };
      // The internal ring first: any failure stops the rollout there, and
      // the fleet is never reached.
      for (const clientId of internal?.clientIds ?? []) {
        current = clientId;
        // oxlint-disable-next-line no-await-in-loop -- one client at a time
        const goOn = await deployClient(env, step, params, clientId);
        current = null;
        if (!goOn) {
          return result;
        }
      }
      const [firstOfFleet] = fleet;
      if (
        internal !== undefined &&
        firstOfFleet !== undefined &&
        !(await awaitApproval(
          step,
          db,
          rolloutId,
          internal.ring,
          firstOfFleet.ring
        ))
      ) {
        return result;
      }
      // One approval for the fleet: every ring after, a few clients at a
      // time, without stopping for a client that fails.
      for (const { ring, clientIds } of fleet) {
        if (ring !== firstOfFleet?.ring) {
          // oxlint-disable-next-line no-await-in-loop -- ring by ring
          await step.do(
            `ring ${ring}`,
            quickStep,
            guarded(async () => {
              await moveToRing(db, rolloutId, ring);
            })
          );
        }
        // oxlint-disable-next-line no-await-in-loop -- ring by ring
        const goOn = await deployFleet(env, step, params, clientIds, {
          stage: `ring ${ring} fleet`,
          round: 0,
        });
        if (!goOn) {
          return result;
        }
      }
      // Fleet clients that failed wait for staff: retried in this rollout,
      // which keeps what a rollback of each puts back and deploys none of
      // the others again, or the rollout cancelled.
      for (let round = 1; ; round += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one round at a time
        const retried = await awaitRetry(step, db, rolloutId, round);
        if (retried === "cancelled") {
          return result;
        }
        if (retried === null) {
          break;
        }
        // oxlint-disable-next-line no-await-in-loop -- one round at a time
        const goOn = await deployFleet(env, step, params, retried, {
          stage: `retry ${round} fleet`,
          round,
        });
        if (!goOn) {
          return result;
        }
      }
      await step.do(
        "done",
        quickStep,
        guarded(async () => {
          await finishRollout(db, rolloutId);
        })
      );
      return result;
    } catch (error) {
      // Paused or terminated, the run never gets here: the engine never
      // settles its activation's calls. Paused, it carries on where it was
      // once resumed; terminated (a cancel), the admin settles it
      // (src/rollout/control.ts).
      const failed = current;
      await step.do("record stop", quickStep, async () => {
        await recordStop(db, rolloutId, failed, stopReason(error));
      });
      throw error;
    }
  },
});
