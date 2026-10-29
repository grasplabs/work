import type { InstanceStatus as EngineStatus } from "@grasp-os/workerflow/contracts";
/**
 * A client's runner: the one thing that may change what its account runs,
 * as `client_runs` names it. A provisioning attempt (a Workflow instance
 * per attempt, `<clientId>-p<random>`, src/hosting/workflow.ts), a rollout
 * while it deploys the client (the rollout's instance, or for a fleet
 * client a child of it that claims it in the rollout's name,
 * src/rollout/workflow.ts), a rollback of the client (its instance,
 * src/rollout/rollback.ts), or applying its settings (its instance,
 * src/clients/apply.ts). Instances are never deleted or reused.
 *
 * A runner claims the client with one conditional write that names the
 * runner it replaces (none, for a client without one), audited in the
 * same batch. However many act at once, one claim wins and only its
 * caller goes on, so a client has one runner: the precondition of a
 * deploy's D1 migrations and router map write (src/deploy/deploy.ts). A
 * rollout or a rollback releases its claim once it's done with the
 * client; a provisioning run's stays, naming the client's last run. Only
 * a rollback takes a client from a runner still going, and only from the
 * rollout it rolls back.
 *
 * One set of rules for every runner: each is a Workflow instance, and it
 * holds the client while `client_runs` names it and its instance hasn't
 * ended (`hasEnded`); a claim whose instance doesn't exist yet counts as
 * starting for `startingMs`. A runner checks it still holds the client
 * right before and after each change it makes live, and every write it
 * makes to the client's record carries `stillHolds` in the same
 * statement, so one that lost the client changes nothing.
 */
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { Actor, AdminDatabase, AdminEvent } from "./db/act.ts";
import { actIfChanged, adminDatabase } from "./db/act.ts";
import { clientRuns } from "./db/schema.ts";
import { adminWorkflow, adminWorkflows } from "./workflow-runs.ts";

/** Which Workflow a runner is an instance of. */
export type RunKind = (typeof clientRuns.kind.enumValues)[number];

/**
 * Where a client's current run is: its engine's status, `starting` for a
 * run claimed a moment ago that the engine doesn't have yet (its creation
 * is under way), or `gone` for one the engine doesn't have after that
 * (its retention passed, or its creation failed). Runs are on Cloudflare
 * Workflows or on Workerflow (src/workflow-runs.ts) while the admin moves
 * to Workerflow; Workerflow adds `rollingBack`.
 */
export type RunStatus =
  | InstanceStatus["status"]
  | EngineStatus["status"]
  | "starting"
  | "gone";

/** A run, on either engine: what the admin reads and asks of it. */
export interface RunInstance {
  status: () => Promise<{ status: RunStatus }>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  terminate: () => Promise<void>;
}

/** A binding of runs, on either engine. */
interface RunBinding {
  get: (id: string) => Promise<RunInstance>;
}

/** A client's current run. */
export interface CurrentRun {
  runId: string;
  kind: RunKind;
  /** When it was claimed: what's newer belongs to it. */
  claimedAt: Date;
  status: RunStatus;
  /** The instance, when its engine has it. */
  instance: RunInstance | null;
}

/**
 * How long a claimed run Workflows doesn't have counts as starting: well
 * past the moment between a claim and its create. After it, the run is
 * gone and may be replaced.
 */
export const startingMs = 60_000;

/** Runs that ended without finishing, or that Workflows no longer has: a claim may replace them. */
const replaceable: ReadonlySet<RunStatus> = new Set([
  "errored",
  "terminated",
  "gone",
]);

/**
 * Whether a run in `status` stopped without finishing (or is gone), so a
 * new claim may replace it: what staff resume.
 */
export const isReplaceable = (status: RunStatus): boolean =>
  replaceable.has(status);

/**
 * Whether a run in `status` has ended, finished or not: another kind of
 * runner, such as a rollout, may take the client over from it.
 */
