// The app shell's sidebar parts, which stand in AppShell's `sidebar` (or AppShellSidebar): the rows
// as data in their groups (AppShellNav), the switch of the main list's views under the head
// (AppShellSwitch), and the person at the foot with their menu (AppShellProfile). Each is drawn with
// Sidebar's parts; a level's head is Sidebar's own SidebarLevelHeader. Their words come from the
// I18nProvider (`appShell`).
//
//   <AppShell sidebar={
//     <>
//       <SidebarLevels value={level}>
//         <SidebarLevel value="main">
//           <AppShellSwitch aria-label="Views" tabs={views} value={view} onValueChange={setView}>
//             <AppShellNav aria-label="Main" groups={groups} />
//           </AppShellSwitch>
//         </SidebarLevel>
//         <SidebarLevel value="settings">
//           <SidebarLevelHeader>
//             <SidebarLevelTrigger value="main" asChild aria-label="Back"><Link to="/" /></SidebarLevelTrigger>
//             <SidebarLevelTitle asChild><Link to="/settings">Settings</Link></SidebarLevelTitle>
//           </SidebarLevelHeader>
//           <AppShellNav aria-label="Settings" groups={settings} />
//         </SidebarLevel>
//       </SidebarLevels>
//       <AppShellProfile name="Anna de Vries" detail="Northwind Finance" entries={menu} />
//     </>
//   } />
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  MenuContent,
  MenuItem,
  MenuItemIcon,
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
} from "@ui-sdk/react/menu";
import { renderElement } from "@ui-sdk/react/primitive";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import type {
  FocusEvent,
  KeyboardEvent,
  MouseEvent,
  ReactElement,
  ReactNode,
  RefCallback,
} from "react";

