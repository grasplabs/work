/**
 * One organization's rollout of a release, as a run on Workerflow
 * (src/workflow-runs.ts): `start`, then each phase of the client's
 * operation (src/hosting/operation.ts) as a step of its own: `preflight`,
 * `snapshot`, `migrate`, `install`, `probe`, `route` and `record`. The
 * release's own steps among them, and which failures put the release
 * before back, are the rules an install on its own premises applies a
 * release by too (@grasp-os/shared/release-apply); the steps here call
 * the hosted phases.
 *
 * Whoever starts it claims the client for it first (`client_runs`, kind
 * `rollout`, and `client_deploys`, in one batch), so nothing else changes
 * what the client runs while it goes. Every step observes first: it takes
 * the client for its attempt (`takeAttempt`, fenced by the step's ordinal
 * and the attempt, so one that timed out acts no more beside the attempts
 * and steps after it), and its phase does only what the operation hasn't
 * done in this change. A step whose operation this run finished already
 * (its result lost) does nothing.
 *
 * A failure a retry can't fix stops the run at once; the retries are
 * for what one can: Cloudflare's 5xx and lost answers, a 429's block
 * (waited out, `retryDelay`), a new version still starting, the admin's
 * database. An attempt the admin's own redeploy cuts off spends none:
 * the engine runs it again.
 *
 * Once `install` started, any failure, and staff terminating the run with
 * rollback, restores the release before (`restore`, the rollback of
 * `install`): reconciled first, so a release that's live and passes its
 * probe after all is called done. Its migrations are never undone. However
 * it ends, the deploy's end is recorded on `client_deploys`, audited and
 * alerted, the claim given back, and the fleet's pass run to start the
 * next (`endRun`): by `record`, by the restore, or else by the rollback
 * of `start`, which runs last. A run that ends without any of them
 * (terminated without rollback) is settled by the pass.
 */
import "@tanstack/react-start/server-only";
import { log } from "@grasp-os/shared/log";
import { restoresFrom } from "@grasp-os/shared/release-apply";
import type {
  WorkflowDefinition,
  WorkflowDelayFunction,
  WorkflowDuration,
  WorkflowRollbackContext,
  WorkflowStepContext,
} from "@grasp-os/workerflow/contracts";
import { NonRetryableError } from "@grasp-os/workerflow/errors";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { rateLimitBlockMs } from "../cloudflare/api.ts";
import { adminDatabase } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import { clientDeploys } from "../db/schema.ts";
import { deployContext } from "../deploy/context.ts";
import type { DeployContext } from "../deploy/context.ts";
import { errorCode } from "../deploy/errors.ts";
import {
  operationErrorCode,
  operationPhases,
  provisionOf,
  recordUnstarted,
  runOperationPhase,
  startClientRelease,
} from "../hosting/operation.ts";
import type { OperationPhase, Stopped } from "../hosting/operation.ts";
import { claimRun, takeAttempt } from "../runners.ts";
import type { HeldClient } from "../runners.ts";
import {
  asOperationStepError,
  asStepError,
  guarded,
  stop,
  stopReason,
} from "../workflow-steps.ts";
import { recordApiUsage } from "./api-budget.ts";
import { failureCodeOf, recordEnd } from "./deploy.ts";
import type { DeployEnd } from "./deploy.ts";
import { runRolloutPass } from "./scheduler.ts";
import { runningRelease, targetClient } from "./targets.ts";

/** What an organization's rollout is started with: identifiers only, as its journal keeps them. */
const orgRolloutParamsSchema = z.object({
  clientId: z.string(),
  releaseId: z.string(),
});
export type OrgRolloutParams = z.infer<typeof orgRolloutParamsSchema>;

/** The run's steps, in order: its start, then the operation's phases. */
const steps = ["start", ...operationPhases] as const;
type Step = (typeof steps)[number];

/**
 * Each step's place in the run, from 1, as it takes the client
 * (`takeAttempt`): a later one takes it from any attempt of an earlier
 * one. The restore comes after every step, as it runs once they stopped.
 */
