import type { Identity } from "@grasp-os/shared/rpc";

import type { HeldPermissions } from "../connections/connection-list.tsx";
import { loadIntegrations } from "../connections/integrations-data.ts";
import { integrationsOf } from "../connections/integrations.ts";
import type { Integration } from "../connections/integrations.ts";
import type { CoreConnection } from "../core-connection.ts";
import type { Loaded } from "../load-from-core.tsx";
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
  };
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
  apps: Loaded<LandscapeApp[]>;
}

/**
 * The apps, from the catalog and the connections this person can see, with
 * the engines that use them for those who may list permissions. The
 * catalog only names them: without it, an app goes by its provider's ID.
 */
export const loadLandscape = async (
  core: CoreConnection,
  identity: Identity
): Promise<LandscapeData> => {
  const { catalog, connections, held } = await loadIntegrations(
    core,
    identity,
    { held: true }
  );
  if (connections.state !== "ready") {
    return { apps: connections };
  }
  const integrations = integrationsOf(
    catalog.state === "ready" ? catalog.data.entries : [],
    connections.data
  );
  return {
    apps: {
      state: "ready",
      data: landscapeAppsOf(
        integrations,
        held?.state === "ready" ? held.data : undefined
      ),
    },
  };
};