import { AgentIndicator } from "../../components/agent-indicator";
import { Avatar, AvatarFallback, AvatarImage } from "../../components/avatar";
import {
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../../components/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/dropdown-menu";
import {
  SidebarCollapsible,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "../../components/sidebar";
import { sidebarMenuItemMarker } from "../../components/sidebar.stylex";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../components/tooltip";
import { useI18n } from "../../lib/i18n";
import {
  CheckIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  EllipsisIcon,
  Icon,
} from "../../lib/icons";
import type { IconData } from "../../lib/icons";
import { focusRingInset, menuStyles, visuallyHidden } from "../../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  size,
  space,
} from "../../lib/tokens.stylex";
import { durations, popup } from "../../lib/tokens.values";
import { announce } from "../../lib/utils";
import { iconVars } from "../../lib/vars.stylex";
import { switchMarker } from "./app-shell-01.stylex";

const HOVER = media.hover;
const COARSE = media.pointerCoarse;
const FORCED = media.forcedColors;
// A row whose dots' menu is open.
const HELD_OPEN = ":has([data-slot=sidebar-menu-action][aria-expanded=true])";
const HIGHLIGHTED = ":is([data-highlighted])";

/** How far the switch's track stands round its tabs, on all four sides, and between them. */
const INSET = "2px";
/** The track's corner: the system's, as round as a pill at most. */
const TRACK_CORNER = `min(${radius.xl}, calc((${size.sidebarIconButton} + 2 * ${INSET}) / 2))`;
/** A tab's corner, and the thumb's: the track's less the inset, so the two nest. */
const TAB_CORNER = `calc(${TRACK_CORNER} - ${INSET})`;
/** The chosen ground's veil in dark, as a segmented chosen tab has it. */
const VEIL = `linear-gradient(light-dark(transparent, ${colors.accentActive}), light-dark(transparent, ${colors.accentActive}))`;
/** How far the person's menu stands off their row. */
const MENU_GAP = 6;

const styles = stylex.create({
  // ---- The rows ----
  labelWords: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  labelCount: { flexShrink: 0, fontVariantNumeric: "tabular-nums" },
  // Open, it points down; folded, the way of reading.
  chevron: {
    display: "inline-flex",
    flexShrink: 0,
    transform: {
      default: "none",
      ':is([aria-expanded="true"] > *)': "rotate(90deg)",
      ':is([aria-expanded="true"] > *):dir(rtl)': "rotate(-90deg)",
    },
    transitionProperty: "transform",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  // The rows of a group that folds stand in from its label, as a tree: room inside its panel,
  // which stays its group's width, so a row's end and its action stay inside the panel that folds
  // it. Inline only: nothing shows while it is folded.
  under: { paddingInlineStart: space["3"] },
  more: {
    fontWeight: font.weightNormal,
    color: {
      default: colors.mutedForeground,
      [HOVER]: {
        default: colors.mutedForeground,
        ":hover": colors.sidebarForeground,
      },
    },
  },
  name: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "0%",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  // A row with a second line: as tall as its lines.
  words: { display: "flex", flexDirection: "column", minWidth: 0 },
  detail: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontWeight: font.weightNormal,
    letterSpacing: "normal",
    color: colors.mutedForeground,
  },
  end: {
    flexShrink: 0,
    marginInlineStart: "auto",
    fontSize: font.textXs,
    lineHeight: font.textSmLine,
    fontWeight: font.weightNormal,
    letterSpacing: "normal",
    fontVariantNumeric: "tabular-nums",
    color: colors.mutedForeground,
  },
  empty: {
    margin: 0,
    paddingInline: `calc(${space["2"]} + ${size.sidebarRowInline})`,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.sidebarSecondaryForeground,
    textWrap: "pretty",
  },
  // Renaming, the field over the row shows the words: the row's own stand hidden in their place,
  // and what stands at its end (its time, its Working mark) with them.
  renaming: { visibility: "hidden" },
  // A row with its own menu keeps its hover while the pointer is anywhere on it, its dots too, and
  // while their menu is open: a fill under the row's link, which is clear at rest, and the name in
  // the ink. The row holds its own only when its action is the item's child; here the link and the
  // dots stand in the right-click menu's area.
  held: {
    position: "absolute",
    inset: 0,
    borderRadius: radius.sidebarRowRadius,
    cornerShape: radius.shape,
    pointerEvents: "none",
    backgroundColor: {
      default: "transparent",
      [stylex.when.ancestor(":hover", sidebarMenuItemMarker)]: {
        default: "transparent",
        [HOVER]: colors.sidebarHover,
      },
      [stylex.when.ancestor(HELD_OPEN, sidebarMenuItemMarker)]:
        colors.sidebarHover,
    },
    transitionProperty: "background-color",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  heldInk: {
    color: {
      default: null,
      [stylex.when.ancestor(":hover", sidebarMenuItemMarker)]: {
        default: null,
        [HOVER]: colors.sidebarForeground,
      },
      [stylex.when.ancestor(HELD_OPEN, sidebarMenuItemMarker)]:
        colors.sidebarForeground,
    },
  },
  // The Working mark at a row's end, in an icon's room, never squeezed.
  working: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    marginInlineStart: "auto",
  },
  // The unread dot: small and round, in the primary ink, two of the Working mark's pixels across,
  // so it stands as large as that mark's light.
  unreadDot: {
    width: `calc(${size.agentIndicatorDot} * 2)`,
    height: `calc(${size.agentIndicatorDot} * 2)`,
    borderRadius: radius.full,
    backgroundColor: { default: colors.primary, [FORCED]: "CanvasText" },
  },
  // On a row with dots, where the dots stand: it gives way to them while the row is pointed at,
  // holds focus or has its menu open; on a touch screen, where the dots always show, before them.
  workingSlot: {
    position: { default: "absolute", [COARSE]: "static" },
    insetBlock: 0,
    insetInlineEnd: space["1"],
    width: { default: size.sidebarIconButton, [COARSE]: "auto" },
    opacity: {
      default: 1,
      [stylex.when.ancestor(":hover", sidebarMenuItemMarker)]: {
        default: 1,
        [HOVER]: 0,
      },
      [stylex.when.ancestor(":focus-within", sidebarMenuItemMarker)]: 0,
      [stylex.when.ancestor(HELD_OPEN, sidebarMenuItemMarker)]: 0,
      [COARSE]: 1,
    },
    transitionProperty: "opacity",
    transitionDuration: {
      default: duration.hover,
      [media.reducedMotion]: "0s",
    },
    transitionTimingFunction: duration.ease,
  },
  // The rename field: the row's own box (its fill's start, end, height and corner) over the row's
  // link, which stays drawn under it, its words hidden; the row's type, so nothing jumps.
  field: {
    position: "absolute",
    inset: 0,
    boxSizing: "border-box",
    width: "100%",
    height: "100%",
    margin: 0,
    paddingInlineEnd: size.sidebarRowInline,
    borderWidth: 0,
    borderRadius: radius.sidebarRowRadius,
    cornerShape: radius.shape,
    backgroundColor: "transparent",
    color: colors.sidebarForeground,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    letterSpacing: size.sidebarTracking,
  },

  // ---- The switch ----
  row: {
    flexShrink: 0,
    paddingInline: space["2"],
    paddingBlockStart: space["1"],
  },
  track: {
    position: "relative",
    display: "flex",
    boxSizing: "border-box",
    width: "100%",
    gap: INSET,
    padding: INSET,
    borderRadius: TRACK_CORNER,
    cornerShape: radius.shape,
    backgroundColor: colors.sidebarHover,
    outline: { default: "none", [FORCED]: "1px solid CanvasText" },
    outlineOffset: "-1px",
  },
  // The chosen ground, one for the switch: it travels from the tab left to the tab chosen, its
  // leading edge first and its trailing edge after. Until it stands (before script) and in forced
  // colours, the chosen tab draws its own ground instead.
  thumb: {
    position: "absolute",
    insetBlock: INSET,
    left: 0,
    width: 0,
    boxSizing: "border-box",
    borderRadius: TAB_CORNER,
    cornerShape: radius.shape,
    backgroundColor: colors.sidebarCard,
    backgroundImage: VEIL,
    boxShadow: shadow.sm,
    pointerEvents: "none",
    display: {
      default: "none",
      [stylex.when.ancestor("[data-thumb]", switchMarker)]: {
        default: "block",
        [FORCED]: "none",
      },
    },
  },
  tab: {
    position: "relative",
    display: "inline-flex",
    flexGrow: 1,
    flexBasis: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: size.sidebarIconGap,
    boxSizing: "border-box",
    minWidth: 0,
    minHeight: size.sidebarIconButton,
    margin: 0,
    paddingBlock: 0,
    paddingInline: `calc(${size.sidebarRowInline} - ${INSET})`,
    borderWidth: 0,
    borderRadius: TAB_CORNER,
    cornerShape: radius.shape,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    letterSpacing: size.sidebarTracking,
    whiteSpace: "nowrap",
    color: {
      default: colors.sidebarSecondaryForeground,
      [HOVER]: {
        default: colors.sidebarSecondaryForeground,
        ":hover": colors.sidebarForeground,
      },
    },
    backgroundColor: "transparent",
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
    transitionProperty: "color, background-color",
    transitionDuration: `${duration.ui}, ${duration.hover}`,
    transitionTimingFunction: duration.ease,
  },
  // Chosen: its ink, and its own ground only until the thumb stands (and always in forced colours).
  tabChosen: {
    forcedColorAdjust: { default: null, [FORCED]: "none" },
    color: { default: colors.sidebarForeground, [FORCED]: "HighlightText" },
    backgroundColor: {
      default: colors.sidebarCard,
      [stylex.when.ancestor("[data-thumb]", switchMarker)]: {
        default: "transparent",
        [FORCED]: "Highlight",
      },
      [FORCED]: "Highlight",
    },
    backgroundImage: {
      default: VEIL,
      [stylex.when.ancestor("[data-thumb]", switchMarker)]: "none",
      [FORCED]: "none",
    },
    boxShadow: {
      default: shadow.sm,
      [stylex.when.ancestor("[data-thumb]", switchMarker)]: "none",
      [FORCED]: "none",
    },
  },
  // A finger's target, the look unchanged.
  target: {
    position: "absolute",
    insetInline: 0,
    insetBlock: {
      default: 0,
      [COARSE]: `calc((${size.sidebarIconButton} - ${size.tapTarget}) / 2)`,
    },
  },
  hold: { position: "relative", display: "inline-flex", minWidth: 0 },
  tabWords: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // How many wait: a red dot on its icon's corner, raised at the words' end when it has no icon.
  count: {
    position: "absolute",
    insetBlockStart: `calc(${space["2"]} / -2 + ${size.hairline} / 2)`,
    insetInlineStart: `calc(100% - ${space["2"]} / 2 - ${size.hairline})`,
    width: `calc(${space["2"]} - ${size.hairline})`,
    height: `calc(${space["2"]} - ${size.hairline})`,
    borderRadius: radius.full,
    backgroundColor: { default: colors.destructive, [FORCED]: "Highlight" },
    backgroundImage: {
      default: `radial-gradient(circle at 35% 30%, oklch(from ${colors.destructive} calc(l + 0.09) c h), ${colors.destructive} 55%, oklch(from ${colors.destructive} calc(l - 0.05) c h))`,
      [FORCED]: "none",
    },
    boxShadow: {
      default: `0 ${size.hairline} calc(${size.hairline} * 2) ${colors.destructiveShadowColor}`,
      [FORCED]: "none",
    },
  },
  countAtWords: { insetInlineStart: "100%", marginInlineStart: space["1"] },
  panel: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
  },
  leaving: {
    position: "absolute",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    pointerEvents: "none",
  },

  // ---- The person at the foot ----
  // A rule over the person, a gutter in from each side.
  foot: {
    marginBlockStart: `calc(-1 * ${space["2"]})`,
    paddingBlockStart: space["2"],
    borderBlockStartWidth: size.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: {
      default: colors.sidebarBorder,
      [FORCED]: "CanvasText",
    },
  },
  // The person's name over one quiet line, cut where the row ends.
  who: { display: "grid", flexGrow: 1, minWidth: 0, textAlign: "start" },
  person: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: font.weightMedium,
    lineHeight: font.sidebarNameLine,
  },
  personDetail: {
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
  // The menu: as wide as the person's row, over it, on the sidebar's menu ground, a small corner,
  // its items a row tall in the regular weight.
  menu: {
    width: "var(--anchor-width)",
    minWidth: 0,
    maxWidth: `calc(100vw - 2 * ${space.popupGutter})`,
    backgroundColor: colors.sidebarMenu,
    borderRadius: radius.sidebarMenuRadius,
    cornerShape: radius.shape,
    fontWeight: font.weightNormal,
  },
  // A submenu is as wide as its longest choice.
  subMenu: {
    width: "auto",
    minWidth: 0,
    backgroundColor: colors.sidebarMenu,
    borderRadius: radius.sidebarMenuRadius,
    cornerShape: radius.shape,
    fontWeight: font.weightNormal,
  },
  item: {
    [iconVars.size]: size.sidebarIcon,
    [iconVars.stroke]: size.iconStroke,
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    boxSizing: "border-box",
    minHeight: {
      default: size.sidebarMenuButtonHeight,
      [COARSE]: size.tapTarget,
    },
    paddingBlock: "6px",
    paddingInline: size.sidebarRowInline,
    borderRadius: radius.sm,
    cornerShape: radius.shape,
    color: {
      default: colors.foreground,
      [FORCED]: { default: "CanvasText", [HIGHLIGHTED]: "HighlightText" },
    },
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightNormal,
    textDecoration: "none",
    whiteSpace: "nowrap",
    cursor: "default",
    userSelect: "none",
    outline: "none",
    WebkitTapHighlightColor: "transparent",
    backgroundColor: {
      default: "transparent",
      [HIGHLIGHTED]: { default: colors.accentHighlight, [FORCED]: "Highlight" },
    },
  },
  destructive: {
    color: {
      default: colors.destructive,
      [FORCED]: { default: "CanvasText", [HIGHLIGHTED]: "HighlightText" },
    },
  },
  // A choice keeps room at its end for the tick.
  choice: {
    paddingInlineEnd: `calc(${size.sidebarRowInline} + ${size.sidebarIcon} + ${space["2"]})`,
  },
  itemIcon: { display: "inline-flex", flexShrink: 0, color: "inherit" },
  itemWords: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  itemEnd: { display: "inline-flex", flexShrink: 0, marginInlineStart: "auto" },
  tick: {
    position: "absolute",
    insetInlineEnd: size.sidebarRowInline,
    display: "inline-flex",
  },
  // The theme's row: its words at the start, the segments at the end.
  themeRow: {
    [iconVars.size]: size.sidebarIcon,
    [iconVars.stroke]: size.iconStroke,
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    minHeight: {
      default: size.sidebarMenuButtonHeight,
      [COARSE]: size.tapTarget,
    },
    paddingInlineStart: size.sidebarRowInline,
    color: { default: colors.foreground, [FORCED]: "CanvasText" },
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
  // The segments, one per choice, each its icon, on a pill track.
  segments: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    position: "relative",
    display: "inline-grid",
    flexShrink: 0,
    gridAutoFlow: "column",
    gridAutoColumns: "minmax(0, 1fr)",
    padding: space["1"],
    backgroundColor: colors.accent,
    borderRadius: radius.full,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
  },
  pill: {
    position: "absolute",
    insetBlock: space["1"],
    insetInlineStart: space["1"],
    boxSizing: "border-box",
    backgroundColor: colors.sidebarMenu,
    borderRadius: radius.full,
    boxShadow: shadow.sm,
    borderWidth: { default: 0, [FORCED]: 2 },
    borderStyle: "solid",
    borderColor: "Highlight",
    transitionProperty: "transform",
    transitionDuration: {
      default: duration.mark,
      [media.reducedMotion]: "0s",
    },
    transitionTimingFunction: duration.ease,
  },
  segment: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: { default: space["5"], [COARSE]: size.tapTarget },
    paddingInline: space["1"],
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: "transparent",
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    whiteSpace: "nowrap",
    cursor: "pointer",
    outline: "none",
    outlineStyle: {
      default: "none",
      ":is([data-highlighted]):focus-visible": "solid",
    },
    outlineWidth: size.ringWidth,
    outlineColor: colors.ring,
    outlineOffset: `calc(-1 * ${size.ringWidth})`,
    color: {
      default: colors.mutedForeground,
      [HIGHLIGHTED]: colors.foreground,
      [HOVER]: { default: null, ":hover": colors.foreground },
      [FORCED]: "CanvasText",
    },
    transitionProperty: "color",
    transitionDuration: duration.hover,
    WebkitTapHighlightColor: "transparent",
  },
  segmentOn: { color: colors.foreground },
  separator: {
    height: size.hairline,
    marginBlock: space["1"],
    marginInline: `calc(-1 * ${space.popupPadding})`,
    backgroundColor: { default: colors.sidebarBorder, [FORCED]: "CanvasText" },
  },
});

