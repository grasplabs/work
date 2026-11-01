import { agentErrors } from "@grasp-os/shared/agent";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { buildLeases } from "./db/core/schema.ts";
import { busyRetryAfterSeconds } from "./workflows/admission.ts";

// How many build jobs build at once: a fixed number for the whole
// deployment ({@link buildsAtOnce}); core runs once per client. Each step
// that builds (a job's check, its commit) holds a lease, a row of
// `build_leases`, taken by one conditional statement that counts the
// leases held as it runs, so two admissions never both take the last one.
// A job with no lease free sleeps and asks again (build-jobs.ts): nothing
// is queued, and nothing is ordered.
//
// Two jobs of one App may build at once: each commit is over the version
// its check read, and the App's versions are unique, so the second one to
// commit fails with `app.conflict` (apps.ts, `proposeDraft`) rather than
// landing over the first.
//
// A lease never outlives its step for long: it counts only while the step
// renews it ({@link renewEveryMs}, each time up to {@link renewedForMs}
// ahead), never past {@link maxLeaseMs} after it was taken, and a step
// that ends gives it back at once (`settle`, in a `finally`). A renewal
// holds only by the database's clock as it runs, and never once another
// lease was taken after it would have ended (`stillHolds`), so a late
// renewal never takes back a lease that lapsed. A step whose lease is
// lost stops (`holding`), for the engine to try again.

/** Build jobs building at once in the whole deployment. */
export const buildsAtOnce = 2;

/** The longest a lease is taken for at once: renewed before it ends. */
export const renewedForMs = 60_000;

/** How often a building step renews its lease. */
export const renewEveryMs = 20_000;

/**
 * The longest a lease counts for after it was taken, renewed or not: the
 * longest a build job's step may run (build-jobs.ts, `stepConfig`).
 */
export const maxLeaseMs = 10 * 60_000;

/** The longest a job waits for a lease in all before it fails. */
export const maxBuildWaitMs = 60 * 60_000;

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

/** A lease a job's step holds while it builds. */
export interface BuildLease {
  /**
   * Takes it {@link renewedForMs} further, never past its cap: `held` if it
   * still holds, `lost` if it no longer does, and `unknown` if the
   * database couldn't say. Never throws.
   */
  renew: () => Promise<"held" | "lost" | "unknown">;
  /** Gives it back, once; never throws. */
  settle: () => Promise<void>;
}

/** A whole number of core's own as a literal. */
const literal = (value: number): SQL => sql.raw(String(Math.trunc(value)));

/** The lease of job `job`'s step at `seq`. */
const leaseIs = (job: string, seq: number) =>
  and(eq(buildLeases.jobId, job), eq(buildLeases.seq, seq));

/** The database's clock as the statement runs, in milliseconds. */
const databaseNow = sql`CAST(unixepoch('subsec') * 1000 AS INTEGER)`;

/**
 * That the lease of job `job`'s step at `seq` still holds as the statement
 * runs, by the database's clock, never the Worker's: unsettled, not
 * ended, and no lease taken since it would have ended, which may have
 * taken its place. So a renewal delayed past its lease's end never
 * revives it beside the job that took its place since.
 */
const stillHolds = (job: string, seq: number) =>
  and(
    leaseIs(job, seq),
    isNull(buildLeases.settledAt),
    sql`${buildLeases.admittedAt} + ${buildLeases.reservedMs} > ${databaseNow}`,
    sql`NOT EXISTS (SELECT 1 FROM build_leases AS o WHERE o.admitted_at >= ${buildLeases.admittedAt} + ${buildLeases.reservedMs} AND NOT (o.job_id = ${job} AND o.seq = ${literal(seq)}))`
  );

/** How long a settled or lapsed lease is kept before it is dropped. */
const leaseKeptMs = 24 * 60 * 60_000;

/** The lease of job `job`'s step at `seq`, as `admitBuild` hands it back. */
const leaseOf = (
  db: DrizzleD1Database,
  job: string,
  seq: number
): BuildLease => {
  let settled = false;
  return {
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
          .where(stillHolds(job, seq))
          .returning({ seq: buildLeases.seq });
        return renewed.length > 0 ? "held" : "lost";
      } catch (error) {
        log.warn("build.lease_renew_failed", {
          jobId: job,
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
          .where(and(leaseIs(job, seq), isNull(buildLeases.settledAt)));
      } catch (error) {
        // It lapses within `renewedForMs`, as it is renewed no more.
        log.warn("build.lease_settle_failed", {
          jobId: job,
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
 * Renews `lease` while `run` runs, then gives it back, however `run`
 * ends. Once the lease is lost (another job may hold its place now), or
 * no renewal went through for as long as one lasts, the step stops
 * waiting for `run` and fails, for the engine to try again, which waits
 * for a lease: nothing `run` makes after is used.
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

/** What a job's step brings to its admission. */
export interface BuildAsk {
  /** Its sequence (`buildSeqOf`). */
  seq: number;
  /** How long it has waited for a lease in all: its rounds' waits added up. */
  waitedMs: number;
}

/**
 * Admits the step at `ask.seq` of build job `job`: a lease, if fewer than
 * {@link buildsAtOnce} are held, until it settles or stops renewing, never
 * past {@link maxLeaseMs}; the same step admitted again holds the one
 * lease. Else the seconds to wait before it asks again. Throws, holding
 * nothing, `agent.build_queue_timeout` once it has waited
 * {@link maxBuildWaitMs}.
 */
export const admitBuild = async (
  env: Pick<Env, "DB">,
  job: string,
  { seq, waitedMs }: BuildAsk
): Promise<{ lease: BuildLease } | { retryAfterSeconds: number }> => {
  if (waitedMs >= maxBuildWaitMs) {
    throw agentErrors.create("agent.build_queue_timeout");
  }
  const db = drizzle(env.DB);
  // The database's clock, as renewals read it (`stillHolds`), never the
  // Worker's: so what admission counts as held and what a holder counts
  // as held agree. Read before the statement that takes the lease, so a
  // lease that ends meanwhile is counted held a moment longer, never
  // shorter.
  const now = await databaseTime(db);
  const held = sql`(SELECT count(*) FROM build_leases AS h WHERE h.settled_at IS NULL AND h.admitted_at > ${literal(now - maxLeaseMs)} AND h.admitted_at + h.reserved_ms > ${literal(now)})`;
  const written = await db.batch([
    db
      .delete(buildLeases)
      .where(lte(buildLeases.admittedAt, new Date(now - leaseKeptMs))),
    // The lease, only while one is free: one statement, so no other
    // admission comes between the count and the hold.
    db
      .insert(buildLeases)
      .select(
        sql`SELECT ${job}, ${seq}, ${now}, ${renewedForMs}, NULL WHERE ${held} < ${literal(buildsAtOnce)}`
      )
      .onConflictDoNothing(),
    db
      .select({ seq: buildLeases.seq })
      .from(buildLeases)
      .where(
        and(
          leaseIs(job, seq),
          isNull(buildLeases.settledAt),
          sql`${buildLeases.admittedAt} + ${buildLeases.reservedMs} > ${literal(now)}`
        )
      ),
  ]);
  // Held now: taken by this call, or by an earlier one of the same step.
  return written[2].length > 0
    ? { lease: leaseOf(db, job, seq) }
    : { retryAfterSeconds: busyRetryAfterSeconds };
};
