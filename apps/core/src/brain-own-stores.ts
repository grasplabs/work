import { and, eq, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { brainOwnStores } from "./db/core/schema.ts";

// How people's own stores of the new Brain are doing, for Grasp's staff
// (brain-report.ts), without reading any of them: each store tells core
// its own numbers as its alarm's tick ends (brain-next.ts `alarmHostOf`),
// kept here as one row per store, and staff read only their sums. So a
// read of the report costs one query, whatever the number of people, and
// wakes no one's store. A row holds numbers and flags alone, keyed by the
// SHA-256 of the person's id: nothing of what the store holds, no id, no
// size (only whether it is near its limit). Erasing the person removes it
// (brain-next.ts `erasePerson`), and so does a tick that finds the store
// holding nothing any more, so the count is of stores that hold anything.

/** What one person's own store last told core of itself: numbers and flags. */
export interface OwnStoreHealth {
  /** When its tick ended. */
  reportedAt: Date;
  waiting: number;
  /** When the item waiting longest was added; null while none waits. */
  oldestWaitingAt: Date | null;
  parked: number;
  failing: boolean;
  notRebuilt: boolean;
  nearLimit: boolean;
}

/** The sums staff read: never a row, never a person. */
export interface OwnStoresTotals {
  /** People's own stores that hold anything, as their last tick found them. */
  stores: number;
  waiting: number;
  /** When the item waiting longest across them was added; null while none waits. */
  oldestWaitingAt: Date | null;
  parked: number;
  /** Stores whose tick last failed a step, whose queue is paused, or whose ledger isn't read through. */
  failing: number;
  /** Stores whose rebuild for the shipped model isn't done. */
  notRebuilt: number;
  /** Stores near what one object holds. */
  nearLimit: number;
}

const encoder = new TextEncoder();

/** A person's own store's row key: the SHA-256 of their id, in hex. */
const keyOf = async (person: string): Promise<string> =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(person))
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/**
 * Keeps what `person`'s own store told of itself: in place of what it
 * told before, unless that was reported later (a late write of an older
 * tick never replaces a newer one).
 */
export const keepOwnStoreHealth = async (
  env: Pick<Env, "DB">,
  person: string,
  health: OwnStoreHealth
): Promise<void> => {
  const row = { store: await keyOf(person), ...health };
  await drizzle(env.DB)
    .insert(brainOwnStores)
    .values(row)
    .onConflictDoUpdate({
      target: brainOwnStores.store,
      set: {
        reportedAt: health.reportedAt,
        waiting: health.waiting,
        oldestWaitingAt: health.oldestWaitingAt,
        parked: health.parked,
        failing: health.failing,
        notRebuilt: health.notRebuilt,
        nearLimit: health.nearLimit,
      },
      setWhere: lte(brainOwnStores.reportedAt, health.reportedAt),
    });
};

/**
 * Removes `person`'s row: once their own store was erased, or, as of a
 * tick that ended at `reportedAt`, once it holds nothing (a row a later
 * tick wrote stays).
 */
export const forgetOwnStoreHealth = async (
  env: Pick<Env, "DB">,
  person: string,
  reportedAt?: Date
): Promise<void> => {
  const store = eq(brainOwnStores.store, await keyOf(person));
  await drizzle(env.DB)
    .delete(brainOwnStores)
    .where(
      reportedAt === undefined
        ? store
        : and(store, lte(brainOwnStores.reportedAt, reportedAt))
    );
};

/** The sums of every row, in one query. */
export const ownStoresTotals = async (
  env: Pick<Env, "DB">
): Promise<OwnStoresTotals> => {
  const [totals] = await drizzle(env.DB)
    .select({
      stores: sql<number>`count(*)`,
      waiting: sql<number>`coalesce(sum(${brainOwnStores.waiting}), 0)`,
      oldestWaitingAt: sql<
        number | null
      >`min(${brainOwnStores.oldestWaitingAt})`,
      parked: sql<number>`coalesce(sum(${brainOwnStores.parked}), 0)`,
      failing: sql<number>`coalesce(sum(${brainOwnStores.failing}), 0)`,
      notRebuilt: sql<number>`coalesce(sum(${brainOwnStores.notRebuilt}), 0)`,
      nearLimit: sql<number>`coalesce(sum(${brainOwnStores.nearLimit}), 0)`,
    })
    .from(brainOwnStores);
  if (totals === undefined) {
    throw new Error("The sum of people's own stores came back empty");
  }
  return {
    ...totals,
    oldestWaitingAt:
      totals.oldestWaitingAt === null ? null : new Date(totals.oldestWaitingAt),
  };
};
