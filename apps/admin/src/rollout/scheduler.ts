/**
 * The fleet's rollout pass: a short, stateless pass over the admin's
 * database that takes each active client to its target (src/rollout/desired.ts)
 * as each channel's rollout orders it (src/rollout/plan.ts). Nothing else
 * deploys a release. It runs on the admin's cron every minute
 * (src/server.ts), after an import, and after each staff change
 * (src/rollout/functions.ts). `runRolloutPass` is also the hook an
 * organization's run calls as it ends, to refill the slot it frees at
 * once; until one does, the cron refills it within a minute.
 *
 * Each pass, while it holds the `reconciler` lease (src/db/lease.ts):
 * 1. self-heals each channel's rollout row (`healRollouts`): one the
 *    channel's release lacks is started by `system`, and a live one of
 *    a release the channel no longer has is superseded, as after an older
 *    admin moved a channel;
 * 2. settles deploys whose run ended without recording how (`run_ended`);
 * 3. halts a running rollout or calls it done, its counts kept on its row;
 * 4. starts runs in the plan's order while slots and budget last, each
 *    through `startOrganisationRun`;
 * 5. runs once more when a deploy ended while it ran, so no refill is lost
 *    to the lease: the cron is the backstop, a minute later.
 *
 * Safe to cut off anywhere: it keeps nothing of its own, and acts only
 * through compare-and-set claims on the client (`claim`), each of which
 * also checks that the rollout it's for still runs. A pass that read the
 * client before a run came and went, or a rollout before it halted or was
 * superseded, starts nothing. An older admin's reconciler, during one
 * deploy of the admin, takes the same lease and claims through the same
 * rows: its claims have no rollout, which then neither fill nor halt one,
 * but count against the fleet's slots.
 */
import "@tanstack/react-start/server-only";
import { log } from "@grasp-os/shared/log";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  ne,
  sql,
} from "drizzle-orm";

import { alert } from "../alerts/alert.ts";
import { adminDatabase, auditIfChanged } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import { withLease } from "../db/lease.ts";
import {
  apiBudget,
  auditEvents,
  channels,
  clientDeploys,
  clientPlacements,
  clientProvisions,
  clientRuns,
  clients,
  clientWatch,
  clientWorkers,
  rollouts,
} from "../db/schema.ts";
import { clientDomain } from "../deploy/context.ts";
import { errorCode } from "../deploy/errors.ts";
import { currentRun, hasEnded, instanceStatus } from "../runners.ts";
import { adminWorkflow, adminWorkflows } from "../workflow-runs.ts";
import { channelIds } from "./channel-ids.ts";
import type { Channel } from "./channel-ids.ts";
import { recordEnd } from "./deploy.ts";
import type { DeployParams } from "./deploy.ts";
import { isSecretsBehind } from "./desired.ts";
import type { ChannelReleases, SharedByWorker } from "./desired.ts";
import {
  liveRolloutStatuses,
  planPass,
  platformFaultCodes,
  rateLimitedPrefix,
  rolloutLimits,
} from "./plan.ts";
import type {
  Admission,
  Budget,
  Organization,
  PassFacts,
  PassPlan,
  Rollout,
  RolloutCounts,
} from "./plan.ts";
import { desiredShared } from "./shared-secrets.ts";
import { channelReleases, deliveredShared } from "./targets.ts";

/** How many clients a pass reads at once. */
const pageSize = 200;

/**
 * How long a pass holds its lease: well past a pass's run, and short, so
 * one cut off by the admin's own redeploy holds the next back little.
 */
const passLeaseMs = 2 * 60 * 1000;

/** The deployer token's row in `api_budget`. */
const deployerToken = "DEPLOYER_API_TOKEN";

/**
 * The one release every Worker of the client runs, as SQL: null when it
 * has none, or they run different ones (a deploy stopped between them).
 */
const runningSql = sql<
  string | null
