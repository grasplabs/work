import { maxRetryAfterSeconds } from "@grasp-os/runtime/connector";
import { connectErrors, connectionErrors } from "@grasp-os/shared/connect";
import { isExpectedError } from "@grasp-os/shared/errors";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, eq, exists, isNull, like, lte, not, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { recordEventIf } from "./audit.ts";
import { outbound } from "./company-network.ts";
import { pastAddressesAfter } from "./connections.ts";
import { providerConfigFor } from "./connector-providers.ts";
import {
  connections,
  connectionTokens,
  tokenRevocations,
} from "./db/schema.ts";
import { ownerErased } from "./erased-people.ts";
import { isInvalidGrant, refreshTokens, revokeToken } from "./oauth-client.ts";
import type { TokenSet } from "./oauth-client.ts";
import { oweRevoke, revocable } from "./owed-revokes.ts";
import {
  bearer,
  providerFor,
  scopesLacking,
  renewalHolds,
  renewedAsGranted,
} from "./providers.ts";
import type {
  Credential,
  LoginProviderConfig,
  OAuthClientCredentials,
  OAuthProviderConfig,
} from "./providers.ts";
import { minSessionMs } from "./session-login.ts";
import { resealBatchSize, VaultError, vaultFor } from "./vault.ts";
import type { Vault } from "./vault.ts";

// The token vault: each connection's tokens, its API key, or its login's
// fields and session, sealed (src/vault.ts), in connect's D1. Nothing
// here is reachable over RPC: tokens and keys never leave connect, except
// as the credential of one call, which a connector's egress handler adds
// to the call's requests (threat model R1). A refresh token never leaves
// at all: only its token endpoint sees it.

/**
 * The host a connection signed in with for each of its connector's host
 * templates (runtime's `filledHost`), sealed with its tokens or key: they
 * can't be changed apart from the credential, so pointing a connection
 * at another host takes signing in again (GRA-2350).
 */
const connectionHostsSchema = z.record(z.string(), z.string()).optional();

/**
 * What a connection's sealed value holds: OAuth tokens, or an API key and,
 * for a shared connection reached through the company network, the one
 * address its requests go to (company-network.ts): sealed with the key,
 * so the address can't be changed apart from it.
 */
const storedTokensSchema = z.union([
  z.strictObject({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    hosts: connectionHostsSchema,
  }),
  z.strictObject({
    apiKey: z.string().min(1),
    companyNetwork: z.string().min(1).optional(),
    hosts: connectionHostsSchema,
  }),
  // A login's fields, by name, as the person gave them, and the session
  // the last login answered with (session-login.ts).
  z.strictObject({
    login: z.record(z.string(), z.string()),
    session: z.string().min(1),
    companyNetwork: z.string().min(1).optional(),
    hosts: connectionHostsSchema,
  }),
]);
type StoredTokens = z.infer<typeof storedTokensSchema>;
type StoredOAuthTokens = Extract<StoredTokens, { refreshToken: string }>;
type StoredLogin = Extract<StoredTokens, { login: unknown }>;

/**
 * When an API key's "access" expires: never, as far as connect goes. A key
 * the app stopped taking fails the call, until the person gives the
 * connection a new one (`connectWithKey`).
 */
export const apiKeyExpiresAt = Date.UTC(9999, 11, 31);

/** A connection's tokens are sealed for that connection only. */
const sealContext = (connectionId: string): string => `token:${connectionId}`;

/** An access token this close to expiry is refreshed first. */
const expirySkewMs = 60_000;
/**
 * How long one refresh holds its lease: past the token request's own
 * timeout, so a lease only lapses when its holder is gone.
 */
const refreshLeaseMs = 15_000;
/** How often a call waiting for another's refresh looks again. */
const refreshPollMs = 100;

type TokenRow = typeof connectionTokens.$inferSelect;

const sealTokens = async (
  vault: Vault,
  connectionId: string,
  tokens: StoredTokens
): Promise<string> =>
  await vault.seal(JSON.stringify(tokens), sealContext(connectionId));

const openTokens = async (
  vault: Vault,
  row: Pick<TokenRow, "connectionId" | "sealed">
): Promise<StoredTokens> =>
  storedTokensSchema.parse(
    JSON.parse(await vault.open(row.sealed, sealContext(row.connectionId)))
  );

/** The OAuth tokens a row holds; an API key's row has none. */
const openOAuthTokens = async (
  vault: Vault,
  row: Pick<TokenRow, "connectionId" | "sealed">
): Promise<StoredOAuthTokens> => {
  const tokens = await openTokens(vault, row);
  if (!("refreshToken" in tokens)) {
    throw connectErrors.create("connect.connection_inactive");
  }
  return tokens;
};

const accessTokenOf = async (
  vault: Vault,
  row: Pick<TokenRow, "connectionId" | "sealed">
): Promise<string> => {
  const { accessToken } = await openOAuthTokens(vault, row);
  return accessToken;
};

