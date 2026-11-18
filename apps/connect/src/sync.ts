import { syncMethod, syncPlacesMethod } from "@grasp-os/connector-kit/manifest";
import type { SyncManifest } from "@grasp-os/connector-kit/manifest";
import {
  syncPlacesResultSchema,
  syncResultSchema,
} from "@grasp-os/connector-kit/sync";
import type { SyncFailure } from "@grasp-os/connector-kit/sync";
import { connectErrors, connectionErrors } from "@grasp-os/shared/connect";
import type { ConnectionPerson } from "@grasp-os/shared/connect";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import {
  ownPlace,
  pickSyncPlacesSchema,
  syncErrors,
  syncPageRequestSchema,
  syncPlaceChoicesRequestSchema,
  syncPlaceSchema,
  syncPlacesRequestSchema,
} from "@grasp-os/shared/sync";
import type {
  SyncChoices,
  SyncPage,
  SyncPlaceChoices,
  SyncPlaces,
} from "@grasp-os/shared/sync";
import { and, eq, not, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { recordEvents } from "./audit.ts";
import { nativeConnector } from "./bundled-connectors.ts";
import { auditRefusal, connectionEvent } from "./connection-audit.ts";
import type { Connection } from "./connections.ts";
import { syncServer } from "./connectors.ts";
import { connections, syncPicks } from "./db/schema.ts";
import { ownerErased } from "./erased-people.ts";
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
//   routes stay in the account. A shared connection syncs only with a
//   sync of picked places (`places: "picked"`: shared drives, document
//   libraries), and only a place an admin picked on it (`sync_picks`),
//   read in the same statement as the connection; never its account's
//   own mail or files, which only `own` and `listed` syncs read, and a
//   personal connection never takes a sync of picked places. Checked
//   before the token is read. A route's `{place}` segment is bound to the
//   place asked for.
// - An unpicked place, or one the account no longer sees, kept: the places
//   of a shared connection's sync (`listSyncPlaces`) are the picked ones
//   its connector still lists, so core's sync run drops the source of a
//   place unpicked or gone, and erases what it brought.
// - Someone other than an admin picking: picks are an admin's alone,
//   never Grasp staff's, each change one audit event, in the same batch.
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
 * statement; with whether `place` is picked on it for `feed`.
 */
const connectionOf = async (
  env: Env,
  connectionId: string,
  picked: { feed: string; place: string } | null = null
): Promise<{ connection: Connection; picked: boolean } | undefined> =>
  await drizzle(env.DB)
    .select({
      connection: connections,
      picked:
        picked === null
          ? sql<boolean>`0`.mapWith(Boolean)
          : sql<boolean>`EXISTS (SELECT 1 FROM ${syncPicks} WHERE ${syncPicks.connectionId} = ${connections.id} AND ${syncPicks.feed} = ${picked.feed} AND ${syncPicks.place} = ${picked.place})`.mapWith(
              Boolean
            ),
    })
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
 * its places, one in a place's alphabet; on a shared connection, with a
 * sync of picked places, a place an admin picked on it (`picked`).
 */
const mayRead = (
  connection: Connection,
  sync: SyncManifest,
  place: string,
  picked: boolean
): boolean => {
  if (connection.scope !== "personal") {
    return sync.places === "picked" && picked;
  }
  switch (sync.places) {
    case "own": {
      return place === ownPlace;
    }
    case "listed": {
      return syncPlaceSchema.safeParse(place).success;
    }
    case "picked": {
      return false;
    }
    default: {
      return sync.places satisfies never;
    }
  }
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
  if (!parsed.success || "choices" in parsed.data) {
    throw syncErrors.create("sync.provider_failed");
  }
  if ("places" in parsed.data) {
    return parsed.data;
  }
  throw failureError(parsed.data.failure);
};

/** The places to pick a connector's answer holds, or the error it stands for. */
const choicesOf = (result: unknown): SyncChoices => {
  const parsed = syncPlacesResultSchema.safeParse(result);
  if (!parsed.success || "places" in parsed.data) {
    throw syncErrors.create("sync.provider_failed");
  }
  if ("choices" in parsed.data) {
    return parsed.data;
  }
  throw failureError(parsed.data.failure);
};

/**
 * The connection `connectionId` and its connector's sync `feed`, if it may
 * be read: a native connection, not disconnected, of the connector's own
 * provider; with whether `place` is picked on it.
 */
const syncOf = async (
  env: Env,
  connectionId: string,
  feed: string,
  place: string | null = null
) => {
  const found = await connectionOf(
    env,
    connectionId,
    place === null ? null : { feed, place }
  );
  const connection = found?.connection;
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
  return { connection, connector, sync, picked: found?.picked === true };
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
  params: Record<string, string | null>
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
  const { connectionId, feed, place, cursor } = syncErrors.parse(
    "sync.invalid",
    syncPageRequestSchema,
    request
  );
  const found = await syncOf(env, connectionId, feed, place);
  if (!mayRead(found.connection, found.sync, place, found.picked)) {
    throw syncErrors.create("sync.place_refused");
  }
  return pageOf(
    await sendToSync(env, found, place, syncMethod, {
      name: feed,
      place,
      cursor,
    })
  );
};

/** The places picked on a shared connection for its sync `feed`. */
const picksOf = async (
  env: Env,
  connectionId: string,
  feed: string
): Promise<Set<string>> => {
  const rows = await drizzle(env.DB)
    .select({ place: syncPicks.place })
    .from(syncPicks)
    .where(
      and(eq(syncPicks.connectionId, connectionId), eq(syncPicks.feed, feed))
    );
  return new Set(rows.map(({ place }) => place));
};

/**
 * One read of the places a shared connection's sync of picked places can
 * read, from `cursor` on, as its connector lists what the connected
 * account sees.
 */
const choicesRead = async (
  env: Env,
  found: Awaited<ReturnType<typeof syncOf>>,
  feed: string,
  cursor: string | null
): Promise<SyncChoices> =>
  choicesOf(
    await sendToSync(env, found, ownPlace, syncPlacesMethod, {
      name: feed,
      cursor,
    })
  );

/**
 * The places of a connection's sync, each a source of its own: `own` for
 * a sync of the whole account; the places a sync lists of its own account
 * (`places: "listed"`), read from the provider, a read at a time from
 * `cursor` when the list is longer than one read takes; on a shared
 * connection, of a sync of picked places, those picked that its connector
 * still lists, so a place unpicked or no longer seen is dropped, and none
 * of any other sync.
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
  const shared = found.connection.scope !== "personal";
  if (shared !== (found.sync.places === "picked")) {
    return { places: [], cursor: null };
  }
  if (found.sync.places === "own") {
    return { places: [ownPlace], cursor: null };
  }
  if (found.sync.places === "listed") {
    return placesOf(
      await sendToSync(env, found, ownPlace, syncPlacesMethod, {
        name: feed,
        cursor,
      })
    );
  }
  const listed = await choicesRead(env, found, feed, cursor);
  const picks = await picksOf(env, connectionId, feed);
  return {
    places: listed.choices
      .map(({ place }) => place)
      .filter((place) => picks.has(place)),
    cursor: listed.cursor,
  };
};

/**
 * Refuses, and audits the refusal, unless `person` is one of the company's
 * admins: never Grasp staff, who don't decide what a client's connections
 * bring in.
 */
const refuseUnlessAdmin = async (
  env: Env,
  person: ConnectionPerson,
  connectionId: string,
  feed: string
): Promise<void> => {
  let reason: "connection.staff_not_allowed" | "role.forbidden" | undefined;
  if (person.staff) {
    reason = "connection.staff_not_allowed";
  } else if (!isAdmin(person.role)) {
    reason = "role.forbidden";
  }
  if (reason === undefined) {
    return;
  }
  await auditRefusal(
    env,
    person,
    "connection.sync_places",
    { feed, outcome: "refused", reason },
    connectionId
  );
  throw reason === "role.forbidden"
    ? roleErrors.create("role.forbidden")
    : connectionErrors.create("connection.staff_not_allowed");
};

/**
 * The connection and its sync `feed`, if an admin may pick its places: a
 * shared connection, not disconnected, whose sync reads picked places.
 */
const pickableOf = async (env: Env, connectionId: string, feed: string) => {
  const found = await syncOf(env, connectionId, feed);
  if (found.connection.scope !== "shared") {
    throw syncErrors.create("sync.not_shared");
  }
  if (found.sync.places !== "picked") {
    throw syncErrors.create("sync.place_refused");
  }
  return found;
};

/**
 * One read of the places an admin may pick for a shared connection's sync,
 * as its connector lists what the connected account sees, from `cursor`
 * on, each with its name and whether it is picked. For the company's
 * admins alone.
 */
export const syncPlaceChoices = async (
  env: Env,
  request: unknown
): Promise<SyncPlaceChoices> => {
  const { person, connectionId, feed, cursor } = syncErrors.parse(
    "sync.invalid",
    syncPlaceChoicesRequestSchema,
    request
  );
  await refuseUnlessAdmin(env, person, connectionId, feed);
  const found = await pickableOf(env, connectionId, feed);
  const listed = await choicesRead(env, found, feed, cursor);
  const picks = await picksOf(env, connectionId, feed);
  return {
    choices: listed.choices.map((choice) => ({
      ...choice,
      picked: picks.has(choice.place),
    })),
    cursor: listed.cursor,
  };
};

/**
 * Sets the places a shared connection's sync reads to `places`, as one of
 * the company's admins picked them: the whole set, replacing the one
 * before, with one audit event (how many places, how many came and went)
 * in the same batch. The same set again changes and records nothing. A
 * place no longer picked is refused from the next read on, and is no
 * longer among the sync's places, so core's sync run drops it and erases
 * what it brought.
 */
export const pickSyncPlaces = async (
  env: Env,
  request: unknown
): Promise<{ places: string[] }> => {
  const { person, connectionId, feed, places } = syncErrors.parse(
    "sync.invalid",
    pickSyncPlacesSchema,
    request
  );
  await refuseUnlessAdmin(env, person, connectionId, feed);
  await pickableOf(env, connectionId, feed);
  const before = await picksOf(env, connectionId, feed);
  const after = new Set(places);
  const added = places.filter((place) => !before.has(place)).length;
  const removed = [...before].filter((place) => !after.has(place)).length;
  if (added === 0 && removed === 0) {
    return { places };
  }
  const db = drizzle(env.DB);
  const ofSync = and(
    eq(syncPicks.connectionId, connectionId),
    eq(syncPicks.feed, feed)
  );
  // One value, so the set's size is bounded by D1's, not a statement's
  // bound parameters (`syncPicksSchema`).
  const picked = sql`(SELECT value FROM json_each(${JSON.stringify(places)}))`;
  await recordEvents(
    env,
    [
      connectionEvent(person, "connection.sync_places", connectionId, {
        feed,
        outcome: "ok",
        places: places.length,
        added,
        removed,
      }),
    ],
    [
      db
        .delete(syncPicks)
        .where(and(ofSync, sql`${syncPicks.place} NOT IN ${picked}`)),
      db
        .insert(syncPicks)
        .select(
          db
            .select({
              connectionId: sql<string>`${connectionId}`.as("connection_id"),
              feed: sql<string>`${feed}`.as("feed"),
              place: sql<string>`value`.as("place"),
              pickedAt: sql<Date>`${Date.now()}`.as("picked_at"),
            })
            .from(sql`json_each(${JSON.stringify(places)})`)
            // SQLite reads `ON CONFLICT` after a bare `SELECT … FROM` as a
            // join's: a `WHERE` ends the `SELECT` (sqlite.org/lang_upsert.html,
            // "Parsing Ambiguity").
            .where(sql`true`)
        )
        .onConflictDoNothing(),
    ]
  );
  return { places };
};
