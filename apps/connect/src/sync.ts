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
import { createAuditEvent } from "@grasp-os/shared/audit";
import {
  connectErrors,
  connectionErrors,
  connectionOwnersMax,
} from "@grasp-os/shared/connect";
import type { ConnectionPerson } from "@grasp-os/shared/connect";
import type { Json } from "@grasp-os/shared/json";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import {
  ownPlace,
  pickSyncPlacesSchema,
  syncErrors,
  syncPageRequestSchema,
  syncPlaceChoicesRequestSchema,
  syncPlaceSchema,
  syncPlacesRequestSchema,
  syncSourcesRequestSchema,
} from "@grasp-os/shared/sync";
import type {
  SyncChoices,
  SyncPage,
  SyncPlaceChoices,
  SyncPlaces,
  SyncSource,
  SyncSourcePage,
} from "@grasp-os/shared/sync";
import { and, asc, eq, gt, not, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { nativeConnector } from "./bundled-connectors.ts";
import { auditRefusal, connectionEvent } from "./connection-audit.ts";
import type { Connection } from "./connections.ts";
import { syncServer } from "./connectors.ts";
import { auditOutbox, connections, syncPicks } from "./db/schema.ts";
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
  const found = await syncOf(env, connectionId, feed, place);
  if (!mayRead(found.connection, found.sync, place, found.picked)) {
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
  feed: string | null
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
    { ...(feed === null ? {} : { feed }), outcome: "refused", reason },
    connectionId
  );
  throw reason === "role.forbidden"
    ? roleErrors.create("role.forbidden")
    : connectionErrors.create("connection.staff_not_allowed");
};

/**
 * The sync of picked places of a shared connection's connector, if it has
 * one (`places: "picked"`): none for a personal connection, a connection
 * that is no native one, or a connector without one.
 */
const pickedFeedOf = async (
  env: Env,
  connectionId: string
): Promise<string | null> => {
  const found = await connectionOf(env, connectionId);
  const connection = found?.connection;
  if (
    connection === undefined ||
    connection.scope !== "shared" ||
    connection.status === "disconnected"
  ) {
    return null;
  }
  const manifest = nativeConnector(connection.server)?.manifest;
  if (manifest?.provider !== connection.provider) {
    return null;
  }
  const [feed] = Object.entries(manifest.syncs ?? {}).flatMap(([name, sync]) =>
    sync.places === "picked" ? [name] : []
  );
  return feed ?? null;
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
 * `pickableOf`, with every refusal recorded in the audit log as an
 * admin's refused pick, as the refusals of who may pick are.
 */
const pickableOrRefused = async (
  env: Env,
  person: ConnectionPerson,
  connectionId: string,
  feed: string
) => {
  try {
    return await pickableOf(env, connectionId, feed);
  } catch (error) {
    const reason = syncErrors.codeOf(error);
    if (reason !== undefined) {
      await auditRefusal(
        env,
        person,
        "connection.sync_places",
        { feed, outcome: "refused", reason },
        connectionId
      );
    }
    throw error;
  }
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
): Promise<SyncPlaceChoices | null> => {
  const { person, connectionId, feed, cursor } = syncErrors.parse(
    "sync.invalid",
    syncPlaceChoicesRequestSchema,
    request
  );
  await refuseUnlessAdmin(env, person, connectionId, feed ?? null);
  const sync = feed ?? (await pickedFeedOf(env, connectionId));
  if (sync === null) {
    return null;
  }
  const found = await pickableOrRefused(env, person, connectionId, sync);
  const listed = await choicesRead(env, found, sync, cursor);
  const picks = await picksOf(env, connectionId, sync);
  return {
    feed: sync,
    choices: listed.choices.map((choice) => ({
      ...choice,
      picked: picks.has(choice.place),
    })),
    picks: [...picks],
    cursor: listed.cursor,
  };
};

/**
 * Sets the places a shared connection's sync reads to `places`, as one of
 * the company's admins picked them, from the picks their page started
 * from (`from`): the whole set, replacing the one before, with one audit
 * event (how many places, how many came and went) in the same batch, and
 * only while the picks held are still `from`; else refused
 * (`sync.picks_changed`), with nothing changed. The same set again
 * changes and records nothing. A place no longer picked is refused from
 * the next read on, and is no longer among the sync's places, so core's
 * sync run drops it and erases what it brought.
 */
export const pickSyncPlaces = async (
  env: Env,
  request: unknown
): Promise<{ places: string[] }> => {
  const { person, connectionId, feed, from, places } = syncErrors.parse(
    "sync.invalid",
    pickSyncPlacesSchema,
    request
  );
  await refuseUnlessAdmin(env, person, connectionId, feed);
  await pickableOrRefused(env, person, connectionId, feed);
  const db = drizzle(env.DB);
  const changed = async (): Promise<never> => {
    await auditRefusal(
      env,
      person,
      "connection.sync_places",
      { feed, outcome: "refused", reason: "sync.picks_changed" },
      connectionId
    );
    throw syncErrors.create("sync.picks_changed");
  };
  // One value each, so a set's size is bounded by D1's, not a statement's
  // bound parameters (`syncPicksSchema`).
  const asked = JSON.stringify(places);
  const started = JSON.stringify(from);
  const ofSync = sql`${syncPicks.connectionId} = ${connectionId} AND ${syncPicks.feed} = ${feed}`;
  const held = sql`(SELECT ${syncPicks.place} FROM ${syncPicks} WHERE ${ofSync})`;
  // The picks held are exactly the ones the admin's page started from.
  const unchanged = sql`(SELECT count(*) FROM ${held}) = ${from.length} AND NOT EXISTS (SELECT 1 FROM ${syncPicks} WHERE ${ofSync} AND ${syncPicks.place} NOT IN (SELECT value FROM json_each(${started})))`;
  const after = new Set(places);
  const same =
    from.length === places.length && from.every((place) => after.has(place));
  if (same) {
    // Nothing to change: still, never answer a page left open as if
    // what it shows were what is held.
    const now = await db
      .select({ unchanged: sql<number>`${unchanged}` })
      .from(sql`(SELECT 1)`)
      .get();
    if (now?.unchanged !== 1) {
      await changed();
    }
    return { places };
  }
  // What came and went, counted in the same transaction as the write, from
  // the picks it replaces.
  const added = sql`(SELECT count(*) FROM json_each(${asked}) WHERE value NOT IN ${held})`;
  const removed = sql`(SELECT count(*) FROM ${held} AS kept WHERE kept.place NOT IN (SELECT value FROM json_each(${asked})))`;
  const event = createAuditEvent(
    connectionEvent(person, "connection.sync_places", connectionId, {
      feed,
      outcome: "ok",
      places: places.length,
      added: 0,
      removed: 0,
    }),
    "connect"
  );
  // The change is made only once its event is written, and its event only
  // while the picks are the ones the page started from: one transaction.
  const recorded = sql`EXISTS (SELECT 1 FROM ${auditOutbox} WHERE ${auditOutbox.id} = ${event.id})`;
  const [written] = await db.batch([
    db
      .insert(auditOutbox)
      .select(
        db
          .select({
            id: sql<string>`${event.id}`.as("id"),
            event:
              sql<string>`json_set(${JSON.stringify(event)}, '$.detail.added', ${added}, '$.detail.removed', ${removed})`.as(
                "event"
              ),
            createdAt: sql<Date>`${Date.now()}`.as("created_at"),
          })
          .from(sql`(SELECT 1)`)
          .where(unchanged)
      )
      .returning({ id: auditOutbox.id }),
    db
      .delete(syncPicks)
      .where(
        and(
          eq(syncPicks.connectionId, connectionId),
          eq(syncPicks.feed, feed),
          sql`${syncPicks.place} NOT IN (SELECT value FROM json_each(${asked}))`,
          recorded
        )
      ),
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
          .from(sql`json_each(${asked})`)
          // A `WHERE` also ends the `SELECT`, so SQLite reads `ON CONFLICT`
          // as the insert's (sqlite.org/lang_upsert.html, "Parsing
          // Ambiguity").
          .where(recorded)
      )
      .onConflictDoNothing(),
  ]);
  if (written.length === 0) {
    await changed();
  }
  return { places };
};