// Where the row's name stood when renaming started, so the field's words stand exactly there; and
// where the theme row's pill stands, one choice's width along.
const placed = stylex.create({
  at: (start: string, top: string, bottom: string) => ({
    paddingInlineStart: start,
    paddingBlockStart: top,
    paddingBlockEnd: bottom,
  }),
  pill: (choices: number, chosen: number) => ({
    width: `calc((100% - 2 * ${space["1"]}) / ${String(choices)})`,
    transform: {
      default: `translateX(${String(chosen * 100)}%)`,
      ":dir(rtl)": `translateX(${String(chosen * -100)}%)`,
    },
  }),
});

/** A link drawn from data: the router's element (`render`), else an `<a>` to `href`. */
const linkOf = (
  where: { href?: string; render?: ReactElement<Record<string, unknown>> },
  props: Record<string, unknown>
): ReactElement =>
  renderElement("a", { href: where.href, ...props }, where.render);

/** Whether data leads somewhere: an `href`, or the router's own link. */
const leads = (where: { href?: string; render?: ReactElement }): boolean =>
  where.href !== undefined || where.render !== undefined;

// ---- The rows ------------------------------------------------------------------------------------

/** One entry of a row's menu: a choice, or a line between choices. */
export type AppShellRowAction =
  | {
      /** What `onAction` hears. */
      value: string;
      /** Its words. */
      label: string;
      icon: IconData;
      /** A choice that removes or destroys, in the danger ink. */
      destructive?: boolean;
      /** It renames the row in place (a row with `onRename`), rather than telling `onAction`. */
      rename?: boolean;
    }
  | "separator";

/** A row under a row: a page within it. */
export interface AppShellNavSubRow {
  /** What it is kept under, one of its own among its neighbours: two rows may share a name. */
  id: string;
  /** Its name. */
  label: string;
  /** Where it leads. */
  href?: string;
  /** The element its link is drawn as, for a router's link (`render: <Link to="/apps" />`). */
  render?: ReactElement<Record<string, unknown>>;
  /** Whether it is the page shown (`aria-current="page"`). */
  current?: boolean;
}

/** One row: a link to a page (or a button), its icon, and what stands at its end. */
export interface AppShellNavRow extends AppShellNavSubRow {
  icon?: IconData;
  /** Runs when the row is pressed; a row without `href` or `render` is a button. */
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  /** Its own rows, under its name. */
  rows?: readonly AppShellNavSubRow[];
  /** A second, quieter line under its name: the row grows to two lines. */
  detail?: string;
  /** Short words at the row's end, quiet, instead of a count ("2d"). */
  end?: string;
  /** What a screen reader hears of `end`. @default `end` */
  endText?: string;
  /** Its name in the regular weight: a thing in a list of them (a chat), not a place. */
  quiet?: boolean;
  /** How many things wait there: a small pill at the row's end. None at 0. */
  count?: number;
  /** What a screen reader hears of the count ("3 waiting"). @default the number */
  countText?: string;
  /** Something works there now: the Working mark at the row's end, said as the I18nProvider's `appShell.working`. */
  working?: boolean;
  /**
   * Something there not seen yet: a small dot at the row's end, where the Working mark stands,
   * which wins while both hold; said as `appShell.unread`.
   */
  unread?: boolean;
  /**
   * At its end, after its words: a control of the product's own, such as a SidebarMenuAction that
   * leads elsewhere with its tooltip. Its menu's dots stand after it.
   */
  endAction?: ReactNode;
  /**
   * Its menu: behind three dots at its end (named `appShell.more`), and on a right-click, a long
   * press, the menu key or Shift+F10.
   */
  actions?: readonly AppShellRowAction[];
  /** Runs with the value of the menu's entry chosen, unless it renames. */
  onAction?: (value: string) => void;
  /**
   * Renamed in place: its menu's entry marked `rename`, F2 or a double-click lays a field over its
   * words; runs with the new name, trimmed, when it is not empty and differs.
   */
  onRename?: (name: string) => void;
}

/** The last, quiet row of a group: the way to all of them ("All chats"). */
export interface AppShellNavMore {
  /** Its words. */
  label: string;
  href?: string;
  render?: ReactElement<Record<string, unknown>>;
  onClick?: () => void;
}

/** A run of rows, under a small label or none. */
export interface AppShellNavGroup {
  /** What it is kept under, and its fold (`storageKey:id`): one of its own among the groups. */
  id: string;
  /** Its small label above the rows. */
  label?: string;
  rows: readonly AppShellNavRow[];
  /** Its own content in place of the rows: skeletons while they come, a tree. */
  content?: ReactElement;
  /** Its label folds the rows away and opens them again. */
  collapsible?: boolean;
  /** A number beside its label. */
  count?: number;
  /** A last, quiet row: the way to all of them. */
  more?: AppShellNavMore;
  /** A landmark of its own, so a screen reader can jump to it ("Organizations"). */
  landmark?: string;
}

/** Every prop an AppShellNav takes. */
export interface AppShellNavProps {
  /** What its rows are, said as a landmark ("Main"). */
  "aria-label": string;
  /** The rows, in their groups. */
  groups: readonly AppShellNavGroup[];
  /** Before the groups: an AppShellNavEmpty when there are none. */
  children?: ReactNode;
}

