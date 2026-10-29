import { errorFields, log } from "@grasp-os/shared/log";
import { and, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { recordEventIf } from "./audit.ts";
import {
  connections,
  connectionTokens,
  tokenRevocations,
} from "./db/schema.ts";
import { revokeToken } from "./oauth-client.ts";
import { endOwedRevoke } from "./owed-revokes.ts";
import type { OwedEnd } from "./owed-revokes.ts";
import { providerFor } from "./providers.ts";
import { revocableToken } from "./tokens.ts";

// Revoking a connection's grant at its provider until it goes (GRA-1191).
// Disconnecting revokes the grant where the provider can (oauth.ts
// `stop`); a provider that is down doesn't keep anyone from disconnecting
// (CN14). What it can't revoke then is owed: the connection is
// disconnected all the same, but its sealed tokens stay, with a
// `token_revocations` row, and the cron trigger tries again until the
// revoke goes through. From its threat model:
//
// - A token kept longer than it must be: only while its revoke is owed,
//   sealed as ever (src/vault.ts), and of a disconnected connection, which
//   nothing calls with (tokens.ts `activeConnection`). It goes once the
//   revoke does, once the provider no longer knows it, once there is
//   nothing it could revoke (no refresh token), once its tokens won't open
//   (given up, on record, never counted as revoked), and at the latest
//   `owedForMs` after the disconnect, given up on record. A year: grants
//   outlive 90 days at most providers (Google's unused refresh tokens last
//   about six months, GitHub's a year, Slack's until revoked), so a
//   shorter wait would give up on grants still live.
// - A retry loop against a provider that is down: each owed revoke waits
//   longer after every failed try, doubling up to a day, a few a run, and
//   a try under way holds its row (`underWayMs`) so two runs never ask at
//   once.
// - A revoke racing a reconnect: connecting the same account again makes
//   a new connection. Where the provider's grant is the account's with
//   Grasp's client (`accountWideGrant`: Google), revoking the old token
//   would end the new connection's too, so while a live connection holds
//   the same account (by its ID, or its email where an ID is missing) the
//   owed revoke is dropped instead, with its token, on record: the grant is
//   wanted again, and the new connection's own disconnect revokes it.
//   Everywhere else each token is a grant of its own, and the old one is
//   revoked as owed. A reconnect landing while a try is under way is
//   checked again after the provider revoked: its connection, whose grant
//   just ended, is marked for signing in again at once, on record.
// - An owed revoke nobody can see: the disconnect's event says it is owed
//   (`revokePending`), and its end is on record (`connection.revoked`,
//   `connection.revoke_superseded`, `connection.revoke_abandoned`). An
//   erasure of the connection's owner waits for it
//   (person-erasure.ts).
// - Providers without a revocation endpoint (Microsoft): nothing is owed,
//   and their tokens go at the disconnect, as ever.

/** How a revoke at the provider went. */
export type RevokeOutcome = "revoked" | "nothing" | "unreadable" | "failed";

/** The first wait before trying an owed revoke again. */
export const firstRevokeRetryMs = 5 * 60 * 1000;

/** The longest wait between two tries. */
const maxRetryMs = 24 * 60 * 60 * 1000;

/** How long a try holds its row, so another run passes it by. */
const underWayMs = 5 * 60 * 1000;

/** How long a revoke is owed at most before it is given up: a year. */
export const owedForMs = 365 * 24 * 60 * 60 * 1000;

/** Most owed revokes one cron run tries: one request each. */
const retryBatchSize = 10;

/** Failed tries after which an owed revoke is logged as stuck, every try. */
const stuckAttempts = 8;

/** How long to wait after `attempts` failed tries: doubling, up to a day. */
const retryDelayMs = (attempts: number): number =>
  Math.min(firstRevokeRetryMs * 2 ** attempts, maxRetryMs);

type ConnectionRow = typeof connections.$inferSelect;

/**
 * Revokes `connection`'s grant at its provider: `revoked` once it did (or
 * no longer knows the token), `nothing` where there is nothing to revoke
 * (no grant, no revocation endpoint, no refresh token), `unreadable` where
 * a key that is held doesn't open the tokens, `failed` while the provider
 * won't, connect has no client to ask it with, or the tokens' key isn't
 * held.
 */
export const revokeAtProvider = async (
  env: Env,
  connection: ConnectionRow
): Promise<RevokeOutcome> => {
  const provider = providerFor(connection.provider);
  // An API key has no grant to revoke: the app's own settings do that.
  if (provider?.kind !== "oauth" || provider.revocationEndpoint === undefined) {
    return "nothing";
  }
  const token = await revocableToken(env, connection.id);
  if (token === "none") {
    return "nothing";
  }
  if (token === "unreadable") {
    return "unreadable";
  }
  if (token === "unavailable") {
    // Its key isn't held now: tried again, never given up for it.
    return "failed";
  }
  const client = provider.client(env);
  if (client === undefined) {
    log.warn("oauth.revoke_failed", {
      provider: provider.id,
      reason: "no_client",
    });
    return "failed";
  }
  try {
    return (await revokeToken(provider, client, token.refreshToken))
      ? "revoked"
      : "nothing";
  } catch (error) {
    log.warn("oauth.revoke_failed", {
      provider: provider.id,
      ...errorFields(error),
    });
    return "failed";
  }
};

/**
 * The live connections that hold `connection`'s grant now, where its
 * provider's grant is the account's (`accountWideGrant`): connections of
 * the same account at a provider of the same group. By the account's ID,
 * or, where either side has none recorded, its email, so a Google account
 * named only by its address is still found; never by email between two
 * different IDs. None where each token is a
 * grant of its own: revoking the old one ends nothing new.
 */
const liveOnSameGrant = async (
  env: Env,
  connection: ConnectionRow
): Promise<ConnectionRow[]> => {
  const provider = providerFor(connection.provider);
  const group =
    provider?.kind === "oauth" ? provider.accountWideGrant : undefined;
  if (group === undefined) {
    return [];
  }
  const { accountId, accountEmail } = connection;
  // An email names the account only where one side has no ID: two
  // different IDs are two accounts, whatever address each once had.
  const sameEmail =
    accountEmail === null
      ? undefined
      : and(
          sql`lower(${connections.accountEmail}) = lower(${accountEmail})`,
          accountId === null ? undefined : isNull(connections.accountId)
        );
  const sameAccount = or(
    accountId === null ? undefined : eq(connections.accountId, accountId),
    sameEmail
  );
  if (sameAccount === undefined) {
    return [];
  }
  const live = await drizzle(env.DB)
    .select()
    .from(connections)
    .where(and(sameAccount, ne(connections.status, "disconnected")));
  return live.filter((each) => {
    const theirs = providerFor(each.provider);
    return theirs?.kind === "oauth" && theirs.accountWideGrant === group;
  });
};

/**
 * Marks `live`, a connection whose grant a revoke just ended, for signing
 * in again, at once, on record, rather than on its next refused refresh:
 * a reconnect that landed while the revoke was on its way.
 */
const markGrantRevoked = async (
  env: Env,
  live: ConnectionRow
): Promise<void> => {
  const db = drizzle(env.DB);
  const stillActive = sql`${connections.id} = ${live.id} AND ${connections.status} = 'active'`;
  await recordEventIf(
    env,
    {
      actor: { type: "system" },
      action: "connection.needs_reauth",
      target: { type: "connection", id: live.id },
      detail: { provider: live.provider, reason: "grant_revoked" },
    },
    { from: connections, where: stillActive },
    [
      db
        .delete(connectionTokens)
        .where(
          and(
            eq(connectionTokens.connectionId, live.id),
            sql`EXISTS (SELECT 1 FROM ${connections} WHERE ${stillActive})`
          )
        ),
      db
        .update(connections)
        .set({ status: "needs_reauth", updatedAt: new Date() })
        .where(stillActive),
    ]
  );
};

/**
 * Tries the owed revoke `owed` once: claims it for a while, then drops it
 * where the account is connected again, gives it up past `owedForMs`,
 * settles it once the provider revoked, or waits longer after a failure.
 */
const tryOwed = async (
  env: Env,
  owed: typeof tokenRevocations.$inferSelect,
  connection: ConnectionRow,
  now: number
): Promise<void> => {
  const db = drizzle(env.DB);
  const claimed = await db
    .update(tokenRevocations)
    .set({ retryAt: new Date(now + underWayMs) })
    .where(
      and(
        eq(tokenRevocations.connectionId, owed.connectionId),
        eq(tokenRevocations.retryAt, owed.retryAt)
      )
    )
    .returning({ id: tokenRevocations.connectionId });
  if (claimed.length === 0) {
    return;
  }
  const attempts = owed.attempts + 1;
  if (connection.status !== "disconnected") {
    // Never: a disconnected connection stays so. Its tokens are a live
    // connection's, so only the row goes.
    log.error("oauth.revoke_owed_for_live", { provider: connection.provider });
    await db
      .delete(tokenRevocations)
      .where(eq(tokenRevocations.connectionId, owed.connectionId));
    return;
  }
  const end = async (
    action: OwedEnd,
    detail: Record<string, string | number>
  ): Promise<void> => {
    await endOwedRevoke(env, connection.id, action, {
      provider: connection.provider,
      ...detail,
    });
  };
  const heldAgain = await liveOnSameGrant(env, connection);
  if (heldAgain.length > 0) {
    await end("connection.revoke_superseded", { attempts: owed.attempts });
    return;
  }
  if (now - owed.createdAt.getTime() >= owedForMs) {
    log.error("oauth.revoke_abandoned", {
      provider: connection.provider,
      attempts: owed.attempts,
    });
    await end("connection.revoke_abandoned", {
      attempts: owed.attempts,
      reason: "expired",
    });
    return;
  }
  const outcome = await revokeAtProvider(env, connection);
  if (outcome === "unreadable") {
    log.error("oauth.revoke_abandoned", {
      provider: connection.provider,
      attempts,
    });
    await end("connection.revoke_abandoned", {
      attempts,
      reason: "unreadable",
    });
    return;
  }
  if (outcome !== "failed") {
    await end("connection.revoked", { attempts, outcome });
    // A reconnect that landed while the revoke was on its way: its grant
    // just ended with it.
    if (outcome === "revoked") {
      for (const live of await liveOnSameGrant(env, connection)) {
        // oxlint-disable-next-line no-await-in-loop -- rare, and one each
        await markGrantRevoked(env, live);
      }
    }
    return;
  }
  if (attempts >= stuckAttempts) {
    log.error("oauth.revoke_stuck", {
      provider: connection.provider,
      attempts,
    });
  }
  await db
    .update(tokenRevocations)
    .set({ attempts, retryAt: new Date(now + retryDelayMs(attempts)) })
    .where(eq(tokenRevocations.connectionId, owed.connectionId));
};

/** The owed revokes `where` picks, with their connections, a batch at most. */
const owedWhere = async (env: Env, where: SQL | undefined) =>
  await drizzle(env.DB)
    .select({ owed: tokenRevocations, connection: connections })
    .from(tokenRevocations)
    .innerJoin(connections, eq(connections.id, tokenRevocations.connectionId))
    .where(where)
    .orderBy(tokenRevocations.retryAt)
    .limit(retryBatchSize);

/**
 * Tries again the owed revokes that are due, a few a run, each on its own:
 * one failing waits longer, and the rest go on. The cron trigger calls it.
 */
export const retryRevocations = async (env: Env): Promise<void> => {
  const now = Date.now();
  const due = await owedWhere(
    env,
    lte(tokenRevocations.retryAt, new Date(now))
  );
  for (const { owed, connection } of due) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one provider request at a time
      await tryOwed(env, owed, connection, now);
    } catch (error) {
      log.error("oauth.revoke_retry_failed", errorFields(error));
    }
  }
};

/**
 * Tries at once the owed revokes of `ownerUserId`'s personal connections,
 * due or not, for their erasure (person-erasure.ts), and answers whether
 * any is still owed after.
 */
export const revokeOwedOf = async (
  env: Env,
  ownerUserId: string
): Promise<boolean> => {
  const theirs = sql`${tokenRevocations.connectionId} IN (
    SELECT ${connections.id} FROM ${connections}
    WHERE ${connections.scope} = 'personal' AND ${connections.ownerUserId} = ${ownerUserId}
  )`;
  const now = Date.now();
  const owed = await owedWhere(env, theirs);
  // Due or not: the erasure asks now. A revoke asked twice at once (the
  // cron trigger's try, and this) is only revoked twice, which a provider
  // takes (RFC 7009 §2.2).
  for (const { owed: each, connection } of owed) {
    // oxlint-disable-next-line no-await-in-loop -- one provider request at a time
    await tryOwed(env, each, connection, now);
  }
  const [left] = await drizzle(env.DB)
    .select({ id: tokenRevocations.connectionId })
    .from(tokenRevocations)
    .where(theirs)
    .limit(1);
  return left !== undefined;
};