const ordinalOf = (step: Step | "restore"): number =>
  step === "restore" ? steps.length + 1 : steps.indexOf(step) + 1;

/**
 * How many times a step is tried again after a failure a retry can fix.
 * Cloudflare's 5xx and lost answers to calls that may be sent again are
 * retried inside the API client already (4 tries in about 4 s), so what
 * reaches a step is an outage that outlasts that, a call that mustn't be
 * sent twice (an upload, a migration) and whose answer was lost, which
 * the retry reads back first, a new version still starting past the
 * probe's own waits, a 429, or the admin's database failing a moment.
 * Three more tries, 10, 20 and 40 s apart, outlast a brief one of those;
 * a 429's block is waited out (`retryDelay`), so three blocks in a row
 * fail the step, by when the pass has started nothing for 15 minutes. A
 * longer outage fails the organization, and the rollout counts it.
 */
const retries = 3;

/** The wait before a step's first retry, doubling with each failure. */
const retryDelayMs = 10_000;

/** Whether a step failed for a 429: its code, as `asStepError` leaves it. */
const isRateLimitedStep = (error: Error): boolean =>
  stopReason(error).startsWith("cloudflare_429");

/**
 * The wait before a step's retry: past a 429's block, Cloudflare's five
 * minutes, so the retry isn't refused again; otherwise 10 s, doubling
 * with each failure (its backoff is constant, so this is the wait).
 */
const retryDelay: WorkflowDelayFunction = ({ ctx, error }) =>
  isRateLimitedStep(error)
    ? rateLimitBlockMs
    : retryDelayMs * 2 ** ctx.failedAttempts;

/**
 * How long each step's attempt may take: its usual time several times
 * over. Most are a few reads and writes of the admin's database and a
 * few API calls; `preflight` may create a resource and wait to read it
 * back (`observed`, about 31 s); `migrate` sends each database's
 * migrations and model files; `install` uploads connect and core, each
 * whole after a failed probe; `probe` waits out a new version and its
 * static files (about 80 s each) before the signed probe; `record` also
 * runs the fleet's pass.
 */
const timeouts: Readonly<Record<Step, WorkflowDuration>> = {
  start: "2 minutes",
  preflight: "5 minutes",
  snapshot: "2 minutes",
  migrate: "10 minutes",
  install: "10 minutes",
  probe: "5 minutes",
  route: "2 minutes",
  record: "2 minutes",
};

/** Step `step`'s config: its timeout, and the retries every step has. */
const configOf = (step: Step) =>
  ({
    retries: { limit: retries, delay: retryDelay, backoff: "constant" },
    timeout: timeouts[step],
  }) as const;

/**
 * The restore's: it may reconcile (a probe, the route), then run every
 * phase for the release before, its uploads whole after a failed probe,
 * so it may take a whole deploy's time: the longest a Workerflow
 * attempt runs.
 */
const restoreConfig = {
  retries: { limit: retries, delay: retryDelay, backoff: "constant" },
  timeout: "14 minutes",
} as const;

/**
 * Probe failures a moment may cause, which the probe step tries again
 * (`retries`): core didn't answer the signed probe (no answer, a 5xx, a
 * timeout), or its frontend still answered Cloudflare's stub for static
 * files (or nothing). Any other answer is definite: another client,
 * version or release, a database behind, a binding missing, a clock not
 * armed. It fails at once, and the restore runs.
 */
const momentaryProbeCodes: ReadonlySet<string> = new Set([
  "probe_unanswered",
  "probe_assets_not_ready",
]);

/** A phase's failure as its step fails with it. */
const stepError = (stopped: Stopped): Error =>
  momentaryProbeCodes.has(stopped.code)
    ? new Error(stopped.code)
    : asOperationStepError(stopped.error);

/** Whether a phase's failure is final: no retry would fix it. */
const isFinal = (stopped: Stopped): boolean =>
  stepError(stopped) instanceof NonRetryableError;

/** A run's deploy of its client, as its end is recorded. */
interface Ending extends OrgRolloutParams {
  runId: string;
}

/** Client `clientId`'s operation, as it is now. */
type Operation = Awaited<ReturnType<typeof provisionOf>>;