export const hasEnded = (status: RunStatus): boolean =>
  status === "complete" || isReplaceable(status);

/** Whether `error` is the engine saying it has no instance of that id: both say it so. */
const isMissingInstance = (error: unknown): boolean =>
  error instanceof Error && error.message.includes("instance.not_found");

/** The workflow a runner of `kind` is a run of. */
const workflows: Readonly<Record<RunKind, (env: Env) => RunBinding>> = {
  rollout: (env) => adminWorkflow(env, adminWorkflows.rollout),
  rollback: (env) => adminWorkflow(env, adminWorkflows.rollbackClient),
  apply: (env) => adminWorkflow(env, adminWorkflows.applyClient),
  provision_placed: (env) =>
    adminWorkflow(env, adminWorkflows.provisionPlacedClient),
};

/**
 * Where instance `id` of `workflow`, created (or about to be) at
 * `since`, is, and the instance when its engine has it.
 */
export const instanceStatus = async <Instance extends RunInstance>(
  workflow: { get: (id: string) => Promise<Instance> },
  id: string,
  since: Date
): Promise<{ status: RunStatus; instance: Instance | null }> => {
  let instance: Instance;
  try {
    instance = await workflow.get(id);
  } catch (error) {
    if (!isMissingInstance(error)) {
      throw error;
    }
    const starting = Date.now() - since.getTime() < startingMs;
    return { status: starting ? "starting" : "gone", instance: null };
  }
  const { status } = await instance.status();
  return { status, instance };
};

/** Client `clientId`'s current run, or null when it has none. */
export const currentRun = async (
  env: Env,
  clientId: string
): Promise<CurrentRun | null> => {
  const [claim] = await adminDatabase(env.DB)
    .select({
      runId: clientRuns.runId,
      kind: clientRuns.kind,
      claimedAt: clientRuns.claimedAt,
    })
    .from(clientRuns)
    .where(eq(clientRuns.clientId, clientId));
  if (claim === undefined) {
    return null;
  }
  const where = await instanceStatus(
    workflows[claim.kind](env),
    claim.runId,
    claim.claimedAt
  );
  return { ...claim, ...where };
};

/** The runner a claim is for: its kind and its instance's id. */
export interface Runner {
  kind: RunKind;
  runId: string;
}

/**
 * Claims client `clientId` for a runner in place of `replacing` (null
 * when it has none), recording `event` by `actor` in the same batch, and
 * returns the runner's id; undefined when another claim got there first,
 * so the caller runs nothing.
 */
export const claimRun = async (
  db: AdminDatabase,
  actor: Actor,
  clientId: string,
  replacing: string | null,
  event: AdminEvent,
  { kind, runId }: Runner
): Promise<string | undefined> => {
  const claimedAt = new Date();
  const statement =
    replacing === null
      ? db
          .insert(clientRuns)
          .values({
            clientId,
            runId,
            kind,
            claimedAt,
            attempt: 0,
            attemptKey: null,
          })
          .onConflictDoNothing()
      : db
          .update(clientRuns)
          .set({ runId, kind, claimedAt, attempt: 0, attemptKey: null })
          .where(
            and(
              eq(clientRuns.clientId, clientId),
              eq(clientRuns.runId, replacing)
            )
          );
  const won = await actIfChanged(db, actor, statement, {
    ...event,
    detail: { ...event.detail, run: runId },
  });
  return won ? runId : undefined;
};

/**
 * Whether runner `runId` is client `clientId`'s current one, and, given
 * `attempt`, that attempt is the runner's latest (`takeAttempt`): what a
 * runner checks before each change it makes live.
 */
