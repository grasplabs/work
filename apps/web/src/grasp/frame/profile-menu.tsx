import type { Identity } from "@grasp-os/shared/rpc";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { useSidebar } from "@grasp-os/ui/components/sidebar";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useLocation } from "@tanstack/react-router";
import { useEffect } from "react";

import type { CoreConnection } from "../../core-connection.ts";
import { initials, ThemeMenu, useSignOut } from "../../frame/person-menu.tsx";
import { organizationOf, useShownName } from "../../frame/sidebar-brand.tsx";
import { applyTheme, readTheme } from "../../frame/theme.ts";
import { tourStops } from "../../tour/tour-script.ts";
import { startTour } from "../../tour/tour-state.ts";
import { focus } from "../focus/focus.ts";
import { iconVars } from "../icons/icon.stylex.ts";
import {
  Checklist,
  Contrast,
  Icon,
  Question,
  Settings,
  SignOut,
  Swap,
  UpDown,
} from "../icons/index.ts";
import { grasp, media } from "../tokens/tokens.stylex.ts";
import { frame } from "./frame.stylex.ts";

// The foot of Grasp UI's sidebar, as Capy's: the person signed in and the
// organization they are in, a button that opens their menu above it, as
// wide as it. In it: Getting started (Stephen's tour), Settings, the
// appearance (the theme), support (the docs core serves at /docs); then
// switching organization (the one this deployment is for: each client's
// Grasp is its own, so there is no other to switch to yet) and signing
// out. The language is on Settings
// (Profile).

const styles = stylex.create({
  button: {
    display: "flex",
    alignItems: "center",
    gap: frame.iconGap,
    width: "100%",
    minWidth: 0,
    minHeight: { default: "46px", [media.coarse]: grasp.tap },
    paddingInline: "6px",
    borderWidth: 0,
    borderRadius: frame.corner,
    backgroundColor: {
      default: "transparent",
      [media.hover]: { default: "transparent", ":hover": frame.hover },
      ":is([aria-expanded=true])": frame.selected,
    },
    fontFamily: grasp.fontSans,
    textAlign: "start",
    cursor: "pointer",
    transitionProperty: "background-color",
    transitionDuration: { default: frame.answer, [media.reduced]: "0s" },
    transitionTimingFunction: grasp.ease,
  },
  // The person's initials on lime, a chip: two letters at the smallest
  // size Grasp UI allows.
  initials: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: frame.iconButton,
    height: frame.iconButton,
    borderRadius: frame.corner,
    backgroundColor: grasp.lime,
    // Words on lime are always the deep ink, in either theme.
    color: grasp.lightInk,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
  },
  who: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minWidth: 0,
  },
  name: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: grasp.textSm,
    lineHeight: "18px",
    letterSpacing: frame.tracking,
    fontWeight: grasp.weightMedium,
    color: frame.textPrimary,
  },
  organization: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: grasp.textXs,
    lineHeight: "16px",
    color: frame.textSecondary,
  },
  chevrons: {
    [iconVars.size]: frame.icon,
    display: "flex",
    flexShrink: 0,
    color: frame.textTertiary,
  },
});

/** The person and their organization, and their menu. */
export const ProfileMenu = ({
  core,
  identity,
}: {
  core: CoreConnection;
  identity: Identity;
}) => {
  const { t } = useLingui();
  const { setOpenMobile } = useSidebar();
  const { pathname } = useLocation();
  const organization = useShownName(organizationOf(core));
  const signOut = useSignOut(core);
  const toured = tourStops(identity).length > 0;
  // What theme.js painted first was whoever was here last; this is theirs.
  // Here, not in the theme menu, which mounts only once the menu opens.
  useEffect(() => {
    applyTheme(readTheme(identity.userId));
  }, [identity.userId]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button type="button" {...stylex.props(styles.button, focus.ring)} />
        }
      >
        <span aria-hidden="true" {...stylex.props(styles.initials)}>
          {initials(identity.name)}
        </span>
        <span {...stylex.props(styles.who)}>
          <span {...stylex.props(styles.name)}>{identity.name}</span>
          {organization === undefined ? null : (
            <span {...stylex.props(styles.organization)}>{organization}</span>
          )}
        </span>
        <span {...stylex.props(styles.chevrons)}>
          <Icon icon={UpDown} />
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-(--anchor-width) min-w-56"
        side="top"
        sideOffset={6}
      >
        <DropdownMenuGroup>
          {toured ? (
            <DropdownMenuItem
              onClick={() => {
                // On a phone the menu is in a sheet over the page: it goes, so the tour isn't told behind it.
                setOpenMobile(false);
                startTour(identity.userId, pathname);
              }}
            >
              <Icon icon={Checklist} />
              {t`Getting started`}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem render={<Link to="/settings/profile" />}>
            <Icon icon={Settings} />
            {t`Settings`}
          </DropdownMenuItem>
          <ThemeMenu
            icon={<Icon icon={Contrast} />}
            label={t`Appearance`}
            userId={identity.userId}
          />
          <DropdownMenuItem
            render={
              <a
                aria-label={t`Support`}
                href="/docs"
                rel="noopener"
                target="_blank"
              />
            }
          >
            <Icon icon={Question} />
            {t`Support`}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {/* The organizations the person is in, the one they are in now
              checked: one, until Grasp lets a person be in more. */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Icon icon={Swap} />
              {t`Switch organization`}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup value="current">
                <DropdownMenuRadioItem value="current">
                  {organization ?? "Grasp"}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem
            onClick={() => {
              void signOut();
            }}
            variant="destructive"
          >
            <Icon icon={SignOut} />
            {t`Sign out`}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
