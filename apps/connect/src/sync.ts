import {
  connectorIsolateRequests,
  syncMethod,
  syncPlacesMethod,
} from "@grasp-os/connector-kit/manifest";
import type { SyncManifest } from "@grasp-os/connector-kit/manifest";
import {
  syncPlacesResultSchema,
  syncResultSchema,
} from "@grasp-os/connector-kit/sync";
import type { SyncFailure } from "@grasp-os/connector-kit/sync";
import {
  connectErrors,
  connectionErrors,
  connectionOwnersMax,
} from "@grasp-os/shared/connect";
import type { Json } from "@grasp-os/shared/json";
import {
  ownPlace,
  syncErrors,
  syncPageRequestSchema,
  syncPlaceSchema,
  syncPlacesRequestSchema,
  syncSourcesRequestSchema,
} from "@grasp-os/shared/sync";
import type {
  SyncPage,
  SyncPlaces,
  SyncSource,
  SyncSourcePage,
} from "@grasp-os/shared/sync";
import { and, asc, eq, gt, not, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { nativeConnector } from "./bundled-connectors.ts";
import type { Connection } from "./connections.ts";
import { syncServer } from "./connectors.ts";
import { connections } from "./db/schema.ts";
import { erasureBegan, ownerErased } from "./erased-people.ts";
import { McpError } from "./mcp.ts";

// Native sync's read (GRA-1758): one page of one source's changes, for
// core, which applies it to the Brain and keeps the cursor. A source is a
// connection and a place in it, read by one of its connector's syncs
// (the connector kit's sync.ts). The ways it can fail, which the tests
// start from:
//
// - The token leaving connect: the page is read in a fresh isolate of the
//   connection's own native connector, whose only way out is the egress,
//   which adds the token and lets through only the sync's GET routes. The
//   token is in the egress's props alone, never in the answer.
// - More read than the connection may sync: a personal connection syncs
//   only its own account: `own`, or, for a sync that lists places of the
//   account itself (a mailbox's folders, `places: "listed"`), one of
//   those, a single path segment bound to the routes' `{place}`, whose
//   routes stay in the account; a shared one only the places someone
//   picked on it, and until picks exist (GRA-1758, PR J), nothing. Checked
//   before the token is read. A route's `{place}` segment is bound to the
//   place asked for.
// - A cursor as a link: a cursor is a position in an alphabet with no
//   `/ ? # % :` (`syncCursorSchema`), from core and from the connector
//   alike, and the connector builds every request itself.
// - A harmful answer: the page is checked strictly against the shared
//   shape and read up to the bound on a native connector's answer; one
//   that fails is refused whole, never half passed on.
// - A sync called as a tool: it is a method of its own on the connector's
//   server, reached only by this read; `connect.call` reaches tools alone.

/**
 * The connection `connectionId`, if a native one a sync may read: not
 * disconnected, and not of someone whose erasure began, in the same
 * statement.
 */
const connectionOf = async (
  env: Env,
  connectionId: string
): Promise<Connection | undefined> =>
  await drizzle(env.DB)
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.serverKind, "native"),
        not(ownerErased(connectionId))
      )
    )
    .get();

/**
 * Whether `place` is one the connection may sync with `sync`: on a
 * personal connection, its own account (`own`), or, for a sync that lists
 * its places, one in a place's alphabet. A shared connection syncs only
 * picked places: none yet.
 */
const mayRead = (
  connection: Connection,
  sync: SyncManifest,
  place: string
): boolean => {
  if (connection.scope !== "personal") {
    return false;
  }
  return sync.places === "own"
    ? place === ownPlace
    : syncPlaceSchema.safeParse(place).success;
};

/** The error a connector's failure stands for. */
const failureError = ({ code, retryAfterSeconds }: SyncFailure): Error => {
  switch (code) {
    case "restart": {
      return syncErrors.create("sync.restart");
    }
    case "throttled": {
      return syncErrors.create(
        "sync.throttled",
        retryAfterSeconds === undefined
          ? undefined
          : { retryAfterMs: retryAfterSeconds * 1000 }
      );
    }
    case "inactive": {
      return syncErrors.create("sync.inactive");
    }
    case "failed": {
      return syncErrors.create("sync.provider_failed");
    }
    default: {
      return code satisfies never;
    }
  }
};

/** The page a connector's answer holds, or the error it stands for. */
const pageOf = (result: unknown): SyncPage => {
  const parsed = syncResultSchema.safeParse(result);
  if (!parsed.success) {
    throw syncErrors.create("sync.provider_failed");
  }
  if ("page" in parsed.data) {
    return parsed.data.page;
  }
  throw failureError(parsed.data.failure);
};

/** The places a connector's answer holds, or the error it stands for. */
const placesOf = (result: unknown): SyncPlaces => {
  const parsed = syncPlacesResultSchema.safeParse(result);
  if (!parsed.success) {
    throw syncErrors.create("sync.provider_failed");
  }
  if ("places" in parsed.data) {
    return parsed.data;
  }
  throw failureError(parsed.data.failure);
};

/**
 * The connection `connectionId` and its connector's sync `feed`, if it may
 * be read: a native connection, not disconnected, of the connector's own
 * provider.
 */
const syncOf = async (env: Env, connectionId: string, feed: string) => {
  const connection = await connectionOf(env, connectionId);
  if (connection === undefined || connection.status === "disconnected") {
    throw syncErrors.create("sync.not_found");
  }
  const connector = nativeConnector(connection.server);
  // Its token must never go to another provider's hosts.
  const syncs =
    connector?.manifest.provider === connection.provider
      ? (connector.manifest.syncs ?? {})
      : {};
  const sync = Object.hasOwn(syncs, feed) ? syncs[feed] : undefined;
  if (connector === undefined || sync === undefined) {
    throw syncErrors.create("sync.not_found");
  }
  return { connection, connector, sync };
};