>`(SELECT CASE WHEN COUNT(*) > 0 AND COUNT(${clientWorkers.releaseId}) = COUNT(*) AND COUNT(DISTINCT ${clientWorkers.releaseId}) = 1 THEN MIN(${clientWorkers.releaseId}) END FROM ${clientWorkers} WHERE ${clientWorkers.clientId} = ${clients.id})`;

/** The people on the client's roster, as the hourly watch last read them (src/clients/watch.ts); 0 while unknown. */
const sizeSql = sql<number>`COALESCE((SELECT CASE WHEN json_valid(${clientWatch.signals}) THEN json_extract(${clientWatch.signals}, '$.people') END FROM ${clientWatch} WHERE ${clientWatch.clientId} = ${clients.id}), 0)`;

/** What a page of clients is read as. */
const factColumns = {
  id: clients.id,
  channel: clients.channel,
  pinnedReleaseId: clients.pinnedReleaseId,
  group: clients.rolloutGroup,
  size: sizeSql,
  running: runningSql,
  progress: clientProvisions.progress,
  deployRelease: clientDeploys.releaseId,
  deployStatus: clientDeploys.status,
  deployError: clientDeploys.error,
  deployRolloutId: clientDeploys.rolloutId,
  deployRunId: clientDeploys.runId,
  deployStartedAt: clientDeploys.startedAt,
};

/** A client as a page reads it: its facts, and its deploy's run. */
export interface ClientRow extends Organization {
  run: { runId: string; startedAt: Date } | null;
}

/**
 * Active placed clients following `channel` with an id after `after`, a
 * page of them in id order: what the pass and the pages read.
 */
