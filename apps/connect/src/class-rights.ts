import {
  connectionErrors,
  requireClassRightsSchema,
} from "@grasp-os/shared/connect";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { recordEventsIf } from "./audit.ts";
import { connections, connectionTokens } from "./db/schema.ts";
import { oweRevoke, revocable } from "./owed-revokes.ts";
import { classRightsProviders, holdsClassRights } from "./provider-rights.ts";

// Turning a class on (core's tool-classes.ts) reaches the grants already
// given: a suite's connection (Microsoft 365's, Google Workspace's) whose
// grant lacks the rights of the classes on now is asked to connect again,
// in place (`needs_reauth`: the same connection, its permissions standing,
// once the same account comes back), rather than run calls the provider
// would refuse. Its tokens go, as for any connection that needs connecting
// again, and the change is audited; the grant they held is still valid,
// so it is revoked as owed (src/revocations.ts).

/** Connections asked to connect again per batch: D1 caps a batch's size. */
const reconnectBatch = 50;

/**
 * Asks every suite's connection still active whose grant lacks a right
 * of `request.classes` to connect again. How many it asked; one a
 * disconnect or another request got to first isn't counted.
 */
export const requireClassRights = async (
  env: Env,
  request: unknown
): Promise<{ reconnect: number }> => {
  const { classes, sharedMailbox = false } = connectionErrors.parse(
    "connection.invalid",
    requireClassRightsSchema,
    request
  );
  const db = drizzle(env.DB);
  // Only connections with tokens: one waiting to be connected again has
  // none, and is asked already.
  const active = await db
    .select({
      id: connections.id,
      provider: connections.provider,
      granted: connectionTokens.grantedScopes,
    })
    .from(connections)
    .innerJoin(
      connectionTokens,
      eq(connectionTokens.connectionId, connections.id)
    )
    .where(
      and(
        inArray(connections.provider, classRightsProviders),
        eq(connections.serverKind, "native"),
        eq(connections.status, "active")
      )
    );
  const lacking = active.filter(
    ({ provider, granted }) =>
      !holdsClassRights(provider, granted, classes, sharedMailbox)
  );
  const batches: (typeof lacking)[] = [];
  for (let start = 0; start < lacking.length; start += reconnectBatch) {
    batches.push(lacking.slice(start, start + reconnectBatch));
  }
  const recorded = await Promise.all(
    batches.map(async (batch) => {
      const [first, ...rest] = batch.map(({ id, provider }) => {
        const stillActive = sql`${connections.id} = ${id} AND ${connections.status} = 'active'`;
        return {
          entry: {
            actor: { type: "system" as const },
            action: "connection.needs_reauth",
            target: { type: "connection", id },
            detail: { provider, reason: "class_turned_on" },
          },
          from: connections,
          where: stillActive,
          writes: [
            // Its grant is still valid: revoked as owed, with a copy of
            // the tokens, so it doesn't stay live with nothing to revoke
            // it should the person never connect again (GRA-1196).
            ...(revocable(provider)
              ? [
                  oweRevoke(
                    db,
                    id,
                    "needs_reauth",
                    sql`EXISTS (SELECT 1 FROM ${connections} WHERE ${stillActive})`
                  ),
                ]
              : []),
            // Before the status changes: the same condition guards both.
            db
              .delete(connectionTokens)
              .where(
                and(
                  eq(connectionTokens.connectionId, id),
                  sql`EXISTS (SELECT 1 FROM ${connections} WHERE ${stillActive})`
                )
              ),
            db
              .update(connections)
              .set({ status: "needs_reauth", updatedAt: new Date() })
              .where(stillActive),
          ],
        };
      });
      return first === undefined
        ? []
        : await recordEventsIf(env, [first, ...rest]);
    })
  );
  const asked = recorded.flat().filter(Boolean).length;
  return { reconnect: asked };
};
