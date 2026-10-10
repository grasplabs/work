import type { AuditRecord } from "@grasp-os/shared/audit-log";
import type { KnowledgeSignals } from "@grasp-os/shared/knowledge-signals";
import { canBuild, isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { ImprovementSignals } from "@grasp-os/shared/signals";
import type { WorkflowSummary } from "@grasp-os/shared/workflows";

import { readPendingRequests } from "../activity/pending.tsx";
import { integrationsOf } from "../connections/integrations.ts";
import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { listedOrNone } from "../directory.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { listWorkflows, openableApps } from "../workflows/reads.ts";
import { activityShown } from "./activity.tsx";
import type { LatestActivity } from "./activity.tsx";
import { readNotifications } from "./failed-workflows.tsx";
import type { Signals } from "./signals.tsx";
import { decidesRequests } from "./to-do.tsx";
import type { Waiting } from "./to-do.tsx";
import type { Board, EnginesRead } from "./widget-board.tsx";

// What the dashboard reads, each part on its own so one that fails or
// hangs leaves the rest: what waits on the person, what the widget board
// shows (the workflows, the engines, the signals), and, for admins, the
// latest of the audit trail.

/** The catalog and connections, as integrations: those whose access ran out are on the list. */
const readIntegrations = async (session: Session) => {
  const [catalog, connections] = await Promise.all([
    session.connections.catalog(),
    session.connections.list(),
  ]);
  return integrationsOf(catalog.entries, connections);
};

/** What waits on the person. Reading it marks the failed workflows it lists as read. */
export const readWaiting = async (
  core: CoreConnection,
  identity: Identity
): Promise<Waiting> => {
  const [held, failed, integrations, requests, dependencies, screens] =
    await Promise.all([
      loadFromCore(
        core,
        async (session) => await session.pendingActions.list()
      ),
      loadFromCore(core, readNotifications),
      loadFromCore(core, readIntegrations),
      decidesRequests(identity)
        ? loadFromCore(core, readPendingRequests)
        : undefined,
      loadFromCore(
        core,
        async (session) => await session.dependencies.waiting()
      ),
      decidesRequests(identity)
        ? loadFromCore(
            core,
            async (session) => await session.screenTrust.waiting()
          )
        : undefined,
    ]);
  return { held, failed, integrations, requests, dependencies, screens };
};

/**
 * Whether core refused the read to this person's role (admins read every
 * improvement signal, an engine's builders its own): their having none to
 * see, not a failure. Any other error is one.
 */
const refusedToRole = (error: unknown): boolean =>
  roleErrors.codeOf(error) === "role.forbidden";

/**
 * A read of signals core may refuse this person: none, rather than a
 * failure, then. Anything else (another error, a read that doesn't come
 * in time, a lost connection) fails the card, which says so, rather than
 * hiding it.
 */
const orNone = async <T>(read: Promise<T>): Promise<T | undefined> => {
  try {
    return await read;
  } catch (error) {
    if (refusedToRole(error)) {
      return undefined;
    }
    throw error;
  }
};

/**
 * The improvement signals this person may read: every one for admins,
 * each engine's they build for builders (one read per engine, those core
 * refuses left out), none for anyone else.
 */
const readImprovement = async (
  session: Session,
  identity: Identity,
  engines: readonly string[]
): Promise<ImprovementSignals | undefined> => {
  if (isAdmin(identity.role)) {
    return await orNone(session.signals.list());
  }
  if (!canBuild(identity.role)) {
    return undefined;
  }
  const each = await Promise.all(
    engines.map(async (app) => await orNone(session.signals.list({ app })))
  );
  const read = each.filter((signals) => signals !== undefined);
  if (read.length === 0) {
    return undefined;
  }
  return {
    computedAt:
      read
        .map(({ computedAt }) => computedAt)
        .filter((at) => at !== null)
        .toSorted()
        .at(-1) ?? null,
    signals: read.flatMap(({ signals }) => signals),
  };
};

/** The signals this person sees, with the engines' names and the model a fix is asked with. */
const readSignals = async (
  session: Session,
  identity: Identity
): Promise<Signals> => {
  const [apps, models, knowledge] = await Promise.all([
    openableApps(session),
    listedOrNone(session.chats.models()),
    orNone<KnowledgeSignals>(session.knowledgeSignals.list()),
  ]);
  const improvement = await readImprovement(
    session,
    identity,
    apps.map(({ id }) => id)
  );
  return {
    improvement,
    knowledge,
    engines: new Map(apps.map(({ id, name }) => [id, name])),
    model: models[0],
  };
};

/** How many pages of the trail the card reads at most, past the trail's own searches. */
const activityPages = 5;

/**
 * The latest events of the audit trail, without its own searches: core
 * records every search, the dashboard's too, and those alone can fill a
 * page. It reads older pages until it has enough to show, or the trail
 * ends, or it has read as many as it reads; only a first page records a
 * search. `older` says the trail goes on past what was read.
 */
const readActivity = async (session: Session): Promise<LatestActivity> => {
  const records: AuditRecord[] = [];
  let before: number | undefined;
  for (let page = 0; page < activityPages; page += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each page starts where the last ended
    const read = await session.audit.search({}, before);
    records.push(
      ...read.records.filter(({ event }) => event?.action !== "audit.searched")
    );
    if (records.length >= activityShown || read.next === null) {
      return { records, older: false };
    }
    before = read.next;
  }
  return { records, older: true };
};

/** Both of two reads, once both came: or the first that has no data, as it is. */
const bothOf = async <A, B>(
  first: Promise<Loaded<A>>,
  second: Promise<Loaded<B>>
): Promise<Loaded<[A, B]>> => {
  const [one, other] = await Promise.all([first, second]);
  if (one.state !== "ready") {
    return one;
  }
  if (other.state !== "ready") {
    return other;
  }
  return { state: "ready", data: [one.data, other.data] };
};

/** The engines widget's read: the engines, with the workflows read once for both widgets. */
const readEngines = async (
  core: CoreConnection,
  workflows: Promise<Loaded<WorkflowSummary[]>>
): Promise<Loaded<EnginesRead>> => {
  const both = await bothOf(loadFromCore(core, openableApps), workflows);
  return both.state === "ready"
    ? { state: "ready", data: { apps: both.data[0], workflows: both.data[1] } }
    : both;
};

/**
 * Everything the dashboard shows. What waits on the person comes first;
 * the board's widgets and activity come as they are read, so a slow one
 * never holds back the rest.
 */
export interface Dashboard {
  waiting: Waiting;
  board: Board;
  /** Admins only. */
  activity: Promise<Loaded<LatestActivity>> | undefined;
}

export const readDashboard = async (
  core: CoreConnection,
  identity: Identity
): Promise<Dashboard> => {
  // Not awaited: their blocks and cards wait for them.
  const workflows = loadFromCore(core, listWorkflows);
  const signals = loadFromCore(
    core,
    async (session) => await readSignals(session, identity)
  );
  const engines = readEngines(core, workflows);
  const activity = isAdmin(identity.role)
    ? loadFromCore(core, readActivity)
    : undefined;
  const waiting = await readWaiting(core, identity);
  return { waiting, board: { workflows, engines, signals }, activity };
};