/** What of a sign-in's tokens, key or login is sealed. */
const sealedOf = (tokens: StoredTokens): StoredTokens => {
  const { hosts } = tokens;
  if ("apiKey" in tokens) {
    const { apiKey, companyNetwork } = tokens;
    return { apiKey, companyNetwork, hosts };
  }
  if ("login" in tokens) {
    const { login, session, companyNetwork } = tokens;
    return { login, session, companyNetwork, hosts };
  }
  const { accessToken, refreshToken } = tokens;
  return { accessToken, refreshToken, hosts };
};

/**
 * The row that stores the tokens of a new grant: a new connection's, or a
 * reconnected one's. Its generation starts at the time, which no earlier
 * row of the connection reached, so a refresh still under way for the
 * tokens it had before it was reconnected can't pass for one of these.
 */
export const firstTokens = async (
  vault: Vault,
  connectionId: string,
  tokens: StoredTokens & { expiresAt: number; scope?: string },
  now: Date
): Promise<TokenRow> => ({
  connectionId,
  sealed: await sealTokens(vault, connectionId, sealedOf(tokens)),
  accessExpiresAt: new Date(tokens.expiresAt),
  generation: now.getTime(),
  refreshUntil: null,
  grantedScopes: tokens.scope ?? null,
  updatedAt: now,
  // Stored as a new row (a new connection, or one connected again after
  // its grant was lost), it starts unpaused; a grant renewed in place
  // keeps the pause, which is the same account's.
  pausedUntil: null,
});

/**
 * Revokes tokens that were minted but won't be kept, so no usable grant is
 * left behind that nobody holds (threat model CN14). Only when no live
 * connection holds the grant: Google revokes the whole grant of the
 * account and client, whichever of its tokens is revoked. Best effort:
 * logged, never thrown.
 */
export const discardMint = async (
  provider: OAuthProviderConfig,
  client: OAuthClientCredentials,
  tokens: Pick<TokenSet, "accessToken" | "refreshToken">
): Promise<void> => {
  try {
    const revoked = await revokeToken(
      provider,
      client,
      tokens.refreshToken ?? tokens.accessToken
    );
    if (!revoked) {
      // No endpoint to revoke at (Entra): kept nowhere, it lapses.
      log.info("oauth.discard_unavailable", { provider: provider.id });
    }
  } catch (error) {
    log.warn("oauth.discard_failed", {
      provider: provider.id,
      ...errorFields(error),
    });
  }
};

const readRow = async (
  db: D1Database,
  connectionId: string
): Promise<TokenRow | undefined> =>
  await drizzle(db)
    .select()
    .from(connectionTokens)
    .where(eq(connectionTokens.connectionId, connectionId))
    .get();

/**
 * What connection `connectionId`'s tokens were last granted, as the
 * provider's answer listed it: null when connect didn't keep it, or holds
 * no tokens of it.
 */
export const grantedScopesOf = async (
  env: Env,
  connectionId: string
): Promise<string | null> => {
  const row = await readRow(env.DB, connectionId);
  return row?.grantedScopes ?? null;
};

const isFresh = (row: TokenRow, now: number): boolean =>
  row.accessExpiresAt.getTime() - expirySkewMs > now;

/** The row as read: this connection's tokens, still at this generation. */
const unchanged = (row: TokenRow): SQL =>
  sql`${connectionTokens.connectionId} = ${row.connectionId} AND ${connectionTokens.generation} = ${row.generation}`;

/** Whether connection `connectionId` is disconnected. */
const disconnected = async (
  db: D1Database,
  connectionId: string
): Promise<boolean> => {
  const [row] = await drizzle(db)
    .select({ status: connections.status })
    .from(connections)
    .where(eq(connections.id, connectionId));
  return row?.status === "disconnected";
};

/** That `row`'s connection isn't disconnected, as SQL. */
const notDisconnected = (row: TokenRow): SQL =>
  sql`EXISTS (SELECT 1 FROM ${connections} WHERE ${connections.id} = ${row.connectionId} AND ${connections.status} <> 'disconnected')`;

/** Takes the refresh lease on `row`, unless someone holds it. */
const takeLease = async (
  db: D1Database,
  row: TokenRow,
  now: number
): Promise<boolean> => {
  const taken = await drizzle(db)
    .update(connectionTokens)
    .set({ refreshUntil: new Date(now + refreshLeaseMs) })
    .where(
      and(
        unchanged(row),
        or(
          isNull(connectionTokens.refreshUntil),
          lte(connectionTokens.refreshUntil, new Date(now))
        )
      )
    )
    .returning({ connectionId: connectionTokens.connectionId });
  return taken.length > 0;
};

const releaseLease = async (db: D1Database, row: TokenRow): Promise<void> => {
  await drizzle(db)
    .update(connectionTokens)
    .set({ refreshUntil: null })
    .where(unchanged(row));
};

/** Why a connection's tokens are no use any more (`markDead`). */
type DeadReason =
  | "invalid_grant"
  | "unreadable"
  | "scopes_changed"
  | "scopes_missing"
  | "login_refused";

/** Whether a connection marked for `reason` still holds a valid grant. */
const grantStillValid = (reason: DeadReason): boolean =>
  reason === "scopes_changed" || reason === "scopes_missing";

