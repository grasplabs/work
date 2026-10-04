import type { AuditRecord } from "@grasp-os/shared/audit-log";
import type { KnowledgeSignals } from "@grasp-os/shared/knowledge-signals";
import { canBuild, isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { ImprovementSignals } from "@grasp-os/shared/signals";

import { readPendingRequests } from "../activity/pending.tsx";
import { integrationsOf } from "../connections/integrations.ts";
import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { listedOrNone } from "../directory.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { readNotifications } from "./failed-workflows.tsx";
import type { Signals } from "./signals.tsx";
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
    isAdmin(identity.role)
      ? loadFromCore(core, readPendingRequests)
      : undefined,
  ]);
  return { held, failed, integrations, requests };
};

/** A read of signals core may refuse this person: none, rather than a failure, then. */
const orNone = async <T>(read: Promise<T>): Promise<T | undefined> => {
  const [value] = await listedOrNone((async () => [await read])());
  return value;
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
    listedOrNone(session.apps.list()),
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

/** Everything the dashboard shows. */
export interface Dashboard {
  waiting: Waiting;
  signals: Loaded<Signals>;
  /** Admins only. */
  activity: Loaded<AuditRecord[]> | undefined;
}

export const readDashboard = async (
  core: CoreConnection,
  identity: Identity
): Promise<Dashboard> => {
  const [waiting, signals, activity] = await Promise.all([
    readWaiting(core, identity),
    loadFromCore(core, async (session) => await readSignals(session, identity)),
    isAdmin(identity.role)
      ? loadFromCore(core, async (session) => {
          const { records } = await session.audit.search({});
          return records;
        })
      : undefined,
  ]);
  return { waiting, signals, activity };
};