/** Every prop an AppShellNavEmpty takes. */
export interface AppShellNavEmptyProps {
  /** One quiet sentence where the rows would be ("Nothing waits for you."). */
  children: ReactNode;
}

/** Where the name stands in the row's link: from its start, its top and its bottom, in pixels. */
interface NameAt {
  start: number;
  top: number;
  bottom: number;
}

/** Reads where the row's name stands in its link, as renaming starts. */
const nameIn = (link: HTMLElement | null): NameAt | undefined => {
  const name = link?.querySelector<HTMLElement>("[data-row-name]");
  if (link === null || name === null || name === undefined) {
    return undefined;
  }
  const box = link.getBoundingClientRect();
  const words = name.getBoundingClientRect();
  const rtl = getComputedStyle(link).direction === "rtl";
  return {
    start: rtl ? box.right - words.right : words.left - box.left,
    top: words.top - box.top,
    bottom: box.bottom - words.bottom,
  };
};

/** Whether the row's own name is cut: its words run past their box. */
const isCut = (row: HTMLElement | null) => {
  const name = row?.querySelector<HTMLElement>("[data-row-name]");
  return (
    name !== null && name !== undefined && name.scrollWidth > name.clientWidth
  );
};

/** The rename field: its words chosen as it opens; Enter or leaving it saves, Escape keeps the name. */
const RenameField = ({
  label,
  name,
  at,
  onDone,
}: {
  label: string;
  name: string;
  at: NameAt;
  /** With the new name, or none to keep the old one; `byKey` when a key ended it. */
  onDone: (name: string | undefined, byKey: boolean) => void;
}) => {
  const field = useRef<HTMLInputElement>(null);
  const ended = useRef(false);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  const end = (next: string | undefined, byKey: boolean): void => {
    if (ended.current) {
      return;
    }
    ended.current = true;
    onDone(next, byKey);
  };
  return (
    <input
      aria-label={label}
      data-row-rename=""
      defaultValue={name}
      onBlur={(event: FocusEvent<HTMLInputElement>) => {
        end(event.currentTarget.value, false);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.nativeEvent.isComposing) {
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          end(event.currentTarget.value, true);
        } else if (event.key === "Escape") {
          // Escape ends the rename only: it does not also close a sheet round it.
          event.preventDefault();
          event.stopPropagation();
          end(undefined, true);
        }
      }}
      ref={field}
      type="text"
      {...stylex.props(
        styles.field,
        placed.at(
          `${String(at.start)}px`,
          `${String(at.top)}px`,
          `${String(at.bottom)}px`
        ),
        focusRingInset
      )}
    />
  );
};

/** A row's menu entries, as a Dropdown menu's or a Context menu's items. */
const MenuEntries = ({
  actions,
  menu,
  onChoose,
}: {
  actions: readonly AppShellRowAction[];
  menu: "dropdown" | "context";
  onChoose: (action: Exclude<AppShellRowAction, "separator">) => void;
}) => {
  const Item = menu === "dropdown" ? DropdownMenuItem : ContextMenuItem;
  const Separator =
    menu === "dropdown" ? DropdownMenuSeparator : ContextMenuSeparator;
  return actions.map((action, index) =>
    action === "separator" ? (
      <Separator key={`separator-${String(index)}`} />
    ) : (
      <Item
        icon={action.icon}
        key={action.value}
        onSelect={() => {
          onChoose(action);
        }}
        variant={action.destructive === true ? "destructive" : "default"}
      >
        {action.label}
      </Item>
    )
  );
};

/** Whether the row draws its name itself (a second line, a rename, the ink its dots hold), not as bare words. */
const ownName = (row: AppShellNavRow) =>
  row.detail !== undefined ||
  row.onRename !== undefined ||
  (row.actions?.length ?? 0) > 0;

/** A mark at the row's end, where the dots stand on a row that has them. */
const EndMark = ({
  slot,
  renaming,
  dots,
  children,
}: {
  slot: string;
  renaming: boolean;
  dots: boolean;
  children: ReactNode;
}) => (
  <span
    aria-hidden="true"
    data-slot={slot}
    {...stylex.props(
      styles.working,
      dots && styles.workingSlot,
      renaming && styles.renaming
    )}
  >
    {children}
  </span>
);

/**
 * A row's own words and what stands with them: its icon, its name, a second line, its end, its
 * Working mark or unread dot, and what a screen reader hears of them. A list, not an element of its
 * own, so a name given as bare words reaches SidebarMenuButton as such: it cuts it with an
 * ellipsis and shows it whole in a tooltip while it is cut. A name the row draws itself is marked
 * `data-row-name`, so the rename field stands where it does and the row's own tooltip reads whether
 * it is cut. Renaming, the name and what stands at the end are hidden in their places under the
 * field.
 */
const rowWords = (
  row: AppShellNavRow,
  renaming: boolean,
  dots: boolean,
  words: { working: string; unread: string }
): ReactNode[] => {
  const counted = row.count !== undefined && row.count > 0;
  const unread = row.unread === true && row.working !== true;
  return [
    row.icon === undefined ? null : <Icon icon={row.icon} key="icon" />,
    ownName(row) ? null : row.label,
    ownName(row) && row.detail === undefined ? (
      <span
        data-row-name=""
        key="name"
        {...stylex.props(
          styles.name,
          dots && styles.heldInk,
          renaming && styles.renaming
        )}
      >
        {row.label}
      </span>
    ) : null,
    row.detail === undefined ? null : (
      <span
        key="words"
        data-sidebar-lines=""
        {...stylex.props(styles.words, renaming && styles.renaming)}
      >
        <span data-row-name="" {...stylex.props(styles.name)}>
          {row.label}
        </span>
        <span {...stylex.props(styles.detail)}>{row.detail}</span>
      </span>
    ),
    row.end === undefined ? null : (
      <span
        key="end"
        {...stylex.props(styles.end, renaming && styles.renaming)}
      >
        <span aria-hidden="true">{row.end}</span>
        <span {...stylex.props(visuallyHidden)}>{row.endText ?? row.end}</span>
      </span>
    ),
    row.working === true ? (
      <EndMark
        key="working-mark"
        slot="sidebar-row-working"
        renaming={renaming}
        dots={dots}
      >
        <AgentIndicator />
      </EndMark>
    ) : null,
    unread ? (
      <EndMark
        key="unread-mark"
        slot="sidebar-row-unread"
        renaming={renaming}
        dots={dots}
      >
        <span {...stylex.props(styles.unreadDot)} />
      </EndMark>
    ) : null,
    ...[
      counted ? (row.countText ?? String(row.count)) : undefined,
      row.working === true ? words.working : undefined,
      unread ? words.unread : undefined,
    ].map((said, at) =>
      said === undefined ? null : (
        <span key={`said-${String(at)}`} {...stylex.props(visuallyHidden)}>
          {said}
        </span>
      )
    ),
  ];
};

/** What a row's tooltip gives its trigger, less the description: the tooltip repeats the row's own name. */
const RowTrigger = ({
  draw,
  "aria-describedby": _repeats,
  ...trigger
}: {
  draw: (trigger: Record<string, unknown>) => ReactElement;
  "aria-describedby"?: string;
} & Record<string, unknown>) => draw(trigger);

/**
 * The row's whole name in a tooltip, only while it is cut, for a row that draws its name itself:
 * at the row's end, on a pointer's rest or on focus, never on a phone.
 */
const CutTip = ({
  label,
  draw,
}: {
  label: string;
  draw: (trigger: Record<string, unknown>) => ReactElement;
}) => {
  const { isMobile } = useSidebar();
  const node = useRef<HTMLElement | null>(null);
  return (
    <Tooltip
      disabled={isMobile}
      onOpenChange={(open, details) => {
        if (open && !isCut(node.current)) {
          details.cancel();
        }
      }}
    >
      <TooltipTrigger
        asChild
        ref={(element: HTMLElement | null) => {
          node.current = element;
        }}
      >
        <RowTrigger draw={draw} />
      </TooltipTrigger>
      <TooltipContent side="end">{label}</TooltipContent>
    </Tooltip>
  );
};