/**
 * A page of the syncs core's sync run reads (GRA-1758), by connection ID
 * after `after`: each sync of each active native connection whose
 * connector is for the connection's provider, with its kind and how it
 * reads (`listSyncPlaces`). A person's own connection, of someone whose
 * erasure hasn't begun: its syncs of the whole account (`own`) and of
 * places it lists (`listed`). A shared connection: its syncs of places
 * an admin picks (`picked`), with no person, as it has none (GRA-1719).
 * Neither kind ever the other's syncs (`mayRead`). A page holds at most
 * `connectionOwnersMax` connections, as connect's other pages of
 * connections for core.
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
        eq(connections.serverKind, "native"),
        eq(connections.status, "active"),
        or(
          eq(connections.scope, "shared"),
          and(
            eq(connections.scope, "personal"),
            not(erasureBegan(sql`${connections.ownerUserId}`))
          )
        ),
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
      if (manifest?.provider !== provider) {
        return [];
      }
      // A shared connection has no person, and syncs only picked places;
      // a person's own never syncs them.
      const shared = ownerUserId === null;
      return Object.entries(manifest.syncs ?? {}).flatMap(
        ([feed, sync]): SyncSource[] =>
          (sync.places === "picked") === shared
            ? [
                {
                  connectionId: id,
                  ownerUserId,
                  provider,
                  tenant,
                  // As its items' readers name it, and core's reading side
                  // (connections.ts `personalAccounts`): Google by the
                  // verified address, Microsoft by the object ID.
                  account: provider === "google" ? accountEmail : accountId,
                  feed,
                  kind: sync.kind,
                  places: sync.places,
                },
              ]
            : []
      );
    }
  );
  return {
    sources,
    next: rows.length < connectionOwnersMax ? null : (rows.at(-1)?.id ?? null),
  };
};