/** Whether run `runId` finished `operation` on release `releaseId`. */
const isDoneBy = (
  operation: Operation,
  runId: string,
  releaseId: string
): boolean =>
  operation?.status === "done" &&
  operation.runId === runId &&
  operation.releaseId === releaseId;

/** Whether `ending`'s deploy is still out: not recorded ended yet. */
const isDeploying = async (
  db: AdminDatabase,
  { clientId, runId }: Ending
): Promise<boolean> => {
  const deploy = await db
    .select({ status: clientDeploys.status })
    .from(clientDeploys)
    .where(
      and(eq(clientDeploys.clientId, clientId), eq(clientDeploys.runId, runId))
    )
    .get();
  return deploy?.status === "deploying";
};

/**
 * Records `ending`'s deploy ended, `error` null when it worked
 * (`recordEnd`: audited, alerted, its claim given back), then runs the
 * fleet's pass to start the next at once (`runRolloutPass`, which never
 * throws). Only once: a deploy recorded ended already is left as it is,
 * and the pass run again finds nothing new.
 */
const endRun = async (
  env: Env,
  ending: Ending,
  error: string | null,
  end?: DeployEnd
): Promise<void> => {
  await recordEnd(adminDatabase(env.DB), ending, error, end);
  await runRolloutPass(env);
};

/** Takes the client for `held`'s attempt, or stops: another attempt, or a later step, has it. */
const take = async (
  db: AdminDatabase,
  held: HeldClient & { attempt: number; attemptKey: string }
): Promise<void> => {
  if (!(await takeAttempt(db, held))) {
    throw stop(
      "runner_replaced",
      `${held.runId} no longer holds ${held.clientId} for step ${held.step ?? 0}, attempt ${held.attempt}`
    );
  }
};

/**
 * What `held`'s attempt deploys with; a failure to read it (a secret
 * missing from Secrets Store, no client domain) recorded on the
 * operation, then thrown as its step fails with it.
 */
const contextFor = async (
  env: Env,
  db: AdminDatabase,
  held: HeldClient
): Promise<DeployContext> => {
  try {
    // A 429 fails the call at once, and the step parks past the block
    // (`retryDelay`).
    return await deployContext(env, { failRateLimited: true });
  } catch (error) {
    await recordUnstarted(db, held, errorCode(error));
    throw asStepError(error);
  }
};

/**
 * Step 1: takes the client's operation to the run's release (a release,
 * or the one it runs again with its secrets and settings as they are
 * now), and returns the one every Worker was seen running before: what a
 * restore goes back to, none when it's the same. Started already (a retry
 * whose result was lost), it goes on.
 */
const start = async (
  env: Env,
  { clientId, releaseId }: OrgRolloutParams,
  runId: string,
  { attempt, idempotencyKey }: WorkflowStepContext<WorkflowDelayFunction>
): Promise<string | null> => {
  const db = adminDatabase(env.DB);
  const held = {
    clientId,
    runId,
    attempt,
    attemptKey: idempotencyKey,
    step: ordinalOf("start"),
  };
  await take(db, held);
  const client = await targetClient(db, clientId);
  if (client === undefined) {
    throw stop("not_active", `${clientId} is gone`);
  }
  const running = runningRelease(client);
  try {
    await startClientRelease(db, "system", held, {
      releaseId,
      again: running === releaseId,
      what: client.rotationPending ? "settings_and_secrets" : "secrets",
    });
  } catch (error) {
    throw asOperationStepError(error);
  }
  return running;
};

/**
 * A step that runs phase `phase` of the client's operation as its
 * attempt alone, and records what the API saw of the rate limit as it
 * ends. Nothing when this run finished the operation already. `record`
 * then records the deploy done.
 */
