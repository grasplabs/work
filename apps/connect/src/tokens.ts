import { connectErrors, connectionErrors } from "@grasp-os/shared/connect";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, eq, exists, isNull, like, lte, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { recordEventIf } from "./audit.ts";
import { connections, connectionTokens } from "./db/schema.ts";
import { isInvalidGrant, refreshTokens, revokeToken } from "./oauth-client.ts";
import type { TokenSet } from "./oauth-client.ts";
import { bearer, grantedAsAsked, providerFor } from "./providers.ts";
import type {
  Credential,
  OAuthClientCredentials,
  OAuthProviderConfig,
} from "./providers.ts";
import { resealBatchSize, vaultFor } from "./vault.ts";
import type { Vault } from "./vault.ts";

// The token vault: each connection's tokens, or its API key, sealed
// (src/vault.ts), in connect's D1. Nothing here is reachable over RPC:
// tokens and keys never leave connect, except as the credential of one
// call, which a connector's egress handler adds to the call's requests
// (threat model R1). A refresh token never leaves at all: only its token
// endpoint sees it.

/** What a connection's sealed value holds: OAuth tokens, or an API key. */
const storedTokensSchema = z.union([
  z.strictObject({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
  }),
  z.strictObject({ apiKey: z.string().min(1) }),
]);
type StoredTokens = z.infer<typeof storedTokensSchema>;
type StoredOAuthTokens = Extract<StoredTokens, { refreshToken: string }>;

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

/**
 * The row that stores the tokens of a new grant: a new connection's, or a
 * reconnected one's. Its generation starts at the time, which no earlier
 * row of the connection reached, so a refresh still under way for the
 * tokens it had before it was reconnected can't pass for one of these.
 */
