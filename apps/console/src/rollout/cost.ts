/**
 * What a rollout's clients cost: each one's month so far, read from its
 * account as the client grid reads it (`monthCosts`, src/clients/grid.ts),
 * and their total. It's what the clients cost, not what the rollout did:
 * a rollout's deploys cost nothing of their own that the analytics tell
 * apart.
 */
import { eq } from "drizzle-orm";

import { monthCosts } from "../clients/grid.ts";
import type { MonthCost } from "../clients/grid.ts";
import { consoleDatabase } from "../db/act.ts";
import { clients, rolloutTargets } from "../db/schema.ts";

/** A rollout's clients' cost this month so far, in USD, estimated. */
export interface RolloutCost {
  /** Each client's, by id; null when its account's usage is unknown. */
  clients: Record<string, MonthCost | null>;
  /** The known clients' costs, added up. */
  total: MonthCost;
  /** How many clients' cost is unknown, so not in `total`. */
  unknown: number;
}

/**
 * Rollout `rolloutId`'s clients' cost this month, as of `now`: one
 * client's account not answering leaves only it unknown. Nothing for a
 * rollout that doesn't exist.
 */
export const rolloutCost = async (
  env: Env,
  rolloutId: string,
  now: Date
): Promise<RolloutCost> => {
  const db = consoleDatabase(env.DB);
  const targets = await db
    .select({ id: rolloutTargets.clientId, accountId: clients.accountId })
    .from(rolloutTargets)
    .innerJoin(clients, eq(clients.id, rolloutTargets.clientId))
    .where(eq(rolloutTargets.rolloutId, rolloutId));
  const costs = await monthCosts(env, targets, now);
  const known = Object.values(costs).filter((cost) => cost !== null);
  return {
    clients: costs,
    total: {
      workers: known.reduce((sum, { workers }) => sum + workers, 0),
      ai: known.reduce((sum, { ai }) => sum + ai, 0),
    },
    unknown: targets.length - known.length,
  };
};
