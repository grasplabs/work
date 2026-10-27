import {
  connectionErrors,
  erasePersonalSchema,
} from "@grasp-os/shared/connect";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { recordEventIf } from "./audit.ts";
import {
  callChanges,
  composioFlows,
  connections,
  idempotentCalls,
  oauthFlows,
  pendingActions,
} from "./db/schema.ts";
import { disconnectPersonal } from "./oauth.ts";

// Erasing a person (GRA-903, GRA-1183), connect's part, for core only, for
// someone an admin removed and then erased (core's person-erasure.ts).
// Removing them disconnected their personal connections already: each
// grant revoked at its provider, its tokens gone, their flows spent and
// what waited for them dropped (`disconnectPersonal`). This does that
// again first, in case anything came back, and refuses to go on while any
// of their connections is still live, so a provider's grant is never left
// behind what is erased. Then, in one batch, everything of theirs left in
// connect: who their accounts were at each provider (the account, its
// name, address and aliases), what the calls made through their own
// connections returned and changed, and any flow or held action of
// theirs. Their connections' rows stay, empty of them, as the IDs the
// audit log and the company's records name. Calls made for them through
// the company's shared connections are the company's (Nick's D3).

/** Their personal connections, as SQL: every one, live or disconnected. */
const theirConnections = (ownerUserId: string) =>
  and(
    eq(connections.scope, "personal"),
    eq(connections.ownerUserId, ownerUserId)
  );

/**
 * Erases everything of `ownerUserId`'s in connect, as core asks once an
 * admin erased them. Safe to ask again: what is gone stays gone, and the
 * erasure is recorded once, by the change that found something of theirs.
 * Answers how many of their connections it emptied.
 */
export const erasePersonal = async (
  env: Env,
  request: unknown
): Promise<{ connections: number }> => {
  const { ownerUserId } = connectionErrors.parse(
    "connection.invalid",
    erasePersonalSchema,
    request
  );
  // Revoked at each provider and its tokens gone, as for anyone removed.
  await disconnectPersonal(env, { person: null, ownerUserIds: [ownerUserId] });
  const db = drizzle(env.DB);
  const owned = await db
    .select({ id: connections.id, status: connections.status })
    .from(connections)
    .where(theirConnections(ownerUserId));
  if (owned.some(({ status }) => status !== "disconnected")) {
    // A grant still live at its provider: erased only once it isn't.
    throw connectionErrors.create("connection.invalid");
  }
  const ids = owned.map(({ id }) => id);
  const stillNamed = and(
    theirConnections(ownerUserId),
    or(
      sql`${connections.accountId} IS NOT NULL`,
      sql`${connections.accountName} IS NOT NULL`,
      sql`${connections.accountEmail} IS NOT NULL`,
      sql`${connections.accountAddresses} IS NOT NULL`,
      sql`${connections.accountSenders} IS NOT NULL`
    )
  );
  await recordEventIf(
    env,
    {
      actor: { type: "system" },
      action: "connection.person_erased",
      target: { type: "person", id: ownerUserId },
      detail: { ownerUserId, connections: ids.length },
    },
    { from: connections, where: stillNamed ?? sql`0` },
    [
      db
        .update(connections)
        .set({
          accountId: null,
          accountName: null,
          accountEmail: null,
          accountAddresses: null,
          accountSenders: null,
          updatedAt: new Date(),
        })
        .where(theirConnections(ownerUserId)),
      db
        .delete(idempotentCalls)
        .where(inArray(idempotentCalls.connectionId, ids)),
      db.delete(callChanges).where(inArray(callChanges.connectionId, ids)),
      db
        .delete(pendingActions)
        .where(eq(pendingActions.onBehalfOf, ownerUserId)),
      db.delete(oauthFlows).where(eq(oauthFlows.userId, ownerUserId)),
      db.delete(composioFlows).where(eq(composioFlows.userId, ownerUserId)),
    ]
  );
  return { connections: ids.length };
};