/** Whether an event came from the row's link, not its dots or its field. */
const fromLink = (event: Event): boolean =>
  event.target instanceof Element &&
  event.target.closest("[data-slot=sidebar-menu-button]") !== null;

/**
 * Renaming a row in place: where its name stood as it started, the way to start it, and how it
 * ends. A double-click on the row's link, or F2 on it, starts it; listened to on the item round the
 * link, so the link stays as the caller drew it. Ending by a key puts focus back on the link, once
 * it is drawn again.
 */
const useRename = (row: AppShellNavRow) => {
  const itemRef = useRef<HTMLLIElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [at, setAt] = useState<NameAt>();
  const renames = row.onRename !== undefined;
  const linkOfRow = () =>
    itemRef.current?.querySelector<HTMLElement>(
      "[data-slot=sidebar-menu-button]"
    ) ?? null;
  const start = (): void => {
    const where = nameIn(linkOfRow());
    if (renames && where !== undefined) {
      setAt(where);
      setRenaming(true);
    }
  };
  const onDoubleClick = useEffectEvent((event: Event) => {
    if (fromLink(event)) {
      start();
    }
  });
  const onKey = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (event.key === "F2" && fromLink(event)) {
      event.preventDefault();
      start();
    }
  });
  useEffect(() => {
    const box = itemRef.current;
    const listening = box !== null && renames && !renaming;
    if (listening) {
      box.addEventListener("dblclick", onDoubleClick);
      box.addEventListener("keydown", onKey);
    }
    return () => {
      if (listening) {
        box.removeEventListener("dblclick", onDoubleClick);
        box.removeEventListener("keydown", onKey);
      }
    };
  }, [renames, renaming]);
  const done = (next: string | undefined, byKey: boolean): void => {
    setRenaming(false);
    const trimmed = next?.trim();
    if (trimmed !== undefined && trimmed !== "" && trimmed !== row.label) {
      row.onRename?.(trimmed);
    }
    if (byKey) {
      requestAnimationFrame(() => {
        linkOfRow()?.focus();
      });
    }
  };
  return {
    itemRef,
    renames,
    renaming,
    at: renaming ? at : undefined,
    start,
    onDone: done,
    linkOf: linkOfRow,
  };
};

/** The row's link, or its button: its words, and what the rename gives it. */
const RowButton = ({
  row,
  words,
  trigger,
  describedBy,
  inert,
}: {
  row: AppShellNavRow;
  words: ReactNode[];
  /** The tooltip trigger's props (CutTip), when the row has its own. */
  trigger: Record<string, unknown>;
  describedBy: string | undefined;
  inert: boolean;
}) => {
  const own = {
    ...trigger,
    "aria-describedby": describedBy,
    // While it is renamed: drawn under the field, out of reach.
    inert: inert || undefined,
    variant: row.quiet === true ? ("quiet" as const) : undefined,
    isActive: row.current === true,
  };
  const { isMobile, setOpenMobile } = useSidebar();
  return leads(row) ? (
    <SidebarMenuButton {...own} asChild>
      {linkOf(row, { onClick: row.onClick, children: words })}
    </SidebarMenuButton>
  ) : (
    <SidebarMenuButton
      {...own}
      onClick={(event) => {
        row.onClick?.(event);
        // In the sheet a row that acts closes it, as a link followed does.
        if (isMobile) {
          setOpenMobile(false);
        }
      }}
    >
      {words}
    </SidebarMenuButton>
  );
};

/** A row's sub rows: the pages within it. */
const SubRows = ({
  rows,
}: {
  rows: readonly AppShellNavSubRow[] | undefined;
}) =>
  rows === undefined || rows.length === 0 ? null : (
    <SidebarMenuSub>
      {rows.map((sub) => (
        <SidebarMenuSubItem key={sub.id}>
          <SidebarMenuSubButton asChild isActive={sub.current === true}>
            {linkOf(sub, { children: sub.label })}
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ))}
    </SidebarMenuSub>
  );

