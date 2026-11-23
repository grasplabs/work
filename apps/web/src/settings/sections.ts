import { isAdmin } from "@grasp-os/shared/roles";
import type { Role } from "@grasp-os/shared/roles";
import {
  BrainIcon,
  BuildingIcon,
  CircleAlertIcon,
  CircleUserIcon,
  ClockIcon,
  DollarSignIcon,
  LinkIcon,
  LockIcon,
  RocketIcon,
  SparklesIcon,
  StickyNoteIcon,
  SunIcon,
  UsersIcon,
  WorkflowIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

// Settings' sections as data, in the order they are listed: one place for
// whatever lists them (the Settings layout's own list today, the sidebar
// once the frame lists them there). Who may see a section is part of its
// data, and `sectionsFor` filters by it alone; a link to a section someone
// may not open leads to their profile (`hiddenAt`, the Settings layout).
// Core checks the role on every call whatever is listed: this only keeps
// out of sight what someone can't use.

/** Where a section lives. */
type SettingsHref =
  | "/settings/profile"
  | "/settings/appearance"
  | "/settings/instructions"
  | "/settings/security"
  | "/settings/workspace"
  | "/settings/members"
  | "/settings/teams"
  | "/settings/ai-providers"
  | "/settings/brain"
  | "/settings/onboarding"
  | "/settings/audit"
  | "/settings/webhooks"
  | "/settings/outcomes"
  | "/settings/billing";

/**
 * Who may see a section: everyone; the organization's own people, never
 * Grasp staff (what their chats start with); the organization's admins,
 * Grasp staff signed in as one included; or its admins who are its own
 * people, never Grasp staff (its members, its teams and the outside
 * systems that call in).
 */
type SettingsAudience = "everyone" | "own" | "admins" | "own-admins";

type SettingsGroupId = "account" | "workspace";

interface SettingsGroup {
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
  /** Who finds it in the list, and may open it. */
  audience: SettingsAudience;
  /**
   * Who may open it by its address, where more may than find it listed:
   * the Workspace's values are everyone's to read, though only admins
   * find the section in the list.
   */
  readableBy?: SettingsAudience;
  /**
   * The page runs the page's whole width (a log beside its details);
   * every other section stands in one centred column.
   */
  wide?: true;
}

const settingsGroups: readonly SettingsGroup[] = [
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

const settingsSections: readonly SettingsSection[] = [
  {
    id: "profile",
    label: msg`Profile`,
    href: "/settings/profile",
    group: "account",
    icon: CircleUserIcon,
    audience: "everyone",
  },
  {
    id: "appearance",
    label: msg`Appearance`,
    href: "/settings/appearance",
    group: "account",
    icon: SunIcon,
    audience: "everyone",
  },
  {
    // What their chats start with: Grasp's staff have no chats here.
    id: "instructions",
    label: msg`Instructions`,
    href: "/settings/instructions",
    group: "account",
    icon: StickyNoteIcon,
    audience: "own",
  },
  {
    id: "security",
    label: msg`Security`,
    href: "/settings/security",
    group: "account",
    icon: LockIcon,
    audience: "everyone",
  },
  {
    id: "workspace",
    label: msg`Workspace`,
    href: "/settings/workspace",
    group: "workspace",
    icon: BuildingIcon,
    audience: "admins",
    // Its name, sign-in, data location and time zone, read-only for anyone
    // but its own admins (core refuses their change).
    readableBy: "everyone",
  },
  {
    id: "members",
    label: msg`Members and roles`,
    href: "/settings/members",
    group: "workspace",
    icon: UsersIcon,
    audience: "own-admins",
  },
  {
    id: "teams",
    label: msg`Teams`,
    href: "/settings/teams",
    group: "workspace",
    icon: WorkflowIcon,
    audience: "own-admins",
  },
  {
    // The providers, the models the calls run on, and what they cost.
    id: "ai-providers",
    label: msg`AI and spend`,
    href: "/settings/ai-providers",
    group: "workspace",
    icon: SparklesIcon,
    audience: "admins",
  },
  {
    // Its groups of teams, the brain's regions.
    id: "brain",
    label: msg`Brain`,
    href: "/settings/brain",
    group: "workspace",
    icon: BrainIcon,
    audience: "admins",
  },
  {
    id: "onboarding",
    label: msg`Onboarding`,
    href: "/settings/onboarding",
    group: "workspace",
    icon: RocketIcon,
    audience: "admins",
  },
  {
    id: "audit",
    label: msg`Audit trail`,
    href: "/settings/audit",
    group: "workspace",
    icon: ClockIcon,
    audience: "admins",
    wide: true,
  },
  {
    // Where outside systems send events in (settings/event-sources.tsx).
    id: "webhooks",
    label: msg`Incoming events`,
    href: "/settings/webhooks",
    group: "workspace",
    icon: LinkIcon,
    audience: "own-admins",
  },
  {
    // Every person's open calls of unknown outcome.
    id: "outcomes",
    label: msg`Unknown outcomes`,
    href: "/settings/outcomes",
    group: "workspace",
    icon: CircleAlertIcon,
    audience: "own-admins",
  },
  {
    id: "billing",
    label: msg`Billing`,
    href: "/settings/billing",
    group: "workspace",
    icon: DollarSignIcon,
    audience: "admins",
  },
];

/** Who is looking: their role, and whether they are Grasp staff. */
interface SettingsViewer {
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
  if (audience === "own") {
    return !viewer.staff;
  }
  return isAdmin(viewer.role) && (audience === "admins" || !viewer.staff);
};

/** Whether `viewer` may open `section`, listed for them or not. */
const mayOpen = (section: SettingsSection, viewer: SettingsViewer): boolean =>
  maySee(section.audience, viewer) ||
  (section.readableBy !== undefined && maySee(section.readableBy, viewer));

/** The sections `viewer` finds listed, in their order. */
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

/** Whether `section` is the one open at `pathname`, or holds it. */
const opens = (section: SettingsSection, pathname: string): boolean =>
  pathname === section.href || pathname.startsWith(`${section.href}/`);

/** The section open at `pathname`, among those `viewer` may open. */
export const sectionAt = (
  pathname: string,
  viewer: SettingsViewer
): SettingsSection | undefined =>
  settingsSections.find(
    (section) => opens(section, pathname) && mayOpen(section, viewer)
  );

/**
 * Whether `pathname` is a section `viewer` may not open: someone who
 * follows a link to one goes to their own profile instead, the same for
 * every such section.
 */
export const hiddenAt = (pathname: string, viewer: SettingsViewer): boolean =>
  settingsSections.some(
    (section) => opens(section, pathname) && !mayOpen(section, viewer)
  );
