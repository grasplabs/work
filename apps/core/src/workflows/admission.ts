import { sha256Hex } from "@grasp-os/shared/encoding";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import type { QuotaPolicy } from "@grasp-os/shared/quota-policy";
import { executionErrors, workflowErrors } from "@grasp-os/shared/workflows";
import type { RunQueue } from "@grasp-os/shared/workflows";
import { and, eq, gt, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import {
  workflowAdmissionQueue,
  workflowModelWaits,
  workflowRuns,
} from "../db/core/schema.ts";

// Fair admission of workflow attempts (spec 18.3, 40.5): how many of the
// client's workflow attempts run at once, in all, for one person and of
// one App, each against its share in the quota policy
// (`workflowClientAttempts`, `workflowPersonAttempts`,
// `workflowAppAttempts`), and in what order the ones waiting get a share.
// Core's database is the coordinator: an attempt's lineage receipt
// (quotas.ts, `run_lineage_attempts`) is its lease, taken in the same
// statement that checks its shares, and the waiting are a persistent
// queue (`workflow_admission_queue`). The client is the tenant: core runs
// once per client, so its shares are the tenant's. Build jobs are held to
// their shares by the same rule and statements, over tables of their own
// (`Pool`, build-admission.ts).
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
//   deadline, so none outlives a minute. One that settles gives its share
//   back at once; a run that pauses or ends gives up its places (runs.ts,
//   `projectStatus`).
// - A lease kept by an attempt the engine gave up on: its run cancelled
//   while its code still runs, paused or ended once its activation died,
//   or taken over by a newer activation. The engine's fence decides it,
//   never core's record of the run, which lags the engine: each time the
//   run's object tells core of a status (its durable outbox, in order, at
//   least once), it gives back every lease of the run's generations none
//   of whose attempts holds any more, as its journal has them then
//   (run-object.ts, `notify`; quotas.ts, `sharesReleased`). An activation
//   that took the run over gives back its older ones' leases with its
//   first admission, of any step (quotas.ts). Only the leases of the run
//   the object holds, by its own journal (a batch naming another run acts
//   on none), only of generations fenced: a notification late, or handed
//   over again, gives back nothing a newer activation's attempt holds,
//   since the fence only grows. A cancelled run's attempt is charged to
//   its lineage up to its deadline, as its isolate may compute on, though
//   its share comes back at once. A dead activation is told from a slow one only by the
//   engine's watchdog, a lease away: its leases come back then, or as its
//   run is cancelled.
// - A fenced attempt taking a share again, its admission landing after
//   its lease came back, or retried under the same key: an attempt of a
//   generation the run's object fenced (`shares_fenced_through`), of a
//   cancelled run, or of an activation a newer one's attempt came after,
//   takes no lease (`execution.stale_attempt`), in the statement that
//   would take it. An attempt settled is never admitted again.
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
//   their newer work never passes their older work as places come and go,
//   unless the older gave its place up (below).
// - Starvation and queue jumping: within a turn the waiting are served
//   first come, first served. An attempt is admitted only if serving the
//   queue in order now would admit it (`servedInOrder`): each place ahead
//   of it takes a lease if its person, its App and the client have room
//   after those before it, and is passed over if not. One queued behind a
//   saturated App doesn't wait for that App (no head-of-line blocking, no
//   priority inversion), and a newcomer never takes a share an attempt
//   ahead of it would. What those ahead hold back is exactly what they
//   would take, under every share at once.
// - A dead waiter holding its place for ever: a place lasts only while
//   the step asks again (`queueLiveMs`), which a waiting run does every
//   minute at least (`askAgainSeconds`); a run that stopped
//   asking (its activation gone) loses it, and joins at the back when it
//   asks again.
// - A waiter that couldn't run if its share came free holding one back:
//   a step holds a place only while its last answer was `workflow.queued`,
//   a wait for a share. Refused for anything else (its lineage's time held
//   by a sibling, a lineage limit, a timeout), it gives its place up
//   (quotas.ts, `admitAttempt`) and joins at the back when it next waits
//   for a share; past an admission it holds none (`dequeued`). It gives
//   up only a place no newer attempt of the step wrote (below). So the
//   queue holds back shares only for steps waiting on shares alone, and
//   `servedInOrder` never models a lineage, a hold or anything else a
//   step may wait for: such a wait is the run's own, and it keeps no one
//   else waiting. A step whose lineage filled while it slept holds its
//   place until it asks again, a minute at most, as a run paused before
//   its notification lands does.
// - A late call of an attempt the step has moved past writing or erasing
//   the place: an admission call can outlast its attempt's deadline, and
//   the engine retry the step meanwhile. Each place carries the attempt
//   that wrote it, by its deadline (`attemptDeadline`): the engine claims
//   a step's attempts one after another, so a later deadline is a newer
//   attempt, however late its calls arrive. An attempt refreshes or gives
//   up the place only while no newer one wrote it (`ownedBy`), and writes
//   none once one as new or newer took a lease (`noNewerLease`): each a
//   condition of the one statement that writes, so no late call slips in
//   between. Its refusal is then `execution.stale_attempt`: the step has
//   gone on without it.
// - A queue so long admission overloads core's database: a person, and an
//   App, may have so many places at once (`workflowQueuedPerPerson`,
//   `workflowQueuedPerApp`); past them a step's attempt is refused
//   (`workflow.queue_full`), not queued. Counting is by indexes, in one
//   statement per admission, which counts nothing more once its lease is
//   taken.
// - Waiting for ever, and a journal that grows without bound: a wait
//   spends none of the run's steps (host.ts, `uncountedWaitStep`), since
//   others' load causes it, but each round adds to the run's journal. So
//   a step waits longer each round, five seconds doubling to a minute
//   (`askAgainSeconds`), and fails once its rounds have waited a day in
//   all since it was last admitted (`workflowQueuedStepMs`,
//   `workflow.queue_timeout`), spending none of its retries. A round never
//   waits past when the share's first lease ends (`retryAfterSeconds`),
//   though, which can be a second away again and again: the backoff alone
//   doesn't bound the rounds of a day's wait. Only those rounds count: a
//   pause, or a wait for its person after an admission, is not a wait for
//   load (host.ts).
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

/**
 * A step's place in the queue: its run, and the SHA-256 of its name, as
 * one attempt of the step asks for it, by its deadline (`deadline`, ms
 * since the epoch). The engine claims a step's attempts one after another,
 * each past the last one's deadline or for a later activation or round,
 * so a later deadline is a newer attempt (`ownedBy`, `noNewerLease`).
 */
export interface QueuePlace {
  runId: string;
  stepHash: string;
  deadline: number;
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
const maxAskAgainSeconds = 5;

/** The longest a step that kept waiting waits between asks, in seconds. */
const maxBackedOffSeconds = 60;

/**
 * The longest a step waits before it asks again once it has waited
 * `waited` rounds: five seconds, doubling each round to a minute at most,
 * so a step queued for long adds a round to its run's journal a minute at
 * most. It starts again from five seconds at the step's next wait.
 */
const askAgainSeconds = (waited: number): number =>
  Math.min(maxAskAgainSeconds * 2 ** Math.max(0, waited), maxBackedOffSeconds);

/** What decides when a waiting step asks again (`askAgainMs`). */
export interface AskingAgain {
  /** The rounds it waited for load in a row before this one. */
  waited: number;
  /** What the refusal said, in seconds: the true wait, at the latest. */
  retryAfterSeconds: number;
  /**
   * How long it has waited for load since it was last admitted: the sum
   * of its rounds' waits, never the time between, so a pause or a wait
   * for its person counts for none of it (host.ts).
   */
  waitedMs: number;
  /** How long a step may wait for load in all, in ms. */
  maxWaitMs: number;
}

/**
 * How long a waiting step waits before it asks again, in ms, and so when
 * it says it asks again: its backoff (`askAgainSeconds`), what the
 * refusal said and what is left of the time a step may wait
 * (`waitedMs`), whichever is soonest. One rule for the host's sleep, the
 * summary's `retryAt` and the timeout.
 */
export const askAgainMs = ({
  waited,
  retryAfterSeconds,
  waitedMs,
  maxWaitMs,
}: AskingAgain): number =>
  Math.max(
    0,
    Math.min(
      askAgainSeconds(waited) * 1000,
      retryAfterSeconds * 1000,
      maxWaitMs - waitedMs
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

/**
 * A pool of leases and the queue of those waiting for one: what the one
 * ordering rule below (`servedInOrder`) and the counts beside it read. Two
 * pools share it, each in tables of its own: workflow attempts (this
 * file's own, `attemptPool`) and build jobs (build-admission.ts). A pool's
 * leases are rows with `subject`, `resource`, `admitted_at`,
 * `reserved_ms` and `settled_at`; its places, rows with `run_id`,
 * `step_hash`, `subject`, `resource`, `enqueued_at`, `seen_at` and
 * `turn`. Each is core's own SQL, never a caller's.
 */
export interface Pool {
  leases: SQL;
  queue: SQL;
  /** The most a lease counts for after its admission, whatever it holds. */
  leaseMs: number;
}

/** Workflow attempts: their lineage receipts are their leases (quotas.ts). */
export const attemptPool: Pool = {
  leases: sql.raw("run_lineage_attempts"),
  queue: sql.raw("workflow_admission_queue"),
  // An attempt's wall time.
  leaseMs: platformLimits.workflowAttemptWallMs,
};

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

/** The place in the queue of step `step` of run `runId`, as its attempt with `deadline` asks. */
export const queuePlaceOf = async (
  runId: string,
  step: string,
  deadline: number
): Promise<QueuePlace> => ({
  runId,
  stepHash: await sha256Hex(step),
  deadline,
});

/**
 * A whole number of core's own (a time, a share), as a literal: the
 * statements that count shares repeat each many times, and D1 binds at
 * most 100 parameters to one.
 */
const literal = (value: number): SQL => sql.raw(String(Math.trunc(value)));

/** The step's place, whichever attempt wrote it. */
const placeIs = (place: QueuePlace): SQL | undefined =>
  and(
    eq(workflowAdmissionQueue.runId, place.runId),
    eq(workflowAdmissionQueue.stepHash, place.stepHash)
  );

/**
 * The step's place, if no attempt newer than `place`'s wrote it: the only
 * one `place`'s attempt may refresh or give up.
 */
const ownedBy = (place: QueuePlace): SQL | undefined =>
  and(
    placeIs(place),
    lte(workflowAdmissionQueue.attemptDeadline, new Date(place.deadline))
  );

/**
 * That no attempt of the step as new as `place`'s, or newer, ever took a
 * lease: once one did, the step waits in the queue no more, and an older
 * attempt's late refusal puts no place back.
 */
const noNewerLease = (place: QueuePlace): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM run_lineage_attempts AS r WHERE r.run_id = ${place.runId} AND r.step_hash = ${place.stepHash} AND r.deadline >= ${literal(place.deadline)})`;

/**
 * The leases held at `now` (`h`) that `where` takes: unsettled, until
 * their receipt's hold ends, an attempt's wall time after admission at
 * most (`reserved_ms`), whatever their deadline.
 */
const holding = (pool: Pool, now: number, where: SQL): SQL =>
  sql`h.settled_at IS NULL AND h.admitted_at > ${literal(now - pool.leaseMs)} AND h.admitted_at + h.reserved_ms > ${literal(now)} AND ${where}`;

/** The leases held at `now` that `where` takes, as SQL counting them. */
const running = (pool: Pool, now: number, where: SQL): SQL =>
  sql`(SELECT count(*) FROM ${pool.leases} AS h WHERE ${holding(pool, now, where)})`;

/** When the first of the leases held at `now` that `where` takes ends. */
const firstEnds = (pool: Pool, now: number, where: SQL): SQL =>
  sql`(SELECT min(h.admitted_at + h.reserved_ms) FROM ${pool.leases} AS h WHERE ${holding(pool, now, where)})`;

/** Where a step stands in the queue: its turn, and when it joined. */
export interface Standing {
  turn: number;
  joined: number;
}

/**
 * The queue served in order, up to and including `scope`'s attempt at
 * `place` (standing at `standing`), at `now`, as SQL: `served`, a row for
 * each place still asking ahead of it and a last row for the attempt
 * itself (`me`), each with the leases it would find held, in all
 * (`client`), for its person (`person`) and of its App (`app`), and
 * whether it would take one (`fits`): every share under its own.
 *
 * One rule, so what those ahead hold back is never more, nor less, than
 * what they would take: each in turn takes a lease if its person, its App
 * and the client have room once those before it took theirs, and is passed
 * over if not. A share left over by those ahead is the attempt's, and one
 * they would take never is. Counting each share of those ahead apart
 * holds back too much: two places of one person in two Apps, under a
 * person's share of one, take one lease, not two.
 *
 * The leases each would take are kept as JSON, per person and per App,
 * under the hex of its name: any name is a safe path.
 */
const servedInOrder = (
  pool: Pool,
  scope: AdmissionScope,
  place: QueuePlace,
  { turn, joined }: Standing,
  now: number,
  shares: Shares
): SQL => {
  // Ahead: still asking, not this step, and served before it: by turn,
  // then when it joined, then by place, as `served` orders them.
  const ahead = sql`q.seen_at > ${literal(now - queueLiveMs)}
    AND NOT (q.run_id = ${place.runId} AND q.step_hash = ${place.stepHash})
    AND (q.turn < ${literal(turn)} OR (q.turn = ${literal(turn)} AND (q.enqueued_at < ${literal(joined)} OR (q.enqueued_at = ${literal(joined)} AND (q.run_id, q.step_hash) < (${place.runId}, ${place.stepHash})))))`;
  // What a place would find, after those before it: its person's and its
  // App's leases as taken so far, or as held, if none took one yet.
  const person = sql`coalesce(json_extract(s.persons, w.person_key), w.person_held)`;
  const app = sql`coalesce(json_extract(s.apps, w.app_key), w.app_held)`;
  const fits = sql`(s.client < ${literal(shares.client)} AND ${person} < ${literal(shares.person)} AND ${app} < ${literal(shares.app)})`;
  return sql`WITH RECURSIVE
    waiting AS (
      SELECT row_number() OVER (ORDER BY u.turn, u.joined, u.run_id, u.step_hash) AS i,
        u.me AS me,
        '$.x' || hex(u.subject) AS person_key,
        '$.x' || hex(u.resource) AS app_key,
        ${running(pool, now, sql`h.subject = u.subject`)} AS person_held,
        ${running(pool, now, sql`h.resource = u.resource`)} AS app_held
      FROM (
        SELECT q.turn AS turn, q.enqueued_at AS joined, q.run_id AS run_id, q.step_hash AS step_hash, 0 AS me, q.subject AS subject, q.resource AS resource
        FROM ${pool.queue} AS q WHERE ${ahead}
        UNION ALL
        SELECT ${literal(turn)}, ${literal(joined)}, ${place.runId}, ${place.stepHash}, 1, ${scope.subject}, ${scope.resource}
      ) AS u
    ),
    served (i, me, client, persons, apps, person, app, fits) AS (
      SELECT 0, 0, ${running(pool, now, sql`1`)}, '{}', '{}', 0, 0, 0
      UNION ALL
      SELECT w.i, w.me,
        s.client + ${fits},
        CASE WHEN ${fits} THEN json_set(s.persons, w.person_key, ${person} + 1) ELSE s.persons END,
        CASE WHEN ${fits} THEN json_set(s.apps, w.app_key, ${app} + 1) ELSE s.apps END,
        ${person}, ${app}, ${fits}
      FROM served AS s JOIN waiting AS w ON w.i = s.i + 1
    )`;
};

/** The client's leases a row of `served` found: before its own. */
const servedClient = sql`s.client - s.fits`;

/**
 * The counts an admission of `scope`'s attempt at `place` (standing at
 * `standing`) is checked against at `now`: the leases held, in all, for
 * its person and of its App, and what it would find of each once those
 * ahead of it took theirs (`servedInOrder`), as JSON.
 */
export const admissionCounts = (
  pool: Pool,
  scope: AdmissionScope,
  place: QueuePlace,
  standing: Standing,
  now: number,
  shares: Shares
) =>
  ({
    client: running(pool, now, sql`1`),
    person: running(pool, now, sql`h.subject = ${scope.subject}`),
    app: running(pool, now, sql`h.resource = ${scope.resource}`),
    served: sql`(${servedInOrder(pool, scope, place, standing, now, shares)} SELECT json_object('client', ${servedClient}, 'person', s.person, 'app', s.app) FROM served AS s WHERE s.me = 1)`,
    appEnds: firstEnds(pool, now, sql`h.resource = ${scope.resource}`),
    personEnds: firstEnds(pool, now, sql`h.subject = ${scope.subject}`),
    clientEnds: firstEnds(pool, now, sql`1`),
  }) satisfies Record<string, SQL>;

/** The live places of `scope`'s person and App as SQL counting them. */
export const placesOf = (pool: Pool, where: SQL, now: number): SQL =>
  sql`(SELECT count(*) FROM ${pool.queue} AS p WHERE p.seen_at > ${literal(now - queueLiveMs)} AND ${where})`;

/**
 * The turn a new place of `scope`'s person in its App takes at `now`: one
 * past the latest of their places still waiting there, the first when
 * none is.
 */
export const nextTurn = (pool: Pool, scope: AdmissionScope, now: number): SQL =>
  sql`(SELECT coalesce(max(p.turn) + 1, 0) FROM ${pool.queue} AS p WHERE p.seen_at > ${literal(now - queueLiveMs)} AND p.subject = ${scope.subject} AND p.resource = ${scope.resource})`;

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
    // The turn as a new place takes it (`nextTurn`), off the run's row,
    // which every run has.
    db
      .select({ next: sql<number>`${nextTurn(attemptPool, scope, now)}` })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, place.runId)),
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
  pool: Pool,
  scope: AdmissionScope,
  place: QueuePlace,
  standing: Standing,
  now: number,
  shares: Shares
): SQL => {
  const served = servedInOrder(pool, scope, place, standing, now, shares);
  return sql`EXISTS (${served} SELECT 1 FROM served AS s WHERE s.me = 1 AND s.fits)`;
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
 * Of the runs `runs`, each one a step of which waits in the queue for a
 * share at `now`: the share, and the earliest a step of it asks again, as
 * its summary shows it (summary.ts). A place that stopped asking doesn't
 * count. Only the runs' own places are read (the queue's primary key):
 * never who else waits, nor how many, nor where in the queue.
 */
export const queuedRuns = async (
  db: DrizzleD1Database,
  runs: readonly string[],
  now: number
): Promise<Map<string, RunQueue>> => {
  if (runs.length === 0) {
    return new Map();
  }
  // One bound list: D1 binds at most 100 parameters.
  const listed = JSON.stringify(runs);
  const [places, modelWaits] = await db.batch([
    db
      .select({
        runId: workflowAdmissionQueue.runId,
        waitingFor: workflowAdmissionQueue.waitingFor,
        retryAt: workflowAdmissionQueue.retryAt,
      })
      .from(workflowAdmissionQueue)
      .where(
        and(
          sql`${workflowAdmissionQueue.runId} IN (SELECT value FROM json_each(${listed}))`,
          gt(workflowAdmissionQueue.seenAt, new Date(now - queueLiveMs))
        )
      ),
    // A step whose model call waits for a share of the model requests in
    // flight shows the same (model-waits.ts).
    db
      .select({
        runId: workflowModelWaits.runId,
        waitingFor: workflowModelWaits.waitingFor,
        retryAt: workflowModelWaits.retryAt,
      })
      .from(workflowModelWaits)
      .where(
        and(
          sql`${workflowModelWaits.runId} IN (SELECT value FROM json_each(${listed}))`,
          gt(workflowModelWaits.seenAt, new Date(now - queueLiveMs)),
          isNotNull(workflowModelWaits.waitingFor)
        )
      ),
  ]);
  const rows = [...places, ...modelWaits].toSorted(
    (one, other) => one.retryAt.getTime() - other.retryAt.getTime()
  );
  const byRun = new Map<string, RunQueue>();
  for (const { runId, waitingFor, retryAt } of rows) {
    if (waitingFor !== null && !byRun.has(runId)) {
      byRun.set(runId, { waitingFor, retryAt: retryAt.toISOString() });
    }
  }
  return byRun;
};

/**
 * The statements that give up `place` once its attempt holds its lease
 * (`admitted`, as SQL), or, with `admitted` true, once it waits for
 * something other than a share, its run's summary taking its next
 * revision: unless a newer attempt of the step wrote the place since
 * (`ownedBy`), whose it is then.
 */
export const dequeued = (
  db: DrizzleD1Database,
  place: QueuePlace,
  admitted: SQL
) => {
  const mine = ownedBy(place);
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
    .select(admissionCounts(attemptPool, scope, place, standing, now, shares))
    .from(workflowRuns)
    .where(and(eq(workflowRuns.id, place.runId), sql`NOT (${admitted})`));

/** What `sharesRead` reads. */
const foundSchema = z.object({
  client: z.number(),
  person: z.number(),
  app: z.number(),
});
export const sharesRowSchema = z.object({
  client: z.number(),
  person: z.number(),
  app: z.number(),
  // What the attempt would find once those ahead took theirs: JSON, as
  // SQLite answers it.
  served: z
    .string()
    .transform((text): unknown => JSON.parse(text))
    .pipe(foundSchema),
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
export const waitOf = (
  row: z.infer<typeof sharesRowSchema> | undefined,
  shares: Shares,
  now: number
): { waitingFor: Share; retryAfterSeconds: number } => {
  const checked: { share: Share; held: number; found: number; ends: number }[] =
    row === undefined
      ? []
      : [
          {
            share: "app",
            held: row.app,
            found: row.served.app,
            ends: row.appEnds ?? now,
          },
          {
            share: "person",
            held: row.person,
            found: row.served.person,
            ends: row.personEnds ?? now,
          },
          {
            share: "client",
            held: row.client,
            found: row.served.client,
            ends: row.clientEnds ?? now,
          },
        ];
  const binding = checked.find(({ share, found }) => found >= shares[share]);
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
    waitedMs,
    maxWaitMs,
  }: Pick<AskingAgain, "waited" | "waitedMs" | "maxWaitMs">
): Promise<Error> => {
  const rows = z.array(sharesRowSchema).safeParse(read).data;
  const { waitingFor, retryAfterSeconds } = waitOf(rows?.[0], shares, now);
  const at = new Date(now);
  // When it asks again at the latest, as the host waits (`askAgainMs`):
  // never after it would time out.
  const retryAt = new Date(
    now + askAgainMs({ waited, retryAfterSeconds, waitedMs, maxWaitMs })
  );
  const queue = workflowAdmissionQueue;
  const mine = placeIs(place);
  // Its place as this attempt left it: written or kept by it.
  const kept = db
    .select({ runId: queue.runId })
    .from(queue)
    .where(and(mine, eq(queue.attemptDeadline, new Date(place.deadline))));
  // A newer attempt of the step took the place, or a lease: this one's
  // refusal is late, and the step has gone on without it.
  const superseded = db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.id, place.runId),
        sql`(EXISTS (SELECT 1 FROM ${queue} WHERE ${mine} AND ${queue.attemptDeadline} > ${place.deadline}) OR NOT ${noNewerLease(place)})`
      )
    );
  // Still going as its place is written, in the same statement: a run
  // paused, cancelled or ended meanwhile has given up its places
  // (runs.ts, `projectStatus`), and takes none again.
  const runActive = sql`${workflowRuns.status} IN ('starting', 'running') AND ${workflowRuns.cancelRequestedAt} IS NULL`;
  const active = db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.id, place.runId), runActive));
  const written = await db.batch([
    // A place that lapsed is lost: the step joins at the back.
    db
      .delete(queue)
      .where(and(mine, lte(queue.seenAt, new Date(now - queueLiveMs)))),
    db
      .update(queue)
      .set({
        seenAt: at,
        waitingFor,
        retryAt,
        attemptDeadline: new Date(place.deadline),
      })
      .where(and(ownedBy(place), noNewerLease(place))),
    // A new place, within its person's and its App's.
    db
      .insert(queue)
      .select(
        sql`SELECT ${place.runId}, ${place.stepHash}, ${scope.subject}, ${scope.resource}, ${now}, ${now}, ${waitingFor}, ${retryAt.getTime()}, ${nextTurn(attemptPool, scope, now)}, ${place.deadline} FROM ${workflowRuns} WHERE ${workflowRuns.id} = ${place.runId} AND ${runActive} AND ${noNewerLease(place)} AND NOT EXISTS (SELECT 1 FROM ${queue} WHERE ${mine}) AND ${placesOf(attemptPool, sql`p.subject = ${scope.subject}`, now)} < ${shares.queuedPerPerson} AND ${placesOf(attemptPool, sql`p.resource = ${scope.resource}`, now)} < ${shares.queuedPerApp}`
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
    active,
    superseded,
  ]);
  // It joined the queue only if this refusal took it a place: the run
  // records that it waits then (host.ts), once each time it joins.
  const joined = written[2].length > 0;
  // Paused, cancelled or ended: its attempt is over, not queued.
  // Superseded by a newer attempt of its step: over too, and it neither
  // wrote the place nor put one back.
  if (written[5].length === 0 || written[6].length > 0) {
    return executionErrors.create("execution.stale_attempt");
  }
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
