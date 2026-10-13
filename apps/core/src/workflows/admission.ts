import { sha256Hex } from "@grasp-os/shared/encoding";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import type { QuotaPolicy } from "@grasp-os/shared/quota-policy";
import { workflowErrors } from "@grasp-os/shared/workflows";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { workflowAdmissionQueue, workflowRuns } from "../db/core/schema.ts";

// Fair admission of workflow attempts (spec 18.3, 40.5): how many of the
// client's workflow attempts run at once, in all, for one person and of
// one App, each against its share in the quota policy
// (`workflowClientAttempts`, `workflowPersonAttempts`,
// `workflowAppAttempts`), and in what order the ones waiting get a share.
// Core's database is the coordinator: an attempt's lineage receipt
// (quotas.ts, `run_lineage_attempts`) is its lease, taken in the same
// statement that checks its shares, and the waiting are a persistent
// queue (`workflow_admission_queue`). The client is the tenant: core runs
// once per client, so its shares are the tenant's.
//
// From the threat model, each way an attempt could get more than its
// share, or keep another from its own, and what closes it:
//
// - Two admissions racing for the last share: the lease is taken by one
//   conditional statement, which counts the leases as they stand then. No
//   count is read first and written after, and nothing is counted in
//   memory.
// - A lease leaked by an attempt that died, or its activation, or core:
//   a lease counts for what its receipt holds (`reserved_ms`), an
//   attempt's wall time after its admission at most, whatever its
//   deadline, so none outlives a minute. An attempt the engine took from
//   an activation that is over (a lower generation of the same step's key)
//   is settled as the new one is admitted (quotas.ts), so a replaced
//   activation's lease never keeps its own retry waiting. One that settles
//   gives its share back at once; a run that pauses or ends gives up its
//   places (runs.ts, `projectStatus`).
// - The same attempt admitted twice: it holds one lease (its receipt's
//   key), so a retried admission is never a second share.
// - A saturated App, or a person running many runs, taking every share:
//   an App's and a person's shares are each below the client's (one less,
//   at least, `sharesOf`), so one App, or one person, always leaves room
//   for others. Several Apps, or several people, together can fill the
//   client's share: then the next waits its turn.
// - One person's backlog in an App keeping another person from it: places
//   are served by turn first (`turn`, one past the latest turn of the
//   same person's places waiting in the same App as it joined, the first
//   when none is), so within an App people take turns, round-robin, and
//   another person's newcomer waits behind one of the backlog's places at
//   most. A person's turns only grow while they have places waiting, so
//   their newer work never passes their older work as places come and go.
// - Starvation and queue jumping: within a turn the waiting are served
//   first come, first served. An attempt is admitted only while the shares
//   it takes leave room for every attempt ahead of it that could run now:
//   one whose App and person are still under their shares. One queued
//   behind a saturated App doesn't wait for that App (no head-of-line
//   blocking, no priority inversion), and a newcomer never takes a share
//   an attempt ahead of it could. What those ahead hold back is never
//   more than what they could take: per person and per App, no more than
//   what is left of its share.
// - A dead waiter holding its place for ever: a place lasts only while
//   the step asks again (`queueLiveMs`), which a waiting run does every
//   minute at least (`askAgainSeconds`); a run that stopped
//   asking (its activation gone) loses it, and joins at the back when it
//   asks again.
// - A queue so long admission overloads core's database: a person, and an
//   App, may have so many places at once (`workflowQueuedPerPerson`,
//   `workflowQueuedPerApp`); past them a step's attempt is refused
//   (`workflow.queue_full`), not queued. Counting is by indexes, in one
//   statement per admission, which counts nothing more once its lease is
//   taken.
// - Waiting for ever, and a journal that grows without bound: a wait
//   spends none of the run's steps (host.ts, `loadWaitStep`), since
//   others' load causes it, but each round adds to the run's journal. So
//   a step waits longer each round, five seconds doubling to a minute
//   (`askAgainSeconds`), and fails once it has waited a day in all
//   (`workflowQueuedStepMs`, `workflow.queue_timeout`), spending none of
//   its retries: at most some 1,450 rounds a step.
// - A fake identity for an extra share: who a run acts for and its App
//   come from its row (dispatcher.ts), never from its input or code, and
//   people are the organization's members, from its identity provider.
//   Runs nobody started (a trigger, mail, a connector event) take a share
//   of their own, their App's triggers' (`trigger:<app>`), held to a
//   person's share, so outsiders sending mail never take the App owner's
//   share; a run started under another keeps its lineage root's.
//   Starting more runs takes no more of any share.
// - A gamed retry-after: core says when to ask again, from the leases it
//   holds, and the run waits that long at most (host.ts); neither a
//   workflow nor a person sets it, and asking sooner moves no one up the
//   queue.
// - A policy change missed: shares are read from the policy at each
//   admission (quotas.ts, `quotaPolicy`), and an admission under an older
//   generation than the highest recorded takes nothing.
// - A database that can't answer: nothing is admitted (quotas.ts).
//
// What a run waiting for a share shows: `workflow.queued` as its step's
// refusal, the share it waits for and when it asks again at the latest,
// in its summary (`queued`) and its audit log (`workflow.run.waiting`).
// It is not the run's failure: it spends none of its step's attempts.

