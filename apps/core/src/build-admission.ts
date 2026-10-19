import { agentErrors } from "@grasp-os/shared/agent";
import { errorFields, log } from "@grasp-os/shared/log";
import type { QuotaPolicy } from "@grasp-os/shared/quota-policy";
import { executionErrors } from "@grasp-os/shared/workflows";
import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import {
  buildAdmissionQueue,
  buildCommitFences,
  buildLeases,
} from "./db/core/schema.ts";
import {
  admissionCounts,
  askAgainMs,
  placesOf,
  queueLiveMs,
  roomFor,
  sharesRowSchema,
  waitOf,
} from "./workflows/admission.ts";
import type {
  AdmissionScope,
  Pool,
  QueuePlace,
  Shares,
  Standing,
} from "./workflows/admission.ts";
import { policyStill, quotaPolicy, stillCurrent } from "./workflows/quotas.ts";

// Fair admission of build jobs (spec 18.3, 40.5): how many of the client's
// build jobs build at once, in all and of one App, each against its share
// in the quota policy (`tenantBuildJobs`, `keyBuildJobs`), and in what
// order the jobs waiting get one. Not a mechanism of its own: the pool of
// workflow attempts' (workflows/admission.ts), with tables of its own. A
// lease is a row of `build_leases`, taken by one conditional statement
// whose condition is the one ordering rule both pools share
// (`servedInOrder`), and the jobs waiting are a persistent queue
// (`build_admission_queue`). Nothing is counted in memory. The key a job
// is held to is its App: one App's jobs build one at a time, whoever
// submitted them. The client is the tenant: core runs once per client.
//
// From the threat model, each way a build could get more than its share,
// keep another from its own, or outlive its lease, and what closes it:
//
// - One App's burst taking the client's builds: an App's share is below
//   the client's (one less, at least, `buildSharesOf`), so one App always
//   leaves room for another.
// - One person's burst, over as many Apps as they build, taking the
//   client's builds: a person's share is below the client's too, and a
//   person's places take turns across the whole client, not per App
//   (`buildNextTurn`), so another person's job is served before the first
//   person's later ones, whichever Apps they are in.
// - The same key building twice at once: an App's share is one by
//   default, checked in the statement that takes the lease. A job's step
//   tried again while an earlier attempt of it still holds its lease (cut
//   off, its isolate maybe still running) waits for that lease like any
//   other job of the App: a lease is never taken over, only given back or
//   lapsed.
// - Two admissions racing for the last share: the lease is taken by one
//   conditional statement, which counts the leases as they stand then.
// - Queue jumping and head-of-line blocking: within a turn, first come,
//   first served; a job is admitted only if serving the queue in order
//   now would admit it, each place ahead taking a lease if its App and
//   the client have room after those before it, passed over if not. A
//   job behind a full App doesn't wait for that App, and a newcomer never
//   takes a share a job ahead of it would. People take turns (`turn`):
//   each person's places, in all their Apps, one turn after another.
// - A lease leaked by a step that died, or core: a lease counts only
//   while its step renews it (`renewEveryMs`, each time up to
//   {@link renewedForMs} ahead), and never past {@link maxLeaseMs} after
//   it was taken, the step's timeout, whatever renews it. A step that
//   ends gives it back at once (`settle`, in a `finally`). A dead step's
//   lease comes back within {@link renewedForMs}.
// - A step still running past its lease (it stalled, so it didn't renew):
//   it commits nothing. Its commit's transaction opens with a fence the
//   database refuses unless the lease still holds as that transaction runs
//   (`fence`, migration 0091), so a job that took the App's share since
//   never builds beside a commit of it, however late the commit's write.
// - A renewal delayed past its lease's end reviving it: a renewal, like the
//   fence, holds only by the database's clock as it runs, and never once
//   another lease was taken after it would have ended (`stillHolds`).
// - A late admission of an older step or attempt of a job: a job's steps
//   and attempts are ordered by its own sequence (`seq`: its step, the
//   round it asks in, and the engine's attempt). One older than a lease or
//   a place the job took since takes no lease and writes no place
//   (`execution.stale_attempt`), in the statements that would.
// - A dead waiter holding its place for ever: a place lasts only while its
//   job asks again (`queueLiveMs`), within its backoff (five seconds
//   doubling to a minute, `askAgainMs`).
// - Waiting for ever: a job waits {@link maxBuildWaitMs} in all at most,
//   then fails (`agent.build_queue_timeout`), spending none of its
//   retries.
// - A queue so long admission overloads core's database: a person, and an
//   App, may have so many places at once ({@link buildQueuedPerPerson},
//   {@link buildQueuedPerKey}); past them a job fails
//   (`agent.build_queue_full`), not queued.
// - A fake identity for an extra share: a job's person and App come from
//   its record in its chat's Workspace object (build-jobs.ts), never from
//   the agent's code.
// - A forged retry-after: core says when to ask again, from the leases it
//   holds; asking sooner moves no one up the queue. What a job's view shows
//   is its own place only (`queuedJob`): never who else waits, nor how
//   many, nor where.
// - A policy change missed: the shares are read from the policy at each
//   admission, and the statement that takes a lease takes none under a
//   policy a newer generation replaced since it was read (`stillCurrent`):
//   it reads the policy again and tries again, once.
//
// What a job waiting for a share shows: `queued` in its view, with the
// share it waits for and when it asks again, and once each time it joins
// the queue, `build.job.queued` in the audit log (build-jobs.ts).

