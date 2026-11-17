import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

import { canConnect } from "./connect-dialog.tsx";
import type { Integration } from "./integrations.ts";

// What both the Integrations list's inspector and an integration's own
// page say about one app, so the two say it in the same words: what it is
// for, what its connections reach, the tools a connection allows, the
// groups its tools come in, and why this person can't connect it.

/** What the app is for: in a sentence where the catalog says, else its kind. */
export const aboutOf = (integration: Integration): string | undefined =>
  integration.description ?? integration.categories[0];

/** The connection that says who connected the app and when: its newest. */
export const newestOf = (integration: Integration) =>
  integration.connections[0];

/**
 * The tools a Composio connection allows, as the admin who connected it
 * chose them; none to go by for a native one, whose every tool is there.
 */
export const allowedToolsOf = (
  integration: Integration
): ReadonlySet<string> | undefined => {
  const chosen = integration.connections.flatMap(({ tools }) => tools ?? []);
  return integration.source === "composio" && integration.connections.length > 0
    ? new Set(chosen)
    : undefined;
};

// The prototype's groups: what only reads, then what creates or changes.
export const toolGroups = [
  {
    id: "read",
    readOnly: true,
    title: msg({ message: "Read", context: "permission group" }),
  },
  {
    id: "change",
    readOnly: false,
    title: msg({ message: "Create and change", context: "permission group" }),
  },
] as const;

/**
 * What its connections reach: the tools a Composio connection's admin
 * allowed, or, for a native one, every tool, as Apps and agents are
 * granted them.
 */
export const useReaches = () => {
  const { t } = useLingui();
  return (integration: Integration): string => {
    const allowed = allowedToolsOf(integration);
    if (allowed === undefined) {
      return t`Every tool it has: Apps and agents use only what they are granted.`;
    }
    const total = integration.toolCount;
    const count = allowed.size;
    return total === undefined
      ? t`${plural(count, { one: "# tool allowed", other: "# tools allowed" })}`
      : t`${plural(total, { one: `${count} of its # tool allowed`, other: `${count} of its # tools allowed` })}`;
  };
};

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
    if (!integration.offered) {
      return isAdmin(identity.role)
        ? t`It isn't offered to your organization yet: offer it before connecting it.`
        : t`It isn't offered to your organization.`;
    }
    if (integration.auth === "own") {
      return t`Connecting it needs your organization's own sign-in app, which Grasp can't use yet.`;
    }
    return integration.source === "composio" &&
      integration.connections.length === 0
      ? t`An admin connects this for everyone.`
      : undefined;
  };
};