const phaseStep =
  (env: Env, params: OrgRolloutParams, runId: string, phase: OperationPhase) =>
  async ({
    attempt,
    idempotencyKey,
  }: WorkflowStepContext<WorkflowDelayFunction>): Promise<void> => {
    const { clientId, releaseId } = params;
    const db = adminDatabase(env.DB);
    if (!isDoneBy(await provisionOf(db, clientId), runId, releaseId)) {
      const held = {
        clientId,
        runId,
        attempt,
        attemptKey: idempotencyKey,
        step: ordinalOf(phase),
      };
      await take(db, held);
      const context = await contextFor(env, db, held);
      try {
        const stopped = await runOperationPhase(context, held, phase);
        if (stopped !== undefined) {
          throw stepError(stopped);
        }
      } finally {
        await recordApiUsage(
          db,
          { clientId, step: phase },
          context.api.usage()
        );
      }
    }
    if (phase === "record") {
      await endRun(env, { ...params, runId }, null);
    }
  };

/**
 * Why the run stopped, as its deploy records it: `run_terminated` for
 * staff terminating it; otherwise the failure's code, or, for an attempt
 * the engine cut off or timed out last, the step the operation reached
 * (`failureCodeOf`). Read before anything of the operation changes.
 */
const causeOf = async (
  db: AdminDatabase,
  ending: Ending,
  error: Error
): Promise<string> =>
  error.name === "Terminated"
    ? "run_terminated"
    : await failureCodeOf(db, ending, error);

/** Runs `phases` of the client's operation in turn as `held`; the first that stops, if one does. */
const runPhases = async (
  context: DeployContext,
  held: HeldClient,
  phases: readonly OperationPhase[]
): Promise<Stopped | undefined> => {
  for (const phase of phases) {
    // oxlint-disable-next-line no-await-in-loop -- each after the one before
    const stopped = await runOperationPhase(context, held, phase);
    if (stopped !== undefined) {
      return stopped;
    }
  }
  return undefined;
};

/** The phases that follow the upload: what reconciling a release that's live runs again. */
const afterUpload: readonly OperationPhase[] = ["probe", "route", "record"];

/** What `startClientRelease` refuses a restore with when the release before can't take the client back. */
const refusals: ReadonlySet<string> = new Set([
  "rollback_past_migration",
  "rollback_past_chat_storage",
]);

/**
 * Claims client `ending.clientId` back for its run, which finished with it
 * and gave it back, so its restore may act: only while no runner has it.
 */
const claimedBack = async (
  db: AdminDatabase,
  { clientId, runId, releaseId }: Ending
): Promise<boolean> =>
  (await claimRun(
    db,
    "system",
    clientId,
    null,
    { action: "deploy.restore_claim", clientId, target: releaseId },
    { kind: "rollout", runId }
  )) !== undefined;

/**
 * Records the end of `ending`'s deploy, whose run finished its operation:
 * an earlier try of the restore finished it, and its record was lost
 * (restored when it's off the run's release); or the run finished the
 * release itself, done, unless staff terminated it just after, and the
 * client could be taken back to restore it. Whether it recorded it: not
 * when there's that restore to do.
 */
const recordedFinished = async (
  env: Env,
  db: AdminDatabase,
  ending: Ending,
  {
    onTarget,
    terminated,
    cause,
  }: { onTarget: boolean; terminated: boolean; cause: string }
): Promise<boolean> => {
  if (!onTarget) {
    await endRun(env, ending, cause, { restored: true });
    return true;
  }
  if (terminated && (await claimedBack(db, ending))) {
    return false;
  }
  await endRun(env, ending, null);
  return true;
};

/**
 * Whether a run on `releaseId` that went on from `from` has no release
 * before it to restore: a run of the release it ran already, or its
 * first, whose operation names none before.
 */
const hasNothingBefore = (
  operation: NonNullable<Operation>,
  from: string | null,
  releaseId: string
): boolean =>
  from === releaseId ||
  (operation.releaseId === releaseId &&
    (operation.previousReleaseId === null ||
      operation.previousReleaseId === releaseId));

/** A restore under way: what it works with, why, and whether it's its last try. */
interface Restoring {
  context: DeployContext;
  held: HeldClient;
  /** What the run failed with. */
  cause: string;
  last: boolean;
  /**
   * Whether an earlier try started it already: the operation is on the
   * release before, and goes on there, never rolled back again (which
   * would aim it at the release that failed).
   */
  started: boolean;
}