/** The share of build jobs a job waits for: the client's, or its App's. */
export type BuildShare = "client" | "person" | "key";

/** The longest a lease is taken for at once: renewed before it ends. */
export const renewedForMs = 60_000;

/** How often a building step renews its lease. */
export const renewEveryMs = 20_000;

/**
 * The longest a lease counts for after it was taken, renewed or not: the
 * longest a build job's step may run (build-jobs.ts, `stepConfig`).
 */
export const maxLeaseMs = 10 * 60_000;

/** The longest a job waits for a share in all before it fails. */
export const maxBuildWaitMs = 60 * 60_000;

/** The places one person's build jobs may hold at once. */
export const buildQueuedPerPerson = 16;

/** The places one App's build jobs may hold at once. */
export const buildQueuedPerKey = 32;

/**
 * Build jobs: leases in `build_leases`, places in
 * `build_admission_queue`, as the shared ordering rule reads them. A job
 * holds one place at most, its own (`step_hash` empty).
 */
const buildPool: Pool = {
  leases: sql.raw("build_leases"),
  queue: sql.raw(
    "(SELECT job_id AS run_id, '' AS step_hash, subject, resource, enqueued_at, seen_at, turn FROM build_admission_queue)"
  ),
  leaseMs: maxLeaseMs,
};

/**
 * The shares of `policy`: a person's and an App's below the client's, so
 * neither one person, however many Apps they build, nor one App takes
 * every build at once.
 */
export const buildSharesOf = (policy: QuotaPolicy): Shares => {
  const client = policy.limits.tenantBuildJobs;
  // With one build at once for the whole client there is nothing to leave
  // over: that one is anyone's.
  const most = Math.max(1, client - 1);
  return {
    client,
    person: most,
    app: Math.min(policy.limits.keyBuildJobs, most),
    queuedPerPerson: buildQueuedPerPerson,
    queuedPerApp: buildQueuedPerKey,
  };
};

/** The steps of a job that take a lease, in the order they run. */
const stepOrder = { check: 1, commit: 2 } as const;

export type BuildStep = keyof typeof stepOrder;

/** Rounds of one step, and attempts of one round, a sequence has room for. */
const roundsPerStep = 1_000_000;
const attemptsPerRound = 1000;

/**
 * A job's sequence at `step`, in the round it asks in (`round`, from 1,
 * the engine's occurrence of the step) and the engine's `attempt` (from
 * 1): later steps, rounds and attempts are higher.
 */
export const buildSeqOf = (
  step: BuildStep,
  round: number,
  attempt: number
): number =>
  (stepOrder[step] * roundsPerStep + Math.min(round, roundsPerStep - 1)) *
    attemptsPerRound +
  Math.min(attempt, attemptsPerRound - 1);

/** Whose build job a step is: its job, its person and its App. */
export interface BuildOwner extends AdmissionScope {
  job: string;
}

