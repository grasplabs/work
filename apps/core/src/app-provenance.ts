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
// way (`workflow:<id>` in the graph). So does an App's grant on such a
// workflow: following its runs (`read`) brings the workflow's output into
// the App, and starting it (`start`) sends the App's input into the
// workflow too, from where its store grants carry it on. A store's own
// grants (a store as subject: connections and collections) are its
// owner's sources, or, for a business store no App owns, the store's,
// read by whoever holds it. Once granted counts for
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
// Beyond the Apps asked about. A batch shares one walk; when its union
// trips this cap, each App the cap left unresolved is walked again on its
// own, with a cap of its own (`reachedThroughCalls`), so asking about many
// Apps at once doesn't hide one that passes alone.
const maxReached = 500;
// Those walks again share one budget, whatever the number of Apps asked
// about: this many levels that still had to be queried (each node's edges
// are queried once a request, `Walked`), and this many nodes expanded.
// Past it, the Apps not yet walked, and the rest of the walk it ran out
// in, stay unresolved (`app:*`).
const maxRetryLevels = 2 * maxDepth;
const maxRetryNodes = 20 * maxReached;

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

/** A node's edges, as `edgesOf` finds them. */
interface Edges {
  edges: { from: string; to: string }[];
  unowned: { holder: string; store: string; business: boolean }[];
}

/**
 * What one request has queried of the graph, shared by all its walks: a
 * node's edges and whether an App has a row don't change within it, so
 * each is queried once, however many walks reach it.
 */
interface Walked {
  edges: Map<string, Edges>;
  known: Map<string, boolean>;
}

/**
 * The edges of one level of the graph of calls between Apps, from and to
 * `frontier` (its Apps and its workflows), as `reachedThroughCalls`
 * follows them: each `from` may hold the data of `to`. And what a store
 * grant names that no App owns, by the node that holds it: a business
 * store (`business`), or a store that exists nowhere. By node of the
 * frontier: each node's are those it alone would have found.
 */
const edgesOf = async (
  env: Env,
  frontier: { apps: AppId[]; workflows: string[] }
): Promise<Map<string, Edges>> => {
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
  const [called, writers, bound, consumed, served, run] = await Promise.all([
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
    // Grants ever given to an App on an independent workflow, either end
    // in the frontier.
    db
      .select({
        app: permissions.subjectId,
        workflow: permissions.objectId,
        actions: permissions.actions,
      })
      .from(permissions)
      .where(
        and(
          eq(permissions.subjectType, "app"),
          eq(permissions.objectType, "workflow"),
          isNotNull(permissions.grantedAt),
          or(
            inList(permissions.subjectId, frontierApps),
            inList(permissions.objectId, workflows)
          )
        )
      ),
  ]);
  const found = new Map<string, Edges>(
    [...frontierApps, ...workflows.map(workflowNode)].map((node) => [
      node,
      { edges: [], unowned: [] },
    ])
  );
  // A row is the node's whose ID matched it: an App's as the frontier
  // names it, before `appNode`.
  const keyOf = (type: string, id: string): string =>
    type === "workflow" ? workflowNode(id) : id;
  const link = (
    of: string[],
    ...edges: { from: string; to: string }[]
  ): void => {
    for (const key of of) {
      found.get(key)?.edges.push(...edges);
    }
  };
  for (const { from, to } of called) {
    link([from], { from: appNode(from), to: appNode(to) });
  }
  for (const { from, to } of writers) {
    link([from], { from: appNode(from), to: appNode(to) });
  }
  for (const { caller, callee: to } of bound) {
    const [a, b] = [appNode(caller), appNode(to)];
    link([caller, to], { from: a, to: b }, { from: b, to: a });
  }
  const nodeOf = (type: string, id: string): string =>
    type === "workflow" ? workflowNode(id) : appNode(id);
  for (const { type, consumer, store, owner, business } of consumed) {
    const holder = nodeOf(type, consumer);
    const key = keyOf(type, consumer);
    if (owner === null) {
      // A business store no App owns is a source, not a node: nothing
      // writes into it but whoever holds a grant on it, since a store grant
      // needs a store an App owns (permissions.ts `requireStoreObject`) and
      // sealing claims the store for its App (`claimStore`). Should
      // anything else come to write into one, it must become a node of the
      // graph, so that what one holder wrote reaches the others.
      found
        .get(key)
        ?.unowned.push({ holder, store, business: business !== null });
    } else {
      const to = appNode(owner);
      link([key], { from: holder, to }, { from: to, to: holder });
    }
  }
  for (const { type, consumer, owner } of served) {
    const holder = nodeOf(type, consumer);
    const to = appNode(owner);
    link([owner], { from: holder, to }, { from: to, to: holder });
  }
  for (const { app, workflow, actions } of run) {
    const [from, to] = [appNode(app), workflowNode(workflow)];
    const of = [app, workflowNode(workflow)];
    // Following its runs brings its output in; starting it sends input out.
    link(of, { from, to });
    if (actionsSchema.parse(JSON.parse(actions)).includes("start")) {
      link(of, { from: to, to: from });
    }
  }
  return found;
};

