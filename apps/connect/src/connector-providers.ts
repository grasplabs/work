import { mcpServerKey } from "@grasp-os/runtime/connector";
import type { McpManifest } from "@grasp-os/runtime/connector";
import {
  connectionErrors,
  urlConnectorIdSchema,
} from "@grasp-os/shared/connect";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, eq, exists, inArray, isNull, like, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { recordEventIf } from "./audit.ts";
import { nativeConnector, nativeConnectors } from "./bundled-connectors.ts";
import type { Outbound } from "./company-network.ts";
import {
  connectionTokens,
  connections,
  connectors,
  oauthFlows,
  pendingActions,
  tokenRevocations,
} from "./db/schema.ts";
import { heldDeletions } from "./held-deletions.ts";
import { clientFor, discoverSignIn } from "./mcp-discovery.ts";
import { McpError, modernMcpServer } from "./mcp.ts";
import { giveUpOwed } from "./owed-revokes.ts";
import { providerFor } from "./providers.ts";
import type { ProviderAccount, ProviderConfig } from "./providers.ts";
import { resealBatchSize, vaultFor } from "./vault.ts";
import type { Vault } from "./vault.ts";

// A connector served through its vendor's MCP server, as the rest of
// connect signs in to it: a provider like any app's, built from its row
// in `connectors` instead of a release's record, so the flows, the vault,
// refreshing under the lease and revoking at disconnect are the ones every
// connection has (oauth.ts, tokens.ts, revocations.ts). Two kinds have a
// row: one an admin made from a URL (mcp-connectors.ts `addConnector`),
// and a built-in of the release whose manifest has `mcp`, whose row is
// made on its first connection and moved when a release moves its server
// (`prepareBuiltIn`).

export type ConnectorRow = typeof connectors.$inferSelect;

/** A built-in of this release that serves its vendor's MCP server. */
export interface BuiltIn {
  name: string;
  title: string;
  mcp: McpManifest;
}

/** The built-in named `name`, if this release has one. */
export const builtIn = (name: string): BuiltIn | undefined => {
  const manifest = nativeConnector(name)?.manifest;
  return manifest?.mcp === undefined
    ? undefined
    : { name, title: manifest.title ?? name, mcp: manifest.mcp };
};

/** Every built-in of this release that serves an MCP server. */
export const builtIns = (): BuiltIn[] =>
  nativeConnectors().flatMap(({ manifest }) => {
    const each = builtIn(manifest.name);
    return each === undefined ? [] : [each];
  });

/** The built-in that serves the server at `url`, if one does. */
export const builtInAt = (url: string): BuiltIn | undefined =>
  builtIns().find(({ mcp }) => mcpServerKey(mcp.url) === mcpServerKey(url));

/** Whether `id` names a connector: a built-in, or one made from a URL. */
export const isConnectorId = (id: string): boolean =>
  builtIn(id) !== undefined || urlConnectorIdSchema.safeParse(id).success;

/** The connector `id` names, if there is one, as its row holds it. */
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

/** A unique index refused the row: another connector has that URL. */
export const isDuplicate = (error: unknown): boolean =>
  error instanceof Error &&
  [error.message, error.cause instanceof Error ? error.cause.message : ""].some(
    (message) => message.includes("UNIQUE") && message.includes("connectors")
  );

/**
 * What a connector's client secret is sealed for: the connector and the
 * issuer that issued it (2026-07-28: no client is used at another).
 */
export const secretContext = (id: string, issuer: string | null): string =>
  `connector:${id}\n${issuer ?? ""}`;

/**
 * What connector `id` keeps of the sign-in of its server at `server`:
 * learned from the server (mcp-discovery.ts), and the client connect
 * signs in as there, the one an admin `entered` or one it registered for
 * the deployment at `origin`, its secret sealed.
 */
export const signInRow = async (
  vault: Vault,
  id: string,
  server: URL,
  origin: string,
  entered?: { id: string; secret?: string | undefined }
) => {
  const signIn = await discoverSignIn(server);
  const client = await clientFor(signIn, origin, entered);
  return {
    resource: signIn.resource,
    auth: "oauth",
    header: null,
    issuer: signIn.issuer,
    authorizationEndpoint: signIn.authorizationEndpoint,
    tokenEndpoint: signIn.tokenEndpoint,
    revocationEndpoint: signIn.revocationEndpoint ?? null,
    scopes: signIn.scopes,
    issParameter: signIn.issParameter,
    registration: client.registration,
    clientId: client.id,
    clientSecret:
      client.secret === undefined
        ? null
        : await vault.seal(client.secret, secretContext(id, signIn.issuer)),
    clientAuthentication: client.authentication,
  } satisfies Partial<typeof connectors.$inferInsert>;
};

/** A row's sign-in for a key in `header`: none of an OAuth server's. */
const keyRow = (header: string) =>
  ({
    resource: null,
    auth: "header",
    header,
    issuer: null,
    authorizationEndpoint: null,
    tokenEndpoint: null,
    revocationEndpoint: null,
    scopes: null,
    issParameter: null,
    registration: null,
    clientId: null,
    clientSecret: null,
    clientAuthentication: null,
  }) satisfies Partial<typeof connectors.$inferInsert>;

/** Who a built-in's row says made it: the release, never a person. */
const builtInCreator = "release";

