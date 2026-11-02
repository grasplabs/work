/**
 * The one reconciler: on the admin's cron (src/server.ts), every minute,
 * it deploys each active client whose Workers run something other than
 * its target (src/rollout/desired.ts): another release, or shared secrets
 * other than the ones staff rolled out. Nothing else deploys a release.
 *
 * Per channel, at most `parallelDeploys` deploys are out at once, each a
 * run of its own (src/rollout/deploy.ts). Once a client following the
 * channel failed its deploy of the channel's release, no new deploy
 * starts on the channel: the ones out finish, and staff retry, or promote
 * another release (src/rollout/channels.ts).
 *
 * One tick at a time: a tick acts only while it holds the reconciler's
 * lease (`takeLease`), so the count of deploys out and the check for a
 * failure are one runner's, and ticks that overlap never start more than
 * `parallelDeploys` between them. While a tick runs, deploys can end but
 * none start but its own, so its count can only be high; a failure can
 * land mid-tick, so each claim checks for one in its own statement
 * (`channelFailedSql`).
 *
 * Idempotent: a deploy starts only with a compare-and-set claim on the
 * client (`claim`), so a tick that read the client before a deploy came
 * and went starts none. A deploy whose run ended without recording how
 * (terminated, or never created) is settled as failed (`run_ended`): its
 * claim is the run's life.
 *
 * Clients are read a page at a time, and each page's deploys start before
 * the next is read; no tick holds more than a page in memory or in a
 * statement.
 */
import { log } from "@grasp-os/shared/log";
import { and, asc, eq, gt, lte, sql } from "drizzle-orm";

import { adminDatabase, auditIfChanged } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import {
  channelIds,
  channels,
  clientDeploys,
  clientPlacements,
  clientProvisions,
  clientRuns,
  clients,
  clientWorkers,
  reconcilerLease,
} from "../db/schema.ts";
import type { Channel } from "../db/schema.ts";
import { clientDomain } from "../deploy/context.ts";
import { errorCode } from "../deploy/errors.ts";
import { currentRun, hasEnded, instanceStatus } from "../runners.ts";
import { adminWorkflow, adminWorkflows } from "../workflow-runs.ts";
import { recordEnd } from "./deploy.ts";
import type { DeployParams } from "./deploy.ts";
import {
  failsChannel,
  isSecretsBehind,
  parallelDeploys,
  planChannel,
  stateOf,
  targetOf,
} from "./desired.ts";
import type { ChannelReleases, ClientFacts, RolledOut } from "./desired.ts";
import { rolledOutPrints } from "./shared-secrets.ts";
import { channelReleases, deliveredShared } from "./targets.ts";

/** How many clients a tick reads at once. */
const pageSize = 200;

/**
 * How long a tick's lease lasts: the longest a cron invocation runs, so a
 * tick never outlives it. A tick that dies without giving it back holds
 * the reconciler up until then.
 */
const leaseMs = 15 * 60 * 1000;

/**
 * The one release every Worker of the client runs, as SQL: null when it
 * has none, or they run different ones (a deploy stopped between them).
 */
const runningSql = sql<
  string | null
>`(SELECT CASE WHEN COUNT(*) > 0 AND COUNT(${clientWorkers.releaseId}) = COUNT(*) AND COUNT(DISTINCT ${clientWorkers.releaseId}) = 1 THEN MIN(${clientWorkers.releaseId}) END FROM ${clientWorkers} WHERE ${clientWorkers.clientId} = ${clients.id})`;

/** What a page of clients is read as. */
const factColumns = {
  id: clients.id,
  channel: clients.channel,
  pinnedReleaseId: clients.pinnedReleaseId,
  running: runningSql,
  progress: clientProvisions.progress,
  operationStartedAt: clientProvisions.createdAt,
  operationStatus: clientProvisions.status,
  deployRelease: clientDeploys.releaseId,
  deployStatus: clientDeploys.status,
  deployError: clientDeploys.error,
  deployRunId: clientDeploys.runId,
  deployStartedAt: clientDeploys.startedAt,
};

/** A client as a page reads it: its facts, and its deploy's run. */
export interface ClientRow extends ClientFacts {
  run: { runId: string; startedAt: Date } | null;
}

