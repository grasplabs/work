import { env } from "cloudflare:workers";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { vi } from "vite-plus/test";

import { modelUsage, providerHealth } from "../src/db/core/schema.ts";

// What the gateway recorded after each response (src/model-usage.ts), read
// from core's D1 as the spend overview reads it. The gateway records in
// the background, after the answer: a test that reads what a call it just
// made recorded waits for it (`recordedUsage`).

/** Whose usage a sum counts: whose key, and for whom. */
export interface UsageFilter {
  /** `organization` (the default) or `platform`, Grasp's own key. */
  credential?: "organization" | "platform";
  personId?: string;
  feature?: string;
}

const whereOf = (month: string, filter: UsageFilter): SQL | undefined =>
  and(
    eq(modelUsage.period, month),
    eq(modelUsage.credential, filter.credential ?? "organization"),
    filter.personId === undefined
      ? undefined
      : eq(modelUsage.personId, filter.personId),
    filter.feature === undefined
      ? undefined
      : eq(modelUsage.feature, filter.feature)
  );

/** What `filter`'s usage in `month` cost, in micros, rounded. */
export const spentMicros = async (
  month: string,
  filter: UsageFilter = {}
): Promise<number> => {
  const [row] = await drizzle(env.DB)
    .select({ total: sql<number | null>`sum(${modelUsage.cost})` })
    .from(modelUsage)
    .where(whereOf(month, filter));
  return Math.round((row?.total ?? 0) * 1_000_000);
};

/** `filter`'s usage rows in `month`, oldest first. */
export const usageRows = async (month: string, filter: UsageFilter = {}) =>
  await drizzle(env.DB)
    .select()
    .from(modelUsage)
    .where(whereOf(month, filter))
    .orderBy(modelUsage.createdAt);

/**
 * `filter`'s usage rows in `month` once there are at least `count`: the
 * gateway writes them in the background, after the answer.
 */
export const recordedUsage = async (
  month: string,
  count: number,
  filter: UsageFilter = {}
) =>
  await vi.waitFor(
    async () => {
      const rows = await usageRows(month, filter);
      if (rows.length < count) {
        throw new Error(`${String(rows.length)} of ${String(count)} recorded`);
      }
      return rows;
    },
    { timeout: 5000, interval: 20 }
  );

/** How each provider's requests fared last, by whose key. */
export const providerHealthRows = async () =>
  await drizzle(env.DB).select().from(providerHealth);
