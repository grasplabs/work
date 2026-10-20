import type { AuditDetailValue } from "@grasp-os/shared/audit";
import {
  connectErrors,
  connectionCallbackPath,
  connectionErrors,
  connectionPersonSchema,
  connectWithKeySchema,
  disconnectPersonalSchema,
  disconnectSchema,
  finishConnectionSchema,
  oauthFlowLifetimeMs,
  oauthProviderSchema,
  startConnectionSchema,
} from "@grasp-os/shared/connect";
import type {
  ConnectionPerson,
  ConnectionScope,
  ConnectionSummary,
} from "@grasp-os/shared/connect";
import { randomToken, sha256Hex, toBase64Url } from "@grasp-os/shared/encoding";
import { errorFields, log } from "@grasp-os/shared/log";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import { and, desc, eq, like, lte, ne, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";

import { accountAddressesOf } from "./account-addresses.ts";
import type { AccountAddresses } from "./account-addresses.ts";
import { recordEventIf, recordEvents } from "./audit.ts";
import {
  abandonToolkitFlow,
  disconnectCleanup,
  dropToolkitFlowsOf,
  revokeAtComposio,
  takeToolkitFlow,
} from "./composio-connections.ts";
import {
  auditRefusal,
  connectionEvent,
  refuseStaff,
} from "./connection-audit.ts";
import { allowedToolNames } from "./connections.ts";
import {
  connections,
  connectionTokens,
  oauthFlows,
  pendingActions,
} from "./db/schema.ts";
import { exchangeCode, revokeToken } from "./oauth-client.ts";
import type { TokenSet } from "./oauth-client.ts";
import { dropPendingActions } from "./pending.ts";
import { grantedAsAsked, providerFor } from "./providers.ts";
import type {
  ApiKeyProviderConfig,
  OAuthClientCredentials,
  OAuthProviderConfig,
  ProviderAccount,
  ProviderConfig,
} from "./providers.ts";
import {
  apiKeyExpiresAt,
  discardMint,
  firstTokens,
  revocableToken,
} from "./tokens.ts";
import { resealBatchSize, vaultFor } from "./vault.ts";
import type { Vault } from "./vault.ts";

// Connecting an account: the OAuth 2.0 authorization code flow with PKCE,
// for every provider in src/providers.ts, the suites and the apps alike;
// or, for an app that takes one, an API key the person gives
// (`connectWithKey`), checked with the app and then kept as tokens are.
//
// A person starts it from their browser, signed in to core, and the
// provider sends the browser back to core's callback on the same origin,
// where their session cookie comes along (`SameSite=Lax` goes with a
// top-level navigation). Core says who the person is on both requests, and
// a flow only finishes for the person who started it. So a flow can't be
// finished in anyone else's name: an attacker who gets a victim to finish
// the attacker's flow (or to open a callback URL carrying the attacker's
// code) is refused, because the victim's session isn't the flow's person,
// and nothing is exchanged (threat model CN4). The `state` is 256 random
// bits, single-use and valid for ten minutes; only its hash is stored. The
// PKCE verifier never leaves connect, so the code alone, which core sees on
// the callback, is useless (CN3).
//
// Connecting again is the same flow. A connection whose grant ran out
// (`needs_reauth`) keeps its account, and a flow that comes back with that
// account, finished by someone who could have connected it as it is, gives
// it its new tokens: the same connection, so every permission on it stands.
// Nothing names the connection to reconnect: the account the provider
// vouches for does, so signing in to another account never reaches it.

/**
 * Whether `account` is the person's own: the account they sign in with at
 * that provider (its Entra object ID or Google subject), or, where they
 * sign in elsewhere, the one with their verified email. A personal
 * connection is used only in its owner's own context (R5), so it must hold
 * their own account, not a colleague's or a shared mailbox's.
 */
const isOwnAccount = (
  person: ConnectionPerson,
  provider: string,
  account: ProviderAccount
): boolean => {
  const signIns = person.accounts.filter((each) => each.provider === provider);
  if (signIns.length > 0) {
    return signIns.some(({ subject }) => subject === account.id);
  }
  return account.email?.toLowerCase() === person.email.toLowerCase();
};

type ConnectionRow = typeof connections.$inferSelect;
type FlowRow = typeof oauthFlows.$inferSelect;

/** The live connection that already holds `accountId`, if any. */
const connectionHolding = async (
  env: Env,
  provider: string,
  accountId: string
): Promise<ConnectionRow | undefined> =>
  await drizzle(env.DB)
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.provider, provider),
        eq(connections.accountId, accountId),
        ne(connections.status, "disconnected")
      )
    )
    .get();

