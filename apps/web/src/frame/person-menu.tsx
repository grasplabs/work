import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@grasp-os/ui/components/sidebar";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import {
  EllipsisVerticalIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  RocketIcon,
  SettingsIcon,
  SunIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";

import { signOut } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";
import { roleLabel } from "../labels.ts";
import { LanguageMenu } from "../language-picker.tsx";
import {
  applyTheme,
  chooseTheme,
  isTheme,
  onThemeChange,
  readTheme,
  themes,
} from "./theme.ts";
import type { Theme } from "./theme.ts";

// The person signed in, at the foot of the sidebar, as in the prototype
// (`components/nav-user.tsx`): a menu with Settings, where their profile
// and, for admins, the workspace's settings are, their onboarding, the
// language, the theme and signing out.

/** Up to two letters of `name`, for the avatar. */
export const initials = (name: string): string =>
  name
    .split(/\s+/u)
    .filter((part) => part !== "")
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");

/** The person's name and role, on the menu's button. */
const Who = ({ identity }: { identity: Identity }) => {
  const { t } = useLingui();
  const role = roleLabel(identity.role);
  return (
    <>
      <Avatar>
        <AvatarFallback>{initials(identity.name)}</AvatarFallback>
      </Avatar>
      <span className="grid min-w-0 flex-1 text-left text-sm leading-tight">
        <span className="truncate font-medium">{identity.name}</span>
        <span className="text-muted-foreground truncate text-xs">
          {identity.staff ? t`${role}, Grasp staff` : role}
        </span>
      </span>
    </>
  );
};

const themeNames: Record<Theme, MessageDescriptor> = {
  light: msg`Light`,
  dark: msg`Dark`,
  system: msg`System`,
};

const themeIcons: Record<Theme, LucideIcon> = {
  light: SunIcon,
  dark: MoonIcon,
  system: MonitorIcon,
};

/**
 * Light, dark or the system's, as a submenu of the person menu: the
 * person's own choice in this browser (theme.ts). The person menu applies
 * it; this mounts only while the menu is open.
 */
const ThemeMenu = ({ userId }: { userId: string }) => {
  const { t, i18n } = useLingui();
  // Read where it is kept, so a choice made in another tab shows here too.
  const theme = useSyncExternalStore(onThemeChange, () => readTheme(userId));
  const Icon = themeIcons[theme];
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Icon />
        {t`Theme`}
        <span className="text-muted-foreground ml-auto">
          {i18n._(themeNames[theme])}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value: unknown) => {
            if (isTheme(value)) {
              chooseTheme(userId, value);
            }
          }}
        >
          {themes.map((each) => (
            <DropdownMenuRadioItem key={each} value={each}>
              {i18n._(themeNames[each])}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
};

export const PersonMenu = ({
  core,
  identity,
}: {
  core: CoreConnection;
  identity: Identity;
}) => {
  const { t } = useLingui();
  // What theme.js painted first was whoever was here last; this is theirs.
  // Here, not in the theme menu, which mounts only once the menu opens.
  useEffect(() => {
    applyTheme(readTheme(identity.userId));
  }, [identity.userId]);
  const { isMobile } = useSidebar();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger render={<SidebarMenuButton size="lg" />}>
            <Who identity={identity} />
            <EllipsisVerticalIcon className="ml-auto" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="min-w-56"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>{identity.email}</DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem render={<Link to="/settings/profile" />}>
                <SettingsIcon />
                {t`Settings`}
              </DropdownMenuItem>
              {/* The company's own onboarding, which only its admins go through. */}
              {isAdmin(identity.role) && identity.onboardingOnly !== true ? (
                <DropdownMenuItem render={<Link to="/setup" />}>
                  <RocketIcon />
                  {t`Your onboarding`}
                </DropdownMenuItem>
              ) : null}
              <LanguageMenu />
              <ThemeMenu userId={identity.userId} />
              <DropdownMenuItem
                onClick={() => {
                  void signOut(core);
                }}
              >
                <LogOutIcon />
                {t`Sign out`}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
};
