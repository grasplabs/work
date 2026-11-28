/**
 * One holder at a time of a piece of the admin's background work, across
 * invocations that overlap: Cloudflare starts a cron's or a queue's next
 * invocation whether or not the last one has ended. Each lease is a row of
 * `leases`, taken with one compare-and-set statement, so of runs at once
 * one gets it, and only from no one or a holder whose lease expired: a run
 * that died without giving it back holds the work up until then. Each
 * holder says how long it holds: no longer than the longest its work runs
 * (a cron or queue invocation's wall-clock limit is 15 minutes,
 * developers.cloudflare.com/workers/platform/limits/), and as short as
 * that allows, so work cut off mid-way holds the next run back little.
 */
import "@tanstack/react-start/server-only";
import { and, eq, lte } from "drizzle-orm";

import type { AdminDatabase } from "./act.ts";
import { leases } from "./schema.ts";

/** The longest any work runs: a cron or queue invocation's wall-clock limit. */
export const invocationLeaseMs = 15 * 60 * 1000;

/**
 * Runs `work` while holding lease `id` for up to `leaseMs`, gives it back
 * after, and returns what `work` did; undefined, at once, when another
 * run holds it.
 */
export const withLease = async <T>(
  db: AdminDatabase,
  id: string,
  leaseMs: number,
  work: () => Promise<T>
): Promise<T | undefined> => {
  const holder = crypto.randomUUID();
  const now = new Date();
  const taken = await db
    .insert(leases)
    .values({ id, holder, expiresAt: new Date(now.getTime() + leaseMs) })
    .onConflictDoUpdate({
      target: leases.id,
      set: { holder, expiresAt: new Date(now.getTime() + leaseMs) },
      setWhere: lte(leases.expiresAt, now),
    })
    .returning({ holder: leases.holder });
  if (taken.length === 0) {
    return undefined;
  }
  try {
    return await work();
  } finally {
    // Only while it's still this run's.
    await db
      .delete(leases)
      .where(and(eq(leases.id, id), eq(leases.holder, holder)));
  }
};
