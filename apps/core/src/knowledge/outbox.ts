import { deadline, whenAborted } from "@grasp-os/shared/deadline";
import { errorFields, log } from "@grasp-os/shared/log";
import type {
  SubmissionIntent,
  SubmissionIntentKind,
} from "@grasp-os/shared/submissions";
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { inList } from "../db/d1.ts";
import { submissionOutbox } from "../db/knowledge/schema.ts";

// The outbox of committed submissions (receipts.ts): what each still has
// to tell others, written in the same batch as its change, so it is owed
// exactly when the change committed, and never twice for one submission
// (a retry answers the receipt, and writes nothing). Handing it over comes
// after the commit and repeats nothing of it. Threat model, and how each
// is closed:
//
// - An entry is lost: it is committed with its change, and stays until
//   settled; its receipt is kept until then (receipts.ts, the sweep).
// - An entry is handed over twice: a drain leases each entry before
//   handing it over (its `next_attempt_at` moved past the lease), so an
//   overlapping drain skips it, and settles it only while it still holds
//   that lease. A drain that dies mid-way leaves the lease to run out, and
//   the entry is handed over again, under the same ID: a consumer keeps
//   the IDs it took, and takes it once.
// - A consumer hangs or keeps failing: each hand-over has a time limit,
//   past which it counts as failed; failures back off to hourly, and past
//   `defaultMaxAttempts` (about a day) the entry is settled as
//   `outbox.attempts_exhausted`, never dropped.
// - A long drain hands over entries whose leases already ran out: each
//   entry is leased at the drain's time when its turn comes, not when the
//   drain started, so the lease covers its own hand-over; the budget is
//   checked before each entry.
// - An entry nobody takes is settled away unread: a kind with no consumer
//   can't be staged (receipts.ts, `claim`), and a drain leaves an entry
//   whose consumer is gone untouched.
//
// Who consumes what comes with each kind's delivery: invalidations with
// live queries, workflow notifications (GRA-372) and starts (GRA-376).
// This deployment has none yet, so nothing can be staged: the table, the
// drain and the intent shapes are where they plug in.

/** An entry as a consumer takes it. */
export interface OutboxEntry {
  /** The same each time it is handed over. */
  id: string;
  intent: SubmissionIntent;
  /** How many hand-overs of it failed before. */
  attempts: number;
  /** Aborted once the hand-over's time is up. */
  signal: AbortSignal;
}

/**
 * Takes one entry: `delivered`, or settled undeliverable for good with a
 * code (`{ undeliverable }`), such as a run that ended. Throws to have it
 * handed over again later.
 */
export type OutboxConsumer = (
  entry: OutboxEntry
) => Promise<"delivered" | { undeliverable: string }>;

export type OutboxConsumers = Partial<
  Record<SubmissionIntentKind, OutboxConsumer>
>;

/** The consumers of this deployment's outbox: none yet. */
export const outboxConsumers: OutboxConsumers = {};

/** How a drain goes. */
export interface DrainOptions {
  /** The time it starts at; its clock runs on from there. */
  now?: Date;
  /** How long one hand-over may take. */
  timeoutMs?: number;
  /**
   * How long the drain goes on handing entries over: checked before each
   * entry, so it hands over at least one.
   */
  budgetMs?: number;
  /** How many failed hand-overs settle an entry as undeliverable. */
  maxAttempts?: number;
}

/** Most entries one page of a drain reads. */
const drainPageSize = 50;

/** How long one hand-over may take, unless a drain says otherwise. */
const defaultTimeoutMs = 30_000;

/** How long a drain goes on handing over, unless it says otherwise. */
const defaultBudgetMs = 20_000;

/**
 * How many failed hand-overs settle an entry as undeliverable, unless a
 * drain says otherwise: the backoff reaches hourly by the 8th, so this is
 * about a day of hourly retries, enough to outlast a consumer's outage.
 * Its consumers' delivery (GRA-372) is to confirm it.
 */
export const defaultMaxAttempts = 32;

/** The longest wait before an entry is handed over again. */
const maxBackoffMs = 60 * 60 * 1000;

/** The wait before the next hand-over, after `attempts` failed ones. */
const backoffMs = (attempts: number): number =>
  Math.min(maxBackoffMs, 30_000 * 2 ** Math.min(attempts - 1, 20));

/** A stored intent, which `commitOf` wrote from a `SubmissionIntent`. */
const intentOf = (stored: string): SubmissionIntent =>
  // SAFETY: written by `commitOf` from a `SubmissionIntent`, and by
  // nothing else.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  JSON.parse(stored) as SubmissionIntent;

/** What a hand-over came to. */
type Handed =
  | { settled: "delivered" | { undeliverable: string } }
  | { failed: unknown };

/** Hands `entry` to `consumer`, within `timeoutMs`. */
const handOver = async (
  consumer: OutboxConsumer,
  entry: Omit<OutboxEntry, "signal">,
  timeoutMs: number
): Promise<Handed> => {
  const limit = deadline(timeoutMs);
  try {
    return {
      settled: await Promise.race([
        consumer({ ...entry, signal: limit.signal }),
        whenAborted(limit.signal),
      ]),
    };
  } catch (error) {
    return { failed: error };
  } finally {
    limit.clear();
  }
};

/**
 * Leases one due entry, `id`, until `until`: the entry as it is, or
 * undefined when another drain holds it or it was settled meanwhile.
 */