/**
 * Makes or moves the row of built-in `id` before someone connects it, so
 * its sign-in is the one of the server its manifest names now: a key's
 * header, or the server's sign-in learned and connect registered there
 * for the deployment at `origin`, as for a server an admin adds. Nothing
 * for any other connector, or one whose row is for that server already.
 *
 * Its connections were made with the sign-in it moves from, so they move
 * with it in one write: each still active must be connected again, and
 * every token kept for any of them goes, owed revokes' copies included,
 * so none ever reaches the new server or its issuer. Their grants at the
 * old issuer are left as they are. Its sign-ins under way go too: one
 * that comes back finds no flow, and one already exchanging its code
 * keeps nothing (oauth.ts `flowStands`).
 *
 * Two first connections at once may each register, but one row is
 * written, or moved from the URL it was made for, and both use it: the
 * other's client is never used. Throws `connection.connector_exists` when
 * a connector made from a URL holds the server, and
 * `connection.provider_unavailable` for a sign-in at the server without
 * an origin to return to.
 */
export const prepareBuiltIn = async (
  env: Env,
  id: string,
  origin?: string
): Promise<void> => {
  const found = builtIn(id);
  if (found === undefined) {
    return;
  }
  const { title, mcp } = found;
  const { registration } = mcp;
  const header = typeof registration === "object" ? registration.header : null;
  const row = await connectorRow(env.DB, id);
  if (
    row !== undefined &&
    row.url === mcp.url &&
    row.auth === (header === null ? "oauth" : "header") &&
    row.header === header
  ) {
    // Only its name changed: renamed in place, its sign-in as it is.
    if (row.name !== title) {
      await drizzle(env.DB)
        .update(connectors)
        .set({ name: title })
        .where(eq(connectors.id, id));
    }
    return;
  }
  let state: ReturnType<typeof keyRow> | Awaited<ReturnType<typeof signInRow>>;
  if (header === null) {
    const vault = await vaultFor(env);
    if (vault === undefined || origin === undefined) {
      throw connectionErrors.create("connection.provider_unavailable");
    }
    state = await signInRow(
      vault,
      id,
      new URL(mcp.url),
      new URL(origin).origin
    );
  } else {
    state = keyRow(header);
  }
  const db = drizzle(env.DB);
  const prepared = {
    connector: id,
    ...(state.registration === null
      ? {}
      : { registration: state.registration }),
  };
  try {
    if (row === undefined) {
      const written = await db
        .insert(connectors)
        .values({
          id,
          name: title,
          url: mcp.url,
          ...state,
          createdBy: builtInCreator,
          createdAt: new Date(),
        })
        .onConflictDoNothing({ target: connectors.id });
      if (written.meta.changes > 0) {
        log.info("connect.built_in_prepared", prepared);
      }
      return;
    }
    // A row found is moved only from the state it was found in, and its
    // connections with it: a move made at once by another connection
    // stands, and a connection made after that move keeps its tokens.
    const asFound = and(
      eq(connectors.id, id),
      eq(connectors.url, row.url),
      eq(connectors.auth, row.auth),
      row.header === null
        ? isNull(connectors.header)
        : eq(connectors.header, row.header)
    );
    const unmoved = exists(db.select().from(connectors).where(asFound));
    const ofIt = and(
      eq(connections.serverKind, "connector"),
      eq(connections.server, id)
    );
    const itsConnections = db
      .select({ id: connections.id })
      .from(connections)
      .where(ofIt);
    const active = and(ofIt, eq(connections.status, "active"));
    const tokensOfIt = inArray(connectionTokens.connectionId, itsConnections);
    const owedOfIt = inArray(tokenRevocations.connectionId, itsConnections);
    const heldOfIt = inArray(pendingActions.connectionId, itsConnections);
    // Its tokens and owed revokes were the old server's: none goes to the
    // new one. Nor does any action held on its connections, whose saved
    // input was meant for the old server: each is dropped with its key
    // spent as a disconnect's drop spends it (held-deletions.ts), so it is
    // never confirmed there once its person signs in again. An owed revoke
    // ends given up, the grant it held still live at the old server, for
    // the company's admins to revoke there by hand (revocations-by-hand.ts).
    // The event comes first in the move's transaction, its counts over the
    // rows the move then changes.
    const moved = await recordEventIf(
      env,
      {
        actor: { type: "system" },
        action: "connector.moved",
        target: { type: "connector", id },
        detail: { connector: id, from: row.url, url: mcp.url },
      },
      {
        from: connectors,
        where: sql`${asFound}`,
        counted: {
          needsReauth: sql`SELECT count(*) FROM ${connections} WHERE ${active}`,
          tokensDropped: sql`SELECT count(*) FROM ${connectionTokens} WHERE ${tokensOfIt}`,
          revokesGivenUp: sql`SELECT count(*) FROM ${tokenRevocations} WHERE ${owedOfIt}`,
          heldDropped: sql`SELECT count(*) FROM ${pendingActions} WHERE ${heldOfIt}`,
        },
      },
      [
        db.delete(oauthFlows).where(and(eq(oauthFlows.provider, id), unmoved)),
        ...heldDeletions(
          env,
          sql`${and(heldOfIt, unmoved)}`,
          "connector.moved"
        ),
        giveUpOwed(db, sql`${and(owedOfIt, unmoved)}`, "moved"),
        db.delete(tokenRevocations).where(and(owedOfIt, unmoved)),
        db.delete(connectionTokens).where(and(tokensOfIt, unmoved)),
        db
          .update(connections)
          .set({ status: "needs_reauth", updatedAt: new Date() })
          .where(and(active, unmoved)),
        db
          .update(connectors)
          .set({ name: title, url: mcp.url, ...state })
          .where(asFound),
      ]
    );
    if (moved) {
      log.info("connect.built_in_prepared", prepared);
    }
  } catch (error) {
    if (isDuplicate(error)) {
      throw connectionErrors.create("connection.connector_exists");
    }
    throw error;
  }
};

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