/**
 * Whether finishing `flow` as `person` reconnects `held`, the connection
 * holding the account the flow came back with: only one whose grant ran
 * out, of the scope the flow asked for, and, if personal, the person's own.
 * A shared one is any admin's to reconnect, as it is to disconnect; the
 * caller checked the role.
 */
const reconnects = (
  held: ConnectionRow,
  flow: Target,
  person: ConnectionPerson
): boolean =>
  held.status === "needs_reauth" &&
  held.scope === flow.scope &&
  (held.scope === "shared" || held.ownerUserId === person.userId);

/** Only admins connect or disconnect what the organization shares. */
const mayManage = (person: ConnectionPerson, scope: ConnectionScope): boolean =>
  scope === "personal" || isAdmin(person.role);

interface Ready {
  provider: OAuthProviderConfig;
  client: OAuthClientCredentials;
  vault: Vault;
}

/** The OAuth provider, with its client and the vault, or refused while unset. */
const ready = async (env: Env, providerId: string): Promise<Ready> => {
  const provider = providerFor(providerId);
  const client = provider?.kind === "oauth" ? provider.client(env) : undefined;
  const vault = await vaultFor(env);
  if (
    provider?.kind !== "oauth" ||
    client === undefined ||
    vault === undefined
  ) {
    throw connectionErrors.create("connection.provider_unavailable");
  }
  return { provider, client, vault };
};

const pkceChallenge = async (verifier: string): Promise<string> =>
  toBase64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    )
  );

const flowContext = (stateHash: string): string => `flow:${stateHash}`;

/** Starts a flow: the provider URL to send the person's browser to. */
export const startConnection = async (
  env: Env,
  request: unknown
): Promise<{ url: string }> => {
  const {
    person,
    provider: providerId,
    scope,
    origin,
    returnTo,
    ...rest
  } = connectionErrors.parse(
    "connection.invalid",
    startConnectionSchema,
    request
  );
  await refuseStaff(env, person, { provider: providerId, scope });
  if (!mayManage(person, scope)) {
    await auditRefusal(env, person, "connection.connect", {
      provider: providerId,
      scope,
      outcome: "refused",
      reason: "role.forbidden",
    });
    throw roleErrors.create("role.forbidden");
  }
  const { provider, client, vault } = await ready(env, providerId);
  // The landscape's connection reads the whole tenant: the organization's,
  // never a person's own.
  if (provider.sharedOnly === true && scope !== "shared") {
    throw connectionErrors.create("connection.invalid");
  }
  // A suite's flow is pinned to the organization's tenant; an app's has
  // none, so it is always "" (`isTenant`).
  const tenant = provider.pinned ? (rest.tenant ?? "").toLowerCase() : "";
  if (!provider.isTenant(tenant) || new URL(origin).origin !== origin) {
    throw connectionErrors.create("connection.provider_unavailable");
  }

  const state = randomToken();
  const verifier = randomToken();
  const stateHash = await sha256Hex(state);
  const redirectUri = new URL(connectionCallbackPath, origin).href;
  await drizzle(env.DB)
    .insert(oauthFlows)
    .values({
      stateHash,
      userId: person.userId,
      provider: provider.id,
      scope,
      tenant,
      redirectUri,
      returnTo,
      verifier: await vault.seal(verifier, flowContext(stateHash)),
      expiresAt: new Date(Date.now() + oauthFlowLifetimeMs),
    });

  const url = new URL(provider.authorizationEndpoint(tenant));
  const params = {
    ...provider.authorizationParams(tenant),
    response_type: "code",
    client_id: client.id,
    redirect_uri: redirectUri,
    scope: provider.scopes.join(provider.scopeSeparator),
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
  };
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return { url: url.href };
};

/**
 * Takes the flow `state` names: deleted before anything is checked, so it
 * is spent whatever happens next, even when it isn't this person's.
 */
const takeFlow = async (env: Env, state: string) => {
  const stateHash = await sha256Hex(state);
  const [flow] = await drizzle(env.DB)
    .delete(oauthFlows)
    .where(eq(oauthFlows.stateHash, stateHash))
    .returning();
  return flow;
};

/**
 * Spends the flow `state` names, if it is one: a flow that came back but
 * can't finish (no session, a malformed request) can't be finished later
 * with the same code.
 */
export const abandonFlow = async (env: Env, state: unknown): Promise<void> => {
  const parsed = finishConnectionSchema.shape.state.safeParse(state);
  if (!parsed.success) {
    return;
  }
  const flow = await takeFlow(env, parsed.data);
  if (flow !== undefined) {
    return;
  }
  const toolkitFlow = await takeToolkitFlow(env, await sha256Hex(parsed.data));
  if (toolkitFlow !== undefined) {
    await abandonToolkitFlow(env, toolkitFlow);
  }
};