const lease = async (
  env: Env,
  id: string,
  now: Date,
  until: Date
): Promise<
  { kind: SubmissionIntentKind; intent: string; attempts: number } | undefined
> =>
  await drizzle(env.KNOWLEDGE)
    .update(submissionOutbox)
    .set({ nextAttemptAt: until })
    .where(
      and(
        eq(submissionOutbox.id, id),
        isNull(submissionOutbox.settledAt),
        lte(submissionOutbox.nextAttemptAt, now)
      )
    )
    .returning({
      kind: submissionOutbox.kind,
      intent: submissionOutbox.intent,
      attempts: submissionOutbox.attempts,
    })
    .get();

/** A drain as it goes: its options, and its clock. */
interface Drain {
  consumers: OutboxConsumers;
  timeoutMs: number;
  maxAttempts: number;
  /** The drain's time now: its start, plus the time since. */
  clock: () => Date;
  /** Whether its budget has run out. */
  spent: () => boolean;
}

/**
 * Hands entry `id` over, if it is still due when leased: leased at the
 * drain's time then, for twice the hand-over's limit, and settled, or put
 * back for later when the hand-over failed (settled as
 * `outbox.attempts_exhausted` past the drain's `maxAttempts`), only while
 * the drain still holds that lease. An entry whose kind has no consumer
 * is left as it is.
 */
const handOne = async (env: Env, drain: Drain, id: string): Promise<void> => {
  const db = drizzle(env.KNOWLEDGE);
  const leasedAt = drain.clock();
  // The lease outlasts the hand-over, with room for the writes around it.
  const until = new Date(leasedAt.getTime() + drain.timeoutMs * 2);
  const leased = await lease(env, id, leasedAt, until);
  const consumer =
    leased === undefined ? undefined : drain.consumers[leased.kind];
  if (leased === undefined || consumer === undefined) {
    return;
  }
  const { attempts } = leased;
  const handed = await handOver(
    consumer,
    { id, intent: intentOf(leased.intent), attempts },
    drain.timeoutMs
  );
  const held = and(
    eq(submissionOutbox.id, id),
    isNull(submissionOutbox.settledAt),
    eq(submissionOutbox.nextAttemptAt, until)
  );
  const handedAt = drain.clock();
  if ("settled" in handed) {
    await db
      .update(submissionOutbox)
      .set({
        settledAt: handedAt,
        undeliverable:
          handed.settled === "delivered" ? null : handed.settled.undeliverable,
      })
      .where(held);
    return;
  }
  log.warn("outbox.delivery_failed", {
    id,
    kind: leased.kind,
    ...errorFields(handed.failed),
  });
  const failed = attempts + 1;
  await db
    .update(submissionOutbox)
    .set(
      failed >= drain.maxAttempts
        ? {
            attempts: failed,
            settledAt: handedAt,
            undeliverable: "outbox.attempts_exhausted",
          }
        : {
            attempts: failed,
            nextAttemptAt: new Date(handedAt.getTime() + backoffMs(failed)),
          }
    )
    .where(held);
};

/**
 * Drains one page of due entries, oldest first, one at a time, until the
 * drain's budget is spent (checked before each entry but the first of the
 * drain, `first`). Answers how many were due, and whether it stopped for
 * its budget.
 */
const drainOnePage = async (
  env: Env,
  drain: Drain,
  first: boolean
): Promise<{ due: number; spent: boolean }> => {
  const due = await drizzle(env.KNOWLEDGE)
    .select({ id: submissionOutbox.id })
    .from(submissionOutbox)
    .where(
      and(
        isNull(submissionOutbox.settledAt),
        lte(submissionOutbox.nextAttemptAt, drain.clock()),
        inList(submissionOutbox.kind, Object.keys(drain.consumers))
      )
    )
    .orderBy(asc(sql`rowid`))
    .limit(drainPageSize);
  let handedOne = !first;
  for (const { id } of due) {
    if (handedOne && drain.spent()) {
      return { due: due.length, spent: true };
    }
    // One after the other: in the order they were committed.
    // oxlint-disable-next-line no-await-in-loop -- see above
    await handOne(env, drain, id);
    handedOne = true;
  }
  return { due: due.length, spent: false };
};

/**
 * Hands the outbox's due entries over to `consumers`, a page at a time
 * until a page comes back short or the drain's budget is spent
 * (`drainOnePage`). Run by the cron trigger, every minute.
 */
export const drainSubmissionOutbox = async (
  env: Env,
  consumers: OutboxConsumers = outboxConsumers,
  {
    now = new Date(),
    timeoutMs = defaultTimeoutMs,
    budgetMs = defaultBudgetMs,
    maxAttempts = defaultMaxAttempts,
  }: DrainOptions = {}
): Promise<void> => {
  if (Object.keys(consumers).length === 0) {
    return;
  }
  const started = Date.now();
  const drain: Drain = {
    consumers,
    timeoutMs,
    maxAttempts,
    clock: () => new Date(now.getTime() + (Date.now() - started)),
    spent: () => Date.now() - started >= budgetMs,
  };
  for (let first = true; ; first = false) {
    // One page after the other: each reads what the last left.
    // oxlint-disable-next-line no-await-in-loop -- see above
    const page = await drainOnePage(env, drain, first);
    if (page.spent || page.due < drainPageSize) {
      return;
    }
  }
};