/**
 * Active placed clients following `channel` with an id after `after`, a
 * page of them in id order: what the reconciler and the pages read.
 */
const clientPage = async (
  db: AdminDatabase,
  channel: Channel,
  after: string | null,
  rolledOut: RolledOut | null,
  limit: number = pageSize
): Promise<ClientRow[]> => {
  const rows = await db
    .select(factColumns)
    .from(clients)
    .innerJoin(clientPlacements, eq(clientPlacements.clientId, clients.id))
    .leftJoin(clientProvisions, eq(clientProvisions.clientId, clients.id))
    .leftJoin(clientDeploys, eq(clientDeploys.clientId, clients.id))
    .where(
      and(
        eq(clients.status, "active"),
        eq(clients.channel, channel),
        after === null ? undefined : gt(clients.id, after)
      )
    )
    .orderBy(asc(clients.id))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    channel: row.channel,
    pinnedReleaseId: row.pinnedReleaseId,
    running: row.running,
    secretsBehind: isSecretsBehind(
      deliveredShared(row.progress),
      // A change counts only once it delivered: done, never just started.
      row.operationStatus === "done" ? row.operationStartedAt : null,
      rolledOut
    ),
    deploy:
      row.deployRelease === null ||
      row.deployStatus === null ||
      row.deployRunId === null ||
      row.deployStartedAt === null
        ? null
        : {
            releaseId: row.deployRelease,
            status: row.deployStatus,
            error: row.deployError,
          },
    run:
      row.deployRunId === null || row.deployStartedAt === null
        ? null
        : { runId: row.deployRunId, startedAt: row.deployStartedAt },
  }));
};

/**
 * Visits each page of `channel`'s clients in turn, read as it's needed,
 * until `visit` answers `"stop"`.
 */
export const eachPage = async (
  db: AdminDatabase,
  channel: Channel,
  rolledOut: RolledOut | null,
  visit: (page: ClientRow[]) => Promise<"stop" | "next"> | "stop" | "next"
): Promise<void> => {
  let after: string | null = null;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one page at a time
    const page = await clientPage(db, channel, after, rolledOut);
    // oxlint-disable-next-line no-await-in-loop -- one page at a time
    if (page.length === 0 || (await visit(page)) === "stop") {
      return;
    }
    after = page.at(-1)?.id ?? null;
    if (page.length < pageSize) {
      return;
    }
  }
};

/** The deploy workflow's runs. */
const deploys = (env: Env) =>
  adminWorkflow<DeployParams>(env, adminWorkflows.deploy);

/**
 * Client `row` once its deploy is settled: one whose run ended without
 * recording how is recorded failed (`run_ended`), and read so.
 */
const settled = async (
  env: Env,
  db: AdminDatabase,
  row: ClientRow
): Promise<ClientRow> => {
  if (row.deploy?.status !== "deploying" || row.run === null) {
    return row;
  }
  const { status } = await instanceStatus(
    deploys(env),
    row.run.runId,
    row.run.startedAt
  );
  if (!hasEnded(status)) {
    return row;
  }
  await recordEnd(
    db,
    {
      clientId: row.id,
      runId: row.run.runId,
      releaseId: row.deploy.releaseId,
    },
    "run_ended"
  );
  return {
    ...row,
    deploy: { ...row.deploy, status: "failed", error: "run_ended" },
  };
};

/**
 * Whether a client following `channel` (active, placed, not pinned)
 * failed its deploy of the channel's release, as SQL: what stops the
 * channel (`failsChannel`). Read by the statement that claims a client,
 * so a failure that lands mid-tick stops every claim after it.
 */
const channelFailedSql = (channel: Channel) =>
  sql`EXISTS (SELECT 1 FROM ${clientDeploys} JOIN ${clients} ON ${clients.id} = ${clientDeploys.clientId} JOIN ${clientPlacements} ON ${clientPlacements.clientId} = ${clients.id} JOIN ${channels} ON ${channels.id} = ${clients.channel} WHERE ${clients.channel} = ${channel} AND ${clients.status} = 'active' AND ${clients.pinnedReleaseId} IS NULL AND ${clientDeploys.status} = 'failed' AND ${clientDeploys.releaseId} = ${channels.releaseId})`;

