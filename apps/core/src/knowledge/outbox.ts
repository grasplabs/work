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
//   `maxAttempts` the entry is settled as `outbox.attempts_exhausted`,
//   never dropped.
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
  /** The time it drains at. */
  now?: Date;
  /** How long one hand-over may take. */
  timeoutMs?: number;
  /** How long the drain goes on taking pages, at most. */
  budgetMs?: number;
}

/** Most entries one page of a drain reads. */
const drainPageSize = 50;

/** How long one hand-over may take, unless a drain says otherwise. */
const defaultTimeoutMs = 30_000;

/** How long a drain goes on taking pages, unless it says otherwise. */
const defaultBudgetMs = 20_000;

/** How many failed hand-overs settle an entry as undeliverable. */
export const maxAttempts = 10;

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

/**
 * Drains one page of due entries, oldest first, and answers how many were
 * due: each leased, handed to the consumer of its kind, and settled, or
 * put back for later when the hand-over failed (settled as
 * `outbox.attempts_exhausted` past `maxAttempts`). An entry whose kind
 * has no consumer is left as it is.
 */
const drainOnePage = async (
  env: Env,
  consumers: OutboxConsumers,
  now: Date,
  timeoutMs: number
): Promise<number> => {
  const db = drizzle(env.KNOWLEDGE);
  const kinds = Object.keys(consumers);
  const due = await db
    .select({ id: submissionOutbox.id })
    .from(submissionOutbox)
    .where(
      and(
        isNull(submissionOutbox.settledAt),
        lte(submissionOutbox.nextAttemptAt, now),
        inList(submissionOutbox.kind, kinds)
      )
    )
    .orderBy(asc(sql`rowid`))
    .limit(drainPageSize);
  // The lease outlasts the hand-over, with room for the writes around it.
  const until = new Date(now.getTime() + timeoutMs * 2);
  for (const { id } of due) {
    // One after the other: in the order they were committed.
    // oxlint-disable-next-line no-await-in-loop -- see above
    const leased = await lease(env, id, now, until);
    const consumer = leased === undefined ? undefined : consumers[leased.kind];
    if (leased === undefined || consumer === undefined) {
      continue;
    }
    const { attempts } = leased;
    // oxlint-disable-next-line no-await-in-loop -- see above
    const handed = await handOver(
      consumer,
      { id, intent: intentOf(leased.intent), attempts },
      timeoutMs
    );
    const held = and(
      eq(submissionOutbox.id, id),
      isNull(submissionOutbox.settledAt),
      eq(submissionOutbox.nextAttemptAt, until)
    );
    if ("settled" in handed) {
      // oxlint-disable-next-line no-await-in-loop -- see above
      await db
        .update(submissionOutbox)
        .set({
          settledAt: now,
          undeliverable:
            handed.settled === "delivered"
              ? null
              : handed.settled.undeliverable,
        })
        .where(held);
      continue;
    }
    log.warn("outbox.delivery_failed", {
      id,
      kind: leased.kind,
      ...errorFields(handed.failed),
    });
    const failed = attempts + 1;
    // oxlint-disable-next-line no-await-in-loop -- see above
    await db
      .update(submissionOutbox)
      .set(
        failed >= maxAttempts
          ? {
              attempts: failed,
              settledAt: now,
              undeliverable: "outbox.attempts_exhausted",
            }
          : {
              attempts: failed,
              nextAttemptAt: new Date(now.getTime() + backoffMs(failed)),
            }
      )
      .where(held);
  }
  return due.length;
};

/**
 * Hands the outbox's due entries over to `consumers`, a page at a time
 * until a page comes back short or the drain's budget has passed
 * (`drainOnePage`). Run by the cron trigger, every minute.
 */
export const drainSubmissionOutbox = async (
  env: Env,
  consumers: OutboxConsumers = outboxConsumers,
  {
    now = new Date(),
    timeoutMs = defaultTimeoutMs,
    budgetMs = defaultBudgetMs,
  }: DrainOptions = {}
): Promise<void> => {
  if (Object.keys(consumers).length === 0) {
    return;
  }
  const started = Date.now();
  for (;;) {
    // One page after the other: each reads what the last left.
    // oxlint-disable-next-line no-await-in-loop -- see above
    const count = await drainOnePage(env, consumers, now, timeoutMs);
    if (count < drainPageSize || Date.now() - started >= budgetMs) {
      return;
    }
  }
};