/**
 * The connection's tokens are no use any more (the grant is gone, or they
 * don't open): it needs the person to connect again, and they go. Only if
 * `row` is still what is stored; a refresh whose lease lapsed may hear
 * `invalid_grant` for a refresh token another refresh already replaced,
 * and that connection is fine. Recorded only when it changed something.
 * Whether it did.
 */
const markDead = async (
  env: Env,
  provider: string,
  row: TokenRow,
  reason: DeadReason
): Promise<boolean> => {
  const db = drizzle(env.DB);
  const owesRevoke =
    grantStillValid(reason) &&
    revocable(await providerConfigFor(env, provider));
  return await recordEventIf(
    env,
    {
      actor: { type: "system" },
      action: "connection.needs_reauth",
      target: { type: "connection", id: row.connectionId },
      detail: { provider, reason },
    },
    // Never a disconnected connection's: a stopped connection's tokens are
    // the disconnect's to end.
    {
      from: connectionTokens,
      where: sql`${unchanged(row)} AND ${notDisconnected(row)}`,
    },
    [
      // A grant still valid that loses its tokens here is revoked as owed
      // (src/revocations.ts, GRA-1196), with a copy of them, so it doesn't
      // stay live with nothing left to revoke it, should the person never
      // connect again; one the provider refused, or that won't open, has
      // nothing to revoke.
      ...(owesRevoke
        ? [
            oweRevoke(
              db,
              row.connectionId,
              "needs_reauth",
              sql`${unchanged(row)} AND EXISTS (SELECT 1 FROM ${connections} WHERE ${connections.id} = ${row.connectionId} AND ${connections.status} = 'active')`
            ),
          ]
        : []),
      db
        .update(connections)
        .set({ status: "needs_reauth", updatedAt: new Date() })
        .where(
          and(
            eq(connections.id, row.connectionId),
            eq(connections.status, "active"),
            exists(db.select().from(connectionTokens).where(unchanged(row)))
          )
        ),
      db
        .delete(connectionTokens)
        .where(and(unchanged(row), notDisconnected(row))),
    ]
  );
};

/**
 * Marks the connection for reconnecting when its provider refused one of
 * its writes and its tokens weren't granted every scope its provider asks
 * for now: a connection made before its connector asked for a right (a
 * Microsoft 365 one from before Calendars.ReadWrite) can't get it without
 * the person consenting again, and reconnecting keeps its ID and its
 * permissions (oauth.ts `reconnect`). One granted all of them was refused
 * for another reason, and stays as it is; so does one whose grant connect
 * doesn't know (tokens stored before it kept them), until a refresh tells
 * it. Whether it is marked now: by this call, or by another refused while
 * this one was on its way, which took its tokens with it.
 */
export const markIfGrantLacks = async (
  env: Env,
  connectionId: string
): Promise<boolean> => {
  const connection = await drizzle(env.DB)
    .select({ provider: connections.provider, status: connections.status })
    .from(connections)
    .where(eq(connections.id, connectionId))
    .get();
  const provider =
    connection === undefined ? undefined : providerFor(connection.provider);
  const row = await readRow(env.DB, connectionId);
  if (row === undefined) {
    return connection?.status === "needs_reauth";
  }
  if (
    provider?.kind !== "oauth" ||
    row.grantedScopes === null ||
    scopesLacking(provider, row.grantedScopes).length === 0
  ) {
    return false;
  }
  return await markDead(env, provider.id, row, "scopes_missing");
};

interface RefreshContext {
  env: Env;
  vault: Vault;
  provider: OAuthProviderConfig;
  client: OAuthClientCredentials;
  tenant: string;
}

/**
 * The address the provider confirms for the connection's account at this
 * renewal, and the one it held before, for a provider that confirms
 * addresses (providers.ts `confirmAddress`); `undefined` for any other.
 */
const addressAt = async (
  { env, provider, client, tenant }: RefreshContext,
  connectionId: string,
  minted: TokenSet
): Promise<{ before: string | null; now: string | null } | undefined> => {
  if (provider.confirmAddress === undefined) {
    return undefined;
  }
  const held = await drizzle(env.DB)
    .select({
      accountId: connections.accountId,
      verifiedEmail: connections.verifiedEmail,
    })
    .from(connections)
    .where(eq(connections.id, connectionId))
    .get();
  if (held === undefined) {
    return undefined;
  }
  return {
    before: held.verifiedEmail,
    now:
      held.accountId === null
        ? null
        : await provider.confirmAddress(
            minted,
            tenant,
            client.id,
            held.accountId
          ),
  };
};

/**
 * Stores what a refresh got, only if `row` is still the current
 * generation of a connection not disconnected. If a disconnect came first
 * (the row is gone, or the connection disconnected), the minted tokens
 * are revoked (threat model CN14), and the call goes no
 * further; if another refresh did (its lease had lapsed), they are dropped
 * and the stored ones stand.
 *
 * With the address the provider confirmed now (`address`), in the same
 * transaction: the connection's confirmed address and when it was
 * confirmed, and, when it changed, one `connection.account_changed` event.
 * An address the renewal didn't confirm counts as none, so an address
 * given to someone else since never stays the old account's.
 */