/** Who a run's attempts count for, and its App: whose shares they take. */
export interface AdmissionScope {
  /**
   * The person the run counts for: who started it, or its lineage root's;
   * `trigger:<app>` for a run nobody started (dispatcher.ts).
   */
  subject: string;
  /** The run's App. */
  resource: string;
}

/** A step's place in the queue: its run, and the SHA-256 of its name. */
export interface QueuePlace {
  runId: string;
  stepHash: string;
}

/** The share an attempt waits for. */
export type Share = "client" | "person" | "app";

/** The shares of attempts running at once, and the places a queue keeps. */
export interface Shares {
  client: number;
  person: number;
  app: number;
  queuedPerPerson: number;
  queuedPerApp: number;
}

/**
 * The longest a waiting step first waits before it asks again, in
 * seconds, whatever a refusal said (host.ts): a lease holds what an
 * attempt may take, and most give it back far sooner.
 */
export const maxAskAgainSeconds = 5;

/** The longest a step that kept waiting waits between asks, in seconds. */
const maxBackedOffSeconds = 60;

/**
 * The longest a step waits before it asks again once it has waited
 * `waited` rounds: five seconds, doubling each round to a minute at most,
 * so a step queued for long adds a round to its run's journal a minute at
 * most. It starts again from five seconds at the step's next wait.
 */
export const askAgainSeconds = (waited: number): number =>
  Math.min(maxAskAgainSeconds * 2 ** Math.max(0, waited), maxBackedOffSeconds);

/** What decides when a waiting step asks again (`askAgainMs`). */
export interface AskingAgain {
  /** The rounds it waited for load in a row before this one. */
  waited: number;
  /** What the refusal said, in seconds: the true wait, at the latest. */
  retryAfterSeconds: number;
  /** When it first waited for load (ms since the epoch). */
  since: number;
  /** How long a step may wait for load in all, in ms. */
  maxWaitMs: number;
  /** Now, as the refusal was made. */
  now: number;
}

/**
 * How long a waiting step waits before it asks again, in ms, and so when
 * it says it asks again: its backoff (`askAgainSeconds`), what the
 * refusal said and what is left of the time a step may wait, measured
 * from when it first waited, whichever is soonest. One rule for the
 * host's sleep, the summary's `retryAt` and the timeout.
 */
export const askAgainMs = ({
  waited,
  retryAfterSeconds,
  since,
  maxWaitMs,
  now,
}: AskingAgain): number =>
  Math.max(
    0,
    Math.min(
      askAgainSeconds(waited) * 1000,
      retryAfterSeconds * 1000,
      maxWaitMs - (now - since)
    )
  );

/**
 * How long a place in the queue lasts after its step last asked: longer
 * than a waiting step waits between asks (a minute at most,
 * `askAgainSeconds`), with room for an engine slow to wake it.
 */