/** A lease a job's step holds while it builds. */
export interface BuildLease {
  /**
   * Whether it still holds now (`stillHolds`): for reading only. What
   * guards a commit is its `fence`, in the commit's own transaction.
   */
  held: () => Promise<boolean>;
  /**
   * Fences a commit by the lease: the statement to write first in the
   * commit's transaction, which the database refuses, failing the whole
   * transaction, unless the lease still holds then; and the one to write
   * last, which removes it.
   */
  fence: () => { open: BatchItem<"sqlite">; close: BatchItem<"sqlite"> };
  /**
   * Takes it {@link renewedForMs} further, never past its cap: `held` if it
   * still holds, `lost` if it no longer does, and `unknown` if the
   * database couldn't say. Never throws.
   */
  renew: () => Promise<"held" | "lost" | "unknown">;
  /** Gives it back, once; never throws. */
  settle: () => Promise<void>;
}

/** A job's refusal for want of a share: queued, and when it asks again. */
export interface BuildWait {
  waitingFor: BuildShare;
  retryAfterSeconds: number;
  /** Whether this refusal took it a place: the first time it waits since. */
  joined: boolean;
}

/** A whole number of core's own as a literal: D1 binds at most 100 parameters. */
const literal = (value: number): SQL => sql.raw(String(Math.trunc(value)));

/** The lease of `owner`'s step at `seq`. */
const leaseIs = (owner: BuildOwner, seq: number) =>
  and(eq(buildLeases.jobId, owner.job), eq(buildLeases.seq, seq));

/** That the lease of `owner`'s step at `seq` holds at `now`, as SQL. */
const holdsAt = (owner: BuildOwner, seq: number, now: number) =>
  and(
    leaseIs(owner, seq),
    isNull(buildLeases.settledAt),
    sql`${buildLeases.admittedAt} + ${buildLeases.reservedMs} > ${literal(now)}`
  );

/** The database's clock as the statement runs, in milliseconds. */
const databaseNow = sql`CAST(unixepoch('subsec') * 1000 AS INTEGER)`;

/**
 * That `owner`'s job took a lease, or wrote its place, at a step or an
 * attempt newer than `seq`: an admission at `seq` is late, and the job
 * has gone on without it.
 */
const newerThan = (owner: BuildOwner, seq: number): SQL =>
  sql`(EXISTS (SELECT 1 FROM build_leases AS n WHERE n.job_id = ${owner.job} AND n.seq > ${literal(seq)}) OR EXISTS (SELECT 1 FROM build_admission_queue AS n WHERE n.job_id = ${owner.job} AND n.owner_seq > ${literal(seq)}))`;

/**
 * That the lease of `owner`'s step at `seq` still holds as the statement
 * runs, by the database's clock, never the Worker's: unsettled, not
 * ended, and no lease taken since it would have ended, which may have
 * taken its share. So a renewal or a commit delayed past its lease's end
 * never revives it beside the job that took its share since. As the
 * commit's fence checks it (migration 0091, `build_commit_fences_held`).
 */
const stillHolds = (owner: BuildOwner, seq: number) =>
  and(
    leaseIs(owner, seq),
    isNull(buildLeases.settledAt),
    sql`${buildLeases.admittedAt} + ${buildLeases.reservedMs} > ${databaseNow}`,
    sql`NOT EXISTS (SELECT 1 FROM build_leases AS o WHERE o.admitted_at >= ${buildLeases.admittedAt} + ${buildLeases.reservedMs} AND NOT (o.job_id = ${owner.job} AND o.seq = ${literal(seq)}))`,
    // Nor once a newer step or attempt of the job went on without it.
    sql`NOT ${newerThan(owner, seq)}`
  );

/**
 * How long a settled or lapsed lease is kept: past the longest a job can
 * live (its wait, then each step's attempts), so a late attempt of a job
 * still finds the newer leases it took since (`newerThan`).
 */
const leaseKeptMs = 24 * 60 * 60_000;

