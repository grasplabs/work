import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { recordEventIf } from "./audit.ts";
import {
  connections,
  connectionTokens,
  tokenRevocations,
} from "./db/schema.ts";

// How a revoke owed at a provider ends (src/revocations.ts, GRA-1191):
// its row and the tokens kept for it go together, with the event that
// says how, only while the connection is still disconnected and the
// revoke still owed. Apart from revocations.ts so the vault's resealing
// (tokens.ts) can end one whose tokens no longer open.

/** How an owed revoke ended. */
export type OwedEnd =
  | "connection.revoked"
  | "connection.revoke_superseded"
  | "connection.revoke_abandoned";

/**
 * Ends connection `connectionId`'s owed revoke as `action`, with `detail`:
 * its row and its tokens go, in one write with the event.
 */
export const endOwedRevoke = async (
  env: Env,
  connectionId: string,
  action: OwedEnd,
  detail: Record<string, string | number>
): Promise<void> => {
  const db = drizzle(env.DB);
  const owed = sql`${tokenRevocations.connectionId} = ${connectionId} AND EXISTS (SELECT 1 FROM ${connections} WHERE ${connections.id} = ${connectionId} AND ${connections.status} = 'disconnected')`;
  await recordEventIf(
    env,
    {
      actor: { type: "system" },
      action,
      target: { type: "connection", id: connectionId },
      detail,
    },
    { from: tokenRevocations, where: owed },
    [
      db
        .delete(connectionTokens)
        .where(
          and(
            eq(connectionTokens.connectionId, connectionId),
            sql`EXISTS (SELECT 1 FROM ${tokenRevocations} WHERE ${owed})`
          )
        ),
      db.delete(tokenRevocations).where(owed),
    ]
  );
};