/**
 * The edges of `nodes`, querying only those of the nodes `walked` doesn't
 * hold yet, if `mayQuery` lets it. Undefined when it would have to query
 * and may not.
 */
const edgesThrough = async (
  env: Env,
  walked: Walked,
  nodes: readonly string[],
  mayQuery: () => boolean
): Promise<Edges | undefined> => {
  const missing = nodes.filter((node) => !walked.edges.has(node));
  if (missing.length > 0) {
    if (!mayQuery()) {
      return undefined;
    }
    const found = await edgesOf(env, {
      // An ID an edge names that isn't an App's shape can't be one: it
      // doesn't resolve (`walk`), and has no edges of its own.
      apps: missing.flatMap((id) => {
        const app = appIdSchema.safeParse(id);
        return app.success ? [app.data] : [];
      }),
      workflows: missing.flatMap((id) =>
        id.startsWith(workflowPrefix) ? [id.slice(workflowPrefix.length)] : []
      ),
    });
    for (const node of missing) {
      walked.edges.set(node, found.get(node) ?? { edges: [], unowned: [] });
    }
  }
  const of = nodes.map((node) => walked.edges.get(node));
  return {
    edges: of.flatMap((one) => one?.edges ?? []),
    unowned: of.flatMap((one) => one?.unowned ?? []),
  };
};

/** What the walks again of a batch may still spend (`maxRetryLevels`). */
interface Budget {
  levels: number;
  nodes: number;
}

/**
 * One walk of `reachedThroughCalls` for all of `apps` at once, and whether
 * it stopped at the width cap. It spends of `budget`, and stops where that
 * runs out, as at a cap.
 */