/** The lease of `owner`'s step at `seq`, as `admitBuild` hands it back. */
const leaseOf = (
  db: DrizzleD1Database,
  owner: BuildOwner,
  seq: number
): BuildLease => {
  let settled = false;
  return {
    held: async () => {
      const [row] = await db
        .select({ seq: buildLeases.seq })
        .from(buildLeases)
        .where(stillHolds(owner, seq));
      return row !== undefined;
    },
    fence: () => ({
      open: db.insert(buildCommitFences).values({ jobId: owner.job, seq }),
      close: db
        .delete(buildCommitFences)
        .where(
          and(
            eq(buildCommitFences.jobId, owner.job),
            eq(buildCommitFences.seq, seq)
          )
        ),
    }),
    renew: async () => {
      if (settled) {
        return "lost";
      }
      try {
        // Up to `renewedForMs` from now, never past its cap; only while it
        // still holds, as the update runs: a lease that lapsed is lost,
        // never taken back.
        const renewed = await db
          .update(buildLeases)
          .set({
            reservedMs: sql`min(${maxLeaseMs}, ${databaseNow} + ${renewedForMs} - ${buildLeases.admittedAt})`,
          })
          .where(stillHolds(owner, seq))
          .returning({ seq: buildLeases.seq });
        return renewed.length > 0 ? "held" : "lost";
      } catch (error) {
        log.warn("build.lease_renew_failed", {
          jobId: owner.job,
          ...errorFields(error),
        });
        return "unknown";
      }
    },
    settle: async () => {
      settled = true;
      try {
        await db
          .update(buildLeases)
          .set({ settledAt: new Date() })
          .where(and(leaseIs(owner, seq), isNull(buildLeases.settledAt)));
      } catch (error) {
        // It lapses within `renewedForMs`, as it is renewed no more.
        log.warn("build.lease_settle_failed", {
          jobId: owner.job,
          ...errorFields(error),
        });
      }
    },
  };
};

/** How often a building step checks whether its lease is due a renewal. */
const renewTickMs = 1000;

/** Waits `ms`, or until `signal` stops it, saying which. */
const untilOrStopped = async (
  ms: number,
  signal: AbortSignal
): Promise<"ended" | "stopped"> => {
  try {
    await scheduler.wait(Math.max(0, ms), { signal });
    return "ended";
  } catch {
    return "stopped";
  }
};

/** What a step's run comes to once its lease is lost: nothing it made. */
const lostLease: unique symbol = Symbol("lost lease");
type Lost = typeof lostLease;

/**
 * Renews `lease` while `run` runs (build-admission.ts), then gives it
 * back, however `run` ends. Once the lease is lost (another job may hold
 * its share now), or no renewal went through for as long as one lasts,
 * the step stops waiting for `run` and fails, for the engine to try again,
 * which waits for its share: nothing `run` makes after is used.
 */
export const holding = async <T>(
  lease: BuildLease,
  /** Given a signal aborted once the lease is lost. */
  run: (lost: AbortSignal) => Promise<T>
): Promise<T> => {
  const stop = new AbortController();
  const lostLeaseSignal = new AbortController();
  const { promise: lost, resolve: lose } = Promise.withResolvers<Lost>();
  // Renewed once before anything is built, by the database's clock: an
  // admission that took long to answer may hand back a lease that already
  // ended, or nearly.
  const askedAt = Date.now();
  const first = await Promise.race([
    lease.renew(),
    untilOrStopped(renewedForMs, stop.signal),
  ]);
  if (first !== "held") {
    await lease.settle();
    throw new Error("The build job's step lost its lease");
  }
  const renewing = (async () => {
    let confirmedAt = askedAt;
    let renewedAt = askedAt;
    while (!stop.signal.aborted) {
      try {
        // Short ticks, renewing once one is due: a long timer in a step
        // can fire late (workerd), and a renewal must not.
        // oxlint-disable-next-line no-await-in-loop -- one tick after another
        await scheduler.wait(renewTickMs, { signal: stop.signal });
      } catch {
        // Stopped: `run` has ended.
        return;
      }
      if (Date.now() - renewedAt < renewEveryMs) {
        continue;
      }
      renewedAt = Date.now();
      // A renewal that doesn't answer before the lease would end, as last
      // confirmed, counts as lost: whatever becomes of it, it never
      // revives the lease once given back (`stillHolds`).
      // oxlint-disable-next-line no-await-in-loop -- one renewal after another
      const state = await Promise.race([
        lease.renew(),
        untilOrStopped(confirmedAt + renewedForMs - Date.now(), stop.signal),
      ]);
      if (state === "stopped") {
        return;
      }
      if (state === "held") {
        // From when it was asked: the lease ends no sooner than that.
        confirmedAt = renewedAt;
      }
      if (
        state === "lost" ||
        state === "ended" ||
        Date.now() - confirmedAt >= renewedForMs
      ) {
        lostLeaseSignal.abort(new Error("The build job's step lost its lease"));
        lose(lostLease);
        return;
      }
    }
  })();
  try {
    const ran = await Promise.race([run(lostLeaseSignal.signal), lost]);
    if (ran === lostLease) {
      throw new Error("The build job's step lost its lease");
    }
    return ran;
  } finally {
    stop.abort();
    // The renewal loop stopped before the lease is given back; a renewal
    // still under way that lands after takes nothing back (`stillHolds`).
    await renewing;
    await lease.settle();
  }
};

