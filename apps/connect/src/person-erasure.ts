import {
  connectionErrors,
  erasePersonalSchema,
} from "@grasp-os/shared/connect";
import { and, eq, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { recordEvents } from "./audit.ts";
import { dropToolkitFlowsOf } from "./composio-connections.ts";
import {
  callChanges,
  composioCleanups,
  connectionTokens,
  connections,
  connectorEvents,
  erasedPeople,
  eventSources,
  idempotentCalls,
  oauthFlows,
  pendingActions,
} from "./db/schema.ts";
import { disconnectPersonal, revoke } from "./oauth.ts";
import { providerFor } from "./providers.ts";

// Erasing a person (GRA-903, GRA-1183), connect's part, for core only, for
// someone an admin removed and then erased (core's person-erasure.ts).
// Nothing of theirs is emptied while a grant of theirs may still be live
// at its provider: core's clock asks again until it isn't.
//
// - A connection of theirs still live (a flow that finished after they
//   were removed, say) is revoked at its provider first, strictly: where
//   the provider has a revocation endpoint and the revoke fails, it is
//   left as it is, tokens and all, and this refuses
//   (`connection.erase_pending`). Then it is stopped as any removal stops
//   it (`disconnectPersonal`).
// - A Composio connection is deleted at Composio after it is stopped, by
//   a cleanup the cron trigger retries (composio-connections.ts): while
//   one for theirs is outstanding, this refuses.
// - A revoke that failed when they were removed can't be recovered: a
//   disconnect deletes the tokens however its revoke went (threat model
//   CN14), so there is nothing to revoke with any more, and nothing knows
//   it failed. Until GRA-1191 keeps a token until its revoke succeeds,
//   such a grant stays live at its provider until it lapses.
//
// First of all, connect marks that their erasure began (`erased_people`),
// and from then makes nothing of theirs again: no connection a flow of
// theirs still under way finishes (oauth.ts), no change a call through one
// of their connections still under way made (changes.ts). Each checks the
// mark in the statement that writes, so nothing lands after the batch
// below emptied what was theirs.
//
// Then, in one batch, everything of theirs left in connect: who their
// accounts were at each provider, on their disconnected connections only,
// what the calls made through those connections returned and changed,
// and any flow or held action of theirs, recorded every time. Should one
// of their connections be live again after it (a flow finishing as this
// ran), this refuses, and the next try stops it. Their connections' rows
// stay, empty of them, as the IDs the audit log and the company's records
// name. Calls made for them through the company's shared connections are
// the company's (Nick's D3), and stay.

/** Their personal connections, as SQL: every one, live or disconnected. */
const theirConnections = (ownerUserId: string) =>
  and(
    eq(connections.scope, "personal"),
    eq(connections.ownerUserId, ownerUserId)
  );

/** Refuses: something of theirs may still be live at a provider. */
const pending = (): Error =>
  connectionErrors.create("connection.erase_pending");

/**
 * Revokes the grant of each live connection of `ownerUserId`'s whose
 * provider can revoke one, refusing on the first that fails.
 */
const revokeLive = async (env: Env, ownerUserId: string): Promise<void> => {
  const live = await drizzle(env.DB)
    .select()
    .from(connections)
    .where(
      and(theirConnections(ownerUserId), ne(connections.status, "disconnected"))
    );
  for (const connection of live) {
    const provider = providerFor(connection.provider);
    // oxlint-disable-next-line no-await-in-loop -- one connection at a time
    const [token] = await drizzle(env.DB)
      .select({ id: connectionTokens.connectionId })
      .from(connectionTokens)
      .where(eq(connectionTokens.connectionId, connection.id))
      .limit(1);
    // Without a token there is no grant here to revoke.
    const revocable =
      token !== undefined &&
      provider?.kind === "oauth" &&
      provider.revocationEndpoint !== undefined;
    // oxlint-disable-next-line no-await-in-loop -- one grant at a time
    if (revocable && !(await revoke(env, connection))) {
      throw pending();
    }
  }
};

/** Whether a Composio cleanup of `ownerUserId`'s connections is outstanding. */
const cleaningUp = async (env: Env, ownerUserId: string): Promise<boolean> => {
  const [left] = await drizzle(env.DB)
    .select({ id: composioCleanups.id })
    .from(composioCleanups)
    .where(
      sql`${composioCleanups.serverId} IN (
        SELECT ${connections.composioServerId} FROM ${connections}
        WHERE ${theirConnections(ownerUserId)}
          AND ${connections.composioServerId} IS NOT NULL
      )`
    )
    .limit(1);
  return left !== undefined;
};

/** Whether a connection of `ownerUserId`'s is live. */
const anyLive = async (env: Env, ownerUserId: string): Promise<boolean> => {
  const [live] = await drizzle(env.DB)
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(theirConnections(ownerUserId), ne(connections.status, "disconnected"))
    )
    .limit(1);
  return live !== undefined;
};