/** How a restore ends the deploy: its code (null, done), and why it didn't restore (`code`). */
interface Outcome {
  error: string | null;
  end?: DeployEnd;
  code?: string;
}

/** Whether every Worker of client `clientId` runs `releaseId`, as observed. */
const runsWhole = async (
  db: AdminDatabase,
  clientId: string,
  releaseId: string
): Promise<boolean> => {
  const client = await targetClient(db, clientId);
  return client !== undefined && runningRelease(client) === releaseId;
};

/**
 * The release that's live probed, routed and recorded again: done when
 * it passes. Undefined when it's broken, or on the last try when it
 * can't be told, for the release before to go back; thrown, to be tried
 * again, when a retry may tell.
 */
const reconciled = async ({
  context,
  held,
  last,
}: Restoring): Promise<Outcome | undefined> => {
  const stopped = await runPhases(context, held, afterUpload);
  if (stopped === undefined) {
    return { error: null };
  }
  if (!last && !isFinal(stopped)) {
    throw stepError(stopped);
  }
  return undefined;
};

/**
 * The release before put back, every phase run for it, and probed:
 * restored, refused (`restore_refused`) or failed (`restore_failed`); a
 * failure a retry may fix thrown, but on the last try.
 */
const putBack = async ({
  context,
  held,
  cause,
  last,
  started,
}: Restoring): Promise<Outcome> => {
  try {
    if (!started) {
      await startClientRelease(context.db, "system", held, {
        rollback: true,
        cause,
      });
    }
  } catch (error) {
    const code = operationErrorCode(error);
    if (refusals.has(code)) {
      return { error: "restore_refused", end: { cause }, code };
    }
    const failed = asOperationStepError(error);
    if (!last && !(failed instanceof NonRetryableError)) {
      throw failed;
    }
    return { error: "restore_failed", end: { cause }, code };
  }
  const stopped = await runPhases(context, held, operationPhases);
  if (stopped === undefined) {
    return { error: cause, end: { restored: true } };
  }
  if (!last && !isFinal(stopped)) {
    throw stepError(stopped);
  }
  return { error: "restore_failed", end: { cause }, code: stopped.code };
};

/**
 * The rollback of `install`: puts the client back on `from`, the release
 * it ran whole before, once the run failed after its install started, or
 * staff terminated it with rollback. Only for a release to another one:
 * a run of the release it runs again, or its first, has nothing to go
 * back to, and the rollback of `start` records its failure.
 *
 * 1. Reconciled first, unless staff terminated the run: the client on
 *    the run's release whole, and its probe passing now, the route and
 *    record run again, and the deploy is done. The step that failed came
 *    after the switch: a lost answer.
 * 2. The restore, refused when the release before can't take the client
 *    back (`canMove`: a Durable Object migration ran, or it can't open the
 *    chats stored since): the client stays on the release that failed,
 *    recorded `restore_refused`. Serving broken for a while does less
 *    harm than chats that no longer open.
 * 3. Every phase run for the release before, its migrations left as they
 *    are (expand only), the Workers whose upload and live script still
 *    match skipped, every one uploaded whole after a failed probe, then
 *    probed: the deploy failed, restored. A restore that fails for good,
 *    its probe or before, is recorded `restore_failed`, for staff.
 *
 * A failure a retry can fix is thrown, and the restore runs again,
 * reading where it got to, until its last try: that one records
 * `restore_failed`. Counted by its attempts, a try the admin's redeploy
 * cut off included.
 */
