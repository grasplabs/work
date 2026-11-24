import type { Identity } from "@grasp-os/shared/rpc";
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@grasp-os/ui/components/sidebar";
import { isThemeMode } from "@grasp-os/ui/components/theme-toggle";
import { toast } from "@grasp-os/ui/components/toast";
import {
  ChevronsUpDownIcon,
  Icon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  SettingsIcon,
  SunIcon,
} from "@grasp-os/ui/lib/icons";
import { colors, font } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { useEffect, useSyncExternalStore } from "react";

import { signOut } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";
import { OrganizationName, useOrganizationName } from "./organization-name.tsx";
import {
  ArrowLeftRightIcon,
  CircleHelpIcon,
  ContrastIcon,
} from "./sidebar-icons.ts";
import { ProfileMenu } from "./sidebar-profile.tsx";
import { applyTheme, chooseTheme, onThemeChange, readTheme } from "./theme.ts";

// The person signed in, at the foot of the sidebar: their initials, their
// name and their organization's, and their menu, as the reference's:
// Settings, Appearance (the theme), Support, then the organization they
// are in, and signing out. The language is in Settings › Profile.

const nameParts = /\s+/u;

/**
 * Up to two letters of `name`, for the avatar, as the prototype's
 * (`lib/format.ts`): of the parts written with a capital, so a particle
 * such as "de" or "van" is passed over ("Sanne de Wit" is SW). A name
 * written all in small letters keeps its first two parts.
 */
export const initials = (name: string): string => {
  const parts = name.split(nameParts).filter((part) => part !== "");
  const capitalised = parts.filter((part) => {
    const first = part.charAt(0);
    return first !== first.toLocaleLowerCase();
  });
  return (capitalised.length > 0 ? capitalised : parts)
    .slice(0, 2)
    .map((part) => part.charAt(0).toLocaleUpperCase())
    .join("");
};

const styles = stylex.create({
  // The person's name over their organization's, cut where the row ends.
  who: {
    display: "grid",
    flexGrow: 1,
    minWidth: 0,
    textAlign: "start",
  },
  name: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: font.weightMedium,
    lineHeight: font.sidebarNameLine,
  },
  organization: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: colors.sidebarSecondaryForeground,
    fontSize: font.textXs,
    lineHeight: font.sidebarNoteLine,
    fontWeight: font.weightNormal,
    letterSpacing: "normal",
  },
  // The initials in their own spacing, not the row's tighter one.
  face: { display: "contents", letterSpacing: "normal" },
  // The chevrons quieter than the words, as the rows' end marks are.
  chevrons: {
    display: "flex",
    flexShrink: 0,
    color: colors.sidebarTertiaryForeground,
  },
});

/** The person at the sidebar's foot, and their menu. */
export const PersonMenu = ({
  core,
  identity,
}: {
  core: CoreConnection;
  identity: Identity;
}) => {
  const { t } = useLingui();
  const organization = useOrganizationName(core);
  // Read where it is kept, so a choice made in another tab shows here too.
  const theme = useSyncExternalStore(onThemeChange, () =>
    readTheme(identity.userId)
  );
  // What theme.js painted first was whoever was here last; this is theirs.
  // Here, not in the theme menu, which mounts only once the menu opens.
  useEffect(() => {
    applyTheme(readTheme(identity.userId));
  }, [identity.userId]);
  // The menu is gone once pressed: a sign-out core didn't carry out is
  // said in a toast, and the page stays.
  const signOutOrSay = async (): Promise<void> => {
    try {
      await signOut(core);
    } catch {
      toast.error({
        title: t`Signing out didn't work`,
        description: t`You're still signed in. Try again in a moment.`,
      });
    }
  };
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* Named by the person alone. */}
            <SidebarMenuButton aria-label={identity.name} size="lg">
              <span {...stylex.props(styles.face)}>
                <Avatar decorative name={identity.name} size="sm">
                  <AvatarFallback>{initials(identity.name)}</AvatarFallback>
                </Avatar>
              </span>
              <span {...stylex.props(styles.who)}>
                <span {...stylex.props(styles.name)}>{identity.name}</span>
                <span {...stylex.props(styles.organization)}>
                  <OrganizationName core={core} />
                </span>
              </span>
              <span aria-hidden="true" {...stylex.props(styles.chevrons)}>
                <Icon icon={ChevronsUpDownIcon} />
              </span>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <ProfileMenu
            entries={[
              {
                action: {
                  label: t`Settings`,
                  icon: SettingsIcon,
                  render: <Link to="/settings/profile" />,
                },
              },
              {
                theme: {
                  label: t`Appearance`,
                  icon: ContrastIcon,
                  value: theme,
                  choices: [
                    { label: t`Light`, value: "light", icon: SunIcon },
                    { label: t`Dark`, value: "dark", icon: MoonIcon },
                    { label: t`System`, value: "system", icon: MonitorIcon },
                  ],
                  onValueChange: (mode) => {
                    if (isThemeMode(mode)) {
                      chooseTheme(identity.userId, mode);
                    }
                  },
                },
              },
              {
                action: {
                  label: t`Support`,
                  icon: CircleHelpIcon,
                  // Named here as well: the menu fills in its words, the lint can't see them.
                  render: (
                    <a
                      aria-label={t`Support`}
                      href="/docs"
                      rel="noopener"
                      target="_blank"
                    />
                  ),
                },
              },
              "separator",
              // The organizations the person is in, the one they are in
              // now chosen: one, until Grasp lets a person be in more.
              {
                choices: {
                  label: t`Switch organization`,
                  icon: ArrowLeftRightIcon,
                  choices: [
                    { label: organization, value: "current", avatar: true },
                  ],
                  value: "current",
                },
              },
              {
                action: {
                  label: t`Sign out`,
                  icon: LogOutIcon,
                  danger: true,
                  onSelect: () => {
                    void signOutOrSay();
                  },
                },
              },
            ]}
          />
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
};
