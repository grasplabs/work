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
import type { AppAuditEvent } from "./landscape-audit.ts";
import { landscapeAppsOf } from "./landscape-data.ts";
import type { LandscapeApp } from "./landscape.ts";

// What an app's pages read, once for all its tabs: the app, as the
// Landscape lists it, and its audit trail, the events core's audit log
// holds on its connections. Only admins may read the log, so for anyone
// else the trail is core's refusal.

/** An app's audit trail, or why there is none: only admins read the log. */
export type AppAudit = Loaded<AppAuditEvent[]> | { state: "adminsOnly" };

export interface AppPage {
  /** The app; null when nothing Grasp knows has this ID (any more). */
  app: Loaded<LandscapeApp | null>;
  audit: AppAudit;
}

const adminsOnly: AppAudit = { state: "adminsOnly" };

export const loadAppPage = async (
  core: CoreConnection,
  identity: Identity,
  appId: string
): Promise<AppPage> => {
  const { catalog, connections, held } = await loadIntegrations(
    core,
    identity,
    { held: true }
  );
  if (connections.state !== "ready") {
    return { app: connections, audit: connections };
  }
  const integration = integrationsOf(
    catalog.state === "ready" ? catalog.data.entries : [],
    connections.data
  ).find(({ key, connections: made }) => key === appId && made.length > 0);
  if (integration === undefined) {
    return { app: { state: "ready", data: null }, audit: adminsOnly };
  }
  const apps = landscapeAppsOf(
    [integration],
    held?.state === "ready" ? held.data : undefined
  );
  const [app] = applyPolicy(
    apps,
    findings(policyBook.rules, apps, policyBook.exceptions, policyToday())
  );
  const audit = isAdmin(identity.role)
    ? await loadFromCore(
        core,
        async (session) => await readAppAudit(session, integration.connections)
      )
    : adminsOnly;
  return { app: { state: "ready", data: app ?? null }, audit };
};