const storeRefreshed = async (
  { env, vault, provider, client }: RefreshContext,
  row: TokenRow,
  current: StoredOAuthTokens,
  minted: TokenSet,
  address?: { before: string | null; now: string | null }
): Promise<string | undefined> => {
  const next: StoredOAuthTokens = {
    accessToken: minted.accessToken,
    refreshToken: minted.refreshToken ?? current.refreshToken,
    hosts: current.hosts,
  };
  const db = drizzle(env.DB);
  const tokensUpdate = db
    .update(connectionTokens)
    .set({
      sealed: await sealTokens(vault, row.connectionId, next),
      accessExpiresAt: new Date(minted.expiresAt),
      generation: row.generation + 1,
      refreshUntil: null,
      grantedScopes: minted.scope ?? row.grantedScopes,
      updatedAt: new Date(),
    })
    .where(and(unchanged(row), notDisconnected(row)));
  let stored = false;
  if (address === undefined) {
    const done = await tokensUpdate.returning({
      connectionId: connectionTokens.connectionId,
    });
    stored = done.length > 0;
  } else {
    // The address first, while the tokens' row is still the one read: as
    // confirmed now, and when, so it counts only while recent.
    const addressUpdate = db
      .update(connections)
      .set({
        pastVerifiedEmails: pastAddressesAfter(address.now),
        verifiedEmail: address.now,
        verifiedEmailAt: address.now === null ? null : new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(connections.id, row.connectionId),
          exists(
            db
              .select()
              .from(connectionTokens)
              .where(and(unchanged(row), notDisconnected(row)))
          ),
          // Nothing of a person whose erasure began, though the renewal
          // started before it: their address stays as their erasure read it.
          not(ownerErased(row.connectionId))
        )
      );
    if (address.now === address.before) {
      const [, done] = await db.batch([
        addressUpdate,
        tokensUpdate.returning({ connectionId: connectionTokens.connectionId }),
      ]);
      stored = done.length > 0;
    } else {
      stored = await recordEventIf(
        env,
        {
          actor: { type: "system" },
          action: "connection.account_changed",
          target: { type: "connection", id: row.connectionId },
          detail: { provider: provider.id, confirmed: address.now !== null },
        },
        {
          from: connectionTokens,
          where: sql`${unchanged(row)} AND ${notDisconnected(row)}`,
        },
        [addressUpdate, tokensUpdate]
      );
    }
  }
  if (stored) {
    return next.accessToken;
  }
  if (
    (await readRow(env.DB, row.connectionId)) === undefined ||
    (await disconnected(env.DB, row.connectionId))
  ) {
    await discardMint(provider, client, minted);
  }
  return undefined;
};

/**
 * Refreshes under the lease just taken on `row`. `undefined` when it lost
 * to a change meanwhile: the caller looks at what is stored now. The lease
 * is let go whatever goes wrong.
 */
const refreshUnderLease = async (
  context: RefreshContext,
  row: TokenRow
): Promise<string | undefined> => {
  const { env, vault, provider, client, tenant } = context;
  try {
    const current = await openOAuthTokens(vault, row);
    let minted: TokenSet;
    try {
      minted = await refreshTokens(
        provider,
        client,
        tenant,
        current.refreshToken
      );
    } catch (error) {
      if (!isInvalidGrant(error)) {
        log.warn("oauth.refresh_failed", {
          provider: provider.id,
          ...errorFields(error),
        });
        throw connectionErrors.create("connection.refresh_failed");
      }
      if (!(await markDead(env, provider.id, row, "invalid_grant"))) {
        return undefined;
      }
      throw connectErrors.create("connect.connection_inactive");
    }
    // A connection that must hold exactly what it asked for (the
    // directory's, the documents') is kept only while each renewal says so:
    // granted more than it may hold, or less than it held, since, it needs
    // an admin to connect it again. One made before a scope was asked for
    // renews with what it was granted (`renewedAsGranted`).
    if (!renewedAsGranted(provider, minted, row.grantedScopes)) {
      // What it minted is never kept: revoked where the provider can
      // (Entra can't, and its refresh token lapses unused).
      await discardMint(provider, context.client, minted);
      if (!(await markDead(env, provider.id, row, "scopes_changed"))) {
        return undefined;
      }
      throw connectErrors.create("connect.connection_inactive");
    }
    // A connection made before its provider asked for a scope it now
    // needs (writing workbooks) can't do what it is now asked to: it is
    // marked for its person to reconnect it, in place, with its
    // permissions, and consent to the new scope.
    if (!renewalHolds(provider, minted)) {
      await discardMint(provider, context.client, minted);
      if (!(await markDead(env, provider.id, row, "scopes_missing"))) {
        return undefined;
      }
      throw connectErrors.create("connect.connection_inactive");
    }
    return await storeRefreshed(
      context,
      row,
      current,
      minted,
      await addressAt(context, row.connectionId, minted)
    );
  } catch (error) {
    await releaseLease(env.DB, row);
    throw error;
  }
};

/** The whole seconds left until `until`, at least one. */
const secondsUntil = (until: Date, now: number): number =>
  Math.max(Math.ceil((until.getTime() - now) / 1000), 1);

