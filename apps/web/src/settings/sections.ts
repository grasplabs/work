import { isAdmin } from "@grasp-os/shared/roles";
import type { Role } from "@grasp-os/shared/roles";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import {
  AppRecord,
  Cable,
  Clock,
  Company,
  Contrast,
  Link,
  Lock,
  People,
  Person,
} from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";

// Settings' sections as data, in the order they are listed: one place for
// the in-page list today and for the Sidebar once a section can take it
// over. Who may see a section is part of its data, and `sectionsFor`
// filters by it alone. Core checks the role on every call whatever is
// listed: this only keeps out of sight what someone can't use.

/** Where a section lives. */
export type SettingsHref =
  | "/settings/workspace"
  | "/settings/members"
  | "/settings/ai-providers"
  | "/settings/audit"
  | "/settings/webhooks"
  | "/settings/billing"
  | "/settings/profile"
  | "/settings/appearance"
  | "/settings/security";

/**
 * Who may see a section: everyone; the organization's admins, Grasp
 * staff signed in as one included; or its admins who are its own people,
 * never Grasp staff (its members and the outside systems that call in).
 */
export type SettingsAudience = "everyone" | "admins" | "own-admins";

export type SettingsGroupId = "workspace" | "account";

export interface SettingsGroup {
  id: SettingsGroupId;
  title: MessageDescriptor;
}

export interface SettingsSection {
  /** Stable: a rename changes only the label. */
  id: string;
  label: MessageDescriptor;
  href: SettingsHref;
  group: SettingsGroupId;
  icon: IconData;
  audience: SettingsAudience;
}

export const settingsGroups: readonly SettingsGroup[] = [
  // The person's own account first: the one group everyone has.
  {
    id: "account",
    title: msg({ message: "Account", context: "settings group" }),
  },
  {
    id: "workspace",
    title: msg({ message: "Workspace", context: "settings group" }),
  },
];

export const settingsSections: readonly SettingsSection[] = [
  {
    id: "profile",
    label: msg`Profile`,
    href: "/settings/profile",
    group: "account",
    icon: Person,
    audience: "everyone",
  },
  {
    id: "appearance",
    label: msg`Appearance`,
    href: "/settings/appearance",
    group: "account",
    icon: Contrast,
    audience: "everyone",
  },
  {
    id: "security",
    label: msg`Security`,
    href: "/settings/security",
    group: "account",
    icon: Lock,
    audience: "everyone",
  },
  {
    id: "workspace",
    label: msg`Workspace`,
    href: "/settings/workspace",
    group: "workspace",
    icon: Company,
    audience: "admins",
  },
  {
    id: "members",
    label: msg`Members and roles`,
    href: "/settings/members",
    group: "workspace",
    icon: People,
    audience: "own-admins",
  },
  {
    id: "ai-providers",
    label: msg`AI and spend`,
    href: "/settings/ai-providers",
    group: "workspace",
    icon: Cable,
    audience: "admins",
  },
  {
    id: "audit",
    label: msg`Audit trail`,
    href: "/settings/audit",
    group: "workspace",
    icon: Clock,
    audience: "admins",
  },
  {
    // The event sources outside systems send events to.
    id: "webhooks",
    // Where outside systems send events in (settings/event-sources.tsx).
    label: msg`Incoming events`,
    href: "/settings/webhooks",
    group: "workspace",
    icon: Link,
    audience: "own-admins",
  },
  {
    id: "billing",
    label: msg`Billing`,
    href: "/settings/billing",
    group: "workspace",
    icon: AppRecord,
    audience: "admins",
  },
];

/** Who is looking: their role, and whether they are Grasp staff. */
export interface SettingsViewer {
  role: Role;
  staff: boolean;
}

const maySee = (
  audience: SettingsAudience,
  viewer: SettingsViewer
): boolean => {
  if (audience === "everyone") {
    return true;
  }
  return isAdmin(viewer.role) && (audience === "admins" || !viewer.staff);
};

/** The sections `viewer` may see, in their order. */
export const sectionsFor = (viewer: SettingsViewer): SettingsSection[] =>
  settingsSections.filter((section) => maySee(section.audience, viewer));

/** The groups `viewer` sees, each with its sections; a group with none is left out. */
export const groupedSectionsFor = (
  viewer: SettingsViewer
): { group: SettingsGroup; sections: SettingsSection[] }[] => {
  const visible = sectionsFor(viewer);
  return settingsGroups
    .map((group) => ({
      group,
      sections: visible.filter((section) => section.group === group.id),
    }))
    .filter(({ sections }) => sections.length > 0);
};