export const queueLiveMs = 90_000;

/** The least wait a refusal for a full share names, in seconds. */
const minRetryAfterSeconds = 1;

/** The most a lease counts for after its admission: an attempt's wall time. */
const leaseMs = platformLimits.workflowAttemptWallMs;

/** The shares of `policy`: an App's and a person's below the client's. */
export const sharesOf = (policy: QuotaPolicy): Shares => {
  const client = policy.limits.workflowClientAttempts;
  // With one attempt at once for the whole client there is nothing to
  // leave over: that one is anyone's.
  const most = Math.max(1, client - 1);
  return {
    client,
    person: Math.min(policy.limits.workflowPersonAttempts, most),
    app: Math.min(policy.limits.workflowAppAttempts, most),
    queuedPerPerson: policy.limits.workflowQueuedPerPerson,
    queuedPerApp: policy.limits.workflowQueuedPerApp,
  };
};

/** The place in the queue of step `step` of run `runId`. */
export const queuePlaceOf = async (
  runId: string,
  step: string
): Promise<QueuePlace> => ({ runId, stepHash: await sha256Hex(step) });

/**
 * A whole number of core's own (a time, a share), as a literal: the
 * statements that count shares repeat each many times, and D1 binds at
 * most 100 parameters to one.
 */
const literal = (value: number): SQL => sql.raw(String(Math.trunc(value)));

/**
 * The leases held at `now` (`h`) that `where` takes: unsettled, until
 * their receipt's hold ends, an attempt's wall time after admission at
 * most (`reserved_ms`), whatever their deadline.
 */
const holding = (now: number, where: SQL): SQL =>
  sql`h.settled_at IS NULL AND h.admitted_at > ${literal(now - leaseMs)} AND h.admitted_at + h.reserved_ms > ${literal(now)} AND ${where}`;

/** The leases held at `now` that `where` takes, as SQL counting them. */
const running = (now: number, where: SQL): SQL =>
  sql`(SELECT count(*) FROM run_lineage_attempts AS h WHERE ${holding(now, where)})`;

/** When the first of the leases held at `now` that `where` takes ends. */
const firstEnds = (now: number, where: SQL): SQL =>
  sql`(SELECT min(h.admitted_at + h.reserved_ms) FROM run_lineage_attempts AS h WHERE ${holding(now, where)})`;

/** Where a step stands in the queue: its turn, and when it joined. */
export interface Standing {
  turn: number;
  joined: number;
}

/**
 * The counts an admission of `scope`'s attempt at `place` (standing at
 * `standing`) is checked against at `now`: the leases held, in all, for
 * its person and of its App, and the attempts queued ahead of it that
 * could run now, as each share must leave room for them.
 */
const admissionCounts = (
  scope: AdmissionScope,
  place: QueuePlace,
  { turn, joined }: Standing,
  now: number,
  shares: Shares
) => {
  const liveAfter = now - queueLiveMs;
  // Ahead: still asking, not this step, served before it (by turn, then
  // when it joined, then by place), and could run now, its person and App
  // each under their share.
  const ahead = sql`q.seen_at > ${literal(liveAfter)}
    AND NOT (q.run_id = ${place.runId} AND q.step_hash = ${place.stepHash})
    AND (q.turn < ${literal(turn)} OR (q.turn = ${literal(turn)} AND (q.enqueued_at < ${literal(joined)} OR (q.enqueued_at = ${literal(joined)} AND (q.run_id, q.step_hash) < (${place.runId}, ${place.stepHash})))))
    AND ${running(now, sql`h.subject = q.subject`)} < ${literal(shares.person)}
    AND ${running(now, sql`h.resource = q.resource`)} < ${literal(shares.app)}`;
  // What they could take of the client's share: per person, and per App,
  // no more than what is left of its own.
  const takeBy = (column: "subject" | "resource", share: number): SQL =>
    sql`(SELECT coalesce(sum(n), 0) FROM (SELECT min(count(*), ${literal(share)} - ${running(now, sql`h.${sql.raw(column)} = q.${sql.raw(column)}`)}) AS n FROM workflow_admission_queue AS q WHERE ${ahead} GROUP BY q.${sql.raw(column)}))`;
  const aheadOf = (where: SQL): SQL =>
    sql`(SELECT count(*) FROM workflow_admission_queue AS q WHERE ${ahead} AND ${where})`;
  return {
    client: running(now, sql`1`),
    clientAhead: sql`min(${takeBy("subject", shares.person)}, ${takeBy("resource", shares.app)})`,
    person: running(now, sql`h.subject = ${scope.subject}`),
    personAhead: aheadOf(sql`q.subject = ${scope.subject}`),
    app: running(now, sql`h.resource = ${scope.resource}`),
    appAhead: aheadOf(sql`q.resource = ${scope.resource}`),
    appEnds: firstEnds(now, sql`h.resource = ${scope.resource}`),
    personEnds: firstEnds(now, sql`h.subject = ${scope.subject}`),
    clientEnds: firstEnds(now, sql`1`),
  } satisfies Record<string, SQL>;
};

