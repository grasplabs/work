import {
  BrainIcon,
  BuildingIcon,
  ClockIcon,
  CoinsIcon,
  InfoIcon,
  LinkIcon,
  LockIcon,
  CircleUserIcon,
  RocketIcon,
  ServerIcon,
  SparklesIcon,
  StickyNoteIcon,
  UsersIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import { InvoiceIcon } from "../frame/sidebar-icons.ts";

// Settings' sections, in their groups: the account's for everyone, then
// the workspace's for admins. The sidebar lists them as a level of its own
// while a Settings page is open, in its sheet on a phone
// (frame/settings-level.tsx); the Settings pages name the one that is open
// (routes/_shell.settings.tsx). Core checks the role on every call
// whatever is listed: this only keeps out of sight what someone can't use.

export type SettingsPath =
  | "/settings/workspace"
  | "/settings/members"
  | "/settings/ai-providers"
  | "/settings/models"
  | "/settings/spend"
  | "/settings/onboarding"
  | "/settings/brain"
  | "/settings/audit"
  | "/settings/webhooks"
  | "/settings/outcomes"
  | "/settings/billing"
  | "/settings/profile"
  | "/settings/instructions"
  | "/settings/security";

export interface SettingsItem {
  /** Stephen is a name and stays as it is; the other labels are translated. */
  label: MessageDescriptor | string;
  to: SettingsPath;
  icon: IconData;
}

export interface SettingsGroup {
  id: string;
  title: MessageDescriptor;
  items: SettingsItem[];
}

/** The sections this person may open, in their groups. */
export const groupsFor = ({
  admin,
  staff,
}: {
  admin: boolean;
  staff: boolean;
}): SettingsGroup[] => {
  const workspace: SettingsItem[] = admin
    ? [
        {
          label: msg`Workspace`,
          to: "/settings/workspace",
          icon: BuildingIcon,
        },
        ...(staff
          ? []
          : [
              {
                label: msg`Members and roles`,
                to: "/settings/members" as const,
                icon: UsersIcon,
              },
            ]),
        {
          label: msg`AI providers`,
          to: "/settings/ai-providers",
          icon: ServerIcon,
        },
        { label: msg`Models`, to: "/settings/models", icon: SparklesIcon },
        { label: msg`AI spend`, to: "/settings/spend", icon: CoinsIcon },
        // Its groups of teams, the brain's regions.
        { label: msg`Brain`, to: "/settings/brain", icon: BrainIcon },
        {
          label: msg`Onboarding`,
          to: "/settings/onboarding",
          icon: RocketIcon,
        },
        { label: msg`Audit trail`, to: "/settings/audit", icon: ClockIcon },
        ...(staff
          ? []
          : [
              // The event sources outside systems send events to.
              {
                label: msg`Webhooks`,
                to: "/settings/webhooks" as const,
                icon: LinkIcon,
              },
              {
                label: msg`Unknown outcomes`,
                to: "/settings/outcomes" as const,
                icon: InfoIcon,
              },
            ]),
        { label: msg`Billing`, to: "/settings/billing", icon: InvoiceIcon },
      ]
    : [];
  // The person's own account first, the one group everyone has, as the
  // reference orders them.
  return [
    {
      id: "account",
      title: msg({ message: "Account", context: "settings group" }),
      items: [
        { label: msg`Profile`, to: "/settings/profile", icon: CircleUserIcon },
        // What their chats start with: Grasp's staff have no chats here.
        ...(staff
          ? []
          : [
              {
                label: msg`Instructions`,
                to: "/settings/instructions" as const,
                icon: StickyNoteIcon,
              },
            ]),
        { label: msg`Security`, to: "/settings/security", icon: LockIcon },
      ],
    },
    ...(workspace.length === 0
      ? []
      : [
          {
            id: "workspace",
            title: msg({ message: "Workspace", context: "settings group" }),
            items: workspace,
          },
        ]),
  ];
};