/** A row's three dots at its end, shown while the row is pointed at, holds focus or has its menu open. */
const RowDots = ({
  row,
  actions,
  onChoose,
}: {
  row: AppShellNavRow;
  actions: readonly AppShellRowAction[];
  onChoose: (action: Exclude<AppShellRowAction, "separator">) => void;
}) => {
  const { more } = useI18n().appShell;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuAction aria-label={more(row.label)} showOnHover>
          <Icon icon={EllipsisIcon} />
        </SidebarMenuAction>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <MenuEntries actions={actions} menu="dropdown" onChoose={onChoose} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const Row = ({ row }: { row: AppShellNavRow }) => {
  const hint = useId();
  const {
    itemRef,
    renames,
    renaming,
    at,
    start,
    onDone,
    linkOf: link,
  } = useRename(row);
  const said = useI18n().appShell;
  const actions = row.actions ?? [];
  const hasActions = actions.length > 0;
  const choose = (action: Exclude<AppShellRowAction, "separator">): void => {
    if (action.rename === true && renames) {
      start();
      return;
    }
    row.onAction?.(action.value);
  };
  const words = rowWords(row, renaming, hasActions, said);
  const describedBy = renames && !renaming ? hint : undefined;
  const button = (trigger: Record<string, unknown>) => (
    <RowButton
      describedBy={describedBy}
      inert={renaming}
      row={row}
      trigger={trigger}
      words={words}
    />
  );
  const held = (
    <>
      {hasActions && (row.rows?.length ?? 0) === 0 ? (
        <span aria-hidden="true" {...stylex.props(styles.held)} />
      ) : null}
      {ownName(row) ? <CutTip draw={button} label={row.label} /> : button({})}
      {at === undefined ? null : (
        <RenameField
          at={at}
          label={said.renameRow(row.label)}
          name={row.label}
          onDone={onDone}
        />
      )}
      {/* Read only as the link's description, never as words after the row. */}
      {describedBy === undefined ? null : (
        <span id={hint} hidden>
          {said.renameHint}
        </span>
      )}
      {row.count !== undefined && row.count > 0 && !renaming ? (
        <SidebarMenuBadge>
          <span aria-hidden="true">{row.count}</span>
        </SidebarMenuBadge>
      ) : null}
      {renaming ? null : row.endAction}
      {hasActions && !renaming ? (
        <RowDots row={row} actions={actions} onChoose={choose} />
      ) : null}
    </>
  );
  return (
    <SidebarMenuItem ref={itemRef}>
      {/* The row's link is what the keys reach, so the area takes no tab stop; the menu gives focus back to the link, or to nobody when its choice starts renaming (the field takes it). */}
      {hasActions ? (
        <ContextMenu>
          <ContextMenuTrigger aria-label={row.label} tabStop={false}>
            {held}
          </ContextMenuTrigger>
          <ContextMenuContent finalFocus={renaming ? "none" : link}>
            <MenuEntries actions={actions} menu="context" onChoose={choose} />
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        held
      )}
      <SubRows rows={row.rows} />
    </SidebarMenuItem>
  );
};

const MoreRow = ({ more }: { more: AppShellNavMore }) => {
  const { isMobile, setOpenMobile } = useSidebar();
  const words = (
    <span {...stylex.props(styles.name, styles.more)}>{more.label}</span>
  );
  return (
    <SidebarMenuItem>
      {leads(more) ? (
        <SidebarMenuButton asChild>
          {linkOf(more, { onClick: more.onClick, children: words })}
        </SidebarMenuButton>
      ) : (
        <SidebarMenuButton
          onClick={() => {
            more.onClick?.();
            if (isMobile) {
              setOpenMobile(false);
            }
          }}
        >
          {words}
        </SidebarMenuButton>
      )}
    </SidebarMenuItem>
  );
};

const Rows = ({
  group,
  labelledBy,
}: {
  group: AppShellNavGroup;
  labelledBy?: string;
}) =>
  group.content ?? (
    <SidebarMenu aria-labelledby={labelledBy}>
      {group.rows.map((row) => (
        <Row key={row.id} row={row} />
      ))}
      {group.more === undefined ? null : <MoreRow more={group.more} />}
    </SidebarMenu>
  );

const GroupBody = ({ group }: { group: AppShellNavGroup }) => {
  const labelId = useId();
  const { label } = group;
  if (label === undefined) {
    return (
      <SidebarGroup>
        <Rows group={group} />
      </SidebarGroup>
    );
  }
  const words = (
    <>
      <span {...stylex.props(styles.labelWords)}>{label}</span>
      {group.count === undefined ? null : (
        <span {...stylex.props(styles.labelCount)}>{group.count}</span>
      )}
    </>
  );
  if (group.collapsible !== true) {
    return (
      <SidebarGroup>
        <SidebarGroupLabel id={labelId}>{words}</SidebarGroupLabel>
        <Rows group={group} labelledBy={labelId} />
      </SidebarGroup>
    );
  }
  return (
    <SidebarCollapsible name={group.id}>
      <SidebarGroup>
        <CollapsibleTrigger asChild>
          <SidebarGroupLabel asChild>
            <button id={labelId} type="button">
              {words}
              <span aria-hidden="true" {...stylex.props(styles.chevron)}>
                <Icon icon={ChevronRightIcon} />
              </span>
            </button>
          </SidebarGroupLabel>
        </CollapsibleTrigger>
        {/* The panel alone, without the room above and below a panel's words: the rows follow their label at the rows' own gap. */}
        <CollapsibleContent asChild>
          <div {...stylex.props(group.content === undefined && styles.under)}>
            <Rows group={group} labelledBy={labelId} />
          </div>
        </CollapsibleContent>
      </SidebarGroup>
    </SidebarCollapsible>
  );
};

const Group = ({ group }: { group: AppShellNavGroup }) =>
  group.landmark === undefined ? (
    <GroupBody group={group} />
  ) : (
    <nav aria-label={group.landmark}>
      <GroupBody group={group} />
    </nav>
  );

/**
 * The sidebar's rows as data, in their groups: each row a link or a button with its icon, and at
 * its end a count, short words, the Working mark or an unread dot; a second line under its name;
 * its menu behind three dots and on a right-click; renamed in place. A group has a small label, its
 * count, folds away (kept under the shell's `storageKey`), and may end in a quiet way to all of
 * them.
 */
export const AppShellNav = ({
  "aria-label": label,
  groups,
  children,
}: AppShellNavProps) => (
  <SidebarContent aria-label={label}>
    {children}
    {groups.map((group) => (
      <Group group={group} key={group.id} />
    ))}
  </SidebarContent>
);

/** One quiet sentence where the rows would be, when there are none. */
export const AppShellNavEmpty = ({ children }: AppShellNavEmptyProps) => (
  <p data-slot="app-shell-nav-empty" {...stylex.props(styles.empty)}>
    {children}
  </p>
);

// ---- The switch ----------------------------------------------------------------------------------

/** One tab of the switch. */
export interface AppShellTab {
  /** What the switch calls it ("home"). */
  value: string;
  /** Its words ("Home"); its name alone when only its icon shows. */
  label: string;
  icon?: IconData;
  /** How many things wait there: a red dot on its icon, the number said (`countText`). None at 0. */
  count?: number;
  /** What a screen reader hears of the count. @default the number */
  countText?: string;
}

/** Every prop an AppShellSwitch takes. */
export interface AppShellSwitchProps {
  /** What the tabs choose between ("Views"). */
  "aria-label": string;
  tabs: readonly AppShellTab[];
  /** The tab chosen. */
  value: string;
  /** Runs with the tab chosen: a press, or ←, →, Home and End. */
  onValueChange: (value: string) => void;
  /**
   * The rows the tabs switch, in a tab panel under them, which fade from one list to the next.
   * Leave it out for views of the page (a level's), which switch no rows.
   */
  children?: ReactNode;
}

const reduced = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const still = () =>
  reduced() || window.matchMedia("(forced-colors: active)").matches;

interface Span {
  x: number;
  w: number;
}

const spanOf = (item: HTMLElement): Span => ({
  x: item.offsetLeft,
  w: item.offsetWidth,
});

const px = (value: string) => Number(value.replace("px", "")) || 0;

const easeOut = (x: number) => 1 - (1 - x) ** 3;
const clamp = (x: number) => Math.min(1, Math.max(0, x));

/**
 * The thumb's way from one tab to the next: its leading edge sets off first and its trailing edge
 * after, so it stretches toward the new tab and settles.
 */
const framesOf = (from: Span, to: Span): Keyframe[] => {
  const right = to.x + to.w >= from.x + from.w;
  const steps = 16;
  return Array.from({ length: steps + 1 }, (_, step) => {
    const at = step / steps;
    const lead = easeOut(clamp(at / 0.7));
    const trail = easeOut(clamp((at - 0.2) / 0.8));
    const start = from.x + (to.x - from.x) * (right ? trail : lead);
    const end =
      from.x +
      from.w +
      (to.x + to.w - from.x - from.w) * (right ? lead : trail);
    return {
      left: `${start}px`,
      width: `${Math.max(0, end - start)}px`,
      offset: at,
    };
  });
};

const glide = (thumb: HTMLElement, to: Span) => {
  const style = getComputedStyle(thumb);
  const from = { x: px(style.left), w: px(style.width) };
  for (const running of thumb.getAnimations()) {
    running.cancel();
  }
  thumb.style.setProperty("left", `${to.x}px`);
  thumb.style.setProperty("width", `${to.w}px`);
  if (still() || from.w === 0 || (from.x === to.x && from.w === to.w)) {
    return;
  }
  thumb.animate(framesOf(from, to), {
    duration: durations.ui,
    easing: "linear",
  });
};

const chosenTab = (row: HTMLElement) =>
  row.querySelector<HTMLElement>(':scope > [role=tab][aria-selected="true"]');

const putThumb = (row: HTMLElement, thumb: HTMLElement) => {
  const tab = chosenTab(row);
  if (tab !== null) {
    const span = spanOf(tab);
    thumb.style.setProperty("left", `${span.x}px`);
    thumb.style.setProperty("width", `${span.w}px`);
  }
};

/** The thumb stands on the chosen tab and follows it, however it is chosen. */
const followChoice = (row: HTMLElement, thumb: HTMLElement) => {
  putThumb(row, thumb);
  row.dataset.thumb = "";
  let at = chosenTab(row);
  const chosen = new MutationObserver(() => {
    const next = chosenTab(row);
    if (next !== null && next !== at) {
      at = next;
      glide(thumb, spanOf(next));
    }
  });
  chosen.observe(row, {
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-selected"],
  });
  // The sidebar's width changes the tabs': at rest the thumb follows at once.
  const sized = new ResizeObserver(() => {
    if (thumb.getAnimations().length === 0) {
      putThumb(row, thumb);
    }
  });
  sized.observe(row);
  return () => {
    chosen.disconnect();
    sized.disconnect();
    delete row.dataset.thumb;
  };
};

/** What a ref leaves when it watched nothing. */
const nothingWatched = () => {
  // Nothing was watched.
};

/** The switch's watcher, as a ref callback. */
const watchThumb: RefCallback<HTMLDivElement> = (row) => {
  const thumb =
    row?.querySelector<HTMLElement>(
      ":scope > [data-slot=app-shell-switch-thumb]"
    ) ?? null;
  return row === null || thumb === null
    ? nothingWatched
    : followChoice(row, thumb);
};

/** Each scroller in the copy where the original's stood. */
const keepScroll = (from: Element, to: Element) => {
  const copies = [...to.querySelectorAll("*")];
  for (const [index, element] of [...from.querySelectorAll("*")].entries()) {
    const copy = copies[index];
    if (copy !== undefined && element.scrollTop !== 0) {
      copy.scrollTop = element.scrollTop;
    }
  }
};

/**
 * The lists' crossfade as the switch turns: a still copy of the list leaving is laid over the panel
 * and fades out as the thumb sets off, then the new list fades in; the panel's box never moves.
 * Under reduced motion the new list is simply there.
 */
const crossfade = (panel: HTMLElement | null) => {
  const area = panel?.parentElement ?? null;
  if (panel === null || area === null || reduced()) {
    return;
  }
  for (const running of panel.getAnimations()) {
    running.cancel();
  }
  for (const old of area.querySelectorAll(
    ":scope > [data-slot=app-shell-switch-leaving]"
  )) {
    old.remove();
  }
  const leaving = document.createElement("div");
  leaving.setAttribute("aria-hidden", "true");
  leaving.inert = true;
  leaving.dataset.slot = "app-shell-switch-leaving";
  leaving.className = stylex.props(styles.leaving).className ?? "";
  for (const child of panel.children) {
    leaving.append(child.cloneNode(true));
  }
  for (const named of leaving.querySelectorAll("[id]")) {
    named.removeAttribute("id");
  }
  leaving.style.setProperty("top", `${panel.offsetTop}px`);
  leaving.style.setProperty("left", `${panel.offsetLeft}px`);
  leaving.style.setProperty("width", `${panel.offsetWidth}px`);
  leaving.style.setProperty("height", `${panel.offsetHeight}px`);
  area.append(leaving);
  keepScroll(panel, leaving);
  // One list, then the other, never both.
  const out = durations.leave - durations.stagger;
  leaving.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: out,
    easing: "ease",
    fill: "forwards",
  }).onfinish = () => {
    leaving.remove();
  };
  panel.animate([{ opacity: 0 }, { opacity: 1 }], {
    delay: out,
    duration: durations.stagger,
    easing: "ease",
    fill: "backwards",
  });
};