/**
 * The turn a new place of `owner`'s person takes at `now`: one past the
 * latest of their places still waiting, in any App, the first when none
 * is. Across the client, not per App: a person with jobs in many Apps
 * takes one turn at a time, as anyone else.
 */
const buildNextTurn = (owner: BuildOwner, now: number): SQL =>
  sql`(SELECT coalesce(max(p.turn) + 1, 0) FROM build_admission_queue AS p WHERE p.seen_at > ${literal(now - queueLiveMs)} AND p.subject = ${owner.subject})`;

/**
 * Where `owner`'s job stands in the queue: its place's turn and when it
 * joined, if it holds one still; if it doesn't, `now`, behind everyone
 * waiting, and the turn it would take.
 */
const standingOf = async (
  db: DrizzleD1Database,
  owner: BuildOwner,
  now: number
): Promise<Standing> => {
  const queue = buildAdmissionQueue;
  const [mine, theirs] = await db.batch([
    db
      .select({ turn: queue.turn, enqueuedAt: queue.enqueuedAt })
      .from(queue)
      .where(
        and(
          eq(queue.jobId, owner.job),
          gt(queue.seenAt, new Date(now - queueLiveMs))
        )
      ),
    db
      .select({ next: sql<number>`${buildNextTurn(owner, now)}` })
      .from(sql`(SELECT 1)`),
  ]);
  const [held] = mine;
  if (held !== undefined) {
    return { turn: held.turn, joined: held.enqueuedAt.getTime() };
  }
  return { turn: theirs[0]?.next ?? 0, joined: now };
};

/** The places that stopped asking by `now`, dropped. */
const queuePruned = (db: DrizzleD1Database, now: number) =>
  db
    .delete(buildAdmissionQueue)
    .where(lte(buildAdmissionQueue.seenAt, new Date(now - queueLiveMs)));

/** The database's clock now, in milliseconds. */
const databaseTime = async (db: DrizzleD1Database): Promise<number> => {
  const [row] = await db
    .select({ now: sql<number>`${databaseNow}` })
    .from(sql`(SELECT 1)`);
  if (row === undefined) {
    throw new Error("The database didn't say what time it is");
  }
  return row.now;
};

/** The leases taken longer ago than they are kept, dropped. */
const leasesPruned = (db: DrizzleD1Database, now: number) =>
  db
    .delete(buildLeases)
    .where(lte(buildLeases.admittedAt, new Date(now - leaseKeptMs)));

/** A share as the shared ordering rule names it, as a build job's. */
const buildShareOf = (share: "client" | "person" | "app"): BuildShare =>
  share === "app" ? "key" : share;

/** What a refused admission found, and how long its job has waited. */
interface Refused {
  owner: BuildOwner;
  seq: number;
  now: number;
  shares: Shares;
  read: unknown;
  waited: number;
  waitedMs: number;
}

/**
 * The refusal of `owner`'s step at `seq` for want of a share, as `read`
 * found the shares, having queued it or kept its place. Throws
 * `agent.build_queue_full`, queuing nothing, when its person or its App
 * has as many places as it may, and `execution.stale_attempt` when the
 * job has gone on without this step.
 */
