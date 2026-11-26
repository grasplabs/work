import { connectorIdSchema } from "@grasp-os/shared/connect";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, eq, like, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { Outbound } from "./company-network.ts";
import { connectors } from "./db/schema.ts";
import { McpError, modernMcpServer } from "./mcp.ts";
import { providerFor } from "./providers.ts";
import type { ProviderAccount, ProviderConfig } from "./providers.ts";
import { resealBatchSize, vaultFor } from "./vault.ts";

// A connector made from an MCP server's URL as the rest of connect signs
// in to it: a provider like any app's, built from its row in `connectors`
// instead of a release's record, so the flows, the vault, refreshing under
// the lease and revoking at disconnect are the ones every connection has
// (oauth.ts, tokens.ts, revocations.ts).

export type ConnectorRow = typeof connectors.$inferSelect;

/** Whether `id` names a connector made from a URL. */
export const isConnectorId = (id: string): boolean =>
  connectorIdSchema.safeParse(id).success;

/** The connector `id` names, if there is one. */
export const connectorRow = async (
  db: D1Database,
  id: string
): Promise<ConnectorRow | undefined> =>
  isConnectorId(id)
    ? await drizzle(db)
        .select()
        .from(connectors)
        .where(eq(connectors.id, id))
        .get()
    : undefined;

/** The names admins gave the connectors `ids` name, by ID. */
export const connectorNames = async (
  db: D1Database,
  ids: readonly string[]
): Promise<Map<string, string>> => {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await drizzle(db)
    .select({ id: connectors.id, name: connectors.name })
    .from(connectors)
    // As one JSON parameter: D1 binds at most 100 to a statement.
    .where(
      sql`${connectors.id} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`
    );
  return new Map(rows.map(({ id, name }) => [id, name]));
};

/**
 * What a connector's client secret is sealed for: the connector and the
 * issuer that issued it (2026-07-28: no client is used at another).
 */
export const secretContext = (id: string, issuer: string | null): string =>
  `connector:${id}\n${issuer ?? ""}`;

/**
 * The account of a connection to a connector: an MCP server's sign-in
 * names none connect can check, so it is the connection's owner's
 * (`ownerOf`). One person's own connection to a connector, or the
 * company's shared one, is then always the same account, and connecting
 * again reconnects it in place (oauth.ts `reconnect`). Nothing reads a
 * reader list by it (core's `personalAccounts` counts only the suites').
 */
const ownAccount = (owner: string): ProviderAccount => ({
  id: owner,
  name: null,
  email: null,
});

/** Most tools a server may list for connect to read the list at all. */
export const maxListedTools = 500;

/**
 * Whether the server at `url` lists its tools for `key` in `header`,
 * asked the connection's way out (`send`).
 */
const keyWorks = async (
  url: string,
  header: string,
  key: string,
  send: Outbound
): Promise<boolean> => {
  const server = modernMcpServer(url, async (request) => {
    const headers = new Headers(request.headers);
    headers.set(header, key);
    return await send(new Request(request, { headers, redirect: "manual" }));
  });
  try {
    await server.list(maxListedTools);
    return true;
  } catch (error) {
    if (error instanceof McpError) {
      return false;
    }
    throw error;
  }
};

/** `row` as a provider connect signs in to. */
const providerOf = async (
  env: Env,
  row: ConnectorRow
): Promise<ProviderConfig | undefined> => {
  if (row.auth === "header") {
    const { header } = row;
    if (header === null) {
      return undefined;
    }
    return {
      kind: "api_key",
      id: row.id,
      server: row.id,
      credential: (key) => ({ header, value: key }),
      account: async (key, owner, send) =>
        (await keyWorks(row.url, header, key, send)) ? ownAccount(owner) : null,
      ...(row.companyNetwork === true && {
        companyNetwork: new URL(row.url).origin,
      }),
    };
  }
  const {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    clientId,
    clientAuthentication,
  } = row;
  if (
    issuer === null ||
    authorizationEndpoint === null ||
    tokenEndpoint === null ||
    clientId === null ||
    clientAuthentication === null
  ) {
    return undefined;
  }
  const vault = await vaultFor(env);
  let secret: string | undefined;
  try {
    secret =
      row.clientSecret === null || vault === undefined
        ? undefined
        : await vault.open(row.clientSecret, secretContext(row.id, issuer));
  } catch (error) {
    log.error("vault.open_failed", errorFields(error));
  }
  // A confidential client whose secret can't be opened has no client.
  const client =
    clientAuthentication === "none" || secret !== undefined
      ? { id: clientId, secret: secret ?? "" }
      : undefined;
  return {
    kind: "oauth",
    id: row.id,
    server: row.id,
    pinned: false,
    isTenant: (tenant) => tenant === "",
    authorizationEndpoint: () => authorizationEndpoint,
    tokenEndpoint: () => tokenEndpoint,
    ...(row.revocationEndpoint === null
      ? {}
      : { revocationEndpoint: row.revocationEndpoint }),
    scopes: row.scopes?.split(" ") ?? [],
    scopeSeparator: " ",
    // RFC 8707: every token is asked for this server alone.
    authorizationParams: () => ({ resource: row.resource ?? row.url }),
    tokenParams: { resource: row.resource ?? row.url },
    issuer: { id: issuer, inAnswers: row.issParameter === true },
    clientAuthentication,
    client: () => client,
    account: async (_tokens, _tenant, _client, owner) =>
      await Promise.resolve(ownAccount(owner)),
  };
};

/**
 * The provider `id` names: a suite, an admin connection's, an app of this
 * release (`providerFor`), or a connector made from a URL.
 */
export const providerConfigFor = async (
  env: Env,
  id: string
): Promise<ProviderConfig | undefined> => {
  const known = providerFor(id);
  if (known !== undefined) {
    return known;
  }
  const row = await connectorRow(env.DB, id);
  return row === undefined ? undefined : await providerOf(env, row);
};

/**
 * Seals again, with the current key, the client secrets a rotated key
 * sealed, as `resealTokens` does for tokens. The clock calls it.
 */
export const resealConnectorSecrets = async (env: Env): Promise<void> => {
  const vault = await vaultFor(env);
  if (vault?.sealedWithPrevious === undefined) {
    return;
  }
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(connectors)
    .where(like(connectors.clientSecret, vault.sealedWithPrevious))
    .limit(resealBatchSize);
  for (const { id, issuer, clientSecret } of rows) {
    if (clientSecret === null) {
      continue;
    }
    const context = secretContext(id, issuer);
    try {
      // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
      const secret = await vault.open(clientSecret, context);
      // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
      const sealed = await vault.seal(secret, context);
      // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
      await db
        .update(connectors)
        .set({ clientSecret: sealed })
        .where(
          and(eq(connectors.id, id), eq(connectors.clientSecret, clientSecret))
        );
    } catch (error) {
      // Changed at rest: its sign-in fails closed until an admin adds the
      // server again; the rest go on.
      log.error("vault.open_failed", errorFields(error));
    }
  }
};
