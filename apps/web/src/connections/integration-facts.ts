import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { useLingui } from "@lingui/react/macro";

import { canConnect } from "./connect-dialog.tsx";
import type { Integration } from "./integrations.ts";

// What the Integrations pages say about one app, in the same words
// wherever they say it: what it is for, and why this person can't connect
// it.

/** What the app is for: in a sentence where the catalog says, else its kind. */
export const aboutOf = (integration: Integration): string | undefined =>
  integration.description ?? integration.categories[0];

/**
 * Why this person can't connect it, where they can't: staff, an entry not
 * offered, one that needs the organization's own sign-in app, or a toolkit
 * only admins connect.
 */
export const useWhyNoConnect = () => {
  const { t } = useLingui();
  return (integration: Integration, identity: Identity): string | undefined => {
    if (canConnect(integration, identity)) {
      return undefined;
    }
    if (identity.staff) {
      return t`Grasp staff can't connect accounts or change what is offered here: that is for the organization's own people.`;
    }
    if (integration.auth === "own") {
      return t`Connecting it needs your organization's own sign-in app, which Grasp can't use yet.`;
    }
    // An app the catalog doesn't list can't be offered: its own notice says so.
    if (!integration.offered && integration.listed) {
      if (integration.connections.length === 0) {
        return isAdmin(identity.role)
          ? t`It isn't offered to your organization yet: offer it before connecting it.`
          : t`It isn't offered to your organization.`;
      }
      if (isAdmin(identity.role)) {
        return t`It isn't offered any more, so no one can connect it again.`;
      }
    }
    return integration.source === "composio" &&
      integration.connections.length === 0
      ? t`An admin connects this for everyone.`
      : undefined;
  };
};