/**
 * Drops tokens minted for a connection that won't be made, revoking them
 * unless an active connection holds the same account: at Google, revoking
 * any token of a grant revokes all of it. One that needs connecting again
 * has no grant to lose, so what was minted for its account is revoked.
 */
const dropMint = async (
  env: Env,
  { provider, client }: Ready,
  tokens: TokenSet,
  accountId: string | undefined
): Promise<void> => {
  const held =
    accountId === undefined
      ? undefined
      : await connectionHolding(env, provider.id, accountId);
  if (held?.status !== "active") {
    await discardMint(provider, client, tokens);
  }
};

/** A second live connection to the same account (the unique index). */
const isDuplicate = (error: unknown): boolean =>
  error instanceof Error &&
  error.message.includes("UNIQUE") &&
  error.message.includes("connections");

/** What a connection keeps of its sign-in: tokens or a key, sealed. */
type Kept = Parameters<typeof firstTokens>[2];

/** What a connection is connected for: its scope, and its tenant if pinned. */
type Target = Pick<FlowRow, "scope" | "tenant">;

/** A connection's tenant: none (`null`) for an app's (`""`). */
const tenantOf = ({ tenant }: Target): string | null =>
  tenant === "" ? null : tenant;

interface Keeping {
  provider: ProviderConfig;
  vault: Vault;
}

/** Stores a new connection with its tokens and its event, all or nothing. */
const storeConnection = async (
  env: Env,
  { provider, vault }: Keeping,
  flow: Target,
  person: ConnectionPerson,
  account: ProviderAccount,
  tokens: Kept,
  addresses: AccountAddresses | undefined
): Promise<string> => {
  const connectionId = crypto.randomUUID();
  const now = new Date();
  const db = drizzle(env.DB);
  const writes: BatchItem<"sqlite">[] = [
    db.insert(connections).values({
      id: connectionId,
      provider: provider.id,
      scope: flow.scope,
      ownerUserId: flow.scope === "personal" ? person.userId : null,
      status: "active",
      serverKind: "native",
      server: provider.server,
      tenant: tenantOf(flow),
      accountId: account.id,
      accountName: account.name,
      accountEmail: account.email?.toLowerCase() ?? null,
      accountAddresses: addresses?.receives ?? null,
      accountSenders: addresses?.sends ?? null,
      connectedBy: person.userId,
      createdAt: now,
      updatedAt: now,
    }),
    db
      .insert(connectionTokens)
      .values(await firstTokens(vault, connectionId, tokens, now)),
  ];
  await recordEvents(
    env,
    [
      connectionEvent(person, "connection.connect", connectionId, {
        provider: provider.id,
        scope: flow.scope,
        outcome: "ok",
      }),
    ],
    writes
  );
  return connectionId;
};

/**
 * Gives `held`, whose grant ran out, the tokens of a new one and makes it
 * active again, in one write with its event. Only while it still needs
 * them: of two reconnects at once one does it, and one that a disconnect
 * got ahead of does nothing. Its ID if this call did, and `undefined` if
 * it didn't or there was none to reconnect.
 */
const reconnect = async (
  env: Env,
  { provider, vault }: Keeping,
  flow: Target,
  person: ConnectionPerson,
  held: ConnectionRow | undefined,
  account: ProviderAccount,
  tokens: Kept,
  addresses: AccountAddresses | undefined
): Promise<string | undefined> => {
  if (held === undefined) {
    return undefined;
  }
  const now = new Date();
  const db = drizzle(env.DB);
  const row = await firstTokens(vault, held.id, tokens, now);
  const stillWaiting = sql`${connections.id} = ${held.id} AND ${connections.status} = 'needs_reauth'`;
  const reconnected = await recordEventIf(
    env,
    connectionEvent(person, "connection.reconnected", held.id, {
      provider: provider.id,
      scope: held.scope,
      outcome: "ok",
    }),
    { from: connections, where: stillWaiting },
    [
      // Before the status changes: the same condition guards both.
      db.insert(connectionTokens).select(
        db
          .select({
            connectionId: sql<string>`${row.connectionId}`.as("connection_id"),
            sealed: sql<string>`${row.sealed}`.as("sealed"),
            accessExpiresAt: sql<Date>`${row.accessExpiresAt.getTime()}`.as(
              "access_expires_at"
            ),
            generation: sql<number>`${row.generation}`.as("generation"),
            refreshUntil: sql<null>`NULL`.as("refresh_until"),
            updatedAt: sql<Date>`${now.getTime()}`.as("updated_at"),
          })
          .from(connections)
          .where(stillWaiting)
      ),
      db
        .update(connections)
        .set({
          status: "active",
          tenant: tenantOf(flow),
          accountName: account.name,
          accountEmail: account.email?.toLowerCase() ?? null,
          // A lookup that failed keeps what was read before.
          ...(addresses === undefined
            ? {}
            : {
                accountAddresses: addresses.receives,
                accountSenders: addresses.sends,
              }),
          updatedAt: now,
        })
        .where(stillWaiting),
    ]
  );
  return reconnected ? held.id : undefined;
};