/** Says each tab's count again when it changes, never on first paint. */
const useCountVoice = (tabs: readonly AppShellTab[]) => {
  const heard = useRef<Map<string, number> | null>(null);
  useEffect(() => {
    const before = heard.current;
    heard.current = new Map(tabs.map((tab) => [tab.value, tab.count ?? 0]));
    if (before === null) {
      return;
    }
    for (const tab of tabs) {
      const was = before.get(tab.value);
      const now = tab.count ?? 0;
      if (was !== undefined && was !== now) {
        announce(tab.countText ?? String(now));
      }
    }
  });
};

/** The tab ←/→, Home or End lead to; null for any other key. */
const tabFor = (
  event: KeyboardEvent<HTMLButtonElement>
): HTMLElement | null => {
  const row = event.currentTarget.closest<HTMLElement>("[role=tablist]");
  const all =
    row === null ? [] : [...row.querySelectorAll<HTMLElement>("[role=tab]")];
  const at = all.indexOf(event.currentTarget);
  if (row === null || at === -1) {
    return null;
  }
  const rtl = getComputedStyle(row).direction === "rtl";
  const last = all.length - 1;
  const forward = rtl ? "ArrowLeft" : "ArrowRight";
  const backward = rtl ? "ArrowRight" : "ArrowLeft";
  const steps: Record<string, number> = {
    [forward]: Math.min(at + 1, last),
    [backward]: Math.max(at - 1, 0),
    Home: 0,
    End: last,
  };
  const next = steps[event.key];
  return next === undefined ? null : (all[next] ?? null);
};

const tabId = (id: string, value: string) => `${id}-tab-${value}`;
const tabPanelId = (id: string) => `${id}-tabpanel`;

/** A tab's count: a red dot on its icon's corner, or raised at its words' end with no icon. */
const TabCount = ({ atWords = false }: { atWords?: boolean }) => (
  <span
    aria-hidden="true"
    data-slot="app-shell-switch-count"
    {...stylex.props(styles.count, atWords && styles.countAtWords)}
  />
);

const Tab = ({
  id,
  tab,
  chosen,
  stop,
  panel,
  iconOnly,
  onChoose,
}: {
  id: string;
  tab: AppShellTab;
  chosen: boolean;
  /** The switch's one tab stop: the chosen tab, or the first when `value` names none. */
  stop: boolean;
  panel: boolean;
  iconOnly: boolean;
  onChoose: (value: string) => void;
}) => {
  const counted = tab.count !== undefined && tab.count > 0;
  return (
    <button
      aria-controls={panel ? tabPanelId(id) : undefined}
      // Its words are its name when only its icon shows.
      aria-label={iconOnly ? tab.label : undefined}
      aria-selected={chosen}
      id={tabId(id, tab.value)}
      onClick={() => {
        onChoose(tab.value);
      }}
      onKeyDown={(event) => {
        const next = tabFor(event);
        if (next !== null) {
          event.preventDefault();
          next.click();
          next.focus();
        }
      }}
      role="tab"
      tabIndex={stop ? 0 : -1}
      title={iconOnly ? tab.label : undefined}
      type="button"
      {...stylex.props(styles.tab, chosen && styles.tabChosen, focusRingInset)}
    >
      <span aria-hidden="true" {...stylex.props(styles.target)} />
      {tab.icon === undefined ? null : (
        <span {...stylex.props(styles.hold)}>
          <Icon icon={tab.icon} />
          {counted ? <TabCount /> : null}
        </span>
      )}
      {iconOnly ? null : (
        <span {...stylex.props(styles.hold)}>
          <span {...stylex.props(styles.tabWords)}>{tab.label}</span>
          {counted && tab.icon === undefined ? <TabCount atWords /> : null}
        </span>
      )}
      {counted ? (
        <span {...stylex.props(visuallyHidden)}>
          {` ${tab.countText ?? String(tab.count)}`}
        </span>
      ) : null}
    </button>
  );
};

/**
 * The switch under the sidebar's head (Home | Inbox), or a level's views under its name: a track on
 * the sidebar's hover fill, its tabs sharing its width, the chosen one raised on a thumb that glides
 * from tab to tab; a count is a red dot on its tab's icon. One tab stop; ←, →, Home and End move and
 * choose. From three tabs that all have an icon, each shows its icon alone.
 */
export const AppShellSwitch = ({
  "aria-label": label,
  tabs,
  value,
  onValueChange,
  children,
}: AppShellSwitchProps) => {
  const id = useId();
  const panel = children !== undefined;
  useCountVoice(tabs);
  const iconOnly =
    tabs.length > 2 && tabs.every((tab) => tab.icon !== undefined);
  // Whether `value` names one of the tabs; if not, the first takes the tab stop.
  const named = tabs.some((tab) => tab.value === value);
  return (
    <>
      <div data-slot="app-shell-switch" {...stylex.props(styles.row)}>
        <div
          aria-label={label}
          ref={watchThumb}
          role="tablist"
          {...stylex.props(switchMarker, styles.track)}
        >
          <span
            aria-hidden="true"
            data-slot="app-shell-switch-thumb"
            {...stylex.props(styles.thumb)}
          />
          {tabs.map((tab, at) => (
            <Tab
              chosen={tab.value === value}
              stop={tab.value === value || (!named && at === 0)}
              iconOnly={iconOnly}
              id={id}
              key={tab.value}
              onChoose={(next) => {
                if (panel && next !== value) {
                  crossfade(
                    document.querySelector<HTMLElement>(
                      `#${CSS.escape(tabPanelId(id))}`
                    )
                  );
                }
                onValueChange(next);
              }}
              panel={panel}
              tab={tab}
            />
          ))}
        </div>
      </div>
      {panel && (
        <div
          aria-labelledby={tabId(id, value)}
          id={tabPanelId(id)}
          role="tabpanel"
          {...stylex.props(styles.panel)}
        >
          {children}
        </div>
      )}
    </>
  );
};

// ---- The person at the foot ----------------------------------------------------------------------

/** A press of the person's menu: Settings, Support, Sign out. */
export interface AppShellProfileAction {
  label: string;
  icon: IconData;
  /** Where it leads. */
  href?: string;
  /** The element the item is drawn as, for a router's link (`<Link to="/settings/profile" />`). */
  render?: ReactElement<Record<string, unknown>>;
  /** Runs when it is chosen. */
  onSelect?: () => void;
  /** It ends something (Sign out): in the danger ink. */
  destructive?: boolean;
}

