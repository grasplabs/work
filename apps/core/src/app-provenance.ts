import { collections } from "@grasp-os/brain/schema";
import type { ConnectionOwner } from "@grasp-os/shared/connect";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Role } from "@grasp-os/shared/roles";
import { and, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { storedTeamsOf, unreadableTeam } from "./brain-grant-teams.ts";
import { connectionOwnersOf } from "./connections.ts";
import {
  apps as appsTable,
  collectionTeams,
  permissions,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { mayRead } from "./knowledge/access.ts";
import type { CollectionAccess, PersonAccess } from "./knowledge/access.ts";

// Provenance on sharing. An App keeps what it reads (in its storage, its
// workflows' state, what its pages show), so sharing it must not reach
// anyone who couldn't read that where it comes from.
//
// What an App may have read: every connection it was ever granted, every
// collection it was ever granted to read, and every team a grant to read
// the Brain ever named (only its members may read what it recalled of
// one: brain-recall.ts); and, through grants on
// independent workflows, what those workflows may have read, and what
// another App holding a grant on one sent it, whatever the depth
// (`reachedThroughCalls`, `workflow:<id>` in the graph), each grant an
// edge each way its data can flow (`edgesOf`): following a workflow's runs
// (`read`) brings their output in; starting it (`start`) sends input in
// and brings its result back; sending its runs an event (`send`) sends
// data in; and a workflow granted to call an App's function (`call`)
// sends what it holds into the App's data and gets the function's answer
// back. An App's store is its own and no grant
// reaches another's (data-stores.ts), so stores add no edge. Once granted
// counts for good, revoked or not: the App may still hold what it read. An
// App the graph reaches that has no row fails closed, as an unresolved
// source (`app:<id>`), and so does a graph past the caps below (`app:*`).
// Who may read each: a personal connection (such as a mailbox) only its
// owner; a shared connection everyone in the organization, who may all use it; a
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
  type: "connection" | "collection" | "app" | "brain",
  id: string
): string => `${type}:${id}`;

/** What an App may have read, as `sourcesOf` finds it. */
export interface AppSources {
  connections: ConnectionOwner[];
  collections: (CollectionAccess & { id: string })[];
  /**
   * The teams a grant to read the Brain ever named (GRA-1842): what it
   * recalled of each, only that team's members may read.
   */
  brainTeams: string[];
  /** Granted sources that don't resolve, as `sourceId` names them. */
  unresolved: string[];
}

/** A person, as provenance decides what they read: Knowledge's access. */
export type Reader = PersonAccess;

/** A `Reader` from a role and teams, as the callers have them. */
export const readerOf = (
  userId: string,
  teamIds: string[],
  role: Role
): Reader => ({
  userId,
  teamIds,
  admin: isAdmin(role),
});

const actionsSchema = z.array(z.string());

/** The teams a stored `teams` value names; `unreadableTeam` for one that doesn't read as IDs. */
const teamsIn = (stored: string | null): string[] =>
  storedTeamsOf(stored) ?? [unreadableTeam];

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
  const [rows, shared] = await Promise.all([
    drizzle(env.KNOWLEDGE)
      .select({
        id: collections.id,
        access: collections.access,
        owner: collections.owner,
      })
      .from(collections)
      .where(and(inList(collections.id, ids), ne(collections.source, "apps"))),
    drizzle(env.DB)
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
}

/** A node's edges, as `edgesOf` finds them: each `from` may hold `to`'s data. */
type Edges = { from: string; to: string }[];

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
 * The edges of one level of the graph, from and to `frontier` (its Apps
 * and its workflows), as `reachedThroughCalls` follows them: each `from`
 * may hold the data of `to`. By node of the frontier: each node's are
 * those it alone would have found.
 */
const edgesOf = async (
  env: Env,
  frontier: { apps: AppId[]; workflows: string[] }
): Promise<Map<string, Edges>> => {
  const { apps: frontierApps, workflows } = frontier;
  // Grants ever given on an independent workflow, to an App or to another
  // workflow, either end in the frontier.
  const run = await drizzle(env.DB)
    .select({
      type: permissions.subjectType,
      subject: permissions.subjectId,
      workflow: permissions.objectId,
      actions: permissions.actions,
    })
    .from(permissions)
    .where(
      and(
        eq(permissions.objectType, "workflow"),
        isNotNull(permissions.grantedAt),
        or(
          and(
            eq(permissions.subjectType, "app"),
            inList(permissions.subjectId, frontierApps)
          ),
          and(
            eq(permissions.subjectType, "workflow"),
            inList(permissions.subjectId, workflows)
          ),
          and(
            inArray(permissions.subjectType, ["app", "workflow"]),
            inList(permissions.objectId, workflows)
          )
        )
      )
    );
  // Grants ever given to a workflow to call an App's functions, either
  // end in the frontier.
  const calls = await drizzle(env.DB)
    .select({ workflow: permissions.subjectId, app: permissions.objectId })
    .from(permissions)
    .where(
      and(
        eq(permissions.subjectType, "workflow"),
        eq(permissions.objectType, "app"),
        isNotNull(permissions.grantedAt),
        or(
          inList(permissions.objectId, frontierApps),
          inList(permissions.subjectId, workflows)
        )
      )
    );
  const found = new Map<string, Edges>(
    [...frontierApps, ...workflows.map(workflowNode)].map((node) => [node, []])
  );
  const link = (
    of: string[],
    ...edges: { from: string; to: string }[]
  ): void => {
    for (const key of of) {
      found.get(key)?.push(...edges);
    }
  };
  for (const { type, subject, workflow, actions } of run) {
    const isApp = type === "app";
    const holder = isApp ? appNode(subject) : workflowNode(subject);
    const to = workflowNode(workflow);
    const of = [isApp ? subject : workflowNode(subject), to];
    const granted = actionsSchema.parse(JSON.parse(actions));
    // Which way each action carries data, holder `from` holding `to`'s:
    // - any grant at all: the holder holds the workflow's data, as main
    //   always counted it (a grant of `send` alone brings nothing back,
    //   but loosening an existing sharing protection is not this rule's
    //   to do);
    // - `start`: the arguments go into the run (the workflow holds the
    //   starter's data), and what the run returns comes back;
    // - `read`: following its runs brings their output in;
    // - `send`: an event goes into its runs (the workflow holds the
    //   sender's).
    if (granted.length > 0) {
      link(of, { from: holder, to });
    }
    if (granted.includes("start") || granted.includes("send")) {
      link(of, { from: to, to: holder });
    }
  }
  for (const { workflow, app } of calls) {
    // `call`: what the workflow sends lands in the App's data (the App
    // holds the workflow's), and the function's answer comes back (the
    // workflow holds the App's).
    const [appAt, workflowAt] = [appNode(app), workflowNode(workflow)];
    link(
      [app, workflowAt],
      { from: appAt, to: workflowAt },
      { from: workflowAt, to: appAt }
    );
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
      walked.edges.set(node, found.get(node) ?? []);
    }
  }
  return nodes.flatMap((node) => walked.edges.get(node) ?? []);
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
  apps: readonly string[],
  budget: Budget
): Promise<{ reach: Map<string, Reach>; capped: boolean }> => {
  const holds = new Map<string, Set<string>>();
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
    const edges = await edgesThrough(env, walked, frontier, () => {
      budget.levels -= 1;
      return budget.levels >= 0;
    });
    if (edges === undefined) {
      break;
    }
    budget.nodes -= frontier.length;
    depth += 1;
    for (const node of frontier) {
      explored.add(node);
    }
    const next = new Set<string>();
    for (const { from, to } of edges) {
      note(holds, from, to);
      if (!explored.has(to)) {
        next.add(to);
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
  const reach = new Map<string, Reach>(
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
      const nodes = new Set<string>();
      for (const id of reached) {
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
      return [app, { nodes, unresolved }];
    })
  );
  return { reach, capped };
};

/**
 * The nodes (Apps, and the workflows between them) whose data each of
 * `apps` may hold through grants on workflows, itself included, following
 * every grant ever given (`edgesOf`), as sources are, up to the caps; and
 * what of them doesn't resolve: an App that has no row, or an App past the
 * caps (`app:*`). One query a level of the graph, both directions at once.
 */
const reachedThroughCalls = async (
  env: Env,
  apps: readonly string[]
): Promise<Map<string, Reach>> => {
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

/**
 * `sourcesOfApps` for nodes of the graph: Apps, by their IDs, and
 * workflows (`workflowNode`), each walked as an App is, from itself.
 */
const sourcesOfNodes = async (
  env: Env,
  apps: readonly string[],
  walked?: ReadonlyMap<string, Reach>
): Promise<Map<string, AppSources>> => {
  const reach =
    walked ??
    (apps.length === 0
      ? new Map<string, Reach>()
      : await reachedThroughCalls(env, apps));
  const all = [...new Set([...reach.values()].flatMap((of) => [...of.nodes]))];
  const allApps = all.filter((id) => !id.startsWith(workflowPrefix));
  const allWorkflows = all.flatMap((id) =>
    id.startsWith(workflowPrefix) ? [id.slice(workflowPrefix.length)] : []
  );
  const sourceGrant = and(
    isNotNull(permissions.grantedAt),
    or(
      inArray(permissions.objectType, ["connection", "collection"]),
      // A grant to read the Brain that names teams (only an App's does).
      and(eq(permissions.objectType, "platform"), isNotNull(permissions.teams))
    )
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
            teams: permissions.teams,
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
          );
  /** What one node was granted: connections, collections and teams. */
  interface Granted {
    connected: Set<string>;
    read: Set<string>;
    teams: Set<string>;
  }
  const own = new Map<string, Granted>(
    all.map((node) => [
      node,
      { connected: new Set(), read: new Set(), teams: new Set() },
    ])
  );
  const add = (
    of: Granted | undefined,
    {
      object,
      id,
      actions,
      teams,
    }: { object: string; id: string; actions: string; teams: string | null }
  ): void => {
    if (object === "platform") {
      for (const team of teamsIn(teams)) {
        of?.teams.add(team);
      }
    } else if (object === "connection") {
      of?.connected.add(id);
    } else if (actionsSchema.parse(JSON.parse(actions)).includes("read")) {
      of?.read.add(id);
    }
  };
  for (const row of rows) {
    const { type, app } = row;
    add(own.get(type === "workflow" ? workflowNode(app) : appNode(app)), row);
  }
  const granted = new Map(
    apps.map((app) => {
      const reached = [...(reach.get(app)?.nodes ?? [app])].map((node) =>
        own.get(node)
      );
      return [
        app,
        {
          connected: new Set(
            reached.flatMap((of) => [...(of?.connected ?? [])])
          ),
          read: new Set(reached.flatMap((of) => [...(of?.read ?? [])])),
          teams: [...new Set(reached.flatMap((of) => [...(of?.teams ?? [])]))],
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
  const [owners, readable] = await Promise.all([
    connectionIds.length === 0 ? [] : connectionOwnersOf(env, connectionIds),
    collectionIds.length === 0 ? [] : accessOf(env, collectionIds),
  ]);
  const ownerOf = new Map(owners.map((owner) => [owner.id, owner]));
  const accessById = new Map(readable.map((access) => [access.id, access]));
  return new Map(
    [...granted].map(([app, { connected, read, teams }]) => {
      const sources: AppSources = {
        connections: [],
        collections: [],
        brainTeams: teams,
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
      return [app, sources];
    })
  );
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
  const sources = await sourcesOfNodes(env, apps);
  return new Map(
    apps.map((app) => [
      app,
      sources.get(app) ?? {
        connections: [],
        collections: [],
        unresolved: [],
        brainTeams: [],
      },
    ])
  );
};

/**
 * What code may hold through every grant the walk follows from it
 * (`reachedThroughCalls`, `edgesOf`, both ways each grant carries data):
 * the sources of all of it (`sourcesOfApps`), and every App among the
 * nodes whose data it may hold, itself included for an App. An App the
 * walk can't place, or a walk past its caps, is among `sources.unresolved`.
 * For the caller an App's action or an independent workflow's run makes.
 */
export const holdingsOf = async (
  env: Env,
  caller: { readonly app: AppId } | { readonly workflow: string }
): Promise<{ sources: AppSources; apps: string[] }> => {
  const node = "app" in caller ? caller.app : workflowNode(caller.workflow);
  const reach = await reachedThroughCalls(env, [node]);
  const of = await sourcesOfNodes(env, [node], reach);
  const sources = of.get(node) ?? {
    connections: [],
    collections: [],
    unresolved: [],
    brainTeams: [],
  };
  const apps = [...(reach.get(node)?.nodes ?? [node])].filter(
    (id) => !id.startsWith(workflowPrefix)
  );
  return { sources, apps };
};

/** The sources `app` may have read, as they are now. */
export const sourcesOf = async (env: Env, app: AppId): Promise<AppSources> => {
  const sources = await sourcesOfApps(env, [app]);
  return (
    sources.get(app) ?? {
      connections: [],
      collections: [],
      brainTeams: [],
      unresolved: [],
    }
  );
};

/**
 * Whether App `app` may hold what the Brain recalled: it, or a workflow
 * or App it reaches through grants (`reachedThroughCalls`: on workflows,
 * and a workflow's on an App's functions), whatever the depth, was ever
 * granted the platform's `brain`. What code recalls is what everyone in the company may read
 * (brain-recall.ts), so this matters only for someone outside it: a
 * visitor (app-visitors.ts). One query past the walk.
 */
export const recallsTheBrain = async (
  env: Env,
  app: AppId
): Promise<boolean> => {
  // Every node whose data the App may hold, one level of `edgesOf` at a
  // time until a level adds none: each node is queried once, so it ends,
  // on cycles too, after as many levels as the grants make, with no cap
  // (the sharing walk's caps are for its many Apps at once).
  const reached = new Set<string>([appNode(app)]);
  let frontier: string[] = [appNode(app)];
  while (frontier.length > 0) {
    // oxlint-disable-next-line no-await-in-loop -- one level at a time
    const edges = await edgesOf(env, {
      apps: frontier.flatMap((id) =>
        id.startsWith(workflowPrefix) ? [] : [appIdSchema.parse(id)]
      ),
      workflows: frontier.flatMap((id) =>
        id.startsWith(workflowPrefix) ? [id.slice(workflowPrefix.length)] : []
      ),
    });
    const next = new Set<string>();
    for (const { from, to } of [...edges.values()].flat()) {
      if (reached.has(from) && !reached.has(to)) {
        next.add(to);
      }
    }
    for (const node of next) {
      reached.add(node);
    }
    frontier = [...next];
  }
  const nodes = [...reached];
  const reachedApps = nodes.filter((id) => !id.startsWith(workflowPrefix));
  const reachedWorkflows = nodes.flatMap((id) =>
    id.startsWith(workflowPrefix) ? [id.slice(workflowPrefix.length)] : []
  );
  const brainGrant = and(
    eq(permissions.objectType, "platform"),
    isNotNull(permissions.grantedAt),
    sql`EXISTS (SELECT 1 FROM json_each(${permissions.actions}) WHERE value = 'brain')`
  );
  const found = await drizzle(env.DB)
    .select({ id: permissions.id })
    .from(permissions)
    .where(
      and(
        brainGrant,
        or(
          and(
            eq(permissions.subjectType, "app"),
            inList(permissions.subjectId, reachedApps)
          ),
          and(
            eq(permissions.subjectType, "workflow"),
            inList(permissions.subjectId, reachedWorkflows)
          )
        )
      )
    )
    .limit(1)
    .get();
  return found !== undefined;
};

/**
 * Whether any grant to read the Brain naming teams was ever granted: one
 * statement, through `permissions_object_idx` (object type first), so it
 * reads only the platform's grants, a few per App. Until one is, no App
 * holds a team's content and nobody's access depends on teams.
 */
export const anyTeamGrant = async (env: Env): Promise<boolean> =>
  (await drizzle(env.DB)
    .select({ id: permissions.id })
    .from(permissions)
    .where(
      and(
        eq(permissions.objectType, "platform"),
        isNotNull(permissions.teams),
        isNotNull(permissions.grantedAt)
      )
    )
    .limit(1)
    .get()) !== undefined;

/**
 * The teams whose Brain content each of `apps` may hold (`brainTeams`):
 * every team a grant to read the Brain ever named, of it or of the Apps
 * and workflows whose data it may hold through grants
 * (`reachedThroughCalls`), revoked or not; an App past the walk's caps
 * counts `unreadableTeam` while any grant names teams. For deciding its owner and admins, whom the
 * other sources don't bind (`sourcesOfApps` holds the same for everyone
 * else): no call to connect.
 */
export const brainTeamsOfApps = async (
  env: Env,
  apps: readonly AppId[]
): Promise<Map<AppId, string[]>> => {
  // Most deployments have no team grant: then no App holds a team's
  // content, and nothing is walked.
  if (apps.length === 0 || !(await anyTeamGrant(env))) {
    return new Map();
  }
  const reach = await reachedThroughCalls(env, apps);
  const nodes = [
    ...new Set([...reach.values()].flatMap((of) => [...of.nodes])),
  ];
  const rows = await drizzle(env.DB)
    .select({
      type: permissions.subjectType,
      subject: permissions.subjectId,
      teams: permissions.teams,
    })
    .from(permissions)
    .where(
      and(
        isNotNull(permissions.grantedAt),
        eq(permissions.objectType, "platform"),
        isNotNull(permissions.teams),
        or(
          and(
            eq(permissions.subjectType, "app"),
            inList(
              permissions.subjectId,
              nodes.filter((node) => !node.startsWith(workflowPrefix))
            )
          ),
          and(
            eq(permissions.subjectType, "workflow"),
            inList(
              permissions.subjectId,
              nodes.flatMap((node) =>
                node.startsWith(workflowPrefix)
                  ? [node.slice(workflowPrefix.length)]
                  : []
              )
            )
          )
        )
      )
    );
  const own = new Map<string, string[]>();
  for (const { type, subject, teams } of rows) {
    const node = type === "workflow" ? workflowNode(subject) : appNode(subject);
    own.set(node, [...(own.get(node) ?? []), ...teamsIn(teams)]);
  }
  // Past the walk's caps, what it holds can't be placed: closed (only
  // ever reached while some grant names teams, above).
  const cappedApps = new Set(
    apps.filter(
      (app) => reach.get(app)?.unresolved.has(sourceId("app", "*")) === true
    )
  );

  return new Map(
    apps.map((app) => {
      const capped = cappedApps.has(app) ? [unreadableTeam] : [];
      const teams = [...(reach.get(app)?.nodes ?? [app])].flatMap(
        (node) => own.get(node) ?? []
      );
      return [app, [...new Set([...teams, ...capped])]];
    })
  );
};

/**
 * The Brain teams of `teams` that `reader` isn't in, as `brain:<team id>`:
 * none when they are in all. A team's content in the Brain is its
 * members' alone, an admin's and an App's owner's too.
 */
export const unreadableTeamsBy = (
  teams: readonly string[],
  reader: { readonly teamIds: readonly string[] }
): string[] =>
  teams.flatMap((team) =>
    reader.teamIds.includes(team) ? [] : [sourceId("brain", team)]
  );

/**
 * Whether someone in the teams `teamIds` may read every team's Brain
 * content App `app` may hold (`brainTeamsOfApps`): what its owner and
 * admins are held to.
 */
export const mayReadBrainTeamsOf = async (
  env: Env,
  app: AppId,
  teamIds: readonly string[]
): Promise<boolean> => {
  const teams = await brainTeamsOfApps(env, [app]);
  return unreadableTeamsBy(teams.get(app) ?? [], { teamIds }).length === 0;
};

/** Whether an App has read from anything at all. */
export const hasSources = (sources: AppSources): boolean =>
  sources.connections.length > 0 ||
  sources.collections.length > 0 ||
  sources.brainTeams.length > 0 ||
  sources.unresolved.length > 0;

/**
 * The sources in `sources` that `reader` can't read, as
 * `connection:<id>`, `collection:<id>` and `brain:<team id>`; none when
 * they may read all. A team's content in the Brain is its members' alone,
 * admins' too (brain-next.ts reads as a person's teams).
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
  ...unreadableTeamsBy(sources.brainTeams, reader),
  ...sources.unresolved,
];

/**
 * Whether every member of the organization may read every one of
 * `sources`: one with no team and no admin role may (`unreadableBy`). What
 * code writes for the whole company is held to it (brain-recall.ts).
 */
export const readableByEveryMember = (sources: AppSources): boolean =>
  unreadableBy(sources, { userId: "", teamIds: [], admin: false }).length === 0;