/**
 * Records a flow that didn't finish, naming the connection that holds the
 * account it came back with, if one does.
 */
type Refuse = (
  reason: string,
  about?: { outcome?: "refused" | "failed"; connectionId?: string }
) => Promise<void>;

type RefusalReason =
  | "connection.scopes_refused"
  | "connection.wrong_account"
  | "connection.not_own_account"
  | "connection.already_connected"
  | "connection.provider_refused";

/**
 * Keeps what a sign-in got (tokens, or a key) for `account`, once it is
 * known to be an account the person may connect: their own for a personal
 * connection, and held by no other connection, unless by one the person
 * may reconnect (`reconnects`), which gets it. The connection's ID.
 * Whatever isn't kept is dropped (`drop`).
 */
const keepAccount = async (
  env: Env,
  setUp: Keeping,
  flow: Target,
  person: ConnectionPerson,
  account: ProviderAccount,
  kept: Kept,
  /** Drops what was minted for the sign-in; none for a key. */
  drop: ((accountId: string | undefined) => Promise<void>) | undefined,
  refuse: Refuse
): Promise<string> => {
  const { provider } = setUp;
  const held = await connectionHolding(env, provider.id, account.id);
  const refusal = async (reason: RefusalReason): Promise<never> => {
    // Even an account refused here may be one an active connection holds.
    await drop?.(account.id);
    await refuse(reason, { connectionId: held?.id });
    throw connectionErrors.create(reason);
  };
  if (
    flow.scope === "personal" &&
    !isOwnAccount(person, provider.id, account)
  ) {
    return await refusal("connection.not_own_account");
  }
  if (held !== undefined && !reconnects(held, flow, person)) {
    return await refusal("connection.already_connected");
  }
  // A suite's account's own addresses, read with the token just issued:
  // core counts mail to and from them as the account's
  // (account-addresses.ts). An app has none to read.
  const suite = oauthProviderSchema.safeParse(provider.id);
  const addresses =
    suite.success && "accessToken" in kept
      ? await accountAddressesOf(suite.data, kept.accessToken)
      : undefined;
  try {
    // Stored as new when there is nothing to reconnect, or no longer:
    // disconnected at the same moment, the account connects as new;
    // reconnected by another flow, it is a duplicate.
    return (
      (await reconnect(
        env,
        setUp,
        flow,
        person,
        held,
        account,
        kept,
        addresses
      )) ??
      (await storeConnection(
        env,
        setUp,
        flow,
        person,
        account,
        kept,
        addresses
      ))
    );
  } catch (storeError) {
    // Connected at the same moment by another flow: the grant is theirs.
    if (isDuplicate(storeError)) {
      await refuse("connection.already_connected", {
        connectionId: held?.id,
      });
      throw connectionErrors.create("connection.already_connected");
    }
    await drop?.(account.id);
    throw storeError;
  }
};

/**
 * Keeps the tokens a flow came back with, once they are known to be for an
 * account the person may connect: for a suite, in the organization's
 * tenant; for an app, one the app's lookup names; and as `keepAccount`
 * says. Tokens that aren't kept are dropped (`dropMint`).
 */
