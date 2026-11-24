import type { ListedConnection } from "@grasp-os/shared/connect";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";

import { canConnect, canReconnect } from "./connect-dialog.tsx";
import { reliedOnLapsed } from "./integrations.ts";
import type { Integration } from "./integrations.ts";

/**
 * What this person can do about an app whose connection ran out, as core
 * decides it: sign in again (their own, or a shared Microsoft or Google
 * one for an admin); for an admin, connect anew a shared one that can't be
 * signed in to again (a Composio toolkit), beside the stopped one, which
 * stays until it is disconnected (a toolkit that takes a key only once its
 * stopped key is disconnected, app-actions.tsx); or nothing, when only an
 * admin can.
 */
type Fix = "sign-in" | "reconnect" | "none";

export const fixOf = (
  integration: Integration,
  identity: Pick<Identity, "role" | "staff">
): Fix => {
  const lapsed = integration.connections.find(
    ({ status }) => status === "needs_reauth"
  );
  if (lapsed === undefined) {
    return "none";
  }
  if (canReconnect(lapsed, integration.offered, identity)) {
    return "sign-in";
  }
  return isAdmin(identity.role) && !identity.staff ? "reconnect" : "none";
};

/**
 * A toolkit's shared connections that stopped working, where an admin
 * connects it anew (`fixOf`) and the company relied on one of them; none
 * otherwise, or for anyone else.
 */
export const lapsedOf = (
  integration: Integration,
  identity: Pick<Identity, "role" | "staff">
): ListedConnection[] =>
  integration.source === "composio" &&
  fixOf(integration, identity) === "reconnect" &&
  reliedOnLapsed(integration)
    ? integration.connections.filter(
        ({ status, scope }) => status === "needs_reauth" && scope === "shared"
      )
    : [];

/**
 * The stopped connections an app's panel and page offer to connect again
 * beside, as a new connection (app-actions.tsx): those of `lapsedOf`, where
 * this person may connect the app. None of a toolkit that takes a key:
 * connect keeps one key connection of a toolkit live, a stopped one
 * included (`connection.already_connected`), so its key is disconnected
 * before another is added.
 */
export const connectsAgainBeside = (
  integration: Integration,
  identity: Identity
): ListedConnection[] =>
  integration.auth === "key" || !canConnect(integration, identity)
    ? []
    : lapsedOf(integration, identity);
