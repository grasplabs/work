import { eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { drizzle } from "drizzle-orm/d1";

import { recordEventIf } from "./audit.ts";
import {
  connectionTokens,
  givenUpRevocations,
  tokenRevocations,
} from "./db/schema.ts";
import { providerFor } from "./providers.ts";

// Revokes owed at a provider (src/revocations.ts; GRA-1191, GRA-1196): how
// one is owed, in the same write as what gives the tokens up, and how one
// ends, with the event that says how. Apart from revocations.ts so the
// paths that give tokens up (oauth.ts, tokens.ts, class-rights.ts) and the
// vault's resealing can use them without importing the retrying.

/**
 * The first wait before trying an owed revoke: long enough for a person
 * asked to connect again to finish its consent screen first, so a grant
 * shared by the account isn't revoked under a reconnect still on its way
 * (src/revocations.ts also waits while a sign-in flow is open).
 */
export const firstRevokeRetryMs = 10 * 60 * 1000;

/** Why a revoke is owed. */
export type OwedReason = "disconnected" | "needs_reauth";

/** Whether `provider`'s grants can be revoked at all: an RFC 7009 endpoint. */
export const revocable = (provider: string): boolean => {
  const config = providerFor(provider);
  return config?.kind === "oauth" && config.revocationEndpoint !== undefined;
};

/**
 * The statement that owes the revoke of connection `connectionId`'s
 * tokens, as `connection_tokens` holds them now, when `when` holds: a copy
 * of them sealed as they are, for the cron trigger to revoke with once the
 * connection's own row is gone. Goes in the batch that gives them up,
 * before the statement that deletes them.
 */
export const oweRevoke = (
  db: DrizzleD1Database,
  connectionId: string,
  reason: OwedReason,
  when: SQL
) => {
  const now = Date.now();
  return db.insert(tokenRevocations).select(
    sql`SELECT ${crypto.randomUUID()}, ${connectionTokens.connectionId}, ${connectionTokens.sealed}, ${reason}, 0, ${now + firstRevokeRetryMs}, ${now}
      FROM ${connectionTokens}
      WHERE ${connectionTokens.connectionId} = ${connectionId} AND ${when}`
  );
};

/** How an owed revoke ended. */
export type OwedEnd =
  | "connection.revoked"
  | "connection.revoke_superseded"
  | "connection.revoke_abandoned";

/** Why a revoke was given up. */
export type GivenUpReason = "expired" | "unreadable";

/**
 * Ends the owed revoke `id` of connection `connectionId` as `action`, with
 * `detail`: the row, and the tokens it held, go in one write with the
 * event, once. One given up (`givenUp`, its reason) is kept as such,
 * without them, for the company's admins to revoke by hand
 * (src/revocations-by-hand.ts).
 */
export const endOwedRevoke = async (
  env: Env,
  owed: { id: string; connectionId: string },
  action: OwedEnd,
  detail: Record<string, string | number>,
  givenUp?: GivenUpReason
): Promise<void> => {
  const db = drizzle(env.DB);
  const still = eq(tokenRevocations.id, owed.id);
  const now = Date.now();
  await recordEventIf(
    env,
    {
      actor: { type: "system" },
      action,
      target: { type: "connection", id: owed.connectionId },
      detail,
    },
    { from: tokenRevocations, where: still },
    [
      ...(givenUp === undefined
        ? []
        : [
            db.insert(givenUpRevocations).select(
              sql`SELECT ${tokenRevocations.id}, ${tokenRevocations.connectionId}, ${tokenRevocations.reason}, ${givenUp}, ${tokenRevocations.attempts}, ${tokenRevocations.createdAt}, ${now}
                FROM ${tokenRevocations} WHERE ${still}`
            ),
          ]),
      db.delete(tokenRevocations).where(still),
    ]
  );
};
