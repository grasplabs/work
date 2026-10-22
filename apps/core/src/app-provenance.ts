import type { ConnectionOwner } from "@grasp-os/shared/connect";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { canBuild, isAdmin } from "@grasp-os/shared/roles";
import type { Role } from "@grasp-os/shared/roles";
import { and, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { connectionOwnersOf } from "./connections.ts";
import {
  appResourceBindings,
  apps as appsTable,
  businessStoreMembers,
  businessStores,
  permissions,
  sdkStoreOwners,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { collectionTeams, collections } from "./db/knowledge/schema.ts";
import { mayRead } from "./knowledge/access.ts";
import type { CollectionAccess, PersonAccess } from "./knowledge/access.ts";

// Provenance on sharing. An App keeps what it reads (in its storage, its
// workflows' state, what its screens show), so sharing it must not reach
// anyone who couldn't read that where it comes from.
//
// What an App may have read: every connection it was ever granted, and
// every collection it was ever granted to read; and, through calls between
// Apps, what the Apps it was ever granted to call may have read (their
// answers carry it), and what the Apps ever granted to write into it may
// have read (their input carries it), whatever the depth
// (`reachedThroughCalls`). Calls between Apps are v1 grants on another
// App's exports; sealed app bindings an admin approved (resource-apps.ts),
// each counted both ways, since the functions an App declares live in its
// releases, not the binding, so any call may write; and store grants on
// another App's store (store-operations.ts), both ways too, since a store's
// actions can't tell a read from a write. A workflow (an independent
// resource) holding such a store grant links the App to that workflow's own
// sources, and through it to every other App it holds a grant on, the same
// way (`workflow:<id>` in the graph). Once granted counts for
// good, revoked or not: the App may still hold what it read. An app
// binding to an App with no row, or a store grant on a store that exists
// nowhere, fails closed, as an unresolved source (`app:<id>`, `store:<id>`),
// and so does a graph past the caps below (`app:*`). A store grant on a
// business store no App owns (`business_stores` only) is a source of its
// own: it is read by whoever manages the store, the only access such a
// store has (data-stores.ts): admins, its creator and the people and teams
// it is shared with, while their role builds. Who may read
// each: a personal connection (such as a mailbox) only its owner; a shared
// connection everyone in the organization, who may all use it; a
// collection whoever Knowledge lets read it now (`mayRead`, the rule of
// knowledge/access.ts), so a collection whose access narrows reaches fewer
// people from then on. A granted source that doesn't resolve (connect
// doesn't know the connection, Knowledge has no such collection) fails
// closed: nobody reads it but the App's owner and admins, who aren't
// checked, since what the App read of it can't be placed. So does the
// Apps collection: it is open to everyone, but Knowledge shows each entry
// only to whoever may open its App, so its access says nothing of what
// the App read there. No App is given it now (permissions.ts
// `requireCollection`); one granted it before counts it unresolved.
//
// An App's code is treated as free of provenance, but for its AGENTS.md:
// that is written from what the App's agents read, and is read only by
// those who may open the App (its builders, and its users through the
// Apps collection), so it is under the App's sources like its data. Any
// other file is taken to hold no data, which nothing checks: builders
// must not put data into code. A blueprint copy (app-blueprints.ts)
// doesn't inherit its source's provenance: it has no sources until an
// admin grants its requests, and its code is the source's, which is why
// its AGENTS.md isn't copied but starts as a stub.
//
// The sources are read once, and each person is decided in memory
// (`unreadableBy`), so checking a whole team costs a few queries, not a
// few per person.
//
// Sharing an App with a person, or with a team (each of its people now),
// is refused when anyone it would reach can't read one of its sources
// (app-members.ts). The same check runs on every call of someone whose
// role in the App comes from whom it is shared with (app-access.ts), so a
// person who joins a team later, or a source the App is granted after it
// was shared, reaches nobody who can't read it. The App's owner and the
// organization's admins aren't checked: they manage the App whatever it
// read.

/** A source as the audit log and refusals name it. */
const sourceId = (
  type: "connection" | "collection" | "app" | "store",
  id: string
): string => `${type}:${id}`;

/** What an App may have read, as `sourcesOf` finds it. */
export interface AppSources {
  connections: ConnectionOwner[];
  collections: (CollectionAccess & { id: string })[];
  /** Business stores no App owns, which the App was granted. */
  stores: BusinessStoreAccess[];
  /** Granted sources that don't resolve, as `sourceId` names them. */
  unresolved: string[];
}

/** Who manages a business store (data-stores.ts), and so reads it. */
export interface BusinessStoreAccess {
  id: string;
  ownerId: string;
  /** People and teams it is shared with, in role `manage`. */
  members: { type: "person" | "team"; id: string }[];
}

/**
 * A person, as provenance decides what they read: Knowledge's access, and
 * whether their role in the organization builds, which managing a store
 * needs.
 */
export interface Reader extends PersonAccess {
  builds: boolean;
}

/** A `Reader` from a role and teams, as the callers have them. */
export const readerOf = (
  userId: string,
  teamIds: string[],
  role: Role
): Reader => ({
  userId,
  teamIds,
  admin: isAdmin(role),
  builds: canBuild(role),
});

const actionsSchema = z.array(z.string());

/**
 * The graph of calls between Apps is walked this deep, and this wide, and
 * no further: it runs on every call of everyone an App is shared with. An
 * App past either cap is an unresolved source (`app:*`), so it fails closed.
 */
const maxDepth = 32;
const maxReached = 500;
// (Beyond the Apps asked about, which a batch's walk shares.)

/** A workflow's place in the graph, apart from any App's ID. */
const workflowPrefix = "workflow:";
const workflowNode = (id: string): string => `${workflowPrefix}${id}`;
/** An App's ID as a node: one that looks like a workflow's is no App. */
const appNode = (id: string): string =>
  id.startsWith(workflowPrefix) ? `invalid:${id}` : id;

/**
 * Who may read each of the collections `ids` now, as `mayRead` needs it.
 * The Apps collection is left out, so it doesn't resolve: its readers are
 * decided per entry, not by its access, so what an App granted it (before
 * permissions.ts refused that) read there can't be placed.
 */
const accessOf = async (
  env: Env,
  ids: string[]
): Promise<AppSources["collections"]> => {
  const db = drizzle(env.KNOWLEDGE);
  const [rows, shared] = await db.batch([
    db
      .select({
        id: collections.id,
        access: collections.access,
        owner: collections.owner,
      })
      .from(collections)
      .where(and(inList(collections.id, ids), ne(collections.source, "apps"))),
    db
      .select()
      .from(collectionTeams)
      .where(inList(collectionTeams.collectionId, ids)),
  ]);
  return rows.map((row) => ({
    ...row,
    teamIds: shared
      .filter(({ collectionId }) => collectionId === row.id)
      .map(({ teamId }) => teamId),
  }));
};

/** Adds `value` to the set of `at` in `map`. */
const note = (
  map: Map<string, Set<string>>,
  at: string,
  value: string
): void => {
  map.set(at, (map.get(at) ?? new Set()).add(value));
};

/** What `reachedThroughCalls` finds of each App. */
interface Reach {
  /** The nodes whose data it may hold (Apps, workflows), itself included. */
  nodes: Set<string>;
  /** Edges that don't resolve, as `sourceId` names them. */
  unresolved: Set<string>;
  /** Business stores no App owns, which a node it holds was granted. */
  stores: Set<string>;
}

/**
 * The edges of one level of the graph of calls between Apps, from and to
 * `frontier` (its Apps and its workflows), as `reachedThroughCalls`
 * follows them: each `from` may hold the data of `to`. And what a store
 * grant names that no App owns, by the node that holds it: a business
 * store (`business`), or a store that exists nowhere.
 */
const edgesOf = async (
  env: Env,
  frontier: { apps: AppId[]; workflows: string[] }
): Promise<{
  edges: { from: string; to: string }[];
  unowned: { holder: string; store: string; business: boolean }[];
}> => {
  const { apps: frontierApps, workflows } = frontier;
  const db = drizzle(env.DB);
  const everGranted = and(
    eq(permissions.subjectType, "app"),
    eq(permissions.objectType, "app"),
    isNotNull(permissions.grantedAt)
  );
  const callee = sql<string>`json_extract(${appResourceBindings.target}, '$.appId')`;
  // An App's or a workflow's (an independent resource's) grant on a store:
  // permissions.ts lets both name one.
  const storeGrant = and(
    inArray(permissions.subjectType, ["app", "workflow"]),
    eq(permissions.objectType, "store"),
    isNotNull(permissions.grantedAt)
  );
  const holds = or(
    and(
      eq(permissions.subjectType, "app"),
      inList(permissions.subjectId, frontierApps)
    ),
    and(
      eq(permissions.subjectType, "workflow"),
      inList(permissions.subjectId, workflows)
    )
  );
  const [called, writers, bound, consumed, served] = await Promise.all([
    // v1 grants on another App's exports: what it calls answers it.
    db
      .select({ from: permissions.subjectId, to: permissions.objectId })
      .from(permissions)
      .where(and(everGranted, inList(permissions.subjectId, frontierApps))),
    // And what may write into it sends it.
    db
      .select({ from: permissions.objectId, to: permissions.subjectId })
      .from(permissions)
      .where(
        and(
          everGranted,
          inList(permissions.objectId, frontierApps),
          // Anything beyond reading, as permissions.ts's changesThingsSql.
          sql`EXISTS (SELECT 1 FROM json_each(${permissions.actions}) WHERE value <> 'read')`
        )
      ),
    // Sealed app bindings ever approved, active or revoked, either end in
    // the frontier: counted both ways below.
    db
      .select({ caller: appResourceBindings.appId, callee })
      .from(appResourceBindings)
      .where(
        and(
          eq(appResourceBindings.kind, "app"),
          or(
            inList(appResourceBindings.appId, frontierApps),
            inList(callee, frontierApps)
          )
        )
      ),
    // Store grants ever given to a node of the frontier, with the store's
    // owning App, if any, and whether it is a business store at all.
    db
      .select({
        type: permissions.subjectType,
        consumer: permissions.subjectId,
        store: permissions.objectId,
        owner: sdkStoreOwners.appId,
        business: businessStores.id,
      })
      .from(permissions)
      .leftJoin(
        sdkStoreOwners,
        eq(sdkStoreOwners.storeId, permissions.objectId)
      )
      .leftJoin(businessStores, eq(businessStores.id, permissions.objectId))
      .where(and(storeGrant, holds)),
    // And those on a store an App of the frontier owns.
    db
      .select({
        type: permissions.subjectType,
        consumer: permissions.subjectId,
        owner: sdkStoreOwners.appId,
      })
      .from(permissions)
      .innerJoin(
        sdkStoreOwners,
        eq(sdkStoreOwners.storeId, permissions.objectId)
      )
      .where(and(storeGrant, inList(sdkStoreOwners.appId, frontierApps))),
  ]);
  const edges = [...called, ...writers].map(({ from, to }) => ({
    from: appNode(from),
    to: appNode(to),
  }));
  for (const { caller, callee: to } of bound) {
    const [a, b] = [appNode(caller), appNode(to)];
    edges.push({ from: a, to: b }, { from: b, to: a });
  }
  const nodeOf = (type: string, id: string): string =>
    type === "workflow" ? workflowNode(id) : appNode(id);
  const unowned: { holder: string; store: string; business: boolean }[] = [];
  for (const { type, consumer, store, owner, business } of consumed) {
    const holder = nodeOf(type, consumer);
    if (owner === null) {
      unowned.push({ holder, store, business: business !== null });
    } else {
      const to = appNode(owner);
      edges.push({ from: holder, to }, { from: to, to: holder });
    }
  }
  for (const { type, consumer, owner } of served) {
    const holder = nodeOf(type, consumer);
    const to = appNode(owner);
    edges.push({ from: holder, to }, { from: to, to: holder });
  }
  return { edges, unowned };
};

/**
 * The nodes (Apps, and workflows holding store grants) whose data each of
 * `apps` may hold through calls between Apps (app-calls.ts,
 * resource-apps.ts, store-operations.ts), itself included, following every
 * grant and binding ever given (`edgesOf`), as sources are, up to the
 * caps; and what of them doesn't resolve: a store that exists nowhere, an
 * App bound that has no row, or an App past the caps (`app:*`). A few
 * queries a level of the graph, both directions at once.
 */
const reachedThroughCalls = async (
  env: Env,
  apps: readonly AppId[]
): Promise<Map<AppId, Reach>> => {
  const holds = new Map<string, Set<string>>();
  const unresolvedAt = new Map<string, Set<string>>();
  const businessAt = new Map<string, Set<string>>();
  const explored = new Set<string>();
  let frontier = [...new Set<string>(apps)];
  let depth = 0;
  // A frontier left unexpanded at a cap stays in `frontier`.
  while (
    frontier.length > 0 &&
    depth < maxDepth &&
    explored.size + frontier.length <= apps.length + maxReached
  ) {
    depth += 1;
    for (const node of frontier) {
      explored.add(node);
    }
    // oxlint-disable-next-line no-await-in-loop -- one level at a time
    const { edges, unowned } = await edgesOf(env, {
      // An ID an edge names that isn't an App's shape can't be one: it
      // doesn't resolve (below), and has no edges of its own.
      apps: frontier.flatMap((id) => {
        const app = appIdSchema.safeParse(id);
        return app.success ? [app.data] : [];
      }),
      workflows: frontier.flatMap((id) =>
        id.startsWith(workflowPrefix) ? [id.slice(workflowPrefix.length)] : []
      ),
    });
    const next = new Set<string>();
    for (const { from, to } of edges) {
      note(holds, from, to);
      if (!explored.has(to)) {
        next.add(to);
      }
    }
    for (const { holder, store, business } of unowned) {
      if (business) {
        note(businessAt, holder, store);
      } else {
        note(unresolvedAt, holder, sourceId("store", store));
      }
    }
    frontier = [...next];
  }
  const unexpanded = new Set(frontier);
  // Every App an edge reached must be one: a binding's target without a
  // row (or of no App's shape) fails closed.
  const reachedApps = [...explored].filter(
    (id) => !id.startsWith(workflowPrefix)
  );
  const knownRows =
    reachedApps.length === 0
      ? []
      : await drizzle(env.DB)
          .select({ id: appsTable.id })
          .from(appsTable)
          .where(inList(appsTable.id, reachedApps));
  const known = new Set(knownRows.map(({ id }) => id));
  return new Map(
    apps.map((app) => {
      const reached = new Set<string>([app]);
      const queue: string[] = [app];
      for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
        for (const held of holds.get(at) ?? []) {
          if (!reached.has(held)) {
            reached.add(held);
            queue.push(held);
          }
        }
      }
      const unresolved = new Set<string>();
      const stores = new Set<string>();
      const nodes = new Set<string>();
      for (const id of reached) {
        for (const source of unresolvedAt.get(id) ?? []) {
          unresolved.add(source);
        }
        for (const store of businessAt.get(id) ?? []) {
          stores.add(store);
        }
        const isApp = appIdSchema.safeParse(id).success;
        if (unexpanded.has(id)) {
          unresolved.add(sourceId("app", "*"));
        } else if (
          id.startsWith(workflowPrefix) ||
          (isApp && (id === app || known.has(id)))
        ) {
          nodes.add(id);
        } else {
          unresolved.add(sourceId("app", id));
        }
      }
      return [app, { nodes, unresolved, stores }];
    })
  );
};

/** The business stores `ids`, with whom each is shared with to manage it. */
const businessStoresOf = async (
  env: Env,
  ids: string[]
): Promise<BusinessStoreAccess[]> => {
  const db = drizzle(env.DB);
  const [rows, shared] = await db.batch([
    db
      .select({ id: businessStores.id, ownerId: businessStores.ownerId })
      .from(businessStores)
      .where(inList(businessStores.id, ids)),
    db
      .select({
        storeId: businessStoreMembers.storeId,
        type: businessStoreMembers.memberType,
        id: businessStoreMembers.memberId,
      })
      .from(businessStoreMembers)
      .where(inList(businessStoreMembers.storeId, ids)),
  ]);
  return rows.map((row) => ({
    ...row,
    members: shared
      .filter(({ storeId }) => storeId === row.id)
      .map(({ type, id }) => ({ type, id })),
  }));
};

/**
 * The sources each of the Apps `apps` may have read, as they are now, and
 * those of the Apps whose data they may hold through calls between Apps
 * (`reachedThroughCalls`), in a few queries whatever their number: those
 * that follow the calls, one for all their permissions, one series of
 * pages to connect for all their connections, and one Knowledge batch for
 * all their collections.
 */
export const sourcesOfApps = async (
  env: Env,
  apps: readonly AppId[]
): Promise<Map<AppId, AppSources>> => {
  const reach =
    apps.length === 0
      ? new Map<AppId, Reach>()
      : await reachedThroughCalls(env, apps);
  const all = [...new Set([...reach.values()].flatMap((of) => [...of.nodes]))];
  const allApps = all.filter((id) => !id.startsWith(workflowPrefix));
  const allWorkflows = all.flatMap((id) =>
    id.startsWith(workflowPrefix) ? [id.slice(workflowPrefix.length)] : []
  );
  const rows =
    all.length === 0
      ? []
      : await drizzle(env.DB)
          .select({
            type: permissions.subjectType,
            app: permissions.subjectId,
            object: permissions.objectType,
            id: permissions.objectId,
            actions: permissions.actions,
          })
          .from(permissions)
          .where(
            and(
              or(
                and(
                  eq(permissions.subjectType, "app"),
                  inList(permissions.subjectId, allApps)
                ),
                and(
                  eq(permissions.subjectType, "workflow"),
                  inList(permissions.subjectId, allWorkflows)
                )
              ),
              isNotNull(permissions.grantedAt),
              inArray(permissions.objectType, ["connection", "collection"])
            )
          );
  const own = new Map(
    all.map((node) => [
      node,
      { connected: new Set<string>(), read: new Set<string>() },
    ])
  );
  for (const { type, app, object, id, actions } of rows) {
    const of = own.get(type === "workflow" ? workflowNode(app) : appNode(app));
    if (object === "connection") {
      of?.connected.add(id);
    } else if (actionsSchema.parse(JSON.parse(actions)).includes("read")) {
      of?.read.add(id);
    }
  }
  const granted = new Map(
    apps.map((app) => {
      const reached = [...(reach.get(app)?.nodes ?? [app])];
      return [
        app,
        {
          connected: new Set(
            reached.flatMap((of) => [...(own.get(of)?.connected ?? [])])
          ),
          read: new Set(
            reached.flatMap((of) => [...(own.get(of)?.read ?? [])])
          ),
        },
      ];
    })
  );
  const connectionIds = [
    ...new Set(
      [...granted.values()].flatMap(({ connected }) => [...connected])
    ),
  ];
  const collectionIds = [
    ...new Set([...granted.values()].flatMap(({ read }) => [...read])),
  ];
  const storeIds = [
    ...new Set([...reach.values()].flatMap(({ stores }) => [...stores])),
  ];
  const [owners, readable, managed] = await Promise.all([
    connectionIds.length === 0 ? [] : connectionOwnersOf(env, connectionIds),
    collectionIds.length === 0 ? [] : accessOf(env, collectionIds),
    storeIds.length === 0 ? [] : businessStoresOf(env, storeIds),
  ]);
  const ownerOf = new Map(owners.map((owner) => [owner.id, owner]));
  const accessById = new Map(readable.map((access) => [access.id, access]));
  const storeById = new Map(managed.map((store) => [store.id, store]));
  return new Map(
    [...granted].map(([app, { connected, read }]) => {
      const sources: AppSources = {
        connections: [],
        collections: [],
        stores: [],
        unresolved: [...(reach.get(app)?.unresolved ?? [])],
      };
      for (const id of connected) {
        const owner = ownerOf.get(id);
        if (owner === undefined) {
          sources.unresolved.push(sourceId("connection", id));
        } else {
          sources.connections.push(owner);
        }
      }
      for (const id of read) {
        const access = accessById.get(id);
        if (access === undefined) {
          sources.unresolved.push(sourceId("collection", id));
        } else {
          sources.collections.push(access);
        }
      }
      for (const id of reach.get(app)?.stores ?? []) {
        const store = storeById.get(id);
        if (store === undefined) {
          sources.unresolved.push(sourceId("store", id));
        } else {
          sources.stores.push(store);
        }
      }
      return [app, sources];
    })
  );
};

/** The sources `app` may have read, as they are now. */
export const sourcesOf = async (env: Env, app: AppId): Promise<AppSources> => {
  const sources = await sourcesOfApps(env, [app]);
  return (
    sources.get(app) ?? {
      connections: [],
      collections: [],
      stores: [],
      unresolved: [],
    }
  );
};

/** Whether an App has read from anything at all. */
export const hasSources = (sources: AppSources): boolean =>
  sources.connections.length > 0 ||
  sources.collections.length > 0 ||
  sources.stores.length > 0 ||
  sources.unresolved.length > 0;

/**
 * Whether `reader` manages `store`, as data-stores.ts decides it: an
 * admin, its creator, or someone it is shared with (or a team of theirs),
 * while their role in the organization builds.
 */
const managesStore = (reader: Reader, store: BusinessStoreAccess): boolean =>
  reader.admin ||
  (reader.builds &&
    (store.ownerId === reader.userId ||
      store.members.some(({ type, id }) =>
        type === "person" ? id === reader.userId : reader.teamIds.includes(id)
      )));

/**
 * The sources in `sources` that `reader` can't read, as
 * `connection:<id>`, `collection:<id>` and `store:<id>`; none when they
 * may read all.
 */
export const unreadableBy = (sources: AppSources, reader: Reader): string[] => [
  ...sources.connections.flatMap(({ id, ownerUserId }) =>
    ownerUserId === null || ownerUserId === reader.userId
      ? []
      : [sourceId("connection", id)]
  ),
  ...sources.collections.flatMap((collection) =>
    mayRead(reader, collection) ? [] : [sourceId("collection", collection.id)]
  ),
  ...sources.stores.flatMap((store) =>
    managesStore(reader, store) ? [] : [sourceId("store", store.id)]
  ),
  ...sources.unresolved,
];