export const firstTokens = async (
  vault: Vault,
  connectionId: string,
  tokens: StoredTokens & { expiresAt: number },
  now: Date
): Promise<TokenRow> => ({
  connectionId,
  sealed: await sealTokens(
    vault,
    connectionId,
    "apiKey" in tokens
      ? { apiKey: tokens.apiKey }
      : { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }
  ),
  accessExpiresAt: new Date(tokens.expiresAt),
  generation: now.getTime(),
  refreshUntil: null,
  updatedAt: now,
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
    await revokeToken(
      provider,
      client,
      tokens.refreshToken ?? tokens.accessToken
    );
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

const isFresh = (row: TokenRow, now: number): boolean =>
  row.accessExpiresAt.getTime() - expirySkewMs > now;

/** The row as read: this connection's tokens, still at this generation. */
const unchanged = (row: TokenRow): SQL =>
  sql`${connectionTokens.connectionId} = ${row.connectionId} AND ${connectionTokens.generation} = ${row.generation}`;

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
  reason: "invalid_grant" | "unreadable" | "scopes_changed"
): Promise<boolean> => {
  const db = drizzle(env.DB);
  return await recordEventIf(
    env,
    {
      actor: { type: "system" },
      action: "connection.needs_reauth",
      target: { type: "connection", id: row.connectionId },
      detail: { provider, reason },
    },
    { from: connectionTokens, where: unchanged(row) },
    [
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
      db.delete(connectionTokens).where(unchanged(row)),
    ]
  );
};

interface RefreshContext {
  env: Env;
  vault: Vault;
  provider: OAuthProviderConfig;
  client: OAuthClientCredentials;
  tenant: string;
}

/**
 * Stores what a refresh got, only if `row` is still the current
 * generation. If a disconnect came first (the row is gone), the minted
 * tokens are revoked (threat model CN14); if another refresh did (its
 * lease had lapsed), they are dropped and the stored ones stand.
 */
const storeRefreshed = async (
  { env, vault, provider, client }: RefreshContext,
  row: TokenRow,
  current: StoredOAuthTokens,
  minted: TokenSet
): Promise<string | undefined> => {
  const next: StoredOAuthTokens = {
    accessToken: minted.accessToken,
    refreshToken: minted.refreshToken ?? current.refreshToken,
  };
  const stored = await drizzle(env.DB)
    .update(connectionTokens)
    .set({
      sealed: await sealTokens(vault, row.connectionId, next),
      accessExpiresAt: new Date(minted.expiresAt),
      generation: row.generation + 1,
      refreshUntil: null,
      updatedAt: new Date(),
    })
    .where(unchanged(row))
    .returning({ connectionId: connectionTokens.connectionId });
  if (stored.length > 0) {
    return next.accessToken;
  }
  if ((await readRow(env.DB, row.connectionId)) === undefined) {
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
    // landscape's) is kept only while each renewal says so: granted more
    // or less since, it needs an admin to connect it again.
    if (!grantedAsAsked(provider, minted)) {
      if (!(await markDead(env, provider.id, row, "scopes_changed"))) {
        return undefined;
      }
      throw connectErrors.create("connect.connection_inactive");
    }
    return await storeRefreshed(context, row, current, minted);
  } catch (error) {
    await releaseLease(env.DB, row);
    throw error;
  }
};

/**
 * A fresh access token, refreshing it first when it is about to expire.
 * One refresh at a time per connection, in this isolate or any other: the
 * first call takes a lease in D1 and refreshes; the others wait for its
 * result. A lease whose holder died lapses, and the next call takes it.
 */
const refreshed = async (
  context: RefreshContext,
  connectionId: string
): Promise<string> => {
  const deadline = Date.now() + refreshLeaseMs + refreshPollMs;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- waits for the lease holder
    const row = await readRow(context.env.DB, connectionId);
    if (row === undefined) {
      throw connectErrors.create("connect.connection_inactive");
    }
    const now = Date.now();
    if (isFresh(row, now)) {
      // oxlint-disable-next-line no-await-in-loop -- one of the loop's exits
      return await accessTokenOf(context.vault, row);
    }
    // oxlint-disable-next-line no-await-in-loop -- one of the loop's exits
    if (await takeLease(context.env.DB, row, now)) {
      // oxlint-disable-next-line no-await-in-loop -- one of the loop's exits
      const token = await refreshUnderLease(context, row);
      if (token !== undefined) {
        return token;
      }
      // Lost to a change: what is stored now decides.
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- waits for the lease holder
    await scheduler.wait(refreshPollMs);
  }
  throw connectionErrors.create("connection.refresh_failed");
};

/** An active connection, its provider, its tokens' row and the vault. */
const activeConnection = async (env: Env, connectionId: string) => {
  const connection = await drizzle(env.DB)
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .get();
  const provider =
    connection === undefined ? undefined : providerFor(connection.provider);
  const row = await readRow(env.DB, connectionId);
  if (
    connection?.status !== "active" ||
    provider === undefined ||
    row === undefined
  ) {
    throw connectErrors.create("connect.connection_inactive");
  }
  const vault = await vaultFor(env);
  if (vault === undefined) {
    throw connectionErrors.create("connection.provider_unavailable");
  }
  return { connection, provider, row, vault };
};

type Active = Awaited<ReturnType<typeof activeConnection>>;

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
 * takes it in. Only for connect's egress handler, for that call.
 */
export const credentialFor = async (
  env: Env,
  connectionId: string
): Promise<Credential> => {
  const active = await activeConnection(env, connectionId);
  const { provider, row, vault } = active;
  if (provider.kind === "oauth") {
    return bearer(await freshAccessToken(env, active));
  }
  const tokens = await openTokens(vault, row);
  if (!("apiKey" in tokens)) {
    throw connectErrors.create("connect.connection_inactive");
  }
  return provider.credential(tokens.apiKey);
};

/**
 * The connection's refresh token, for revoking it; `undefined` when it has
 * none or it doesn't open.
 */
export const revocableToken = async (
  env: Env,
  connectionId: string
): Promise<string | undefined> => {
  const row = await readRow(env.DB, connectionId);
  const vault = await vaultFor(env);
  if (row === undefined || vault === undefined) {
    return undefined;
  }
  try {
    const tokens = await openTokens(vault, row);
    return "refreshToken" in tokens ? tokens.refreshToken : undefined;
  } catch (error) {
    log.error("vault.open_failed", errorFields(error));
    return undefined;
  }
};

/**
 * Seals tokens still under the previous key again with the current one, a
 * batch per cron run, so the previous key can be removed once none is left
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