/** The live places of `scope`'s person and App as SQL counting them. */
const placesOf = (where: SQL, now: number): SQL =>
  sql`(SELECT count(*) FROM workflow_admission_queue AS p WHERE p.seen_at > ${literal(now - queueLiveMs)} AND ${where})`;

/**
 * The turn a new place of `scope`'s person in its App takes at `now`: one
 * past the latest of their places still waiting there, the first when
 * none is.
 */
const nextTurn = (scope: AdmissionScope, now: number): SQL =>
  sql`(SELECT coalesce(max(p.turn) + 1, 0) FROM workflow_admission_queue AS p WHERE p.seen_at > ${literal(now - queueLiveMs)} AND p.subject = ${scope.subject} AND p.resource = ${scope.resource})`;

/**
 * Where the step at `place` stands in the queue: its place's turn and
 * when it joined, if it holds one still; if it doesn't, `now`, behind
 * everyone waiting, and the turn it would take, after the latest of the
 * places its person has waiting in its App (`nextTurn`).
 */
export const standingOf = async (
  db: DrizzleD1Database,
  scope: AdmissionScope,
  place: QueuePlace,
  now: number
): Promise<Standing> => {
  const queue = workflowAdmissionQueue;
  const live = sql`${queue.seenAt} > ${now - queueLiveMs}`;
  const [mine, theirs] = await db.batch([
    db
      .select({ turn: queue.turn, enqueuedAt: queue.enqueuedAt })
      .from(queue)
      .where(
        and(
          eq(queue.runId, place.runId),
          eq(queue.stepHash, place.stepHash),
          live
        )
      ),
    db
      .select({ next: sql<number>`coalesce(max(${queue.turn}) + 1, 0)` })
      .from(queue)
      .where(
        and(
          eq(queue.subject, scope.subject),
          eq(queue.resource, scope.resource),
          live
        )
      ),
  ]);
  const [held] = mine;
  if (held !== undefined) {
    return { turn: held.turn, joined: held.enqueuedAt.getTime() };
  }
  return { turn: theirs[0]?.next ?? 0, joined: now };
};

/**
 * That `scope`'s attempt, at `place`, standing at `standing`, fits in
 * every share at `now`, room left for those ahead of it, as SQL: a
 * condition of the statement that takes its lease (quotas.ts).
 */
export const roomFor = (
  scope: AdmissionScope,
  place: QueuePlace,
  standing: Standing,
  now: number,
  shares: Shares
): SQL => {
  const counts = admissionCounts(scope, place, standing, now, shares);
  return sql`(${counts.client} + ${counts.clientAhead} < ${literal(shares.client)} AND ${counts.person} + ${counts.personAhead} < ${literal(shares.person)} AND ${counts.app} + ${counts.appAhead} < ${literal(shares.app)})`;
};

/**
 * The statements that drop the places that stopped asking by `now`, each
 * run's summary taking its next revision, as it no longer shows queued.
 */