const restore = async (
  env: Env,
  params: OrgRolloutParams,
  runId: string,
  from: string | null,
  {
    error,
    attempt,
    idempotencyKey,
  }: WorkflowRollbackContext<void, WorkflowDelayFunction>
): Promise<void> => {
  const { clientId, releaseId } = params;
  const db = adminDatabase(env.DB);
  const ending = { ...params, runId };
  const operation = await provisionOf(db, clientId);
  if (
    operation === undefined ||
    hasNothingBefore(operation, from, releaseId) ||
    !(await isDeploying(db, ending))
  ) {
    return;
  }
  const onTarget = operation.releaseId === releaseId;
  const cause = await causeOf(db, ending, error);
  const terminated = error.name === "Terminated";
  if (
    operation.status === "done" &&
    operation.runId === runId &&
    (await recordedFinished(env, db, ending, { onTarget, terminated, cause }))
  ) {
    return;
  }
  const held = {
    clientId,
    runId,
    attempt,
    attemptKey: idempotencyKey,
    step: ordinalOf("restore"),
  };
  if (!(await takeAttempt(db, held))) {
    log.error("deploy.restore_unheld", { clientId, runId, attempt });
    return;
  }
  const last = attempt > restoreConfig.retries.limit;
  let context: DeployContext;
  try {
    context = await contextFor(env, db, held);
  } catch (contextError) {
    // What it deploys with can't be read (a secret gone from Secrets
    // Store): on its last try, or for good, the restore failed.
    if (!last && !(contextError instanceof NonRetryableError)) {
      throw contextError;
    }
    log.error("deploy.restore_failed", {
      clientId,
      runId,
      cause,
      code: stopReason(contextError),
    });
    await endRun(env, ending, "restore_failed", { cause, held });
    return;
  }
  const restoring = { context, held, cause, last, started: !onTarget };
  try {
    // Staff terminating the run asked for the release before: never
    // reconciled onto the one they stopped.
    const outcome =
      (!terminated && onTarget && (await runsWhole(db, clientId, releaseId))
        ? await reconciled(restoring)
        : undefined) ?? (await putBack(restoring));
    if (outcome.code !== undefined) {
      log.error(`deploy.${outcome.error ?? "restored"}`, {
        clientId,
        runId,
        cause,
        code: outcome.code,
      });
    }
    // A restore that didn't put the release before back is recorded only
    // while this try still holds the client: one that timed out records
    // nothing over the try after it.
    await endRun(
      env,
      ending,
      outcome.error,
      outcome.code === undefined ? outcome.end : { ...outcome.end, held }
    );
  } finally {
    await recordApiUsage(
      db,
      { clientId, step: "restore" },
      context.api.usage()
    );
  }
};

/**
 * The rollback of `start`, which runs last: records the deploy's end
 * when nothing after it did (a failure before `install`, a run of the
 * release it runs again, a first release, a restore that couldn't act).
 * Done after all when this run finished the operation on its release (a
 * step's answer lost after it); otherwise failed, with why.
 */
const recordStopped = async (
  env: Env,
  params: OrgRolloutParams,
  runId: string,
  error: Error
): Promise<void> => {
  const db = adminDatabase(env.DB);
  const ending = { ...params, runId };
  if (!(await isDeploying(db, ending))) {
    return;
  }
  const operation = await provisionOf(db, params.clientId);
  await endRun(
    env,
    ending,
    isDoneBy(operation, runId, params.releaseId)
      ? null
      : await causeOf(db, ending, error)
  );
};

/** An organization's rollout of a release, as a run: its start, then a step a phase. */
export const orgRolloutRun = (env: Env): WorkflowDefinition => ({
  run: async (event, step): Promise<void> => {
    const params = orgRolloutParamsSchema.parse(event.payload);
    const runId = event.instanceId;
    const from = await step.do(
      "start",
      configOf("start"),
      guarded(
        async (context: WorkflowStepContext<WorkflowDelayFunction>) =>
          await start(env, params, runId, context)
      ),
      {
        rollback: guarded(
          async ({
            error,
          }: WorkflowRollbackContext<string | null, WorkflowDelayFunction>) => {
            await recordStopped(env, params, runId, error);
          }
        ),
        rollbackConfig: configOf("start"),
      }
    );
    for (const phase of operationPhases) {
      // oxlint-disable-next-line no-await-in-loop -- each phase after the one before
      await step.do(
        phase,
        configOf(phase),
        guarded(phaseStep(env, params, runId, phase)),
        phase === restoresFrom
          ? {
              rollback: guarded(
                async (
                  context: WorkflowRollbackContext<void, WorkflowDelayFunction>
                ) => {
                  await restore(env, params, runId, from, context);
                }
              ),
              rollbackConfig: restoreConfig,
            }
          : undefined
      );
    }
  },
});
