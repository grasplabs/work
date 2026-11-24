import type { Identity } from "@grasp-os/shared/rpc";
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
} from "@grasp-os/ui/components/sidebar";
import { isThemeMode } from "@grasp-os/ui/components/theme-toggle";
import { toast } from "@grasp-os/ui/components/toast";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import {
  ChevronsUpDownIcon,
  Icon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  SettingsIcon,
  SunIcon,
} from "@grasp-os/ui/lib/icons";
import { colors, font, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { useEffect, useSyncExternalStore } from "react";

import { signOut } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";
import { OrganizationName } from "./organization-name.tsx";
import {
  ArrowLeftRightIcon,
  CircleHelpIcon,
  ContrastIcon,
} from "./sidebar-icons.ts";
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
  // The menu's items scroll in a box of their own, over the whole menu,
  // as tall as the menu may be, so the menu itself never scrolls. In the
  // sidebar's sheet on a phone, UI SDK's sheet scrolls what takes the
  // focus there 16px clear of the foot of the area it scrolls in, once the
  // sheet is still (registry gap "a sheet scrolls a menu that opens in
  // it", 24 November): the menu, focused as it opens, was that area
  // itself, so it opened 16px down, its first label cut. The menu's own
  // room inside it is this box's, so the items stand where they stood.
  items: {
    boxSizing: "border-box",
    maxHeight: `min(${size.popupHeight}, var(--available-height, ${size.popupHeight}))`,
    margin: `calc(-1 * ${space.popupPadding})`,
    padding: space.popupPadding,
    overflowY: "auto",
    overscrollBehavior: "contain",
  },
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
  // The chevrons quieter than the words, as the rows' end marks are.
  chevrons: {
    display: "flex",
    flexShrink: 0,
    color: colors.sidebarTertiaryForeground,
  },
  // Appearance: its words at the start, the theme's segments at the end, on one row.
  themeRow: {
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    minHeight: size.sidebarMenuButtonHeight,
    paddingInlineStart: size.sidebarRowInline,
    color: colors.foreground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  themeWords: {
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // As wide as the person's button, over it.
  menu: {
    width: "var(--anchor-width)",
    minWidth: 0,
    maxWidth: "var(--anchor-width)",
  },
});

/**
 * Appearance, a row of the person menu: light, dark or the system's, the
 * person's own in this browser (theme.ts), as Damsko's theme toggle's
 * segments at the row's end.
 */
const ThemeRow = ({ userId }: { userId: string }) => {
  const { t } = useLingui();
  // Read where it is kept, so a choice made in another tab shows here too.
  const theme = useSyncExternalStore(onThemeChange, () => readTheme(userId));
  return (
    <div data-slot="sidebar-theme-row" {...stylex.props(styles.themeRow)}>
      <span {...stylex.props(styles.themeWords)}>
        <Icon icon={ContrastIcon} />
        {t`Appearance`}
      </span>
      <ToggleGroup
        aria-label={t`Appearance`}
        onValueChange={(next) => {
          const [mode] = next;
          if (isThemeMode(mode)) {
            chooseTheme(userId, mode);
          }
        }}
        size="xs"
        value={[theme]}
      >
        <ToggleGroupItem aria-label={t`Light`} tooltip={t`Light`} value="light">
          <Icon icon={SunIcon} />
        </ToggleGroupItem>
        <ToggleGroupItem aria-label={t`Dark`} tooltip={t`Dark`} value="dark">
          <Icon icon={MoonIcon} />
        </ToggleGroupItem>
        <ToggleGroupItem
          aria-label={t`System`}
          tooltip={t`System`}
          value="system"
        >
          <Icon icon={MonitorIcon} />
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
};

/**
 * The organizations the person is in, the one they are in now chosen: one,
 * until Grasp lets a person be in more, by its initials until the
 * workspace has a logo. A submenu of the person menu.
 */
const OrganizationMenu = ({ core }: { core: CoreConnection }) => {
  const { t } = useLingui();
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger icon={ArrowLeftRightIcon}>
        {t`Switch organization`}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup
          onValueChange={() => {
            // The one there is: nothing to switch to yet.
          }}
          value="current"
        >
          <DropdownMenuRadioItem value="current">
            <OrganizationName core={core} />
          </DropdownMenuRadioItem>
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
              <Avatar decorative name={identity.name} size="sm">
                <AvatarFallback>{initials(identity.name)}</AvatarFallback>
              </Avatar>
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
          <DropdownMenuContent align="start" side="top" style={styles.menu}>
            <div {...stylex.props(styles.items)}>
              <DropdownMenuItem asChild icon={SettingsIcon}>
                <Link to="/settings/profile">{t`Settings`}</Link>
              </DropdownMenuItem>
              <ThemeRow userId={identity.userId} />
              <DropdownMenuItem asChild icon={CircleHelpIcon}>
                <a href="/docs" rel="noopener" target="_blank">
                  {t`Support`}
                </a>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <OrganizationMenu core={core} />
              <DropdownMenuItem
                icon={LogOutIcon}
                onSelect={() => {
                  void signOutOrSay();
                }}
                variant="destructive"
              >
                {t`Sign out`}
              </DropdownMenuItem>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
};
