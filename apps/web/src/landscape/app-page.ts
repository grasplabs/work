import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";

import { loadIntegrations } from "../connections/integrations-data.ts";
import { integrationsOf } from "../connections/integrations.ts";
import type { CoreConnection } from "../core-connection.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { policyBook, policyToday } from "../policies/policies-data.ts";
import { applyPolicy, findings } from "../policies/policy.ts";
import { readAppAudit } from "./landscape-audit.ts";
import type { AppAuditTrail } from "./landscape-audit.ts";
import { discoveredAppOf, landscapeAppsOf } from "./landscape-data.ts";
import { discoveredAppOfId } from "./landscape.ts";
import type { LandscapeApp } from "./landscape.ts";

// What an app's pages read, once for all its tabs: the app, as the
// Landscape lists it, and its audit trail, the events core's audit log
// holds on its connections. The trail isn't awaited: every tab shows the
// app at once, and only the Audit tab waits for the trail. Only admins may
// read the log, so for anyone else the trail is core's refusal.

/** An app's audit trail, or why there is none: only admins read the log. */
export type AppAudit = Loaded<AppAuditTrail> | { state: "adminsOnly" };

export interface AppPage {
  /** The app; null when nothing Grasp knows has this ID (any more). */
  app: Loaded<LandscapeApp | null>;
  /** The latest stretch of its audit trail, still being read. */
  audit: Promise<AppAudit>;
}

const adminsOnly: AppAudit = { state: "adminsOnly" };

/**
 * An app found in the identity provider's grants: its trail is that of the
 * landscape connection it was read through, its syncs and who looked at
 * who granted it access.
 */
const loadDiscoveredPage = async (
  core: CoreConnection,
  identity: Identity,
  appId: string
): Promise<AppPage> => {
  const found = await loadFromCore(
    core,
    async (session) => await session.landscape.apps()
  );
  if (found.state !== "ready") {
    return { app: found, audit: Promise.resolve(found) };
  }
  const summary = found.data
    .map(discoveredAppOf)
    .find(({ id }) => id === appId);
  if (summary?.discovered === undefined || summary.discovered === null) {
    return {
      app: { state: "ready", data: null },
      audit: Promise.resolve(adminsOnly),
    };
  }
  const [app] = applyPolicy(
    [summary],
    findings(policyBook.rules, [summary], policyBook.exceptions, policyToday())
  );
  const { connectionId, appId: providerAppId } = summary.discovered;
  // The connection's own events, and of the events about one of its apps
  // only this app's.
  const audit = isAdmin(identity.role)
    ? loadFromCore(
        core,
        async (session) =>
          await readAppAudit(
            session,
            [{ id: connectionId, accountName: null }],
            providerAppId
          )
      )
    : Promise.resolve(adminsOnly);
  return { app: { state: "ready", data: app ?? null }, audit };
};

export const loadAppPage = async (
  core: CoreConnection,
  identity: Identity,
  appId: string
): Promise<AppPage> => {
  if (discoveredAppOfId(appId) !== undefined) {
    return await loadDiscoveredPage(core, identity, appId);
  }
  const { catalog, connections, held } = await loadIntegrations(
    core,
    identity,
    { held: true }
  );
  if (connections.state !== "ready") {
    return { app: connections, audit: Promise.resolve(connections) };
  }
  const integration = integrationsOf(
    catalog.state === "ready" ? catalog.data.entries : [],
    connections.data
  ).find(({ key, connections: made }) => key === appId && made.length > 0);
  if (integration === undefined) {
    return {
      app: { state: "ready", data: null },
      audit: Promise.resolve(adminsOnly),
    };
  }
  const apps = landscapeAppsOf(
    [integration],
    held?.state === "ready" ? held.data : undefined
  );
  const [app] = applyPolicy(
    apps,
    findings(policyBook.rules, apps, policyBook.exceptions, policyToday())
  );
  // Not awaited: a slow read of the log shouldn't hold up the app's tabs.
  const audit = isAdmin(identity.role)
    ? loadFromCore(
        core,
        async (session) => await readAppAudit(session, integration.connections)
      )
    : Promise.resolve(adminsOnly);
  return { app: { state: "ready", data: app ?? null }, audit };
};