const queued = async (
  db: DrizzleD1Database,
  { owner, seq, now, shares, read, waited, waitedMs }: Refused
): Promise<BuildWait> => {
  const rows = z.array(sharesRowSchema).safeParse(read).data;
  const found = waitOf(rows?.[0], shares, now);
  const waitingFor = buildShareOf(found.waitingFor);
  const retryAt = new Date(
    now +
      askAgainMs({
        waited,
        waitedMs,
        maxWaitMs: maxBuildWaitMs,
      })
  );
  const queue = buildAdmissionQueue;
  const mine = eq(queue.jobId, owner.job);
  const fresh = sql`NOT ${newerThan(owner, seq)}`;
  const written = await db.batch([
    // A place that lapsed is lost: the job joins at the back.
    db
      .delete(queue)
      .where(and(mine, lte(queue.seenAt, new Date(now - queueLiveMs)))),
    db
      .update(queue)
      .set({ seenAt: new Date(now), waitingFor, retryAt, ownerSeq: seq })
      .where(and(mine, lte(queue.ownerSeq, seq), fresh)),
    // A new place, within its person's and its App's.
    db
      .insert(queue)
      .select(
        sql`SELECT ${owner.job}, ${owner.subject}, ${owner.resource}, ${now}, ${now}, ${waitingFor}, ${retryAt.getTime()}, ${buildNextTurn(owner, now)}, ${seq} WHERE ${fresh} AND NOT EXISTS (SELECT 1 FROM build_admission_queue AS m WHERE m.job_id = ${owner.job}) AND ${placesOf(buildPool, sql`p.subject = ${owner.subject}`, now)} < ${literal(shares.queuedPerPerson)} AND ${placesOf(buildPool, sql`p.resource = ${owner.resource}`, now)} < ${literal(shares.queuedPerApp)}`
      )
      .onConflictDoNothing()
      .returning({ jobId: queue.jobId }),
    db
      .select({ jobId: queue.jobId })
      .from(queue)
      .where(and(mine, eq(queue.ownerSeq, seq))),
    db
      .select({ stale: sql<number>`${newerThan(owner, seq)}` })
      .from(sql`(SELECT 1)`),
  ]);
  if ((written[4][0]?.stale ?? 0) !== 0) {
    throw executionErrors.create("execution.stale_attempt");
  }
  if (written[3].length === 0) {
    throw agentErrors.create("agent.build_queue_full");
  }
  return {
    waitingFor,
    retryAfterSeconds: found.retryAfterSeconds,
    joined: written[2].length > 0,
  };
};

/**
 * Gives up the place of `owner`'s job, unless a newer step or attempt of
 * it wrote it: the job waits for a share no more. Never throws: a place
 * left behind lapses (`queueLiveMs`).
 */
export const buildDequeued = async (
  env: Pick<Env, "DB">,
  owner: Pick<BuildOwner, "job">,
  seq: number
): Promise<void> => {
  try {
    await drizzle(env.DB)
      .delete(buildAdmissionQueue)
      .where(
        and(
          eq(buildAdmissionQueue.jobId, owner.job),
          lte(buildAdmissionQueue.ownerSeq, seq)
        )
      );
  } catch (error) {
    log.warn("build.queue.give_up_failed", {
      jobId: owner.job,
      ...errorFields(error),
    });
  }
};

/** What a job's step brings to its admission. */
export interface BuildAsk {
  /** Its sequence (`buildSeqOf`). */
  seq: number;
  /** The rounds it has waited for a share in a row before this one. */
  waited: number;
  /** How long it has waited for a share in all: its rounds' waits added up. */
  waitedMs: number;
}

/**
 * `admitBuild` under `policy`: refused under a policy a newer generation
 * replaced since it was read, it reads the policy again and tries again
 * under it, once.
 */