/** A new deploy run's id. */
const newDeployId = (): string =>
  `deploy-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;

/**
 * Claims client `row` for a deploy of `releaseId` by run `runId`, and
 * returns whether it won. One batch, compare-and-set on both claims as
 * read: the client's runner (`client_runs`, replacing `replacing`, a run
 * that ended, or none) and its deploy (`client_deploys`, replacing the
 * row as read, by its run). Either changed since, or the client's channel
 * has failed by now, and nothing is claimed: the runner claim is undone
 * in the same batch when the deploy's lost.
 */
const claim = async (
  db: AdminDatabase,
  row: ClientRow,
  replacing: string | null,
  { runId, releaseId }: { runId: string; releaseId: string }
): Promise<boolean> => {
  const now = new Date();
  const runner =
    replacing === null
      ? db
          .insert(clientRuns)
          .values({
            clientId: row.id,
            runId,
            kind: "deploy",
            claimedAt: now,
            attempt: 0,
            attemptKey: null,
          })
          .onConflictDoNothing()
      : db
          .update(clientRuns)
          .set({
            runId,
            kind: "deploy",
            claimedAt: now,
            attempt: 0,
            attemptKey: null,
          })
          .where(
            and(
              eq(clientRuns.clientId, row.id),
              eq(clientRuns.runId, replacing)
            )
          );
  const claimable = sql`EXISTS (SELECT 1 FROM ${clientRuns} WHERE ${clientRuns.clientId} = ${row.id} AND ${clientRuns.runId} = ${runId}) AND NOT ${channelFailedSql(row.channel)}`;
  const values = {
    clientId: row.id,
    releaseId,
    runId,
    status: "deploying" as const,
    error: null,
    startedAt: now,
    endedAt: null,
  };
  const asRead = row.run?.runId;
  const deploy =
    asRead === undefined
      ? db
          .insert(clientDeploys)
          .select(
            sql`SELECT ${row.id}, ${releaseId}, ${runId}, 'deploying', NULL, ${now.getTime()}, NULL WHERE ${claimable} AND NOT EXISTS (SELECT 1 FROM ${clientDeploys} WHERE ${clientDeploys.clientId} = ${row.id})`
          )
      : db
          .update(clientDeploys)
          .set(values)
          .where(
            and(
              eq(clientDeploys.clientId, row.id),
              eq(clientDeploys.runId, asRead),
              sql`${claimable}`
            )
          );
  const event = auditIfChanged(db, "system", {
    action: "deploy.start",
    clientId: row.id,
    target: releaseId,
    detail: { run: runId },
  });
  const undo = db
    .delete(clientRuns)
    .where(
      and(
        eq(clientRuns.clientId, row.id),
        eq(clientRuns.runId, runId),
        sql`NOT EXISTS (SELECT 1 FROM ${clientDeploys} WHERE ${clientDeploys.clientId} = ${row.id} AND ${clientDeploys.runId} = ${runId})`
      )
    );
  const results = await db.batch([runner, deploy, event, undo]);
  return results[2].length > 0;
};

/**
 * Starts client `row`'s deploy to `releaseId`: claimed, then its run
 * created. Returns whether it's out: not while another runner (an apply,
 * provisioning) still has the client, when the claim lost, or when the
 * run can't be created, which is recorded failed (`run_not_created`).
 */
const startDeploy = async (
  env: Env,
  db: AdminDatabase,
  row: ClientRow,
  releaseId: string
): Promise<boolean> => {
  const current = await currentRun(env, row.id);
  if (current !== null && !hasEnded(current.status)) {
    return false;
  }
  const runId = newDeployId();
  const won = await claim(db, row, current?.runId ?? null, {
    runId,
    releaseId,
  });
  if (!won) {
    return false;
  }
  try {
    await deploys(env).create({
      id: runId,
      params: { clientId: row.id, releaseId },
    });
    return true;
  } catch (error) {
    log.error("deploy.run_not_created", {
      clientId: row.id,
      error: errorCode(error),
    });
    await recordEnd(
      db,
      { clientId: row.id, runId, releaseId },
      "run_not_created"
    );
    return false;
  }
};

/**
 * Starts deploying `page`'s waiting clients, in order, until `deploying`
 * and those started fill the channel's room or none are left: a client
 * that didn't start (another runner has it) leaves its slot to the next.
 * Returns how many are out now.
 */
const startWaiting = async (
  env: Env,
  db: AdminDatabase,
  page: readonly ClientRow[],
  releases: ChannelReleases,
  deploying: number
): Promise<number> => {
  let out = deploying;
  let left = page;
  for (;;) {
    const { start } = planChannel(left, releases, out, false);
    if (start.length === 0) {
      return out;
    }
    const tried = new Set(start);
    // oxlint-disable-next-line no-await-in-loop -- each round fills the slots the last left
    const started = await Promise.all(
      left
        .filter((row) => tried.has(row.id))
        .map(async (row) => {
          const target = targetOf(row, releases);
          return target !== null && (await startDeploy(env, db, row, target));
        })
    );
    out += started.filter(Boolean).length;
    left = left.filter((row) => !tried.has(row.id));
  }
};

/**
 * Reconciles `channel` once. A first pass over its clients settles
 * deploys whose runs ended, counts those still out, and finds whether a
 * client following it failed on its release; a second, while none did,
 * starts deploying the clients waiting, page by page, as many as fit
 * beside those out. One that fails mid-tick stops the claims after it
 * (`claim`).
 */
const reconcileChannel = async (
  env: Env,
  channel: Channel,
  releases: ChannelReleases,
  rolledOut: RolledOut | null
): Promise<void> => {
  const db = adminDatabase(env.DB);
  let deploying = 0;
  let failed = false;
  await eachPage(db, channel, rolledOut, async (page): Promise<"next"> => {
    const rows = await Promise.all(
      page.map(async (row) => await settled(env, db, row))
    );
    deploying += rows.filter(
      (row) => stateOf(row, releases) === "deploying"
    ).length;
    failed ||= rows.some((row) => failsChannel(row, releases));
    return "next";
  });
  if (failed) {
    return;
  }
  await eachPage(db, channel, rolledOut, async (page) => {
    deploying = await startWaiting(env, db, page, releases, deploying);
    return deploying >= parallelDeploys ? "stop" : "next";
  });
};

/** The one lease's id. */
const leaseId = "reconciler";

/**
 * Takes the reconciler's lease for tick `holder`, and returns whether it
 * did: one statement, so of ticks at once one gets it, and only from no
 * one or a holder whose lease expired.
 */
const takeLease = async (
  db: AdminDatabase,
  holder: string
): Promise<boolean> => {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseMs);
  const taken = await db
    .insert(reconcilerLease)
    .values({ id: leaseId, holder, expiresAt })
    .onConflictDoUpdate({
      target: reconcilerLease.id,
      set: { holder, expiresAt },
      setWhere: lte(reconcilerLease.expiresAt, now),
    })
    .returning({ holder: reconcilerLease.holder });
  return taken.length > 0;
};

/** Gives tick `holder`'s lease back: only while it's still its own. */
const giveLeaseBack = async (
  db: AdminDatabase,
  holder: string
): Promise<void> => {
  await db
    .delete(reconcilerLease)
    .where(
      and(eq(reconcilerLease.id, leaseId), eq(reconcilerLease.holder, holder))
    );
};

/**
 * The reconciler's tick: every channel in turn, each logged and left on
 * its own failure, while it holds the lease. Nothing while another tick
 * holds it, or while the admin has no CLIENT_DOMAIN, so no client can be
 * deployed.
 */
export const reconcile = async (env: Env): Promise<void> => {
  if (clientDomain(env) === null) {
    return;
  }
  const db = adminDatabase(env.DB);
  const holder = crypto.randomUUID();
  if (!(await takeLease(db, holder))) {
    return;
  }
  try {
    const releases = await channelReleases(db);
    const rolledOut = await rolledOutPrints(db);
    for (const channel of channelIds) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one channel at a time
        await reconcileChannel(env, channel, releases, rolledOut);
      } catch (error) {
        log.error("reconcile.channel_failed", {
          channel,
          error: errorCode(error),
        });
      }
    }
  } finally {
    await giveLeaseBack(db, holder);
  }
};