export const holdsClient = async (
  db: AdminDatabase,
  clientId: string,
  runId: string,
  attempt?: number,
  attemptKey?: string
): Promise<boolean> => {
  const [claim] = await db
    .select({
      runId: clientRuns.runId,
      attempt: clientRuns.attempt,
      attemptKey: clientRuns.attemptKey,
    })
    .from(clientRuns)
    .where(eq(clientRuns.clientId, clientId));
  return (
    claim?.runId === runId &&
    (attempt === undefined ||
      (claim.attempt === attempt && claim.attemptKey === (attemptKey ?? null)))
  );
};

/** A runner and the client it claimed. */
export interface HeldClient {
  clientId: string;
  runId: string;
  /**
   * The runner's attempt, for a runner on Workerflow that fences its
   * attempts (`takeAttempt`): then only that attempt holds the client.
   */
  attempt?: number;
  /**
   * The step that attempt is of: Workerflow's idempotency key, the same for
   * every attempt at one step of one run and different for any other. Runs
   * under one runner id (a rollout's fleet clients, round after round)
   * each count their attempts from 1, so the number alone can't tell them
   * apart (`takeAttempt`).
   */
  attemptKey?: string;
}

/**
 * Takes client `held.clientId` for attempt `held.attempt` of step
 * `held.attemptKey` of runner `held.runId`, which holds it: from then on
 * an older attempt of that step, or any attempt of another run under the
 * same runner id, holds it no longer, and every check and write of it is refused
 * (`holdsClient`, `stillHolds`). On Workerflow a step that timed out goes
 * on running beside its retry, under the same run: this keeps the older
 * one from acting. Whether it was taken: not when the runner lost the
 * client, or a newer attempt took it first.
 */
export const takeAttempt = async (
  db: AdminDatabase,
  held: HeldClient & { attempt: number; attemptKey: string }
): Promise<boolean> => {
  const taken = await db
    .update(clientRuns)
    .set({ attempt: held.attempt, attemptKey: held.attemptKey })
    .where(
      and(
        eq(clientRuns.clientId, held.clientId),
        eq(clientRuns.runId, held.runId),
        // The claim's first taker, or a later attempt at the same step: a
        // step of another run under the runner's id never takes it over.
        or(
          isNull(clientRuns.attemptKey),
          and(
            eq(clientRuns.attemptKey, held.attemptKey),
            lt(clientRuns.attempt, held.attempt)
          )
        )
      )
    )
    .returning({ clientId: clientRuns.clientId });
  return taken.length > 0;
};

/**
 * That runner `held.runId` (and its attempt `held.attempt`, when given)
 * still holds `held.clientId`, as SQL: the condition every write a runner
 * makes to the client's record carries, in the same statement, so a
 * runner that lost the client changes nothing.
 */
export const stillHolds = (held: HeldClient): SQL =>
  held.attempt === undefined
    ? sql`EXISTS (SELECT 1 FROM ${clientRuns} WHERE ${clientRuns.clientId} = ${held.clientId} AND ${clientRuns.runId} = ${held.runId})`
    : sql`EXISTS (SELECT 1 FROM ${clientRuns} WHERE ${clientRuns.clientId} = ${held.clientId} AND ${clientRuns.runId} = ${held.runId} AND ${clientRuns.attempt} = ${held.attempt} AND ${clientRuns.attemptKey} IS ${held.attemptKey ?? null})`;

/**
 * Releases client `clientId` from runner `runId`, if it still holds it
 * (and, given `attempt`, that attempt does: `takeAttempt`), as a
 * statement to batch with what the runner records: the client then has
 * no runner, and the next claims it afresh.
 */
export const releaseRun = (
  db: AdminDatabase,
  clientId: string,
  runId: string,
  attempt?: number,
  attemptKey?: string
) =>
  db
    .delete(clientRuns)
    .where(
      and(
        eq(clientRuns.clientId, clientId),
        eq(clientRuns.runId, runId),
        attempt === undefined ? undefined : eq(clientRuns.attempt, attempt),
        attempt === undefined || attemptKey === undefined
          ? undefined
          : eq(clientRuns.attemptKey, attemptKey)
      )
    );