/**
 * Sends `method` to the connection's sync in a fresh isolate, its egress
 * held to the sync's routes with `{place}` bound to `place`.
 */
const sendToSync = async (
  env: Env,
  { connection, connector, sync }: Awaited<ReturnType<typeof syncOf>>,
  place: string,
  method: string,
  params: Record<string, Json>
): Promise<unknown> => {
  if (connection.status !== "active") {
    throw syncErrors.create("sync.inactive");
  }
  try {
    const server = await syncServer(
      env,
      connection,
      connector,
      sync.routes,
      place
    );
    return await server.send(method, params);
  } catch (error) {
    // A grant that ran out, or a renewal granted other access, is for its
    // person to reconnect; a renewal the provider didn't answer, or a
    // connector that didn't answer, a failure.
    if (connectErrors.codeOf(error) === "connect.connection_inactive") {
      throw syncErrors.create("sync.inactive");
    }
    if (
      connectionErrors.codeOf(error) !== undefined ||
      error instanceof McpError
    ) {
      throw syncErrors.create("sync.provider_failed");
    }
    throw error;
  }
};

/** One page of a source's changes, from the request's cursor on. */
export const readSyncPage = async (
  env: Env,
  request: unknown
): Promise<SyncPage> => {
  const { connectionId, feed, place, cursor, names, ids } = syncErrors.parse(
    "sync.invalid",
    syncPageRequestSchema,
    request
  );
  // One request each at most, within what a page may send.
  if (ids !== undefined && ids.length > connectorIsolateRequests) {
    throw syncErrors.create("sync.invalid");
  }
  const found = await syncOf(env, connectionId, feed);
  if (!mayRead(found.connection, found.sync, place)) {
    throw syncErrors.create("sync.place_refused");
  }
  return pageOf(
    await sendToSync(env, found, place, syncMethod, {
      name: feed,
      place,
      cursor,
      ...(names === undefined ? {} : { names }),
      ...(ids === undefined ? {} : { ids: [...ids] }),
    })
  );
};

/**
 * The places of a connection's sync, each a source of its own: `own` for
 * a sync of the whole account; the places a sync lists of its own account
 * (`places: "listed"`), read from the provider, a read at a time from
 * `cursor` when the list is longer than one read takes; none on a shared
 * connection until places are picked (GRA-1758, PR J).
 */
export const listSyncPlaces = async (
  env: Env,
  request: unknown
): Promise<SyncPlaces> => {
  const { connectionId, feed, cursor } = syncErrors.parse(
    "sync.invalid",
    syncPlacesRequestSchema,
    request
  );
  const found = await syncOf(env, connectionId, feed);
  if (found.connection.scope !== "personal") {
    return { places: [], cursor: null };
  }
  if (found.sync.places === "own") {
    return { places: [ownPlace], cursor: null };
  }
  return placesOf(
    await sendToSync(env, found, ownPlace, syncPlacesMethod, {
      name: feed,
      cursor,
    })
  );
};

/**
 * A page of the syncs core's sync run reads (GRA-1758), by connection ID
 * after `after`: each sync of each person's own native connection that is
 * active, of someone whose erasure hasn't begun, whose connector is for
 * the connection's provider, with its kind and whether it reads the whole
 * account or places it lists (`listSyncPlaces`). A shared
 * connection syncs only places picked on it: none yet (`mayRead`). A page
 * holds at most `connectionOwnersMax` connections, as connect's other
 * pages of connections for core.
 */
export const listSyncSources = async (
  env: Env,
  request: unknown
): Promise<SyncSourcePage> => {
  const { after } = syncErrors.parse(
    "sync.invalid",
    syncSourcesRequestSchema,
    request
  );
  const rows = await drizzle(env.DB)
    .select({
      id: connections.id,
      ownerUserId: connections.ownerUserId,
      provider: connections.provider,
      server: connections.server,
      tenant: connections.tenant,
      accountId: connections.accountId,
      accountEmail: connections.accountEmail,
    })
    .from(connections)
    .where(
      and(
        eq(connections.scope, "personal"),
        eq(connections.serverKind, "native"),
        eq(connections.status, "active"),
        not(erasureBegan(sql`${connections.ownerUserId}`)),
        after === null ? undefined : gt(connections.id, after)
      )
    )
    .orderBy(asc(connections.id))
    .limit(connectionOwnersMax);
  const sources = rows.flatMap(
    ({
      id,
      ownerUserId,
      provider,
      server,
      tenant,
      accountId,
      accountEmail,
    }) => {
      const manifest = nativeConnector(server)?.manifest;
      if (ownerUserId === null || manifest?.provider !== provider) {
        return [];
      }
      return Object.entries(manifest.syncs ?? {}).map(
        ([feed, sync]): SyncSource => ({
          connectionId: id,
          ownerUserId,
          provider,
          tenant,
          // As its items' readers name it, and core's reading side
          // (connections.ts `personalAccounts`): Google by the verified
          // address, Microsoft by the object ID.
          account: provider === "google" ? accountEmail : accountId,
          feed,
          kind: sync.kind,
          places: sync.places,
        })
      );
    }
  );
  return {
    sources,
    next: rows.length < connectionOwnersMax ? null : (rows.at(-1)?.id ?? null),
  };
};
