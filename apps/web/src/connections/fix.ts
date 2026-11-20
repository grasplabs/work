import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";

import { canReconnect } from "./connect-dialog.tsx";
import type { Integration } from "./integrations.ts";

/**
 * What this person can do about an app whose connection ran out, as core
 * decides it: sign in again (their own, or a shared Microsoft or Google
 * one for an admin); for an admin, connect anew a shared one that can't be
 * signed in to again (a Composio toolkit), from its panel, which
 * disconnects it first; or nothing, when only an admin can.
 */
export type Fix = "sign-in" | "reconnect" | "none";

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