const walk = async (
  env: Env,
  walked: Walked,
  apps: readonly AppId[],
  budget: Budget
): Promise<{ reach: Map<AppId, Reach>; capped: boolean }> => {
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
    if (frontier.length > budget.nodes) {
      break;
    }
    // oxlint-disable-next-line no-await-in-loop -- one level at a time
    const level = await edgesThrough(env, walked, frontier, () => {
      budget.levels -= 1;
      return budget.levels >= 0;
    });
    if (level === undefined) {
      break;
    }
    budget.nodes -= frontier.length;
    depth += 1;
    for (const node of frontier) {
      explored.add(node);
    }
    const { edges, unowned } = level;
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
  const capped =
    frontier.length > 0 &&
    explored.size + frontier.length > apps.length + maxReached;
  const unexpanded = new Set(frontier);
  // Every App an edge reached must be one: a binding's target without a
  // row (or of no App's shape) fails closed.
  const unknown = [...explored].filter(
    (id) => !(id.startsWith(workflowPrefix) || walked.known.has(id))
  );
  if (unknown.length > 0) {
    const rows = await drizzle(env.DB)
      .select({ id: appsTable.id })
      .from(appsTable)
      .where(inList(appsTable.id, unknown));
    const found = new Set(rows.map(({ id }) => id));
    for (const id of unknown) {
      walked.known.set(id, found.has(id));
    }
  }
  const reach = new Map<AppId, Reach>(
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
          (isApp && (id === app || walked.known.get(id) === true))
        ) {
          nodes.add(id);
        } else {
          unresolved.add(sourceId("app", id));
        }
      }
      return [app, { nodes, unresolved, stores }];
    })
  );
  return { reach, capped };
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
  const walked: Walked = { edges: new Map(), known: new Map() };
  const { reach, capped } = await walk(env, walked, apps, {
    levels: Infinity,
    nodes: Infinity,
  });
  if (!capped || apps.length === 1) {
    return reach;
  }
  // The batch's union tripped the cap: walk each App it left unresolved
  // again on its own, as if asked about alone, one after another so each
  // finds what the others queried, within one budget for them all. One
  // the budget doesn't reach keeps what the batch found: `app:*`.
  const again = apps.filter(
    (app) => reach.get(app)?.unresolved.has(sourceId("app", "*")) === true
  );
  const budget: Budget = { levels: maxRetryLevels, nodes: maxRetryNodes };
  for (const app of again) {
    if (budget.levels < 0 || budget.nodes <= 0) {
      break;
    }
    // oxlint-disable-next-line no-await-in-loop -- each finds the others' edges
    const one = await walk(env, walked, [app], budget);
    for (const [walkedApp, of] of one.reach) {
      reach.set(walkedApp, of);
    }
  }
  return reach;
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
  const storeIds = [
    ...new Set([...reach.values()].flatMap(({ stores }) => [...stores])),
  ];
  const sourceGrant = and(
    isNotNull(permissions.grantedAt),
    inArray(permissions.objectType, ["connection", "collection"])
  );
  const [rows, storeRows] = await Promise.all([
    all.length === 0
      ? []
      : drizzle(env.DB)
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
              sourceGrant
            )
          ),
    // A store's own grants: of the stores the Apps reached own, and of the
    // business stores they were granted.
    all.length === 0
      ? []
      : drizzle(env.DB)
          .select({
            store: permissions.subjectId,
            owner: sdkStoreOwners.appId,
            object: permissions.objectType,
            id: permissions.objectId,
            actions: permissions.actions,
          })
          .from(permissions)
          .leftJoin(
            sdkStoreOwners,
            eq(sdkStoreOwners.storeId, permissions.subjectId)
          )
          .where(
            and(
              eq(permissions.subjectType, "store"),
              or(
                inList(sdkStoreOwners.appId, allApps),
                inList(permissions.subjectId, storeIds)
              ),
              sourceGrant
            )
          ),
  ]);
  const own = new Map(
    all.map((node) => [
      node,
      { connected: new Set<string>(), read: new Set<string>() },
    ])
  );
  const add = (
    of: { connected: Set<string>; read: Set<string> } | undefined,
    { object, id, actions }: { object: string; id: string; actions: string }
  ): void => {
    if (object === "connection") {
      of?.connected.add(id);
    } else if (actionsSchema.parse(JSON.parse(actions)).includes("read")) {
      of?.read.add(id);
    }
  };
  for (const row of rows) {
    const { type, app } = row;
    add(own.get(type === "workflow" ? workflowNode(app) : appNode(app)), row);
  }
  // A business store's own grants, by store, for whoever holds it.
  const ofStore = new Map(
    storeIds.map((id) => [
      id,
      { connected: new Set<string>(), read: new Set<string>() },
    ])
  );
  for (const row of storeRows) {
    add(
      row.owner === null ? ofStore.get(row.store) : own.get(appNode(row.owner)),
      row
    );
  }
  const granted = new Map(
    apps.map((app) => {
      const reached = [
        ...[...(reach.get(app)?.nodes ?? [app])].map((node) => own.get(node)),
        ...[...(reach.get(app)?.stores ?? [])].map((id) => ofStore.get(id)),
      ];
      return [
        app,
        {
          connected: new Set(
            reached.flatMap((of) => [...(of?.connected ?? [])])
          ),
          read: new Set(reached.flatMap((of) => [...(of?.read ?? [])])),
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
