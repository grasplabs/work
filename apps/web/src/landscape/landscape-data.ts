import type {
  LandscapeAppSummary,
  LandscapeSyncStatus,
} from "@grasp-os/shared/landscape";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";

import type { HeldPermissions } from "../connections/connection-list.tsx";
import { loadIntegrations } from "../connections/integrations-data.ts";
import { integrationsOf } from "../connections/integrations.ts";
import type { Integration } from "../connections/integrations.ts";
import type { CoreConnection } from "../core-connection.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { discoveredAppId } from "./landscape.ts";
import type { AppEngine, LandscapeApp } from "./landscape.ts";

// Where the Landscape's apps come from. The prototype's are V1 demo
// records, found through sign-in, the desktop agent and interviews; Grasp
// has none of those yet. What it does know of the apps its people use is
// its integrations: every app someone connected, with who holds the
// access (Grasp's own connector or Composio), since when, and which
// engines hold a permission on it. Everything else an app page shows
// (its vendor, AI type, data, hosting, owner, usage) nothing records yet,
// so it stays unknown and the pages show the prototype's empty states.

/**
 * The engines holding an active permission on any of `connectionIds`, by
 * name; null when the permissions couldn't be read (members may not list
 * them, or the read failed), since then nobody knows.
 */
const enginesOn = (
  connectionIds: readonly string[],
  held?: HeldPermissions
): AppEngine[] | null => {
  if (held === undefined) {
    return null;
  }
  const engines = new Map<string, AppEngine>();
  for (const { subject, object, status } of held.permissions) {
    if (
      status === "active" &&
      subject.type === "app" &&
      object.type === "connection" &&
      connectionIds.includes(object.connectionId)
    ) {
      engines.set(subject.appId, {
        id: subject.appId,
        name: held.appNames.get(subject.appId) ?? subject.appId,
      });
    }
  }
  return [...engines.values()].toSorted((one, other) =>
    one.name.localeCompare(other.name)
  );
};

/** One app, from an integration with connections. */
const appOf = (
  integration: Integration,
  held?: HeldPermissions
): LandscapeApp => {
  const connectionIds = integration.connections.map(({ id }) => id);
  const firstSeen =
    integration.connections
      .map(({ createdAt }) => createdAt)
      .toSorted()
      .at(0) ?? "";
  return {
    id: integration.key,
    name: integration.name,
    vendor: null,
    category: integration.categories[0] ?? null,
    description: null,
    aiType: "Unknown",
    dataExposure: null,
    dataExposureReason: "",
    hosting: [],
    users: null,
    owner: null,
    firstSeen,
    connectionIds,
    use: {
      sources: [integration.source],
      engines: enginesOn(connectionIds, held),
    },
    blocked: false,
    flagged: false,
    policySource: null,
    discovered: null,
  };
};

/**
 * An app found in the identity provider's grants (core's landscape): its
 * publisher as its vendor, and the people who granted it access as its
 * users. Its name is the app's own owner's, shown only as text.
 */
export const discoveredAppOf = (app: LandscapeAppSummary): LandscapeApp => ({
  id: discoveredAppId(app.connectionId, app.appId),
  name: app.name,
  vendor: app.publisher,
  category: null,
  description: null,
  aiType: "Unknown",
  dataExposure: null,
  dataExposureReason: "",
  hosting: [],
  users: app.people,
  owner: null,
  firstSeen: app.firstSeen,
  connectionIds: [],
  use: { sources: [], engines: [] },
  blocked: false,
  flagged: false,
  policySource: null,
  discovered: {
    connectionId: app.connectionId,
    appId: app.appId,
    unverifiedPublisher: app.unverifiedPublisher,
    adminConsented: app.adminConsented,
    scopes: app.scopes,
    signals: app.signals,
  },
});

/** The apps the landscape found, or why core couldn't say. */
export const loadDiscoveredApps = async (
  core: Pick<CoreConnection, "withSession">
): Promise<Loaded<LandscapeApp[]>> => {
  const found = await loadFromCore(
    core,
    async (session) => await session.landscape.apps()
  );
  return found.state === "ready"
    ? { state: "ready", data: found.data.map(discoveredAppOf) }
    : found;
};

/** Every app the company uses, as far as Grasp knows: each integration with a connection. */
export const landscapeAppsOf = (
  integrations: readonly Integration[],
  held?: HeldPermissions
): LandscapeApp[] =>
  integrations
    .filter(({ connections }) => connections.length > 0)
    .map((integration) => appOf(integration, held));

/** What the Landscape's pages read: the apps, or why there are none. */
export interface LandscapeData {
  /**
   * Every app either source gave: ready once one of them loaded, so apps
   * found in the identity provider show when the integrations didn't
   * load, and the other way round.
   */
  apps: Loaded<LandscapeApp[]>;
  /** Why the integrations' apps didn't load; ready once they did. */
  integrations: Loaded<unknown>;
  /** Why the apps found in the identity provider didn't load; ready once they did. */
  found: Loaded<unknown>;
  /**
   * The landscape's connections and their syncs, for admins, who connect
   * one; null for anyone else.
   */
  syncs: Loaded<LandscapeSyncStatus[]> | null;
  /**
   * Whether the apps found in the identity provider may be incomplete: a
   * connection's last read stopped at its limit or failed. Anyone may know.
   */
  incomplete: boolean;
}

/**
 * The apps, from the catalog and the connections this person can see, with
 * the engines that use them for those who may list permissions. The
 * catalog only names them: without it, an app goes by its provider's ID.
 */
export const loadLandscape = async (
  core: Pick<CoreConnection, "withSession">,
  identity: Identity
): Promise<LandscapeData> => {
  const [{ catalog, connections, held }, discovered, stopped, syncs] =
    await Promise.all([
      loadIntegrations(core, identity, { held: true }),
      loadDiscoveredApps(core),
      loadFromCore(
        core,
        async (session) => await session.landscape.incomplete()
      ),
      isAdmin(identity.role)
        ? loadFromCore(
            core,
            async (session) => await session.landscape.status()
          )
        : null,
    ]);
  const fromIntegrations: Loaded<LandscapeApp[]> =
    connections.state === "ready"
      ? {
          state: "ready",
          data: landscapeAppsOf(
            integrationsOf(
              catalog.state === "ready" ? catalog.data.entries : [],
              connections.data
            ),
            held?.state === "ready" ? held.data : undefined
          ),
        }
      : connections;
  const loaded = [fromIntegrations, discovered].flatMap((part) =>
    part.state === "ready" ? [part.data] : []
  );
  return {
    syncs,
    incomplete: stopped.state === "ready" && stopped.data.length > 0,
    integrations: fromIntegrations,
    found: discovered,
    apps:
      loaded.length === 0
        ? fromIntegrations
        : { state: "ready", data: loaded.flat() },
  };
};
