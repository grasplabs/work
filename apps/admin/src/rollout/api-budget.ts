/**
 * The deployer token's share of Cloudflare's rate limit, as the steps of
 * the organizations' rollouts (src/rollout/org-rollout.ts) saw it: one row
 * in `api_budget`, for the rollout pass to admit organizations by. Every
 * client shares the one token, and so one limit: 1,200 requests in five
 * minutes, after which every call is refused with a 429 for five minutes
 * (Cloudflare's API limits).
 *
 * Each step writes what its API client saw as it ends (`recordApiUsage`):
 * the last `Ratelimit` header, newer than the one on record, and a 429's
 * block. A block is recorded once, by the first step to meet it, audited
 * (`rollout.blocked`) and alerted; the steps that meet it later find it
 * on record and leave it as it is. The header is logged with how many of
 * the step's calls carried it, so whether every call of the API reports
 * the token's limit can be read from the logs.
 *
 * Cloudflare-only: an install on its own premises makes no such calls.
 */
import "@tanstack/react-start/server-only";
import { errorName, log } from "@grasp-os/shared/log";
import { and, eq, gte, isNull, lte, or, sql } from "drizzle-orm";

import { alert } from "../alerts/alert.ts";
import type { ApiUsage } from "../cloudflare/api.ts";
import { auditIfChanged } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import { apiBudget } from "../db/schema.ts";

/** The deployer token's row in `api_budget`: by the binding it's read from. */
export const deployerToken = "DEPLOYER_API_TOKEN";

/**
 * Records that a 429 blocks the deployer token until `until`, unless a
 * block is on record already that hasn't ended by `now`: audited
 * (`rollout.blocked`, its target the block's end) and alerted once a
 * block, however many steps meet it.
 */
const recordBlocked = async (
  db: AdminDatabase,
  until: Date,
  now: Date
): Promise<void> => {
  const target = until.toISOString();
  const results = await db.batch([
    // A row to block: until a header is read, none left until the block ends.
    db
      .insert(apiBudget)
      .values({
        token: deployerToken,
        remaining: 0,
        resetAt: until,
        blockedUntil: null,
        updatedAt: now,
      })
      .onConflictDoNothing(),
    db
      .update(apiBudget)
      .set({ blockedUntil: until })
      .where(
        and(
          eq(apiBudget.token, deployerToken),
          or(isNull(apiBudget.blockedUntil), lte(apiBudget.blockedUntil, now))
        )
      ),
    auditIfChanged(db, "system", {
      action: "rollout.blocked",
      target,
      detail: { until: target },
    }),
  ]);
  if (results[2].length > 0) {
    await alert(db, { kind: "rollout_blocked", until: until.getTime() });
  }
};

/**
 * Records what step `step` of client `clientId`'s rollout saw of the
 * deployer token's limit (`usage`), as it ends, and logs it: the last
 * `Ratelimit` header, over the one on record unless that one is newer,
 * and a 429's block (`recordBlocked`). Never throws: a step neither fails
 * nor retries for its budget.
 */
export const recordApiUsage = async (
  db: AdminDatabase,
  { clientId, step }: { clientId: string; step: string },
  usage: ApiUsage,
  now = new Date()
): Promise<void> => {
  // The header carries counts only: what's left of the token's limit,
  // and when it resets.
  log.info("cloudflare.ratelimit", {
    clientId,
    step,
    calls: usage.calls,
    rated: usage.rated,
    header: usage.header ?? undefined,
    blockedUntil: usage.blockedUntil?.toISOString(),
  });
  try {
    const { limit, blockedUntil } = usage;
    if (limit !== null) {
      const seen = {
        remaining: limit.remaining,
        resetAt: limit.resetAt,
        updatedAt: limit.at,
      };
      await db
        .insert(apiBudget)
        .values({ token: deployerToken, ...seen, blockedUntil: null })
        .onConflictDoUpdate({
          target: apiBudget.token,
          set: seen,
          setWhere: gte(sql`excluded.updated_at`, apiBudget.updatedAt),
        });
    }
    if (blockedUntil !== null && blockedUntil.getTime() > now.getTime()) {
      await recordBlocked(db, blockedUntil, now);
    }
  } catch (error) {
    log.error("cloudflare.ratelimit_unrecorded", {
      clientId,
      step,
      error: errorName(error),
    });
  }
};