/** One choice of a submenu or of the theme's row. */
export interface AppShellProfileChoice {
  label: string;
  value: string;
  /** Its icon: the theme row's segment shows it alone. */
  icon?: IconData;
  /** Its initials before its name, as a team's or an organisation's. */
  avatar?: boolean;
}

/** A submenu of choices, one of them chosen (Switch organisation). */
export interface AppShellProfileChoices {
  label: string;
  icon: IconData;
  choices: readonly AppShellProfileChoice[];
  value: string;
  onValueChange?: (value: string) => void;
}

/** The theme's row: its name, and its choices as icon segments at its end (Light, Dark, System). */
export interface AppShellProfileTheme {
  label: string;
  icon: IconData;
  choices: readonly AppShellProfileChoice[];
  value: string;
  onValueChange: (value: string) => void;
}

/** One entry of the person's menu: a press, a submenu, the theme's row, or a line. */
export type AppShellProfileEntry =
  | { action: AppShellProfileAction }
  | { choices: AppShellProfileChoices }
  | { theme: AppShellProfileTheme }
  | "separator";

/** Every prop an AppShellProfile takes. */
export interface AppShellProfileProps {
  /** Who is signed in. It names the row and its menu, and gives the initials. */
  name: string;
  /** One quiet line under the name: their organisation, or their role. */
  detail?: ReactNode;
  /** Their picture, over the initials once it has loaded. */
  src?: string;
  /** Their menu, top to bottom. */
  entries: readonly AppShellProfileEntry[];
}

const itemClass = (destructive = false) =>
  stylex.props(styles.item, destructive && styles.destructive, focusRingInset)
    .className;

const ProfileAction = ({ action }: { action: AppShellProfileAction }) => (
  <MenuItem
    className={itemClass(action.destructive)}
    destructive={action.destructive}
    label={action.label}
    onSelect={() => action.onSelect?.()}
    render={
      action.render ??
      (action.href === undefined ? undefined : (
        <a aria-label={action.label} href={action.href} />
      ))
    }
  >
    <MenuItemIcon {...stylex.props(styles.itemIcon)}>
      <Icon icon={action.icon} />
    </MenuItemIcon>
    <span {...stylex.props(styles.itemWords)}>{action.label}</span>
  </MenuItem>
);

const ProfileChoices = ({ entry }: { entry: AppShellProfileChoices }) => (
  <MenuSub>
    <MenuSubTrigger className={itemClass()}>
      <MenuItemIcon {...stylex.props(styles.itemIcon)}>
        <Icon icon={entry.icon} />
      </MenuItemIcon>
      <span {...stylex.props(styles.itemWords)}>{entry.label}</span>
      <span aria-hidden="true" {...stylex.props(styles.itemEnd)}>
        <Icon icon={ChevronRightIcon} />
      </span>
    </MenuSubTrigger>
    <MenuSubContent
      alignOffset={-popup.gap}
      collisionPadding={popup.gutter}
      sideOffset={popup.gap}
      {...stylex.props(menuStyles.panel, menuStyles.motion, styles.subMenu)}
    >
      <MenuRadioGroup
        onValueChange={(value: string) => entry.onValueChange?.(value)}
        value={entry.value}
      >
        {entry.choices.map((choice) => (
          <MenuRadioItem
            className={
              stylex.props(styles.item, styles.choice, focusRingInset).className
            }
            key={choice.value}
            label={choice.label}
            value={choice.value}
          >
            {choice.avatar === true ? (
              <Avatar decorative name={choice.label} size="xs">
                <AvatarFallback />
              </Avatar>
            ) : null}
            <span {...stylex.props(styles.itemWords)}>{choice.label}</span>
            <MenuItemIndicator {...stylex.props(styles.tick)}>
              <Icon icon={CheckIcon} />
            </MenuItemIndicator>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </MenuSubContent>
  </MenuSub>
);

/** ←/→ move along the theme's segments and choose; ↑/↓ stay the menu's. */
const alongRow = (event: KeyboardEvent<HTMLElement>) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
    return;
  }
  const row = event.currentTarget.closest("[role=group]");
  const all =
    row === null
      ? []
      : [...row.querySelectorAll<HTMLElement>("[role=menuitemradio]")];
  const at = all.indexOf(event.currentTarget);
  const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
  const step = (event.key === "ArrowRight") === rtl ? -1 : 1;
  const next = all[at + step];
  if (at === -1 || next === undefined) {
    return;
  }
  event.preventDefault();
  next.focus();
  next.click();
};

const ThemeRow = ({ theme }: { theme: AppShellProfileTheme }) => {
  const chosen = theme.choices.findIndex(({ value }) => value === theme.value);
  return (
    <MenuRadioGroup
      aria-label={theme.label}
      data-slot="app-shell-theme-row"
      onValueChange={(value: string) => {
        theme.onValueChange(value);
      }}
      value={theme.value}
      {...stylex.props(styles.themeRow)}
    >
      <span aria-hidden="true" {...stylex.props(styles.themeWords)}>
        <Icon icon={theme.icon} />
        {theme.label}
      </span>
      <span {...stylex.props(styles.segments)}>
        {chosen === -1 ? null : (
          <span
            aria-hidden="true"
            {...stylex.props(
              styles.pill,
              placed.pill(theme.choices.length, chosen)
            )}
          />
        )}
        {theme.choices.map((choice) => (
          <MenuRadioItem
            aria-label={choice.label}
            className={
              stylex.props(
                styles.segment,
                choice.value === theme.value && styles.segmentOn
              ).className
            }
            key={choice.value}
            label={choice.label}
            onKeyDown={alongRow}
            title={choice.label}
            value={choice.value}
          >
            {choice.icon === undefined ? (
              choice.label
            ) : (
              <Icon icon={choice.icon} />
            )}
          </MenuRadioItem>
        ))}
      </span>
    </MenuRadioGroup>
  );
};

/**
 * The person at the sidebar's foot, under a rule: their face, their name and one quiet line, and
 * their menu over the row, as wide as it: presses, a submenu of choices with a tick, the theme as
 * icon segments at the end of its row, and lines between.
 */
export const AppShellProfile = ({
  name,
  detail,
  src,
  entries,
}: AppShellProfileProps) => (
  <SidebarFooter>
    <div data-slot="app-shell-profile" {...stylex.props(styles.foot)}>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton size="lg">
                <span {...stylex.props(styles.face)}>
                  <Avatar decorative name={name} size="sm">
                    {src === undefined ? null : <AvatarImage src={src} />}
                    <AvatarFallback />
                  </Avatar>
                </span>
                <span {...stylex.props(styles.who)}>
                  <span {...stylex.props(styles.person)}>{name}</span>
                  {detail === undefined ? null : (
                    <span {...stylex.props(styles.personDetail)}>{detail}</span>
                  )}
                </span>
                <span aria-hidden="true" {...stylex.props(styles.chevrons)}>
                  <Icon icon={ChevronsUpDownIcon} />
                </span>
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <MenuContent
              align="start"
              collisionPadding={popup.gutter}
              side="top"
              sideOffset={MENU_GAP}
              {...stylex.props(
                menuStyles.panel,
                menuStyles.motion,
                styles.menu
              )}
            >
              {entries.map((entry, index) => {
                if (entry === "separator") {
                  return (
                    <MenuSeparator
                      key={`separator-${String(index)}`}
                      {...stylex.props(styles.separator)}
                    />
                  );
                }
                if ("action" in entry) {
                  return (
                    <ProfileAction
                      action={entry.action}
                      key={entry.action.label}
                    />
                  );
                }
                if ("choices" in entry) {
                  return (
                    <ProfileChoices
                      entry={entry.choices}
                      key={entry.choices.label}
                    />
                  );
                }
                return <ThemeRow key={entry.theme.label} theme={entry.theme} />;
              })}
            </MenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
    </div>
  </SidebarFooter>
);