/**
 * Pauses connection `connectionId` for `seconds` from now, for every
 * caller: each call that reads its credential before then is refused as
 * `connect.rate_limited`, and never reaches its vendor. A longer pause
 * already in force is kept, so of two vendor answers that race, the later
 * end holds whichever is written last. A wait longer than an hour is cut
 * to one, whoever names it. The seconds the pause in force has left; none,
 * and nothing stored, for a wait of none. One that can't be stored is
 * logged, and leaves the wait asked: the answer at hand still names the
 * vendor's wait, and its next 429 pauses the connection again.
 */
export const pauseFor = async (
  db: D1Database,
  connectionId: string,
  asked: number
): Promise<number> => {
  if (asked <= 0) {
    return 0;
  }
  const seconds = Math.min(Math.ceil(asked), maxRetryAfterSeconds);
  const now = Date.now();
  try {
    const [row] = await drizzle(db)
      .update(connectionTokens)
      .set({
        pausedUntil: sql`max(coalesce(${connectionTokens.pausedUntil}, 0), ${now + seconds * 1000})`,
      })
      .where(eq(connectionTokens.connectionId, connectionId))
      .returning({ pausedUntil: connectionTokens.pausedUntil });
    return row?.pausedUntil ? secondsUntil(row.pausedUntil, now) : seconds;
  } catch (error) {
    log.error("connection.pause_failed", {
      connection: connectionId,
      ...errorFields(error),
    });
    return seconds;
  }
};

/**
 * The wait a paused connection's `connect.rate_limited` names, as connect's
 * own readers (directory, places, HR, sync) pass on their provider's
 * throttling (`retryAfterMs`); undefined for any other error.
 */
export const pausedWait = (
  error: unknown
): { retryAfterMs: number } | undefined => {
  if (
    !isExpectedError(error) ||
    connectErrors.codeOf(error) !== "connect.rate_limited"
  ) {
    return undefined;
  }
  const seconds = error.details?.retryAfterSeconds;
  return { retryAfterMs: typeof seconds === "number" ? seconds * 1000 : 0 };
};

/**
 * Refuses a connection paused until `pausedUntil` (`pauseFor`) as
 * `connect.rate_limited`, with the seconds the pause has left.
 */
const refuseIfPaused = (pausedUntil: Date | null | undefined): void => {
  const now = Date.now();
  if (pausedUntil && pausedUntil.getTime() > now) {
    throw connectErrors.create("connect.rate_limited", {
      retryAfterSeconds: secondsUntil(pausedUntil, now),
    });
  }
};

/**
 * Refuses a paused connection before anything is spent on a call to it:
 * a held action's confirmation, which a refusal leaves waiting. The
 * credential read checks again, for a pause that begins in between.
 */
export const requireUnpaused = async (
  db: D1Database,
  connectionId: string
): Promise<void> => {
  const row = await readRow(db, connectionId);
  refuseIfPaused(row?.pausedUntil);
};

/** An active connection, its provider, its tokens' row and the vault. */
const activeConnection = async (env: Env, connectionId: string) => {
  const connection = await drizzle(env.DB)
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .get();
  const provider =
    connection === undefined
      ? undefined
      : await providerConfigFor(env, connection.provider);
  const row = await readRow(env.DB, connectionId);
  if (
    connection?.status !== "active" ||
    provider === undefined ||
    row === undefined
  ) {
    throw connectErrors.create("connect.connection_inactive");
  }
  refuseIfPaused(row.pausedUntil);
  const vault = await vaultFor(env);
  if (vault === undefined) {
    throw connectionErrors.create("connection.provider_unavailable");
  }
  return { connection, provider, row, vault };
};

type Active = Awaited<ReturnType<typeof activeConnection>>;

/**
 * What a connection's stored row gives once it needs no renewal (`done`),
 * renewing it first where it does (`renew`). One renewal at a time per
 * connection, in this isolate or any other: the first call takes a lease
 * in D1 and renews; the others wait for its result. A lease whose holder
 * died lapses, and the next call takes it. A connection paused meanwhile
 * (a vendor's 429, or a login that couldn't be made) refuses its waiters
 * too, so they don't each try again.
 */
const leased = async <Value>(
  db: D1Database,
  connectionId: string,
  {
    done,
    read,
    renew,
  }: {
    done: (row: TokenRow, now: number) => boolean;
    read: (row: TokenRow) => Promise<Value>;
    /** `undefined` when it lost to a change: what is stored now decides. */
    renew: (row: TokenRow) => Promise<Value | undefined>;
  }
): Promise<Value> => {
  const deadline = Date.now() + refreshLeaseMs + refreshPollMs;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- waits for the lease holder
    const row = await readRow(db, connectionId);
    // Gone, or its connection stopped meanwhile.
    const stopped =
      row === undefined ||
      // oxlint-disable-next-line no-await-in-loop -- one of the loop's exits
      (await disconnected(db, connectionId));
    if (stopped) {
      throw connectErrors.create("connect.connection_inactive");
    }
    refuseIfPaused(row.pausedUntil);
    const now = Date.now();
    if (done(row, now)) {
      // oxlint-disable-next-line no-await-in-loop -- one of the loop's exits
      return await read(row);
    }
    // oxlint-disable-next-line no-await-in-loop -- one of the loop's exits
    if (await takeLease(db, row, now)) {
      // oxlint-disable-next-line no-await-in-loop -- one of the loop's exits
      const value = await renew(row);
      if (value !== undefined) {
        return value;
      }
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- waits for the lease holder
    await scheduler.wait(refreshPollMs);
  }
  throw connectionErrors.create("connection.refresh_failed");
};

