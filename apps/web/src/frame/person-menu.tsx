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
import { isThemeMode, themeModes } from "@grasp-os/ui/components/theme-toggle";
import type { ThemeMode } from "@grasp-os/ui/components/theme-toggle";
import { toast } from "@grasp-os/ui/components/toast";
import {
  ChevronsUpDownIcon,
  GlobeIcon,
  Icon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  RocketIcon,
  SettingsIcon,
  SunIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { colors, font, space } from "@grasp-os/ui/lib/tokens.stylex";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { useEffect, useSyncExternalStore } from "react";

import { signOut } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";
import { chooseLocale, isLocale, localeNames } from "../i18n.ts";
import type { Locale } from "../i18n.ts";
import { roleLabel } from "../labels.ts";
import { OrganizationName } from "./organization-name.tsx";
import { applyTheme, chooseTheme, onThemeChange, readTheme } from "./theme.ts";

// The person signed in, at the foot of the sidebar: their initials, their
// name and their organization's, and their menu: Settings, their
// onboarding, the language, the theme, and signing out.

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
  },
  // Atop the menu: who is signed in, and their role.
  signedIn: { display: "grid", gap: space["1"] },
  role: { fontWeight: font.weightNormal },
  // A submenu's words, then its choice now at the row's end, before the
  // chevron, quiet, cut short when there is no room, as the reference's.
  choice: { display: "flex", gap: space["4"] },
  current: {
    flexShrink: 100,
    minWidth: 0,
    marginInlineStart: "auto",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: colors.mutedForeground,
  },
});

const themeNames: Record<ThemeMode, MessageDescriptor> = {
  light: msg`Light`,
  dark: msg`Dark`,
  system: msg`System`,
};

const themeIcons: Record<ThemeMode, IconData> = {
  light: SunIcon,
  dark: MoonIcon,
  system: MonitorIcon,
};

/**
 * Light, dark or the system's, as a submenu of the person menu: the
 * person's own choice in this browser (theme.ts), on Damsko's modes. The
 * person menu applies it; this mounts only while the menu is open.
 */
const ThemeMenu = ({ userId }: { userId: string }) => {
  const { t, i18n } = useLingui();
  // Read where it is kept, so a choice made in another tab shows here too.
  const theme = useSyncExternalStore(onThemeChange, () => readTheme(userId));
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger icon={themeIcons[theme]}>
        <span {...stylex.props(styles.choice)}>
          {t`Theme`}
          <span {...stylex.props(styles.current)}>
            {i18n._(themeNames[theme])}
          </span>
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value: unknown) => {
            if (isThemeMode(value)) {
              chooseTheme(userId, value);
            }
          }}
        >
          {themeModes.map((each) => (
            <DropdownMenuRadioItem key={each} value={each}>
              {i18n._(themeNames[each])}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
};

/**
 * The language the product speaks, as a submenu of the person menu. Each
 * language is named in its own words, so anyone can find theirs.
 */
const LanguageMenu = () => {
  const { t, i18n } = useLingui();
  const locale: Locale = isLocale(i18n.locale) ? i18n.locale : "en";
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger icon={GlobeIcon}>
        <span {...stylex.props(styles.choice)}>
          {t`Language`}
          {/* The language now, in its own words. */}
          <span lang={locale} {...stylex.props(styles.current)}>
            {localeNames[locale]}
          </span>
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup
          value={locale}
          onValueChange={(value: unknown) => {
            if (isLocale(value)) {
              void chooseLocale(value);
            }
          }}
        >
          {Object.entries(localeNames).map(([value, label]) => (
            <DropdownMenuRadioItem key={value} label={label} value={value}>
              <span lang={value}>{label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
};

/** The person at the sidebar's foot, and their menu. */
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
  const role = roleLabel(identity.role);
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
            {/* Named by the person alone: their role is in the menu. */}
            <SidebarMenuButton aria-label={identity.name} size="lg">
              <Avatar decorative name={identity.name} size="sm">
                <AvatarFallback>{initials(identity.name)}</AvatarFallback>
              </Avatar>
              <span {...stylex.props(styles.who)}>
                <span {...stylex.props(styles.name)}>{identity.name}</span>
                <span {...stylex.props(styles.organization)}>
                  <OrganizationName core={core} />
                </span>
              </span>
              <Icon icon={ChevronsUpDownIcon} />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side={isMobile ? "top" : "right"}>
            <DropdownMenuGroup>
              <DropdownMenuLabel>
                <span {...stylex.props(styles.signedIn)}>
                  <span>{identity.name}</span>
                  <span {...stylex.props(styles.role)}>
                    {identity.staff ? t`${role}, Grasp staff` : role}
                  </span>
                </span>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem asChild icon={SettingsIcon}>
                <Link to="/settings/profile">{t`Settings`}</Link>
              </DropdownMenuItem>
              {/* The company's own onboarding, which only its admins go through. */}
              {isAdmin(identity.role) && identity.onboardingOnly !== true ? (
                <DropdownMenuItem asChild icon={RocketIcon}>
                  <Link to="/setup">{t`Your onboarding`}</Link>
                </DropdownMenuItem>
              ) : null}
              <LanguageMenu />
              <ThemeMenu userId={identity.userId} />
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              icon={LogOutIcon}
              onSelect={() => {
                void signOutOrSay();
              }}
            >
              {t`Sign out`}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
};
