import type { AdminStephenSignals } from "@grasp-os/shared/admin-snapshot";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, gte, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { channelSignals } from "../db/core/schema.ts";

// How Stephen fares in the chat apps, counted by the hour, for Grasp's
// admin to watch (its src/clients/watch.ts) through the admin snapshot
// (admin-snapshot.ts): requests refused at the door, turns by how they
// ended, answer times by bucket, and sends the platform didn't take.
//
// Counts only: never who wrote, what, or in which conversation, so the
// snapshot can carry them as it carries usage. Kept a week, then swept.
//
// A count is best effort: one that can't be written is logged and
// dropped, so counting never fails a request or a turn. A flood of
// refused requests writes one row per hour, however many it is, and the
// router limits the door anyway.

/** What is counted, besides answer times (`answeredWithin`). */
export type ChannelSignal =
  | "refused"
  | "answered"
  | "failed"
  | "over_budget"
  | "busy"
  | "send_failed"
  | "uninstalled";

/**
 * The answer time buckets' upper bounds, in milliseconds: the plan's p90
 * bars (8 s for knowledge, 12 s with an app) fall on a bound, so a
 * bucket's bound says which side of them an answer was.
 */
const answerBucketsMs = [
  2000, 4000, 6000, 8000, 10_000, 12_000, 15_000, 20_000, 30_000, 60_000,
] as const;

/** The bucket of the slowest answers, past the last bound. */
const slowestBucket = "answered_over";

const answerSignalOf = (ms: number): string => {
  const bound = answerBucketsMs.find((each) => ms <= each);
  return bound === undefined ? slowestBucket : `answered_within_${bound}`;
};

const hourMs = 60 * 60 * 1000;

/** How long counts are kept. */
const keptMs = 7 * 24 * hourMs;

/** The window the admin snapshot reports. */
export const reportedHours = 24;

/** The hour `at` falls in, as its first millisecond. */
const hourOf = (at: Date): Date =>
  new Date(Math.floor(at.getTime() / hourMs) * hourMs);

/** Adds one to `signal` for `platform` in the hour of `at`; never throws. */
const bump = async (
  env: Env,
  platform: string,
  signal: string,
  at: Date
): Promise<void> => {
  try {
    await drizzle(env.DB)
      .insert(channelSignals)
      .values({ hour: hourOf(at), platform, signal, count: 1 })
      .onConflictDoUpdate({
        target: [
          channelSignals.hour,
          channelSignals.platform,
          channelSignals.signal,
        ],
        set: { count: sql`${channelSignals.count} + 1` },
      });
  } catch (error) {
    log.warn("channel.signal_unwritten", {
      platform,
      signal,
      ...errorFields(error),
    });
  }
};

/** Counts `signal` once for `platform`, at `at`. */
export const countSignal = async (
  env: Env,
  platform: string,
  signal: ChannelSignal,
  at = new Date()
): Promise<void> => {
  await bump(env, platform, signal, at);
};

/** Counts a turn answered for `platform` in `ms`, and its time's bucket. */
export const countAnswered = async (
  env: Env,
  platform: string,
  ms: number,
  at = new Date()
): Promise<void> => {
  await Promise.all([
    bump(env, platform, "answered", at),
    bump(env, platform, answerSignalOf(ms), at),
  ]);
};

/**
 * The bucket bound the `share` (0 to 1) of the answers in `buckets`
 * falls in; null without any. The slowest bucket has no bound: its
 * answers are given the last bound doubled, a time past every bar.
 */
const percentileOf = (
  buckets: ReadonlyMap<string, number>,
  share: number
): number | null => {
  const ordered = [
    ...answerBucketsMs.map((bound) => ({
      bound,
      count: buckets.get(`answered_within_${bound}`) ?? 0,
    })),
    {
      bound: (answerBucketsMs.at(-1) ?? 0) * 2,
      count: buckets.get(slowestBucket) ?? 0,
    },
  ];
  const total = ordered.reduce((sum, { count }) => sum + count, 0);
  if (total === 0) {
    return null;
  }
  const rank = Math.ceil(total * share);
  let seen = 0;
  for (const { bound, count } of ordered) {
    seen += count;
    if (seen >= rank) {
      return bound;
    }
  }
  return null;
};

/** How Stephen fared over the `reportedHours` up to `now`, every platform together. */
export const stephenSignalsOf = async (
  env: Env,
  now: Date
): Promise<AdminStephenSignals> => {
  const since = new Date(now.getTime() - reportedHours * hourMs);
  const rows = await drizzle(env.DB)
    .select({
      signal: channelSignals.signal,
      count: sql<number>`sum(${channelSignals.count})`,
    })
    .from(channelSignals)
    .where(
      and(gte(channelSignals.hour, hourOf(since)), lt(channelSignals.hour, now))
    )
    .groupBy(channelSignals.signal);
  const counts = new Map(rows.map(({ signal, count }) => [signal, count]));
  const of = (signal: ChannelSignal): number => counts.get(signal) ?? 0;
  return {
    hours: reportedHours,
    refused: of("refused"),
    answered: of("answered"),
    failed: of("failed"),
    overBudget: of("over_budget"),
    busy: of("busy"),
    sendFailed: of("send_failed"),
    uninstalled: of("uninstalled"),
    p50Ms: percentileOf(counts, 0.5),
    p90Ms: percentileOf(counts, 0.9),
  };
};

/** Deletes counts older than a week. */
export const sweepChannelSignals = async (
  env: Env,
  now: Date
): Promise<void> => {
  await drizzle(env.DB)
    .delete(channelSignals)
    .where(lt(channelSignals.hour, new Date(now.getTime() - keptMs)));
};
