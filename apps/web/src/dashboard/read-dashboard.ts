import type { AuditRecord } from "@grasp-os/shared/audit-log";
import type { KnowledgeSignals } from "@grasp-os/shared/knowledge-signals";
import { canBuild, isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { ImprovementSignals } from "@grasp-os/shared/signals";

import { readPendingRequests } from "../activity/pending.tsx";
import { integrationsOf } from "../connections/integrations.ts";
import type { CoreConnection } from "../core-connection.ts";
import { CoreTimeoutError } from "../core.ts";
import type { Session } from "../core.ts";
import { listedOrNone } from "../directory.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { openableApps } from "../workflows/reads.ts";
import { activityShown } from "./activity.tsx";
import { readNotifications } from "./failed-workflows.tsx";
import type { Signals } from "./signals.tsx";
import { decidesRequests } from "./to-do.tsx";
import type { Waiting } from "./to-do.tsx";

// What the dashboard reads, each part on its own so one that fails or
// hangs leaves the rest: what waits on the person, the signals, and, for
// admins, the latest of the audit trail.

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
  const [held, failed, integrations, requests] = await Promise.all([
    loadFromCore(core, async (session) => await session.pendingActions.list()),
    loadFromCore(core, readNotifications),
    loadFromCore(core, readIntegrations),
    decidesRequests(identity)
      ? loadFromCore(core, readPendingRequests)
      : undefined,
  ]);
  return { held, failed, integrations, requests };
};

/** Whether core itself refused a read: its errors carry a code; a timeout or a lost connection don't. */
const refusedByCore = (error: unknown): boolean =>
  !(error instanceof CoreTimeoutError) &&
  error instanceof Error &&
  "code" in error &&
  typeof error.code === "string";

/**
 * A read of signals core may refuse this person: none, rather than a
 * failure, then. Anything else (a read that doesn't come in time, a lost
 * connection) fails the card, which says so, rather than hiding it.
 */
const orNone = async <T>(read: Promise<T>): Promise<T | undefined> => {
  try {
    return await read;
  } catch (error) {
    if (refusedByCore(error)) {
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
 * ends; only a first page records a search.
 */
const readActivity = async (session: Session): Promise<AuditRecord[]> => {
  const shown: AuditRecord[] = [];
  let before: number | undefined;
  for (let page = 0; page < activityPages; page += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each page starts where the last ended
    const { records, next } = await session.audit.search({}, before);
    shown.push(
      ...records.filter(({ event }) => event?.action !== "audit.searched")
    );
    if (shown.length >= activityShown || next === null) {
      break;
    }
    before = next;
  }
  return shown;
};

/**
 * Everything the dashboard shows. What waits on the person comes first;
 * the signals and activity come as they are read, so a slow one never
 * holds back the rest.
 */
export interface Dashboard {
  waiting: Waiting;
  signals: Promise<Loaded<Signals>>;
  /** Admins only. */
  activity: Promise<Loaded<AuditRecord[]>> | undefined;
}

export const readDashboard = async (
  core: CoreConnection,
  identity: Identity
): Promise<Dashboard> => {
  // Not awaited: their cards wait for them.
  const signals = loadFromCore(
    core,
    async (session) => await readSignals(session, identity)
  );
  const activity = isAdmin(identity.role)
    ? loadFromCore(core, readActivity)
    : undefined;
  const waiting = await readWaiting(core, identity);
  return { waiting, signals, activity };
};