export const queuePruned = (db: DrizzleD1Database, now: number) => {
  const stale = lte(workflowAdmissionQueue.seenAt, new Date(now - queueLiveMs));
  return [
    db
      .update(workflowRuns)
      .set({ summaryRevision: sql`${workflowRuns.summaryRevision} + 1` })
      .where(
        inArray(
          workflowRuns.id,
          db
            .select({ id: workflowAdmissionQueue.runId })
            .from(workflowAdmissionQueue)
            .where(stale)
        )
      ),
    db.delete(workflowAdmissionQueue).where(stale),
  ] as const;
};

/**
 * The statement that gives up every place of run `run` once its row took
 * (`took`, as SQL) the notification that it paused or ended: it waits for
 * nothing then (runs.ts, `projectStatus`). A notification the row refused
 * (older than one it took) gives up none.
 */
export const runDequeued = (db: DrizzleD1Database, run: string, took: SQL) =>
  db
    .delete(workflowAdmissionQueue)
    .where(and(eq(workflowAdmissionQueue.runId, run), took));

/**
 * The statements that give up `place` once its attempt holds its lease
 * (`admitted`, as SQL), its run's summary taking its next revision.
 */
export const dequeued = (
  db: DrizzleD1Database,
  place: QueuePlace,
  admitted: SQL
) => {
  const mine = and(
    eq(workflowAdmissionQueue.runId, place.runId),
    eq(workflowAdmissionQueue.stepHash, place.stepHash)
  );
  return [
    db
      .update(workflowRuns)
      .set({ summaryRevision: sql`${workflowRuns.summaryRevision} + 1` })
      .where(
        and(
          eq(workflowRuns.id, place.runId),
          sql`EXISTS (SELECT 1 FROM ${workflowAdmissionQueue} WHERE ${mine})`,
          admitted
        )
      ),
    db.delete(workflowAdmissionQueue).where(and(mine, admitted)),
  ] as const;
};

/**
 * The statement that reads, for `scope`'s attempt at `place`, the counts
 * its shares were checked against at `now`, and the first end of each
 * share's leases, unless `admitted` (as SQL): run in the batch that tries
 * to take its lease (quotas.ts), after it, one transaction, so it reads
 * the state that refused it, and counts nothing once it is admitted.
 */
export const sharesRead = (
  db: DrizzleD1Database,
  scope: AdmissionScope,
  place: QueuePlace,
  standing: Standing,
  now: number,
  shares: Shares,
  admitted: SQL
) =>
  // Read off the run's row, which every run has: one row of counts.
  db
    .select(admissionCounts(scope, place, standing, now, shares))
    .from(workflowRuns)
    .where(and(eq(workflowRuns.id, place.runId), sql`NOT (${admitted})`));

/** What `sharesRead` reads. */
const sharesRowSchema = z.object({
  client: z.number(),
  clientAhead: z.number(),
  person: z.number(),
  personAhead: z.number(),
  app: z.number(),
  appAhead: z.number(),
  appEnds: z.number().nullable(),
  personEnds: z.number().nullable(),
  clientEnds: z.number().nullable(),
});

/**
 * The share a refused attempt waits for, as `row` (`sharesRead`'s) found
 * them at `now`: the narrowest that was full (the client's, should none
 * be), and the seconds until its first lease ends, when it comes free at
 * the latest (at least a second). A share with room only for those ahead
 * comes free as they take it, or lose their place: as long as a waiting
 * step waits.
 */
