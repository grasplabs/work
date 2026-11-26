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
import { ChevronsUpDownIcon, Icon } from "@grasp-os/ui/lib/icons";
import { colors, font } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { initials } from "./initials.ts";
import { ProfileMenu } from "./sidebar-profile.tsx";
import type { ProfileEntry } from "./sidebar-profile.tsx";

export type { ProfileEntry } from "./sidebar-profile.tsx";

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
  detail: {
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

/**
 * The person at the sidebar's foot: their face, their name and one quiet
 * line under it (their organization, or their role), and their menu.
 */
export const FrameProfile = ({
  name,
  detail,
  entries,
}: {
  name: string;
  detail: ReactNode;
  entries: readonly ProfileEntry[];
}) => (
  <SidebarMenu>
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton aria-label={name} size="lg">
            <span {...stylex.props(styles.face)}>
              <Avatar decorative name={name} size="sm">
                <AvatarFallback>{initials(name)}</AvatarFallback>
              </Avatar>
            </span>
            <span {...stylex.props(styles.who)}>
              <span {...stylex.props(styles.name)}>{name}</span>
              <span {...stylex.props(styles.detail)}>{detail}</span>
            </span>
            <span aria-hidden="true" {...stylex.props(styles.chevrons)}>
              <Icon icon={ChevronsUpDownIcon} />
            </span>
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <ProfileMenu entries={entries} />
      </DropdownMenu>
    </SidebarMenuItem>
  </SidebarMenu>
);