const keepTokens = async (
  env: Env,
  setUp: Ready,
  flow: FlowRow,
  person: ConnectionPerson,
  tokens: TokenSet,
  refuse: Refuse
): Promise<string> => {
  const { provider, client } = setUp;
  const account = await provider.account(tokens, flow.tenant, client.id);
  const drop = async (accountId: string | undefined): Promise<void> => {
    await dropMint(env, setUp, tokens, accountId);
  };
  const refusal = async (reason: RefusalReason): Promise<never> => {
    const accountId = account?.id ?? provider.subject?.(tokens);
    // An app's tokens whose account its lookup didn't name could be a
    // grant a live connection holds (an app may issue the same refresh
    // token again, or revoke the whole grant with any one): kept from
    // revoking, they lapse. A suite's ID token always names its subject.
    if (accountId !== undefined || provider.pinned) {
      await drop(accountId);
    }
    const held =
      account === null || accountId === undefined
        ? undefined
        : await connectionHolding(env, provider.id, accountId);
    await refuse(reason, { connectionId: held?.id });
    throw connectionErrors.create(reason);
  };
  if (account === null) {
    // A suite's account outside the tenant, or an app's lookup that
    // named none.
    return await refusal(
      provider.pinned
        ? "connection.wrong_account"
        : "connection.provider_refused"
    );
  }
  if (!grantedAsAsked(provider, tokens)) {
    return await refusal("connection.scopes_refused");
  }
  const { refreshToken } = tokens;
  if (refreshToken === undefined) {
    // Without one the connection would die within the hour.
    return await refusal("connection.provider_refused");
  }
  return await keepAccount(
    env,
    setUp,
    flow,
    person,
    account,
    {
      accessToken: tokens.accessToken,
      refreshToken,
      expiresAt: tokens.expiresAt,
    },
    drop,
    refuse
  );
};

/**
 * Finishes a flow with the provider's answer, for the person who started
 * it: exchanges the code, checks the account is in the organization's
 * tenant, and stores the connection with its tokens, sealed. A connection
 * that holds the account and needs connecting again gets the tokens
 * instead, if the person may reconnect it (`keepTokens`).
 */
export const finishConnection = async (
  env: Env,
  request: unknown
): Promise<{ connectionId: string; returnTo: string }> => {
  const parsed = finishConnectionSchema.safeParse(request);
  if (!parsed.success) {
    const given: unknown =
      typeof request === "object" && request !== null
        ? Reflect.get(request, "state")
        : undefined;
    await abandonFlow(env, given);
    throw connectionErrors.create("connection.invalid");
  }
  const { person, state, code, error } = parsed.data;
  const flow = await takeFlow(env, state);
  const refuse: Refuse = async (
    reason,
    { outcome = "refused", connectionId } = {}
  ) => {
    await auditRefusal(
      env,
      person,
      "connection.connect",
      {
        provider: flow?.provider ?? null,
        scope: flow?.scope ?? null,
        outcome,
        reason,
      },
      connectionId
    );
  };
  const live =
    flow !== undefined &&
    flow.expiresAt.getTime() > Date.now() &&
    flow.userId === person.userId;
  if (!live) {
    await refuse("connection.flow_invalid");
    throw connectionErrors.create("connection.flow_invalid");
  }
  await refuseStaff(env, person, {
    provider: flow.provider,
    scope: flow.scope,
  });
  // The role is read again: it may have changed since the flow started.
  if (!mayManage(person, flow.scope)) {
    await refuse("role.forbidden");
    throw roleErrors.create("role.forbidden");
  }
  if (code === undefined || error !== undefined) {
    await refuse("connection.provider_refused", { outcome: "failed" });
    throw connectionErrors.create("connection.provider_refused");
  }
  const setUp = await ready(env, flow.provider);
  const { provider, client, vault } = setUp;

  let tokens: TokenSet;
  try {
    tokens = await exchangeCode(provider, client, flow.tenant, {
      code,
      redirectUri: flow.redirectUri,
      verifier: await vault.open(flow.verifier, flowContext(flow.stateHash)),
    });
  } catch (exchangeError) {
    log.warn("oauth.exchange_failed", {
      provider: provider.id,
      ...errorFields(exchangeError),
    });
    await refuse("connection.provider_refused", { outcome: "failed" });
    throw connectionErrors.create("connection.provider_refused");
  }

  const connectionId = await keepTokens(
    env,
    setUp,
    flow,
    person,
    tokens,
    refuse
  );
  return { connectionId, returnTo: flow.returnTo };
};

/**
 * Gives a live key connection that holds `account` the new key `key`:
 * a key the person rotated at the app, which an API key's connection
 * otherwise can't take, since nothing tells connect the old one stopped
 * working. Only one of `scope` that the person may manage (their own if
 * personal; any admin's if shared, as checked before), so it keeps its ID
 * and every permission on it. In one write with its event, and only
 * while it is still active. Its ID if this call replaced the key.
 */