/**
 * Erases everything of `ownerUserId`'s in connect, as core asks once an
 * admin erased them. Safe to ask again: what is gone stays gone. Answers
 * how many of their connections it emptied.
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
  // Before anything else: from here on, connect makes nothing of theirs.
  await drizzle(env.DB)
    .insert(erasedPeople)
    .values({ userId: ownerUserId, beganAt: new Date() })
    .onConflictDoNothing();
  await revokeLive(env, ownerUserId);
  // Stopped, its tokens gone, their flows spent and what waited for them
  // dropped, as for anyone removed.
  await disconnectPersonal(env, { person: null, ownerUserIds: [ownerUserId] });
  if (
    (await anyLive(env, ownerUserId)) ||
    (await cleaningUp(env, ownerUserId))
  ) {
    throw pending();
  }
  // Their Composio flows, handed over to cleanup rows, never deleted: what
  // each made at Composio is deleted there by the clock.
  await dropToolkitFlowsOf(env, [ownerUserId]);
  const db = drizzle(env.DB);
  const [owned] = await db
    .select({ count: sql<number>`count(*)` })
    .from(connections)
    .where(
      and(theirConnections(ownerUserId), eq(connections.status, "disconnected"))
    );
  const count = owned?.count ?? 0;
  // Their disconnected connections, as SQL, however many they had: by
  // their owner, never a list of IDs.
  const theirs = sql`(
    SELECT ${connections.id} FROM ${connections}
    WHERE ${theirConnections(ownerUserId)}
      AND ${connections.status} = 'disconnected'
  )`;
  await recordEvents(
    env,
    [
      {
        actor: { type: "system" },
        action: "connection.person_erased",
        target: { type: "person", id: ownerUserId },
        detail: { ownerUserId, connections: count },
      },
    ],
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
        .where(
          and(
            theirConnections(ownerUserId),
            eq(connections.status, "disconnected")
          )
        ),
      db
        .delete(idempotentCalls)
        .where(sql`${idempotentCalls.connectionId} IN ${theirs}`),
      db
        .delete(callChanges)
        .where(sql`${callChanges.connectionId} IN ${theirs}`),
      // What their connections read for workflows: the mailboxes and items
      // still to deliver, which name them and hold their provider's data.
      db
        .delete(connectorEvents)
        .where(sql`${connectorEvents.connectionId} IN ${theirs}`),
      db
        .delete(eventSources)
        .where(sql`${eventSources.connectionId} IN ${theirs}`),
      db
        .delete(pendingActions)
        .where(eq(pendingActions.onBehalfOf, ownerUserId)),
      db.delete(oauthFlows).where(eq(oauthFlows.userId, ownerUserId)),
    ]
  );
  // A flow that finished as this ran: refused, and stopped on the next try.
  if (await anyLive(env, ownerUserId)) {
    throw pending();
  }
  return { connections: count };
};