/** A fresh access token, refreshing it first when it is about to expire. */
const refreshed = async (
  context: RefreshContext,
  connectionId: string
): Promise<string> =>
  await leased(context.env.DB, connectionId, {
    done: isFresh,
    read: async (row) => await accessTokenOf(context.vault, row),
    renew: async (row) => await refreshUnderLease(context, row),
  });

/** How long a login that couldn't be made pauses its connection, unless it said. */
const loginBackoffSeconds = 60;

/** A session login's connection's current session, and which it is. */
interface Session {
  session: string;
  generation: number;
}

interface LoginContext {
  env: Env;
  vault: Vault;
  provider: LoginProviderConfig;
}

/** The login a row holds; any other row's has none. */
const openLogin = async (
  vault: Vault,
  row: Pick<TokenRow, "connectionId" | "sealed">
): Promise<StoredLogin> => {
  const tokens = await openTokens(vault, row);
  if (!("login" in tokens)) {
    throw connectErrors.create("connect.connection_inactive");
  }
  return tokens;
};

const sessionOf = async (vault: Vault, row: TokenRow): Promise<Session> => {
  const { session } = await openLogin(vault, row);
  return { session, generation: row.generation };
};

/**
 * Logs in again under the lease just taken on `row`, with the fields it
 * holds, because its session ran out or was refused (`reason`), and keeps
 * the new session with one `connection.session_renewed` event, only if
 * `row` is still the current generation of a connection not
 * disconnected: a session minted for one disconnected meanwhile is never
 * kept. A login the vendor refuses (threat model LG5) marks the
 * connection for a person to give its fields again, and its fields go, so
 * nothing logs in with them again; one it couldn't answer pauses the
 * connection for as long as it asked, or `loginBackoffSeconds`, so no call
 * logs in until then. `undefined` when it lost to a change meanwhile. The
 * lease is let go whatever goes wrong.
 */
const logInUnderLease = async (
  { env, vault, provider }: LoginContext,
  row: TokenRow,
  reason: "expired" | "refused"
): Promise<Session | undefined> => {
  try {
    // A session refused this soon after its login wasn't refused for
    // being old: a new one would be too, and every call would log in.
    // The call gets the vendor's refusal; one after the floor logs in.
    const age = Date.now() - row.updatedAt.getTime();
    if (reason === "refused" && age < minSessionMs) {
      throw connectErrors.create("connect.rate_limited", {
        retryAfterSeconds: Math.ceil((minSessionMs - age) / 1000),
      });
    }
    const { login, companyNetwork, hosts = {} } = await openLogin(vault, row);
    const answer = await provider.logIn(
      login,
      outbound(env, companyNetwork),
      hosts
    );
    if ("refused" in answer) {
      if (answer.refused) {
        if (!(await markDead(env, provider.id, row, "login_refused"))) {
          return undefined;
        }
        throw connectErrors.create("connect.connection_inactive");
      }
      const seconds = await pauseFor(
        env.DB,
        row.connectionId,
        answer.retryAfterSeconds ?? loginBackoffSeconds
      );
      throw connectErrors.create("connect.rate_limited", {
        retryAfterSeconds: seconds,
      });
    }
    const current = sql`${unchanged(row)} AND ${notDisconnected(row)}`;
    const kept = await recordEventIf(
      env,
      {
        actor: { type: "system" },
        action: "connection.session_renewed",
        target: { type: "connection", id: row.connectionId },
        detail: { provider: provider.id, reason },
      },
      { from: connectionTokens, where: current },
      [
        drizzle(env.DB)
          .update(connectionTokens)
          .set({
            sealed: await sealTokens(vault, row.connectionId, {
              login,
              session: answer.session,
              companyNetwork,
              hosts: Object.keys(hosts).length === 0 ? undefined : hosts,
            }),
            accessExpiresAt: new Date(answer.expiresAt),
            generation: row.generation + 1,
            refreshUntil: null,
            updatedAt: new Date(),
          })
          .where(current),
      ]
    );
    return kept
      ? { session: answer.session, generation: row.generation + 1 }
      : undefined;
  } catch (error) {
    await releaseLease(env.DB, row);
    throw error;
  }
};

/** A session login's connection's session, logging in again once it ran out. */
const freshSession = async (
  context: LoginContext,
  connectionId: string
): Promise<Session> =>
  await leased(context.env.DB, connectionId, {
    done: isFresh,
    read: async (row) => await sessionOf(context.vault, row),
    renew: async (row) => await logInUnderLease(context, row, "expired"),
  });