const replaceKey = async (
  env: Env,
  { provider, vault }: { provider: ApiKeyProviderConfig; vault: Vault },
  scope: ConnectionScope,
  person: ConnectionPerson,
  account: ProviderAccount,
  key: string
): Promise<string | undefined> => {
  const held = await connectionHolding(env, provider.id, account.id);
  if (
    held?.status !== "active" ||
    held.scope !== scope ||
    (scope === "personal" && held.ownerUserId !== person.userId)
  ) {
    return undefined;
  }
  const now = new Date();
  const row = await firstTokens(
    vault,
    held.id,
    { apiKey: key, expiresAt: apiKeyExpiresAt },
    now
  );
  const stillActive = sql`${connections.id} = ${held.id} AND ${connections.status} = 'active'`;
  const db = drizzle(env.DB);
  const replaced = await recordEventIf(
    env,
    connectionEvent(person, "connection.reconnected", held.id, {
      provider: provider.id,
      scope: held.scope,
      outcome: "ok",
    }),
    { from: connections, where: stillActive },
    [
      db
        .update(connectionTokens)
        .set({
          sealed: row.sealed,
          accessExpiresAt: row.accessExpiresAt,
          generation: row.generation,
          refreshUntil: null,
          updatedAt: now,
        })
        .where(
          sql`${connectionTokens.connectionId} = ${held.id} AND EXISTS (SELECT 1 FROM ${connections} WHERE ${stillActive})`
        ),
      db
        .update(connections)
        .set({
          accountName: account.name,
          accountEmail: account.email?.toLowerCase() ?? null,
          updatedAt: now,
        })
        .where(stillActive),
    ]
  );
  return replaced ? held.id : undefined;
};

/**
 * Connects an app that signs in with an API key: the key the person gave,
 * once the app's own lookup takes it and names its account, kept sealed
 * as a connection's tokens are, under the same rules (`keepAccount`). The
 * key is never logged, audited or answered; a key the app refuses is
 * `connection.provider_refused`, and nothing is kept.
 */
export const connectWithKey = async (
  env: Env,
  request: unknown
): Promise<{ connectionId: string }> => {
  const {
    person,
    provider: providerId,
    scope,
    key,
  } = connectionErrors.parse(
    "connection.invalid",
    connectWithKeySchema,
    request
  );
  await refuseStaff(env, person, { provider: providerId, scope });
  if (!mayManage(person, scope)) {
    await auditRefusal(env, person, "connection.connect", {
      provider: providerId,
      scope,
      outcome: "refused",
      reason: "role.forbidden",
    });
    throw roleErrors.create("role.forbidden");
  }
  const provider = providerFor(providerId);
  const vault = await vaultFor(env);
  if (provider?.kind !== "api_key" || vault === undefined) {
    throw connectionErrors.create("connection.provider_unavailable");
  }
  const refuse: Refuse = async (
    reason,
    { outcome = "refused", connectionId } = {}
  ) => {
    await auditRefusal(
      env,
      person,
      "connection.connect",
      { provider: provider.id, scope, outcome, reason },
      connectionId
    );
  };
  const account = await provider.account(key);
  if (account === null) {
    await refuse("connection.provider_refused", { outcome: "failed" });
    throw connectionErrors.create("connection.provider_refused");
  }
  const replaced = await replaceKey(
    env,
    { provider, vault },
    scope,
    person,
    account,
    key
  );
  if (replaced !== undefined) {
    return { connectionId: replaced };
  }
  const connectionId = await keepAccount(
    env,
    { provider, vault } satisfies {
      provider: ApiKeyProviderConfig;
      vault: Vault;
    },
    { scope, tenant: "" },
    person,
    account,
    { apiKey: key, expiresAt: apiKeyExpiresAt },
    undefined,
    refuse
  );
  return { connectionId };
};

/** The person's own connections and the shared ones, never disconnected ones. */
export const listConnections = async (
  env: Env,
  request: unknown
): Promise<ConnectionSummary[]> => {
  const person = connectionErrors.parse(
    "connection.invalid",
    connectionPersonSchema,
    request
  );
  const rows = await drizzle(env.DB)
    .select()
    .from(connections)
    .where(
      and(
        ne(connections.status, "disconnected"),
        or(
          eq(connections.scope, "shared"),
          eq(connections.ownerUserId, person.userId)
        )
      )
    )
    .orderBy(desc(connections.createdAt));
  return rows.map((row) => ({
    id: row.id,
    source: row.serverKind,
    provider: row.provider,
    scope: row.scope,
    status: row.status,
    ownerUserId: row.ownerUserId,
    connectedBy: row.connectedBy,
    accountName: row.accountName,
    createdAt: row.createdAt.toISOString(),
    ...(row.serverKind === "composio" && { tools: allowedToolNames(row) }),
  }));
};

/**
 * Revokes the grant at the provider where it can. Best effort: a provider
 * that is down doesn't keep a person from disconnecting, and the tokens are
 * deleted either way (threat model CN14).
 */
