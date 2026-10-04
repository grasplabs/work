import { canBuild } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { listedOrNone } from "../directory.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { HeldPermissions } from "./connection-list.tsx";

// What the Integrations pages read: the catalog, the connections this
// person can see and, for those who may list them (admins and builders),
// the permissions Apps and agents hold. Each part is read on its own, and
// says on its own why it failed: one read that fails or hangs leaves the
// others.

/**
 * The Apps' names by ID; IDs stand in for them if the Apps can't be read
 * in time.
 */
const appNamesOf = async (
  session: Session
): Promise<ReadonlyMap<string, string>> => {
  const apps = await listedOrNone(session.apps.list());
  return new Map(apps.map(({ id, name }) => [id, name]));
};

/** Every active permission the person may list, with the Apps' names. */
const heldPermissions = async (session: Session): Promise<HeldPermissions> => {
  const [permissions, appNames] = await Promise.all([
    session.permissions.list(undefined, "active"),
    appNamesOf(session),
  ]);
  return { permissions, appNames };
};

/** The catalog and the connections; with `held`, the permissions too. */
export const loadIntegrations = async (
  core: CoreConnection,
  identity: Identity,
  { held }: { held: boolean }
) => {
  const [catalog, connections, permissions] = await Promise.all([
    loadFromCore(core, async (session) => await session.connections.catalog()),
    loadFromCore(core, async (session) => await session.connections.list()),
    held && canBuild(identity.role)
      ? loadFromCore(core, heldPermissions)
      : undefined,
  ]);
  return { catalog, connections, held: permissions };
};