/**
 * What a call of session login's connection `connectionId` sends its
 * requests with once the vendor refused its session of `generation` (a
 * 401, egress.ts): a session logged in for anew, once for that generation,
 * however many calls were refused it; or the one another call already
 * logged in for. A session refused again by a call that got the new one
 * is answered with the same, never logged in for again by that call
 * (threat model LG5, LG9). `undefined` when there is none: the
 * connection needs its fields again, is paused or stopped.
 */
export const sessionAfterRefusal = async (
  env: Env,
  connectionId: string,
  generation: number
): Promise<(Credential & { secret: string }) | undefined> => {
  try {
    const active = await activeConnection(env, connectionId);
    const { provider, vault } = active;
    if (provider.kind !== "login") {
      return undefined;
    }
    const context = { env, vault, provider };
    const { session } = await leased(env.DB, connectionId, {
      done: (row) => row.generation !== generation,
      read: async (row) => await sessionOf(vault, row),
      renew: async (row) => await logInUnderLease(context, row, "refused"),
    });
    return { ...provider.credential(session), secret: session };
  } catch (error) {
    log.warn("login.renewal_failed", {
      connection: connectionId,
      ...errorFields(error),
    });
    return undefined;
  }
};

/**
 * The session a call of session login's connection `connectionId` that
 * was given its session of `generation` sends a write with: the one
 * another request logged in for since, if one did, since a write refused
 * with the old one isn't sent again (egress.ts); else `undefined`, and
 * the call's own goes.
 */
export const sessionSince = async (
  env: Env,
  connectionId: string,
  generation: number
): Promise<(Credential & { secret: string }) | undefined> => {
  try {
    const { provider, row, vault } = await activeConnection(env, connectionId);
    if (provider.kind !== "login" || row.generation === generation) {
      return undefined;
    }
    const { session } = await openLogin(vault, row);
    return { ...provider.credential(session), secret: session };
  } catch {
    return undefined;
  }
};

/** An active OAuth connection's access token, refreshed if it must be. */
const freshAccessToken = async (
  env: Env,
  { connection, provider, row, vault }: Active
): Promise<string> => {
  // A suite's connection is pinned to its tenant; an app's has none.
  const tenant =
    provider.kind === "oauth" && provider.pinned ? connection.tenant : "";
  if (provider.kind !== "oauth" || tenant === null) {
    throw connectErrors.create("connect.connection_inactive");
  }
  const client = provider.client(env);
  if (client === undefined) {
    throw connectionErrors.create("connection.provider_unavailable");
  }
  if (isFresh(row, Date.now())) {
    return await accessTokenOf(vault, row);
  }
  return await refreshed(
    { env, vault, provider, client, tenant },
    connection.id
  );
};

/**
 * The access token of an active OAuth connection, fresh for at least a
 * minute. Only for connect itself: a connector's egress handler gets it for
 * one call. Throws `connect.connection_inactive` when the connection has
 * no usable grant, or isn't an OAuth one.
 */
export const accessTokenFor = async (
  env: Env,
  connectionId: string
): Promise<string> =>
  await freshAccessToken(env, await activeConnection(env, connectionId));

/**
 * What one call of an active connection's connector sends its requests
 * with: a fresh access token, or the API key, in the header the provider
 * takes it in, with the token or key itself (`secret`); the host the
 * connection signed in with for each of its connector's host templates,
 * which its egress fills them with; and, for a connection reached through
 * the company network, the address sealed with its key, which its
 * requests go to. Only for connect's own requests and its egress handler,
 * for that call.
 */
export const connectorCredentialFor = async (
  env: Env,
  connectionId: string
): Promise<{
  credential: Credential & { secret: string };
  connectionHosts: Record<string, string>;
  companyNetwork: string | undefined;
  /** A session login's: which session the credential is (`sessionAfterRefusal`). */
  session?: number;
}> => {
  const active = await activeConnection(env, connectionId);
  const { provider, row, vault } = active;
  const tokens = await openTokens(vault, row);
  const connectionHosts = tokens.hosts ?? {};
  if (provider.kind === "login") {
    if (!("login" in tokens)) {
      throw connectErrors.create("connect.connection_inactive");
    }
    const { session, generation } = isFresh(row, Date.now())
      ? { session: tokens.session, generation: row.generation }
      : await freshSession({ env, vault, provider }, connectionId);
    return {
      credential: { ...provider.credential(session), secret: session },
      connectionHosts,
      companyNetwork: tokens.companyNetwork,
      session: generation,
    };
  }
  if (provider.kind === "oauth") {
    const accessToken = await freshAccessToken(env, active);
    return {
      credential: { ...bearer(accessToken), secret: accessToken },
      connectionHosts,
      companyNetwork: undefined,
    };
  }
  if (!("apiKey" in tokens)) {
    throw connectErrors.create("connect.connection_inactive");
  }
  return {
    credential: {
      ...provider.credential(tokens.apiKey),
      secret: tokens.apiKey,
    },
    connectionHosts,
    companyNetwork: tokens.companyNetwork,
  };
};

/**
 * `connectorCredentialFor`'s credential alone, for a request to the
 * public internet: refused for a connection reached through the company
 * network, whose requests go nowhere else.
 */