const revoke = async (
  env: Env,
  connection: ConnectionRow
): Promise<boolean> => {
  const provider = providerFor(connection.provider);
  // An API key has no grant to revoke: the app's own settings do that.
  if (provider?.kind !== "oauth") {
    return false;
  }
  const client = provider.client(env);
  const token = await revocableToken(env, connection.id);
  if (client === undefined || token === undefined) {
    return false;
  }
  try {
    return await revokeToken(provider, client, token);
  } catch (error) {
    log.warn("oauth.revoke_failed", {
      provider: provider.id,
      ...errorFields(error),
    });
    return false;
  }
};

/**
 * Stops `connection`: revokes the grant where the provider can, then
 * deletes the tokens and marks it disconnected, in one write with its
 * event, then drops the actions held for it, which can no longer run.
 * Returns whether the provider revoked the grant, and whether this call
 * stopped it (a concurrent one may have first).
 *
 * One read while it needed connecting again had no grant to revoke, so it
 * is stopped only while it still needs that: if it was reconnected
 * meanwhile, it is read again and stopped as the active connection it is
 * now, with the new grant revoked, not only deleted.
 */
const stop = async (
  env: Env,
  person: ConnectionPerson | null,
  connection: ConnectionRow,
  detail: Record<string, AuditDetailValue> = {}
): Promise<{ revoked: boolean; stopped: boolean }> => {
  const db = drizzle(env.DB);
  // A Composio connection is stopped first, with its cleanup recorded in
  // the same transaction, and deleted at Composio only after: calls stop
  // whatever becomes of that deletion, and the cron trigger retries it
  // (src/composio-connections.ts). An OAuth grant is revoked first, as ever.
  const composio = connection.serverKind === "composio";
  const cleanupId = crypto.randomUUID();
  const revokedGrant = composio ? false : await revoke(env, connection);
  // Recorded only by the disconnect that stops it, if two run at once.
  const waiting = connection.status === "needs_reauth";
  const stillConnected = waiting
    ? sql`${connections.id} = ${connection.id} AND ${connections.status} = 'needs_reauth'`
    : sql`${connections.id} = ${connection.id} AND ${connections.status} <> 'disconnected'`;
  const stopped = await recordEventIf(
    env,
    connectionEvent(person, "connection.disconnect", connection.id, {
      ...detail,
      provider: connection.provider,
      scope: connection.scope,
      outcome: "ok",
      ...(composio ? { tokenHolder: "composio" } : { revoked: revokedGrant }),
    }),
    { from: connections, where: stillConnected },
    [
      ...(composio ? [disconnectCleanup(db, cleanupId, stillConnected)] : []),
      db
        .update(connections)
        .set({ status: "disconnected", updatedAt: new Date() })
        .where(stillConnected),
      // After the status: only a stopped connection's tokens go.
      db
        .delete(connectionTokens)
        .where(
          sql`${connectionTokens.connectionId} = ${connection.id} AND EXISTS (SELECT 1 FROM ${connections} WHERE ${connections.id} = ${connection.id} AND ${connections.status} = 'disconnected')`
        ),
    ]
  );
  const reconnected =
    waiting && !stopped
      ? await db
          .select()
          .from(connections)
          .where(
            and(
              eq(connections.id, connection.id),
              eq(connections.status, "active")
            )
          )
          .get()
      : undefined;
  if (reconnected !== undefined) {
    return await stop(env, person, reconnected, detail);
  }
  await dropPendingActions(
    env,
    eq(pendingActions.connectionId, connection.id),
    "connection.disconnected",
    person
  );
  const revoked =
    composio && stopped
      ? await revokeAtComposio(env, cleanupId, connection)
      : revokedGrant;
  return { revoked, stopped };
};

/**
 * Disconnects: stops the connection (see `stop`). A personal connection
 * only by its owner, a shared one only by an admin.
 */
export const disconnect = async (
  env: Env,
  request: unknown
): Promise<{ revoked: boolean }> => {
  const { person, connectionId } = connectionErrors.parse(
    "connection.invalid",
    disconnectSchema,
    request
  );
  const db = drizzle(env.DB);
  const connection = await db
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .get();
  if (connection === undefined) {
    throw connectErrors.create("connect.connection_not_found");
  }
  const refused = async (reason: string): Promise<void> => {
    await auditRefusal(
      env,
      person,
      "connection.disconnect",
      { provider: connection.provider, outcome: "refused", reason },
      connectionId
    );
  };
  if (
    connection.scope === "personal" &&
    connection.ownerUserId !== person.userId
  ) {
    await refused("connect.not_owner");
    throw connectErrors.create("connect.not_owner");
  }
  if (!mayManage(person, connection.scope)) {
    await refused("role.forbidden");
    throw roleErrors.create("role.forbidden");
  }
  if (connection.status === "disconnected") {
    // Already stopped, maybe by a call that failed before it dropped the
    // held actions: dropped now.
    await dropPendingActions(
      env,
      eq(pendingActions.connectionId, connection.id),
      "connection.disconnected",
      person
    );
    return { revoked: false };
  }
  const { revoked } = await stop(env, person, connection);
  return { revoked };
};

