import { roleSchema } from "@grasp-os/shared/roles";
import type { Role } from "@grasp-os/shared/roles";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import { roleLabel } from "../labels.ts";

// The three roles in the product's own words: the members' role Select,
// their Roles popover and the Invite dialog all read them from here.

/** What each role may do, in one line each. */
export const roleLines: Record<Role, MessageDescriptor> = {
  admin: msg`Manages people, teams and permissions, and can do everything a Builder can.`,
  builder: msg`Builds Apps and workflows, and asks for the permissions they need.`,
  user: msg`Uses the Apps and workflows shared with them, and chats with Grasp.`,
};

/** The roles to pick from, most first, each with its line, in the page's language. */
export const roleItems = (): {
  label: string;
  value: Role;
  description: string;
}[] =>
  roleSchema.options.map((role) => ({
    label: roleLabel(role),
    value: role,
    description: i18n._(roleLines[role]),
  }));