const clientPage = async (
  db: AdminDatabase,
  channel: Channel,
  after: string | null,
  desired: SharedByWorker | null
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
    .limit(pageSize);
  return rows.map((row) => ({
    id: row.id,
    channel: row.channel,
    pinnedReleaseId: row.pinnedReleaseId,
    group: row.group,
    size: row.size,
    running: row.running,
    secretsBehind: isSecretsBehind(deliveredShared(row.progress), desired),
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
            rolloutId: row.deployRolloutId,
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
  desired: SharedByWorker | null,
  visit: (page: ClientRow[]) => Promise<"stop" | "next"> | "stop" | "next"
): Promise<void> => {
  let after: string | null = null;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one page at a time
    const page = await clientPage(db, channel, after, desired);
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

/** The workflow an organization's run is a run of. */
const organizationRuns = (env: Env) =>
  adminWorkflow<DeployParams>(env, adminWorkflows.deploy);

/**
 * Client `row` once its deploy is settled: one whose run ended without
 * recording how is recorded failed (`run_ended`), and read so; one whose
 * run was never created (a pass cut off between its claim and the run's
 * create) as the platform's fault (`run_not_created`). One whose run
 * can't be read now is logged and read as still deploying: the next pass
 * tries again.
 */
const settled = async (
  env: Env,
  db: AdminDatabase,
  row: ClientRow
): Promise<ClientRow> => {
  if (row.deploy?.status !== "deploying" || row.run === null) {
    return row;
  }
  let code: string;
  try {
    const { status } = await instanceStatus(
      organizationRuns(env),
      row.run.runId,
      row.run.startedAt
    );
    if (!hasEnded(status)) {
      return row;
    }
    code = status === "gone" ? "run_not_created" : "run_ended";
    await recordEnd(
      db,
      {
        clientId: row.id,
        runId: row.run.runId,
        releaseId: row.deploy.releaseId,
      },
      code
    );
  } catch (error) {
    log.error("rollout.settle_failed", {
      clientId: row.id,
      error: errorCode(error),
    });
    return row;
  }
  return {
    ...row,
    deploy: { ...row.deploy, status: "failed", error: code },
  };
};

/**
 * How many organizations failed on rollout `rolloutId`, platform faults
 * aside, as SQL: what the claim reads, so a failure that lands mid-pass
 * stops the claims after the one that halts it (`isHalting`). Of the
 * organizations the pass reads, active and placed, as the plan counts
 * them: one offboarded since never holds a rollout up.
 */
const failedSql = (rolloutId: string) =>
  sql`(SELECT COUNT(*) FROM ${clientDeploys} JOIN ${clients} ON ${clients.id} = ${clientDeploys.clientId} WHERE ${clients.status} = 'active' AND EXISTS (SELECT 1 FROM ${clientPlacements} WHERE ${clientPlacements.clientId} = ${clientDeploys.clientId}) AND ${clientDeploys.rolloutId} = ${rolloutId} AND ${clientDeploys.status} = 'failed' AND COALESCE(${clientDeploys.error}, '') NOT IN (SELECT value FROM json_each(${JSON.stringify(platformFaultCodes)})) AND substr(COALESCE(${clientDeploys.error}, ''), 1, ${rateLimitedPrefix.length}) != ${rateLimitedPrefix})`;

/** A new organization run's id. */
const newRunId = (): string =>
  `deploy-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;

/**
 * Claims client `row` for `admission` by run `runId`, and returns whether
 * it won. One batch, compare-and-set on both claims as read: the client's
 * runner (`client_runs`, replacing `replacing`, a run that ended, or none)
 * and its deploy (`client_deploys`, replacing the row as read, by its
 * run). Either changed since, the client moved channel or pin, or the
 * rollout it's for no longer runs (halted, or superseded by a channel
 * move), and nothing is claimed: the
 * runner claim is undone in the same batch when the deploy's lost.
 */
const claim = async (
  db: AdminDatabase,
  row: ClientRow,
  replacing: string | null,
  runId: string,
  { releaseId, rolloutId }: Admission
): Promise<boolean> => {
  const now = new Date();
  const runner = { runId, kind: "deploy" as const, claimedAt: now };
  const fresh = { attempt: 0, attemptKey: null, step: 0 };
  const takeRunner =
    replacing === null
      ? db
          .insert(clientRuns)
          .values({ clientId: row.id, ...runner, ...fresh })
          .onConflictDoNothing()
      : db
          .update(clientRuns)
          .set({ ...runner, ...fresh })
          .where(
            and(
              eq(clientRuns.clientId, row.id),
              eq(clientRuns.runId, replacing)
            )
          );
  // Its rollout still running; outside one, its target still `releaseId`.
  const rolloutRuns =
    rolloutId === null
      ? sql`COALESCE((SELECT ${clients.pinnedReleaseId} FROM ${clients} WHERE ${clients.id} = ${row.id}), (SELECT ${channels.releaseId} FROM ${channels} WHERE ${channels.id} = ${row.channel})) = ${releaseId}`
      : sql`EXISTS (SELECT 1 FROM ${rollouts} WHERE ${rollouts.id} = ${rolloutId} AND ${rollouts.status} = 'running') AND ${failedSql(rolloutId)} < ${rolloutLimits.failuresToHalt}`;
  // The client as read: on its channel, pinned (or not) as it was.
  const asReadClient = sql`EXISTS (SELECT 1 FROM ${clients} WHERE ${clients.id} = ${row.id} AND ${clients.channel} = ${row.channel} AND ${clients.pinnedReleaseId} IS ${row.pinnedReleaseId})`;
  const claimable = sql`EXISTS (SELECT 1 FROM ${clientRuns} WHERE ${clientRuns.clientId} = ${row.id} AND ${clientRuns.runId} = ${runId}) AND ${rolloutRuns} AND ${asReadClient}`;
  const asRead = row.run?.runId;
  const deploy =
    asRead === undefined
      ? db.insert(clientDeploys).select(
          // Every column, in the table's order.
          sql`SELECT ${row.id}, ${releaseId}, ${runId}, 'deploying', NULL, ${now.getTime()}, NULL, ${rolloutId} WHERE ${claimable} AND NOT EXISTS (SELECT 1 FROM ${clientDeploys} WHERE ${clientDeploys.clientId} = ${row.id})`
        )
      : db
          .update(clientDeploys)
          .set({
            releaseId,
            runId,
            status: "deploying",
            error: null,
            startedAt: now,
            endedAt: null,
            rolloutId,
          })
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
    detail: {
      run: runId,
      ...(rolloutId === null ? {} : { rollout: rolloutId }),
    },
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
  const results = await db.batch([takeRunner, deploy, event, undo]);
  return results[2].length > 0;
};

/**
 * Starts client `row`'s run for `admission`: claimed, then the run
 * created. The one place an organization's run starts. Returns whether
 * it's out: not while another runner (an apply, provisioning) still has
 * the client, when the claim lost, or when the run can't be created,
 * which is recorded failed (`run_not_created`).
 */
export const startOrganisationRun = async (
  env: Env,
  db: AdminDatabase,
  row: ClientRow,
  admission: Admission
): Promise<boolean> => {
  const current = await currentRun(env, row.id);
  if (current !== null && !hasEnded(current.status)) {
    return false;
  }
  const runId = newRunId();
  if (!(await claim(db, row, current?.runId ?? null, runId, admission))) {
    return false;
  }
  const { releaseId } = admission;
  try {
    await organizationRuns(env).create({
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
 * How many runs are out now, every channel together: one count over every
 * active client's deploy. A run that ended without being settled yet
 * still counts, so the count can only be high. An offboarded client's
 * isn't counted: nothing settles it once its client is no longer active.
 */
const deploysOut = async (db: AdminDatabase): Promise<number> => {
  const [row] = await db
    .select({ out: count() })
    .from(clientDeploys)
    .innerJoin(clients, eq(clients.id, clientDeploys.clientId))
    .where(
      and(eq(clientDeploys.status, "deploying"), eq(clients.status, "active"))
    );
  return row?.out ?? 0;
};

/**
 * Gives every channel's release a rollout row, in one batch: a live
 * rollout of a release its channel no longer has is superseded, and a
 * channel whose release has no row but superseded ones gets one, started
 * by `system`. Nothing while every row is as the channels' moves left
 * them, which write their rows in the batch that moves them
 * (src/rollout/channels.ts); this mends what an older admin's moves left.
 */
const healRollouts = async (db: AdminDatabase, now: Date): Promise<void> => {
  await db.batch([
    db
      .update(rollouts)
      .set({ status: "superseded", endedAt: now })
      .where(
        and(
          inArray(rollouts.status, liveRolloutStatuses),
          sql`${rollouts.releaseId} IS NOT (SELECT ${channels.releaseId} FROM ${channels} WHERE ${channels.id} = ${rollouts.channel})`
        )
      ),
    db
      .insert(rollouts)
      .select(
        sql`SELECT lower(hex(randomblob(16))), ${channels.id}, ${channels.releaseId}, 'running', 'system', ${now.getTime()}, NULL, NULL, NULL, 0, 0 FROM ${channels} WHERE NOT EXISTS (SELECT 1 FROM ${rollouts} WHERE ${rollouts.channel} = ${channels.id} AND ${rollouts.releaseId} = ${channels.releaseId} AND ${rollouts.status} != 'superseded')`
      ),
  ]);
};

/** A channel's current rollout, as its row keeps it. */
interface RolloutRow extends Rollout {
  done: number;
  failed: number;
  /** When staff last resumed it; null while they never did. */
  resumedAt: Date | null;
  /** Since when its failures count: when it started, or was last resumed. */
  since: Date;
}

/**
 * Rollout `rollout` still as the pass read it, as SQL: in `status`, and
 * not resumed since, so a resume while the pass ran never meets counts
 * from before it.
 */
const asRead = (rollout: RolloutRow, status: Rollout["status"]) =>
  and(
    eq(rollouts.id, rollout.id),
    eq(rollouts.status, status),
    rollout.resumedAt === null
      ? isNull(rollouts.resumedAt)
      : eq(rollouts.resumedAt, rollout.resumedAt)
  );

/**
 * Each channel's current rollout: its live one of the channel's release,
 * else its latest done one.
 */
const currentRollouts = async (
  db: AdminDatabase,
  releases: ChannelReleases
): Promise<RolloutRow[]> => {
  const rows = await Promise.all(
    channelIds.map(async (channel) => {
      const releaseId = releases[channel];
      if (releaseId === null) {
        return [];
      }
      return await db
        .select()
        .from(rollouts)
        .where(
          and(
            eq(rollouts.channel, channel),
            eq(rollouts.releaseId, releaseId),
            ne(rollouts.status, "superseded")
          )
        )
        .orderBy(desc(rollouts.startedAt));
    })
  );
  return rows.flatMap((ofChannel) => {
    const row =
      ofChannel.find(({ status }) =>
        liveRolloutStatuses.some((live) => live === status)
      ) ?? ofChannel[0];
    if (row === undefined || row.status === "superseded") {
      return [];
    }
    return [
      {
        id: row.id,
        channel: row.channel,
        releaseId: row.releaseId,
        status: row.status,
        done: row.done,
        failed: row.failed,
        resumedAt: row.resumedAt,
        since: row.resumedAt ?? row.startedAt,
      },
    ];
  });
};

/** The deployer token's budget now: unknown without a row, or once its window reset. */
const budgetOf = async (db: AdminDatabase, now: Date): Promise<Budget> => {
  const row = await db
    .select()
    .from(apiBudget)
    .where(eq(apiBudget.token, deployerToken))
    .get();
  return {
    remaining:
      row === undefined || row.resetAt.getTime() <= now.getTime()
        ? null
        : row.remaining,
    blockedUntil: row?.blockedUntil ?? null,
  };
};

/**
 * Alerts that rollout `rollout` halted: once a halt, as `alert` records
 * each halt once, so a pass may say it again (`recordRollouts`) for one
 * whose alert a pass cut off never recorded.
 */
const alertHalt = async (
  db: AdminDatabase,
  rollout: RolloutRow,
  { done, failed }: Pick<RolloutCounts, "done" | "failed">
): Promise<void> => {
  await alert(db, {
    kind: "rollout_halted",
    rolloutId: rollout.id,
    channel: rollout.channel,
    releaseId: rollout.releaseId,
    done,
    failed,
    since: rollout.since.getTime(),
  });
};

/**
 * Halts running rollout `rollout` (`failed`), audited (`rollout.halt`)
 * and alerted once, and says so on its channel (`channels.stopped_by`,
 * which an older admin reads). Nothing when it's no longer as read.
 */
const recordHalt = async (
  db: AdminDatabase,
  rollout: RolloutRow,
  { done, failed }: RolloutCounts
): Promise<void> => {
  const reason = "failed";
  const [, recorded] = await db.batch([
    db
      .update(rollouts)
      .set({ status: "halted", haltedReason: reason, done, failed })
      .where(asRead(rollout, "running")),
    auditIfChanged(db, "system", {
      action: "rollout.halt",
      target: rollout.id,
      detail: {
        channel: rollout.channel,
        release: rollout.releaseId,
        reason,
        done,
        failed,
      },
    }),
    db
      .update(channels)
      .set({ stoppedBy: reason })
      .where(
        and(
          eq(channels.id, rollout.channel),
          sql`EXISTS (SELECT 1 FROM ${rollouts} WHERE ${rollouts.id} = ${rollout.id} AND ${rollouts.status} = 'halted')`
        )
      ),
  ]);
  if (recorded.length > 0) {
    await alertHalt(db, rollout, { done, failed });
  }
};

/** Calls running rollout `rollout` done, audited (`rollout.done`). Nothing when it's no longer as read. */
const recordDone = async (
  db: AdminDatabase,
  rollout: RolloutRow,
  { done, failed }: RolloutCounts,
  now: Date
): Promise<void> => {
  await db.batch([
    db
      .update(rollouts)
      .set({ status: "done", endedAt: now, done, failed })
      .where(asRead(rollout, "running")),
    auditIfChanged(db, "system", {
      action: "rollout.done",
      target: rollout.id,
      detail: {
        channel: rollout.channel,
        release: rollout.releaseId,
        done,
        failed,
      },
    }),
  ]);
};

/** Records what `plan` decided of each current rollout: halted, done, or its counts as they are now. */
const recordRollouts = async (
  db: AdminDatabase,
  current: readonly RolloutRow[],
  plan: PassPlan,
  now: Date
): Promise<void> => {
  const halts = new Set(plan.halt);
  const done = new Set(plan.done);
  for (const rollout of current) {
    const counts = plan.counts.get(rollout.id);
    if (counts === undefined) {
      continue;
    }
    if (halts.has(rollout.id)) {
      // oxlint-disable-next-line no-await-in-loop -- three channels at most
      await recordHalt(db, rollout, counts);
    } else if (done.has(rollout.id)) {
      // oxlint-disable-next-line no-await-in-loop -- as above
      await recordDone(db, rollout, counts, now);
    } else if (
      rollout.status !== "done" &&
      (counts.done !== rollout.done || counts.failed !== rollout.failed)
    ) {
      // oxlint-disable-next-line no-await-in-loop -- as above
      await db
        .update(rollouts)
        .set({ done: counts.done, failed: counts.failed })
        .where(asRead(rollout, rollout.status));
    }
    if (rollout.status === "halted") {
      // Told again each pass, which `alert` records once: a pass cut off
      // between the halt and its alert never loses it.
      // oxlint-disable-next-line no-await-in-loop -- as above
      await alertHalt(db, rollout, counts);
      // Said again each pass: an older admin's reconciler clears it.
      // oxlint-disable-next-line no-await-in-loop -- as above
      await db
        .update(channels)
        .set({ stoppedBy: "failed" })
        .where(
          and(
            eq(channels.id, rollout.channel),
            eq(channels.releaseId, rollout.releaseId),
            isNull(channels.stoppedBy)
          )
        );
    }
  }
};

/**
 * Records that a 429 blocks the deployer token until `until`: audited
 * (`rollout.blocked`) and alerted once a block, however many passes see
 * it. Alerted by each, which `alert` records once: a pass cut off between
 * the two never loses it.
 */
const recordBlocked = async (db: AdminDatabase, until: Date): Promise<void> => {
  const target = until.toISOString();
  await db
    .insert(auditEvents)
    .select(
      sql`SELECT ${crypto.randomUUID()}, ${Date.now()}, 'system', 'rollout.blocked', NULL, ${target}, ${JSON.stringify({ until: target })} WHERE NOT EXISTS (SELECT 1 FROM ${auditEvents} WHERE ${auditEvents.action} = 'rollout.blocked' AND ${auditEvents.target} = ${target})`
    );
  await alert(db, { kind: "rollout_blocked", until: until.getTime() });
};

/**
 * Starts what `facts`' plan admits (`first`), then plans again with what
 * changed, until it admits no one or the pass lost its lease: a client
 * that didn't start (another runner has it, its claim lost) leaves its
 * slot to the next.
 */
const admitAll = async (
  env: Env,
  db: AdminDatabase,
  facts: Omit<PassFacts, "organizations"> & {
    organizations: readonly ClientRow[];
  },
  first: readonly Admission[],
  renew: () => Promise<boolean>
): Promise<void> => {
  const rows = new Map(facts.organizations.map((row) => [row.id, row]));
  const skip = new Set<string>();
  let { inFlight } = facts;
  let admit = first;
  // Each round only while the pass still holds its lease, held longer: one
  // that outlived it starts nothing beside the pass that took it over.
  // oxlint-disable-next-line no-await-in-loop -- one round at a time
  while (admit.length > 0 && (await renew())) {
    // Each on its own: one that throws is logged and passed over, never
    // holding up the rest of the fleet.
    // oxlint-disable-next-line no-await-in-loop -- each round fills the slots the last left
    const started = await Promise.all(
      admit.map(async (admission) => {
        const row = rows.get(admission.clientId);
        if (row === undefined) {
          return false;
        }
        try {
          return await startOrganisationRun(env, db, row, admission);
        } catch (error) {
          log.error("rollout.start_failed", {
            clientId: row.id,
            error: errorCode(error),
          });
          return false;
        }
      })
    );
    for (const [index, admission] of admit.entries()) {
      const row = rows.get(admission.clientId);
      if (started[index] === true && row !== undefined) {
        inFlight += 1;
        rows.set(row.id, {
          ...row,
          deploy: {
            releaseId: admission.releaseId,
            status: "deploying",
            error: null,
            rolloutId: admission.rolloutId,
          },
        });
      } else {
        skip.add(admission.clientId);
      }
    }
    ({ admit } = planPass({
      ...facts,
      organizations: [...rows.values()],
      inFlight,
      skip,
    }));
  }
};

/** One pass over every channel: steps 1 to 4 of the file's comment. */
const passOnce = async (
  env: Env,
  db: AdminDatabase,
  renew: () => Promise<boolean>
): Promise<void> => {
  const now = new Date();
  await healRollouts(db, now);
  const releases = await channelReleases(db);
  // Before the clients: a rollout resumed after this is read as halted,
  // never counted with the failures its resume cleared.
  const current = await currentRollouts(db, releases);
  const desired = await desiredShared(env);
  const organizations: ClientRow[] = [];
  for (const channel of channelIds) {
    // oxlint-disable-next-line no-await-in-loop -- one channel at a time
    await eachPage(db, channel, desired, async (page) => {
      organizations.push(
        ...(await Promise.all(
          page.map(async (row) => await settled(env, db, row))
        ))
      );
      return "next" as const;
    });
  }
  const facts = {
    rollouts: current,
    organizations,
    releases,
    inFlight: await deploysOut(db),
    budget: await budgetOf(db, now),
    now,
  };
  const plan = planPass(facts);
  await recordRollouts(db, current, plan, now);
  if (plan.blocked && facts.budget.blockedUntil !== null) {
    await recordBlocked(db, facts.budget.blockedUntil);
  }
  await admitAll(env, db, facts, plan.admit, renew);
};

/** Whether a deploy ended after `since`: a slot freed while the pass ran. */
const endedSince = async (db: AdminDatabase, since: Date): Promise<boolean> =>
  (await db
    .select({ clientId: clientDeploys.clientId })
    .from(clientDeploys)
    .where(gt(clientDeploys.endedAt, since))
    .limit(1)
    .get()) !== undefined;

/**
 * The rollout pass, while it holds the lease: once, and once more when a
 * deploy ended as it ran. Nothing while another pass (or an older admin's
 * reconciler) holds it, or while the admin has no CLIENT_DOMAIN, so no
 * client can be deployed.
 */
export const rolloutPass = async (env: Env): Promise<void> => {
  if (clientDomain(env) === null) {
    return;
  }
  const db = adminDatabase(env.DB);
  await withLease(db, "reconciler", passLeaseMs, async (renew) => {
    const since = new Date();
    await passOnce(env, db, renew);
    if (await endedSince(db, since)) {
      await passOnce(env, db, renew);
    }
  });
};

/**
 * The pass, as its triggers call it: the cron, an import, a staff change,
 * and an organization's run as it ends, to refill its slot. Never throws:
 * a pass that fails is logged, and the cron runs the next.
 */
export const runRolloutPass = async (env: Env): Promise<void> => {
  try {
    await rolloutPass(env);
  } catch (error) {
    log.error("rollout.pass_failed", { error: errorCode(error) });
  }
};