export const credentialFor = async (
  env: Env,
  connectionId: string
): Promise<Credential> => {
  const { credential, companyNetwork } = await connectorCredentialFor(
    env,
    connectionId
  );
  if (companyNetwork !== undefined) {
    throw connectErrors.create("connect.connection_inactive");
  }
  return credential;
};

/**
 * The refresh token an owed revoke holds (`token_revocations.sealed`,
 * sealed for connection `connectionId`), to revoke with: `none` when it
 * holds none; `unavailable` while the key it was sealed under isn't held
 * (tried again); `unreadable` only when a held key fails to open it.
 */
export const owedRefreshToken = async (
  env: Env,
  connectionId: string,
  sealed: string
): Promise<
  { refreshToken: string } | "none" | "unavailable" | "unreadable"
> => {
  const vault = await vaultFor(env);
  if (vault === undefined) {
    log.error("vault.unavailable", { connection: connectionId });
    return "unavailable";
  }
  try {
    const tokens = await openTokens(vault, { connectionId, sealed });
    return "refreshToken" in tokens
      ? { refreshToken: tokens.refreshToken }
      : "none";
  } catch (error) {
    log.error("vault.open_failed", errorFields(error));
    return error instanceof VaultError && error.reason === "unknown_key"
      ? "unavailable"
      : "unreadable";
  }
};

/**
 * Seals again with the current key what owed revokes hold under the
 * previous one, as `resealTokens` does for connections' tokens: whatever
 * won't open is answered for `abandon` to end, so the previous key can go.
 */
export const resealOwedTokens = async (
  env: Env,
  abandon: (owed: { id: string; connectionId: string }) => Promise<void>
): Promise<void> => {
  const vault = await vaultFor(env);
  if (vault?.sealedWithPrevious === undefined) {
    return;
  }
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      id: tokenRevocations.id,
      connectionId: tokenRevocations.connectionId,
      sealed: tokenRevocations.sealed,
    })
    .from(tokenRevocations)
    .where(like(tokenRevocations.sealed, vault.sealedWithPrevious))
    .limit(resealBatchSize);
  for (const owed of rows) {
    let tokens: StoredTokens;
    try {
      // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
      tokens = await openTokens(vault, owed);
    } catch (error) {
      log.error("vault.open_failed", errorFields(error));
      // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
      await abandon(owed);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
    const sealed = await sealTokens(vault, owed.connectionId, tokens);
    // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
    await db
      .update(tokenRevocations)
      .set({ sealed })
      .where(
        and(
          eq(tokenRevocations.id, owed.id),
          eq(tokenRevocations.sealed, owed.sealed)
        )
      );
  }
};

/**
 * The connection's refresh token, for revoking it: `none` when it has
 * none; `unavailable` while the key it was sealed under isn't held (the
 * vault unset, or its key not among the current and previous ones), which
 * setting the key again mends, so the revoke is tried again; `unreadable`
 * only when a key that is held fails to open it (changed at rest), which
 * nothing mends.
 */
export const revocableToken = async (
  env: Env,
  connectionId: string
): Promise<
  { refreshToken: string } | "none" | "unavailable" | "unreadable"
> => {
  const row = await readRow(env.DB, connectionId);
  if (row === undefined) {
    return "none";
  }
  const vault = await vaultFor(env);
  if (vault === undefined) {
    log.error("vault.unavailable", { connection: connectionId });
    return "unavailable";
  }
  try {
    const tokens = await openTokens(vault, row);
    return "refreshToken" in tokens
      ? { refreshToken: tokens.refreshToken }
      : "none";
  } catch (error) {
    log.error("vault.open_failed", errorFields(error));
    return error instanceof VaultError && error.reason === "unknown_key"
      ? "unavailable"
      : "unreadable";
  }
};

/**
 * Seals tokens still under the previous key again with the current one, a
 * batch per clock run, so the previous key can be removed once none is left
 * under it. A row changed meanwhile keeps its newer value. One that
 * doesn't open (changed at rest) can never be used: its connection is
 * marked for reconnecting, so it doesn't hold up the rest.
 */
export const resealTokens = async (env: Env): Promise<void> => {
  const vault = await vaultFor(env);
  if (vault?.sealedWithPrevious === undefined) {
    return;
  }
  const db = drizzle(env.DB);
  const rows = await db
    .select({ row: connectionTokens, provider: connections.provider })
    .from(connectionTokens)
    .innerJoin(connections, eq(connections.id, connectionTokens.connectionId))
    .where(like(connectionTokens.sealed, vault.sealedWithPrevious))
    .limit(resealBatchSize);
  for (const { row, provider } of rows) {
    let tokens: StoredTokens;
    try {
      // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
      tokens = await openTokens(vault, row);
    } catch (error) {
      log.error("vault.open_failed", errorFields(error));
      // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
      await markDead(env, provider, row, "unreadable");
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
    const sealed = await sealTokens(vault, row.connectionId, tokens);
    // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
    await db
      .update(connectionTokens)
      .set({ sealed })
      .where(and(unchanged(row), eq(connectionTokens.sealed, row.sealed)));
  }
};