const admitBuildOnce = async (
  env: Pick<Env, "DB" | "QUOTA_LIMITS">,
  owner: BuildOwner,
  { seq, waited, waitedMs }: BuildAsk,
  policy: QuotaPolicy,
  retried: boolean
): Promise<{ lease: BuildLease } | { wait: BuildWait }> => {
  const db = drizzle(env.DB);
  const shares = buildSharesOf(policy);
  // The database's clock, as renewals and the commit's fence read it
  // (`stillHolds`), never the Worker's: so what admission counts as held
  // and what a holder counts as held agree, whatever the Worker's clock
  // says. Read before the statement that takes the lease, so a lease that
  // ends meanwhile is counted held a moment longer, never shorter.
  const now = await databaseTime(db);
  const standing = await standingOf(db, owner, now);
  const place: QueuePlace = { runId: owner.job, stepHash: "", deadline: seq };
  const holdsNow = sql`EXISTS (SELECT 1 FROM ${buildLeases} WHERE ${holdsAt(owner, seq, now)})`;
  const written = await db.batch([
    queuePruned(db, now),
    leasesPruned(db, now),
    // The lease, only while every share has room, after those queued
    // before it, and the job hasn't gone on past this step: one statement,
    // so no other admission comes between the check and the hold.
    db
      .insert(buildLeases)
      .select(
        sql`SELECT ${owner.job}, ${seq}, ${owner.subject}, ${owner.resource}, ${now}, ${renewedForMs}, NULL, ${policy.generation} WHERE NOT ${newerThan(owner, seq)} AND ${stillCurrent(policy)} AND ${roomFor(buildPool, owner, place, standing, now, shares)}`
      )
      .onConflictDoNothing(),
    // Admitted, it waits in the queue no more.
    db
      .delete(buildAdmissionQueue)
      .where(
        and(
          eq(buildAdmissionQueue.jobId, owner.job),
          lte(buildAdmissionQueue.ownerSeq, seq),
          holdsNow
        )
      ),
    // Refused, why: the shares as that statement found them, in the same
    // transaction; nothing counted once it is admitted.
    db
      .select(admissionCounts(buildPool, owner, place, standing, now, shares))
      .from(sql`(SELECT 1)`)
      .where(sql`NOT ${holdsNow}`),
    db
      .select({ settledAt: buildLeases.settledAt })
      .from(buildLeases)
      .where(and(leaseIs(owner, seq), sql`${holdsNow}`)),
  ]);
  if (written[5].length > 0) {
    return { lease: leaseOf(db, owner, seq) };
  }
  if (!retried && !(await policyStill(db, policy))) {
    return await admitBuildOnce(
      env,
      owner,
      { seq, waited, waitedMs },
      await quotaPolicy(env),
      true
    );
  }
  return {
    wait: await queued(db, {
      owner,
      seq,
      now,
      shares,
      read: written[4],
      waited,
      waitedMs,
    }),
  };
};

/**
 * Admits the step at `ask.seq` of `owner`'s build job: a lease, if the
 * client's builds and its App's leave it a share after the jobs queued
 * before it, held until it settles or stops renewing, never past
 * {@link maxLeaseMs}; the same step admitted again holds the one lease.
 * Else its wait, having queued it or kept its place. Throws, holding
 * nothing, `execution.stale_attempt` for a step the job has gone on
 * without, `agent.build_queue_full`, or `agent.build_queue_timeout` once
 * it has waited {@link maxBuildWaitMs}.
 */
export const admitBuild = async (
  env: Pick<Env, "DB" | "QUOTA_LIMITS">,
  owner: BuildOwner,
  ask: BuildAsk
): Promise<{ lease: BuildLease } | { wait: BuildWait }> => {
  if (ask.waitedMs >= maxBuildWaitMs) {
    await buildDequeued(env, owner, ask.seq);
    throw agentErrors.create("agent.build_queue_timeout");
  }
  return await admitBuildOnce(env, owner, ask, await quotaPolicy(env), false);
};

/** A job's wait for a share, as its view shows it. */
export interface QueuedJob {
  waitingFor: BuildShare;
  retryAt: string;
}

/**
 * Whether job `job` waits for a share now, and for which, and when it asks
 * again: its own place only, by its key, never who else waits.
 */
export const queuedJob = async (
  env: Pick<Env, "DB">,
  job: string
): Promise<QueuedJob | null> => {
  const [place] = await drizzle(env.DB)
    .select({
      waitingFor: buildAdmissionQueue.waitingFor,
      retryAt: buildAdmissionQueue.retryAt,
    })
    .from(buildAdmissionQueue)
    .where(
      and(
        eq(buildAdmissionQueue.jobId, job),
        gt(buildAdmissionQueue.seenAt, new Date(Date.now() - queueLiveMs))
      )
    );
  return place === undefined
    ? null
    : { waitingFor: place.waitingFor, retryAt: place.retryAt.toISOString() };
};