const waitOf = (
  row: z.infer<typeof sharesRowSchema> | undefined,
  shares: Shares,
  now: number
): { waitingFor: Share; retryAfterSeconds: number } => {
  const checked: { share: Share; held: number; ahead: number; ends: number }[] =
    row === undefined
      ? []
      : [
          {
            share: "app",
            held: row.app,
            ahead: row.appAhead,
            ends: row.appEnds ?? now,
          },
          {
            share: "person",
            held: row.person,
            ahead: row.personAhead,
            ends: row.personEnds ?? now,
          },
          {
            share: "client",
            held: row.client,
            ahead: row.clientAhead,
            ends: row.clientEnds ?? now,
          },
        ];
  const binding = checked.find(
    ({ share, held, ahead }) => held + ahead >= shares[share]
  );
  if (binding === undefined) {
    return { waitingFor: "client", retryAfterSeconds: maxAskAgainSeconds };
  }
  if (binding.held < shares[binding.share]) {
    return { waitingFor: binding.share, retryAfterSeconds: maxAskAgainSeconds };
  }
  return {
    waitingFor: binding.share,
    retryAfterSeconds: Math.max(
      minRetryAfterSeconds,
      Math.ceil((binding.ends - now) / 1000)
    ),
  };
};

/**
 * The refusal of `scope`'s attempt at `place` for want of a share at
 * `now`, as `read` (`sharesRead`'s rows) found the shares (`waitOf`),
 * having queued it, or kept its place, asked again.
 *
 * `workflow.queue_full`, queuing nothing, when its person or its App has
 * as many places as it may.
 */
export const queuedRefusal = async (
  db: DrizzleD1Database,
  scope: AdmissionScope,
  place: QueuePlace,
  now: number,
  shares: Shares,
  read: unknown,
  {
    waited,
    since,
    maxWaitMs,
  }: Pick<AskingAgain, "waited" | "since" | "maxWaitMs">
): Promise<Error> => {
  const rows = z.array(sharesRowSchema).safeParse(read).data;
  const { waitingFor, retryAfterSeconds } = waitOf(rows?.[0], shares, now);
  const at = new Date(now);
  // When it asks again at the latest, as the host waits (`askAgainMs`):
  // never after it would time out.
  const retryAt = new Date(
    now + askAgainMs({ waited, retryAfterSeconds, since, maxWaitMs, now })
  );
  const queue = workflowAdmissionQueue;
  const mine = and(
    eq(queue.runId, place.runId),
    eq(queue.stepHash, place.stepHash)
  );
  const kept = db.select({ runId: queue.runId }).from(queue).where(mine);
  const written = await db.batch([
    // A place that lapsed is lost: the step joins at the back.
    db
      .delete(queue)
      .where(and(mine, lte(queue.seenAt, new Date(now - queueLiveMs)))),
    db.update(queue).set({ seenAt: at, waitingFor, retryAt }).where(mine),
    // A new place, within its person's and its App's.
    db
      .insert(queue)
      .select(
        sql`SELECT ${place.runId}, ${place.stepHash}, ${scope.subject}, ${scope.resource}, ${now}, ${now}, ${waitingFor}, ${retryAt.getTime()}, ${nextTurn(scope, now)} FROM ${workflowRuns} WHERE ${workflowRuns.id} = ${place.runId} AND NOT EXISTS (SELECT 1 FROM ${queue} WHERE ${mine}) AND ${placesOf(sql`p.subject = ${scope.subject}`, now)} < ${shares.queuedPerPerson} AND ${placesOf(sql`p.resource = ${scope.resource}`, now)} < ${shares.queuedPerApp}`
      )
      .onConflictDoNothing()
      .returning({ runId: queue.runId }),
    // Its summary shows it queued, and when it asks again.
    db
      .update(workflowRuns)
      .set({ summaryRevision: sql`${workflowRuns.summaryRevision} + 1` })
      .where(
        and(
          eq(workflowRuns.id, place.runId),
          sql`EXISTS (SELECT 1 FROM ${queue} WHERE ${mine})`
        )
      ),
    kept,
  ]);
  // It joined the queue only if this refusal took it a place: the run
  // records that it waits then (host.ts), once each time it joins.
  const joined = written[2].length > 0;
  if (written[4].length === 0) {
    return workflowErrors.create("workflow.queue_full", {
      perPerson: shares.queuedPerPerson,
      perApp: shares.queuedPerApp,
    });
  }
  return workflowErrors.create("workflow.queued", {
    waitingFor,
    retryAfterSeconds,
    maxWaitMs,
    joined,
  });
};