/**
 * Disconnects every personal connection of the people `ownerUserIds`, each
 * as `disconnect` does, spends the OAuth flows they still have open, so
 * none of them finishes into a new connection, and drops every action held
 * for them. For the admin who removed
 * them, or for core itself (`person` null), which retries until a call
 * completes; core calls it only for people it removed. Staff are
 * refused, as they are for connecting. A flow already past its spending
 * when this runs can still finish; core's retry catches that connection.
 * Returns how many connections this call stopped.
 */
export const disconnectPersonal = async (
  env: Env,
  request: unknown
): Promise<{ disconnected: number }> => {
  const { person, ownerUserIds } = connectionErrors.parse(
    "connection.invalid",
    disconnectPersonalSchema,
    request
  );
  if (person !== null && (person.staff || !isAdmin(person.role))) {
    await auditRefusal(env, person, "connection.disconnect", {
      outcome: "refused",
      reason: "role.forbidden",
    });
    throw roleErrors.create("role.forbidden");
  }
  if (ownerUserIds.length === 0) {
    return { disconnected: 0 };
  }
  const db = drizzle(env.DB);
  // The IDs as one JSON parameter: D1 binds at most 100 to a statement,
  // and a full list of owners is that many on its own.
  const owners = sql`(SELECT value FROM json_each(${JSON.stringify(ownerUserIds)}))`;
  await db.delete(oauthFlows).where(sql`${oauthFlows.userId} IN ${owners}`);
  await dropToolkitFlowsOf(env, ownerUserIds);
  const owned = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.scope, "personal"),
        sql`${connections.ownerUserId} IN ${owners}`,
        ne(connections.status, "disconnected")
      )
    );
  let disconnected = 0;
  // One at a time: each revokes at its provider, and the first failure
  // stops the rest, for a later try to pick up.
  for (const connection of owned) {
    // oxlint-disable-next-line no-await-in-loop -- one connection at a time
    const { stopped } = await stop(env, person, connection, {
      ownerUserId: connection.ownerUserId,
    });
    disconnected += stopped ? 1 : 0;
  }
  // Nobody can confirm what waits for them any more, on any connection.
  // After their connections, so this never keeps one of those live; core
  // retries the whole call until it completes.
  await dropPendingActions(
    env,
    sql`${pendingActions.onBehalfOf} IN ${owners}`,
    "person.removed",
    person
  );
  return { disconnected };
};

/**
 * Seals the verifiers of flows under way again with the current key, after
 * a rotation, as `resealTokens` does for tokens: a flow started just before
 * still finishes once the previous key is gone. The cron trigger calls it.
 */
export const resealFlows = async (env: Env): Promise<void> => {
  const vault = await vaultFor(env);
  if (vault?.sealedWithPrevious === undefined) {
    return;
  }
  const db = drizzle(env.DB);
  const flows = await db
    .select()
    .from(oauthFlows)
    .where(like(oauthFlows.verifier, vault.sealedWithPrevious))
    .limit(resealBatchSize);
  for (const flow of flows) {
    const context = flowContext(flow.stateHash);
    try {
      // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
      const verifier = await vault.open(flow.verifier, context);
      // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
      const sealed = await vault.seal(verifier, context);
      // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
      await db
        .update(oauthFlows)
        .set({ verifier: sealed })
        .where(
          and(
            eq(oauthFlows.stateHash, flow.stateHash),
            eq(oauthFlows.verifier, flow.verifier)
          )
        );
    } catch (error) {
      // Changed at rest: it can never finish, so it goes rather than hold
      // up the rest.
      log.error("vault.open_failed", errorFields(error));
      // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
      await db
        .delete(oauthFlows)
        .where(eq(oauthFlows.stateHash, flow.stateHash));
    }
  }
};

/** Deletes OAuth flows nobody finished in time. The cron trigger calls it. */
export const purgeExpiredFlows = async (env: Env): Promise<void> => {
  await drizzle(env.DB)
    .delete(oauthFlows)
    .where(lte(oauthFlows.expiresAt, new Date()));
};
