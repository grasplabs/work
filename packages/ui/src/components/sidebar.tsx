// Sidebar: an app's main places down one side: a provider that holds whether it is open, the
// sidebar with its header, its content in groups of menus and its footer, a trigger that folds it
// (and the keys), and the page beside it (SidebarInset).
//
//   <SidebarProvider>
//     <Sidebar>
//       <SidebarHeader>…</SidebarHeader>
//       <SidebarContent>
//         <SidebarGroup>
//           <SidebarGroupLabel>Workspace</SidebarGroupLabel>
//           <SidebarMenu>
//             <SidebarMenuItem>
//               <SidebarMenuButton asChild isActive>
//                 <a href="/inbox"><Icon icon={InboxIcon} />Inbox</a>
//               </SidebarMenuButton>
//               <SidebarMenuBadge>3</SidebarMenuBadge>
//             </SidebarMenuItem>
//           </SidebarMenu>
//         </SidebarGroup>
//       </SidebarContent>
//       <SidebarFooter>…</SidebarFooter>
//     </Sidebar>
//     <SidebarInset>
//       <SidebarTrigger />
//       …
//     </SidebarInset>
//   </SidebarProvider>
//
// It stands in the page's flow, never fixed to the window, so it lives in any frame: an aside
// named by the I18nProvider's `sidebar.name`, its content a navigation named `sidebar.main`.
// It folds away whole, off the canvas; `collapsible="icon"` folds it down to its icons instead,
// where each row's words show in a tooltip. A row's words longer than the row end in an ellipsis,
// and its tooltip shows them whole. Under the lg breakpoint it is a Sheet from its side, which
// holds Tab inside and gives focus back to the trigger. Cmd+B on a Mac, Ctrl+B elsewhere, folds and
// opens it, or the sheet, from anywhere on the page (`keyboardShortcut`); where a page holds
// several, the one holding focus answers, else the first. `storageKey` keeps the person's choice
// in localStorage, and `sidebarStateScript` draws it before the page wakes. A group that folds is a
// SidebarCollapsible, a Collapsible by a `name`, whose fold is kept and drawn the same way. Nothing
// here knows a product: a profile, a theme control or a working mark is the caller's, composed
// into the parts.
//
// The provider's row is the window's height unless its `style` gives the frame's, and under lg
// (the window's width) the sidebar is a Sheet fixed to the window. In a box of its own, such as a
// gallery's card, give the row the box's height and make the box the containing block of what is
// fixed (`contain: layout`, or a transform); or show it with `collapsible="none"`, which never
// turns into a sheet.
//
// An area of the product with a navigation of its own (its settings, one project) is a level: the
// SidebarLevels between the header and the footer hold a SidebarLevel for each, one shown at a
// time, by `value` (the router's). The others stay in the page, unseen and out of reach, so each
// keeps its scroll place and its folded groups.
//
//   <SidebarLevels value={area}>
//     <SidebarLevel value="main">
//       <SidebarContent>…</SidebarContent>
//     </SidebarLevel>
//     <SidebarLevel value="settings">
//       <SidebarLevelHeader>
//         <SidebarMenu>…a SidebarMenuButton that leads back…</SidebarMenu>
//         <SidebarLevelTitle><Icon icon={SettingsIcon} />Settings</SidebarLevelTitle>
//       </SidebarLevelHeader>
//       <SidebarContent aria-label="Settings">…</SidebarContent>
//     </SidebarLevel>
//   </SidebarLevels>
"use client";

import * as stylex from "@stylexjs/stylex";
import { mergeProps, renderElement } from "@ui-sdk/react/primitive";
import { useShortcut, useShortcutHint } from "@ui-sdk/react/shortcuts";
import {
  createContext,
  createElement,
  Fragment,
  use,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  ComponentProps,
  MouseEvent,
  ReactElement,
  ReactNode,
} from "react";

import { useI18n } from "../lib/i18n";
import { ChevronLeftIcon, Icon, PanelLeftIcon } from "../lib/icons";
import { focusRingInset, scrollbarHidden } from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  size,
  space,
} from "../lib/tokens.stylex";
import { durations, px } from "../lib/tokens.values";
import {
  announce,
  className,
  listOf,
  slotProps,
  slotWords,
} from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars, motionVars, skeletonVars } from "../lib/vars.stylex";
import { Collapsible } from "./collapsible";
import { Input } from "./input";
import type { InputProps } from "./input";
import { Sheet, SheetContent } from "./sheet";
import {
  sidebarMarker,
  sidebarMenuItemMarker,
  sidebarWrapperMarker,
} from "./sidebar.stylex";
import { Skeleton } from "./skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";
import type { TooltipProps } from "./tooltip";

/** The keys that fold the sidebar and open it again: Cmd+B on a Mac, Ctrl+B elsewhere. */
export const SIDEBAR_KEYBOARD_SHORTCUT = "mod+b";

// Under the lg breakpoint the sidebar is a sheet: the page is too narrow to stand beside it.
const MOBILE = `(width < ${px.lg}px)`;

// ---- The look ------------------------------------------------------------------------------------

const HOVER = media.hover;
const COARSE = media.pointerCoarse;
const FORCED = media.forcedColors;
const BELOW = media.maxLg;
const ROW = size.sidebarMenuButtonHeight;
const ICON = size.sidebarIcon;
const ACTION = size.sidebarIconButton;
// A count's box: a line of the small words, and its edge above and below.
const BADGE = `calc(${font.textXsLine} + 2 * ${size.hairline})`;
// Folded to its icons, a row is a square the row's height, in the middle of the rail.
const SQUARE_MARGIN = `calc((${size.sidebarRailWidth} - 2 * ${space["2"]} - ${ROW}) / 2)`;
const SQUARE_PADDING = `calc((${ROW} - ${ICON}) / 2)`;
// A level's head: the room round its segment, the segment's corner and the corner of the two parts
// in it, nested inside.
const SEGMENT_INSET = "2px";
const SEGMENT_CORNER = `calc(min(${radius.xl}, calc((${ACTION} + 2 * ${SEGMENT_INSET}) / 2)) - ${SEGMENT_INSET})`;
// The sidebar's state as its parts read it: one that folds to its icons, folded off the canvas,
// and folded to its icons. Each a function the compiler calls, as it reads the styles: a call of
// `stylex.when` itself has no value when the page runs.
const iconSidebar = () =>
  stylex.when.ancestor('[data-collapsible="icon"]', sidebarMarker);
const folded = () =>
  stylex.when.ancestor('[data-state="collapsed"]', sidebarMarker);
// A row with an action of its own (SidebarMenuAction): while the pointer is anywhere on it, and
// while the action's menu is open, the row keeps its hover and the action takes the ink, as the
// original's row and its dots. A row holding a nested list does not light up from a nested row.
const rowWithAction = () =>
  stylex.when.ancestor(
    ':hover:has(> [data-slot="sidebar-menu-action"])',
    sidebarMenuItemMarker
  );
const rowMenuOpen = () =>
  stylex.when.ancestor(
    ':has(> [data-slot="sidebar-menu-action"][aria-expanded="true"])',
    sidebarMenuItemMarker
  );
// In the sheet on a narrow window.
const inSheet = () => stylex.when.ancestor("[data-mobile]", sidebarMarker);
const onRail = () =>
  stylex.when.ancestor(
    '[data-state="collapsed"][data-collapsible="icon"]',
    sidebarMarker
  );
// The aside's width: the sidebar's, none folded off the canvas, `rail` folded to its icons.
const asideWidth = (rail: string) => ({
  default: size.sidebarWidth,
  ':is([data-state="collapsed"][data-collapsible="offcanvas"])': 0,
  ':is([data-state="collapsed"][data-collapsible="icon"])': rail,
});
// A row's room at its end, for an action or a badge beside it while its words show; on the rail,
// `railed`.
const endRoom = (railed: string | number) => ({
  default: size.sidebarRowInline,
  ":has(~ [data-slot=sidebar-menu-action], ~ [data-slot=sidebar-menu-badge])": {
    default: `calc(${ACTION} + ${space["2"]})`,
    [onRail()]: railed,
  },
  [onRail()]: railed,
});

// How far a level travels as it moves in.
const fromEnd = stylex.keyframes({
  from: { opacity: 0, transform: `translateX(${space["4"]})` },
  to: { opacity: 1, transform: "none" },
});
const fromStart = stylex.keyframes({
  from: { opacity: 0, transform: `translateX(calc(-1 * ${space["4"]}))` },
  to: { opacity: 1, transform: "none" },
});

const styles = stylex.create({
  // The row the sidebar and the page stand in: the window's height unless the frame sets its own.
  // What slides off the canvas is cut at its edges. Under an inset page, the sidebar's ground.
  wrapper: {
    display: "flex",
    width: "100%",
    minHeight: "100svh",
    overflowX: "clip",
    backgroundColor: {
      default: null,
      ":has(> [data-variant=inset])": colors.sidebar,
    },
  },

  // The aside holds its room in the row; its width follows the fold.
  aside: {
    position: "relative",
    display: { default: "flex", [BELOW]: "none" },
    flexShrink: 0,
    alignSelf: "stretch",
    width: asideWidth(size.sidebarRailWidth),
    color: colors.sidebarForeground,
    transitionProperty: "width",
    transitionDuration: motionVars.ui,
    transitionTimingFunction: duration.ease,
  },
  // Floating, the panel stands in by space-2: the rail grows by as much on each side.
  asideFloating: {
    width: asideWidth(`calc(${size.sidebarRailWidth} + 2 * ${space["2"]})`),
  },
  // Never folding: as wide as the sidebar, on a phone too, beside what it stands with.
  asideFixed: {
    display: "flex",
    width: size.sidebarWidth,
  },

  // The panel: as tall as the window at most, held in view while the page scrolls past, a layer
  // above the page.
  container: {
    position: "sticky",
    insetBlockStart: 0,
    zIndex: 1,
    display: "flex",
    boxSizing: "border-box",
    width: "100%",
    height: "100%",
    maxHeight: "100svh",
    transitionProperty: "translate, visibility",
    // Hidden only once it has slid away, and shown as it starts to slide in: focus can go to it
    // as soon as it opens.
    transitionDuration: {
      default: `${motionVars.ui}, 0s`,
      [folded()]: motionVars.ui,
    },
    transitionTimingFunction: duration.ease,
  },
  // Off the canvas it keeps its width and slides out past its side, and once gone it is out of
  // reach: hidden, so no tab stop lands on what cannot be seen.
  offcanvas: {
    flexShrink: 0,
    width: size.sidebarWidth,
    visibility: {
      default: null,
      [folded()]: "hidden",
    },
  },
  offcanvasStart: {
    translate: {
      default: null,
      [folded()]: {
        default: "-100% 0",
        ":dir(rtl)": "100% 0",
      },
    },
  },
  // At the end the aside shrinks towards the end and the panel goes with it.
  // Its ground parts it from the page, with no line; in forced colours, where grounds are dropped,
  // a line does.
  edgeStart: {
    borderInlineEndWidth: { default: 0, [FORCED]: size.hairline },
    borderInlineEndStyle: "solid",
    borderInlineEndColor: "CanvasText",
  },
  edgeEnd: {
    borderInlineStartWidth: { default: 0, [FORCED]: size.hairline },
    borderInlineStartStyle: "solid",
    borderInlineStartColor: "CanvasText",
  },
  roomy: { padding: space["2"] },

  // What it holds: the header, the content and the footer, top to bottom.
  // On the sidebar's ground, in an aside or a sheet.
  ground: {
    [iconVars.size]: ICON,
    [iconVars.stroke]: size.iconStroke,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    backgroundColor: colors.sidebar,
    color: colors.sidebarForeground,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  inner: {
    boxSizing: "border-box",
    width: "100%",
    height: "100%",
  },
  floating: {
    borderRadius: radius["2xl"],
    cornerShape: radius.shape,
    borderWidth: size.hairline,
    borderStyle: "solid",
    borderColor: { default: colors.border, [FORCED]: "CanvasText" },
    boxShadow: shadow.sm,
  },
  // In a sheet, on a narrow window: it fills the sheet, on its own ground from edge to edge.
  sheet: {
    flexGrow: 1,
    borderRadius: "inherit",
    cornerShape: "inherit",
  },

  // The page beside it.
  inset: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minWidth: 0,
    // Beside an inset sidebar it is a card on the sidebar's ground, from the lg breakpoint: the
    // same room on every side, folded or open, and a line inside its edge, with no lift.
    backgroundColor: {
      default: colors.background,
      [stylex.when.anySibling('[data-variant="inset"]', sidebarMarker)]: {
        default: colors.background,
        [media.lg]: colors.sidebarCard,
      },
    },
    margin: {
      default: null,
      [stylex.when.anySibling('[data-variant="inset"]', sidebarMarker)]: {
        default: null,
        [media.lg]: size.sidebarCardGap,
      },
    },
    borderRadius: {
      default: null,
      [stylex.when.anySibling('[data-variant="inset"]', sidebarMarker)]: {
        default: null,
        [media.lg]: radius.md,
      },
    },
    cornerShape: radius.shape,
    // The line is a layer over what the card holds, so no bar's ground inside covers it.
    "::after": {
      content: {
        default: null,
        [stylex.when.anySibling('[data-variant="inset"]', sidebarMarker)]: {
          default: null,
          [media.lg]: '""',
        },
      },
      position: "absolute",
      inset: 0,
      borderRadius: "inherit",
      cornerShape: "inherit",
      boxShadow: {
        default: `inset 0 0 0 ${size.hairline} ${colors.sidebarCardBorder}`,
        [FORCED]: `inset 0 0 0 ${size.hairline} CanvasText`,
      },
      pointerEvents: "none",
    },
  },

  // The head: the room above the first row, then what it holds, a hair above the rows.
  header: {
    display: "flex",
    flexDirection: "column",
    gap: space["2"],
    // In the sheet, the sheet's own inset is taken from its room above, so the head stands as high
    // in the window as beside the page, as the original's phone menu stood its head on the bar's row.
    paddingBlockStart: {
      default: space["4"],
      [inSheet()]: `calc(${space["4"]} - ${size.sheetPadding})`,
    },
    paddingBlockEnd: space["1"],
    paddingInline: space["2"],
  },
  footer: {
    display: "flex",
    flexDirection: "column",
    gap: space["2"],
    padding: space["2"],
  },
  // The one part that scrolls, its bar hidden; folded to its icons, nothing scrolls sideways.
  content: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    gap: space["2"],
    minHeight: 0,
    paddingBlock: space["2"],
    overflow: {
      default: "auto",
      [onRail()]: "hidden",
    },
    overscrollBehavior: "contain",
  },
  // A rule that parts the sidebar, as far in as the rows.
  separator: {
    flexShrink: 0,
    height: size.hairline,
    marginInline: space["2"],
    backgroundColor: { default: colors.sidebarBorder, [FORCED]: "CanvasText" },
  },
  input: { display: "flex", flexDirection: "column" },

  group: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: size.sidebarRowGap,
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    paddingInline: space["2"],
  },
  // The small label over a group's menu, its words low in its row, nearer the rows they name;
  // folded to its icons, it gives its room up.
  groupLabel: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space["1"],
    boxSizing: "border-box",
    width: "100%",
    margin: 0,
    paddingBlockStart: space["2"],
    paddingBlockEnd: space["1"],
    paddingInline: size.sidebarRowInline,
    borderWidth: 0,
    borderRadius: radius.sidebarRowRadius,
    cornerShape: radius.shape,
    backgroundColor: "transparent",
    // Drawn as a button or a link (`asChild`), it answers the pointer as a row's words do.
    color: {
      default: colors.sidebarSecondaryForeground,
      [HOVER]: {
        default: null,
        ":is(button, a):hover": colors.sidebarForeground,
      },
    },
    cursor: { default: null, ":is(button, a)": "pointer" },
    fontFamily: font.sans,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontWeight: font.weightMedium,
    textAlign: "start",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textDecoration: "none",
    opacity: {
      default: 1,
      [onRail()]: 0,
    },
    marginBlockStart: {
      default: 0,
      [onRail()]: `calc(-1 * (${font.textXsLine} + ${space["2"]} + ${space["1"]}))`,
    },
    transitionProperty: "margin-block-start, opacity",
    transitionDuration: motionVars.ui,
    transitionTimingFunction: duration.ease,
  },
  groupContent: { width: "100%", fontSize: font.textSm },

  // A small button at the end of a row or a group's label.
  action: {
    position: "absolute",
    display: {
      default: "flex",
      [onRail()]: "none",
    },
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    width: ACTION,
    height: ACTION,
    padding: 0,
    borderWidth: { default: 0, [FORCED]: size.hairline },
    borderStyle: "solid",
    borderColor: "ButtonText",
    // A small icon Button's corner, capped at half its height, as the original drew its row's
    // action: not the row's own.
    borderRadius: `min(${radius.xl}, calc(${ACTION} / 2))`,
    cornerShape: radius.shape,
    color: {
      default: colors.sidebarSecondaryForeground,
      [HOVER]: { default: null, ":hover": colors.sidebarForeground },
    },
    backgroundColor: {
      default: "transparent",
      [HOVER]: { default: null, ":hover": colors.sidebarHover },
      ":is([aria-expanded=true])": colors.sidebarHover,
    },
    cursor: "pointer",
    transitionProperty: "color, background-color, opacity",
    transitionDuration: duration.hover,
  },
  groupAction: {
    insetBlockStart: `calc((${ROW} - ${ACTION}) / 2)`,
    insetInlineEnd: `calc(${space["2"]} + (${ROW} - ${ACTION}) / 2)`,
  },
  // A row's action: a space-1 from the row's end; in the ink while its row is pointed at or holds
  // focus, or its menu is open; filled only under the pointer itself, as the original's dots.
  menuAction: {
    insetBlockStart: {
      default: `calc((${ROW} - ${ACTION}) / 2)`,
      [COARSE]: `calc((${size.tapTarget} - ${ACTION}) / 2)`,
    },
    insetInlineEnd: space["1"],
    color: {
      default: colors.sidebarSecondaryForeground,
      [HOVER]: { default: null, ":hover": colors.foreground },
      [stylex.when.ancestor(":hover", sidebarMenuItemMarker)]: {
        default: null,
        [HOVER]: colors.foreground,
      },
      [stylex.when.ancestor(":focus-within", sidebarMenuItemMarker)]:
        colors.foreground,
      ":is([aria-expanded=true])": colors.foreground,
    },
    backgroundColor: {
      default: "transparent",
      [HOVER]: { default: null, ":hover": colors.accent },
    },
  },
  // Shown while the pointer is on its row, focus is in the row or its menu is open; on a touch
  // screen, always.
  showOnHover: {
    opacity: {
      default: 0,
      [stylex.when.ancestor(":hover", sidebarMenuItemMarker)]: 1,
      [stylex.when.ancestor(":focus-within", sidebarMenuItemMarker)]: 1,
      ":is([aria-expanded=true])": 1,
      [COARSE]: 1,
    },
  },

  menu: {
    display: "flex",
    flexDirection: "column",
    gap: size.sidebarRowGap,
    width: "100%",
    minWidth: 0,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  menuItem: { position: "relative" },

  // A row: its icon and its words, quiet until the pointer is on it or it is the page you are on.
  button: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: size.sidebarIconGap,
    boxSizing: "border-box",
    minWidth: 0,
    // Folded to its icons: a square the row's height, in the middle of the rail, its words cut away.
    width: {
      default: "100%",
      [onRail()]: ROW,
    },
    // A row's height; a name over a second, quieter line (one element marked
    // `data-sidebar-lines`) grows it to hold both.
    minHeight: {
      default: ROW,
      [COARSE]: size.tapTarget,
      [onRail()]: ROW,
    },
    height: {
      default: ROW,
      [COARSE]: size.tapTarget,
      ":has(> [data-sidebar-lines])": "auto",
      [onRail()]: ROW,
    },
    marginBlock: 0,
    marginInline: {
      default: 0,
      [onRail()]: SQUARE_MARGIN,
    },
    paddingBlock: 0,
    paddingInlineStart: {
      default: size.sidebarRowInline,
      [onRail()]: SQUARE_PADDING,
    },
    paddingInlineEnd: endRoom(SQUARE_PADDING),
    borderWidth: { default: 0, [FORCED]: size.hairline },
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: radius.sidebarRowRadius,
    cornerShape: radius.shape,
    overflow: "hidden",
    color: {
      default: colors.sidebarSecondaryForeground,
      [HOVER]: { default: null, ":hover": colors.sidebarForeground },
      [rowWithAction()]: { default: null, [HOVER]: colors.sidebarForeground },
      [rowMenuOpen()]: colors.sidebarForeground,
    },
    backgroundColor: {
      default: "transparent",
      [HOVER]: { default: null, ":hover": colors.sidebarHover },
      [rowWithAction()]: { default: null, [HOVER]: colors.sidebarHover },
      [rowMenuOpen()]: colors.sidebarHover,
    },
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    letterSpacing: size.sidebarTracking,
    textAlign: "start",
    textDecoration: "none",
    whiteSpace: "nowrap",
    cursor: {
      default: "pointer",
      ':is(:disabled, [aria-disabled="true"])': "default",
    },
    opacity: {
      default: null,
      ':is(:disabled, [aria-disabled="true"])': size.opacityDisabled,
    },
    pointerEvents: {
      default: null,
      ':is(:disabled, [aria-disabled="true"])': "none",
    },
    // Its box moves only in a sidebar that folds to its icons, as it folds and opens.
    transitionProperty: {
      default: "color, background-color",
      [iconSidebar()]:
        "color, background-color, width, height, padding, margin",
    },
    transitionDuration: duration.hover,
  },
  // A row's own words: longer than the row, they end in an ellipsis before its end, its action or
  // its count.
  label: {
    flexGrow: 1,
    // It gives way first, down to nothing, before anything beside it (a badge, a mark at its end):
    // flex shrinks by weight times width, so its weight is far past any other's.
    flexShrink: 100_000,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  sm: {
    minHeight: {
      default: size.controlXs,
      [COARSE]: size.tapTarget,
      [onRail()]: ROW,
    },
    height: {
      default: size.controlXs,
      [COARSE]: size.tapTarget,
      [onRail()]: ROW,
    },
    fontSize: font.textXs,
  },
  // A large row (a person, a workspace), in the words read first; it folds to its picture alone.
  lg: {
    borderRadius: radius.sidebarRowRadiusLg,
    cornerShape: radius.shape,
    color: colors.sidebarForeground,
    minHeight: {
      default: size.sidebarMenuButtonHeightLg,
      [onRail()]: ROW,
    },
    height: {
      default: size.sidebarMenuButtonHeightLg,
      [onRail()]: ROW,
    },
    paddingInlineStart: {
      default: size.sidebarRowInline,
      [onRail()]: 0,
    },
    paddingInlineEnd: endRoom(0),
  },
  outline: {
    backgroundColor: {
      default: colors.background,
      [HOVER]: { default: null, ":hover": colors.sidebarHover },
    },
    boxShadow: `inset 0 0 0 ${size.hairline} ${colors.border}`,
  },
  // The trigger: on the page (a page's bar) in the page's ink, as the original's Menu button; in the
  // sidebar itself (its head, by its place in the page, so a dialog opened from the sidebar is the
  // page again) the sidebar's quiet ink, the ink under a pointer.
  trigger: {
    color: {
      default: colors.foreground,
      ":is([data-sidebar=sidebar] *)": colors.sidebarSecondaryForeground,
      [HOVER]: {
        default: null,
        ":is([data-sidebar=sidebar] *):hover": colors.sidebarForeground,
      },
    },
  },
  quiet: { fontWeight: font.weightNormal },
  // Something there not seen yet: its words in the semibold weight, over its variant's.
  unread: { fontWeight: font.weightSemibold },
  // A button that is only its icon (a search in the head, the trigger): round, the icon button's
  // size, a finger's on a touch screen.
  icon: {
    flexShrink: 0,
    justifyContent: "center",
    width: { default: ACTION, [COARSE]: size.tapTarget },
    minHeight: { default: ACTION, [COARSE]: size.tapTarget },
    height: { default: ACTION, [COARSE]: size.tapTarget },
    marginInline: 0,
    paddingInlineStart: 0,
    paddingInlineEnd: 0,
    borderRadius: radius.full,
    // A circle, as the original drew it: the rows' squircle does not reach it.
    cornerShape: "round",
  },
  // The page you are on: ink laid flat over the ground, the words in the ink read first. In forced
  // colours a border marks it.
  active: {
    color: colors.sidebarForeground,
    backgroundColor: colors.sidebarAccent,
    borderColor: { default: "transparent", [FORCED]: "Highlight" },
  },

  // A count at a row's end, quiet, never pressed.
  badge: {
    position: "absolute",
    insetBlockStart: {
      default: `calc((${ROW} - ${BADGE}) / 2)`,
      [COARSE]: `calc((${size.tapTarget} - ${BADGE}) / 2)`,
    },
    insetInlineEnd: space["2"],
    display: {
      default: "flex",
      [onRail()]: "none",
    },
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    minWidth: font.textXsLine,
    height: BADGE,
    paddingInline: size.sidebarCountInline,
    borderWidth: size.hairline,
    borderStyle: "solid",
    borderColor: { default: colors.sidebarBorder, [FORCED]: "CanvasText" },
    borderRadius: radius.full,
    backgroundColor: colors.sidebarCard,
    color: colors.sidebarSecondaryForeground,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontWeight: font.weightMedium,
    fontVariantNumeric: "tabular-nums",
    pointerEvents: "none",
    userSelect: "none",
  },

  // Quiet bars in a row's own box, before the rows arrive.
  skeleton: {
    display: "flex",
    alignItems: "center",
    gap: size.sidebarIconGap,
    height: ROW,
    paddingInline: size.sidebarRowInline,
  },
  // The icon's square, which its Skeleton fills.
  skeletonIcon: {
    [skeletonVars.size]: "100%",
    display: "flex",
    flexShrink: 0,
    width: ICON,
    height: ICON,
  },

  // The rows under a row, their words in line with its words; folded to its icons, they go.
  sub: {
    display: {
      default: "flex",
      [onRail()]: "none",
    },
    flexDirection: "column",
    gap: size.sidebarRowGap,
    minWidth: 0,
    marginBlockStart: size.sidebarRowGap,
    marginBlockEnd: 0,
    marginInline: 0,
    padding: 0,
    listStyle: "none",
  },
  subItem: { position: "relative" },
  subButton: {
    paddingInlineStart: `calc(${size.sidebarRowInline} + ${ICON} + ${size.sidebarIconGap})`,
  },
  subSm: { fontSize: font.textXs },

  // The levels: the room between the header and the footer. The one shown fills it; what moves in
  // is cut at its edges, so nothing shows over the page beside it.
  levels: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minWidth: 0,
    minHeight: 0,
    overflow: "clip",
  },
  // A level moves in from the way the person went (`data-entering`, set once the level has changed,
  // never on the first paint): from the end going deeper, from the start going back. With reduced
  // motion it is simply there.
  level: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minWidth: 0,
    minHeight: 0,
    animationName: {
      default: null,
      ':is([data-entering="forward"])': {
        default: fromEnd,
        ":dir(rtl)": fromStart,
      },
      ':is([data-entering="back"])': {
        default: fromStart,
        ":dir(rtl)": fromEnd,
      },
    },
    animationDuration: motionVars.ui,
    animationTimingFunction: duration.ease,
    animationFillMode: "both",
  },
  // Not shown: laid over the same room, so it keeps its size and its scroll place, unseen, and
  // with `inert` out of reach of Tab, the pointer and a screen reader.
  levelAway: {
    position: "absolute",
    inset: 0,
    visibility: "hidden",
  },
  // The top of a level, a hair under the sidebar's header: the way back and the level's name as one
  // raised row (its segment), in the room a track round it would take.
  levelHeader: {
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    gap: size.sidebarRowGap,
    paddingInline: space["2"],
    paddingBlockStart: space["1"],
  },
  levelTrack: {
    display: "flex",
    boxSizing: "border-box",
    width: "100%",
    padding: { default: SEGMENT_INSET, [onRail()]: 0 },
  },
  // Folded to its icons, the two stand one over the other, each a row's square, flat on the rail.
  levelSegment: {
    display: "flex",
    flexDirection: { default: "row", [onRail()]: "column" },
    flexGrow: 1,
    alignItems: "stretch",
    minWidth: 0,
    borderRadius: SEGMENT_CORNER,
    cornerShape: radius.shape,
    backgroundColor: {
      default: colors.control,
      [FORCED]: "Canvas",
      [onRail()]: "transparent",
    },
    boxShadow: {
      default: `inset 0 0 0 ${size.hairline} ${colors.borderStrongColor}`,
      [FORCED]: "none",
      [onRail()]: "none",
    },
    outline: { default: null, [FORCED]: `${size.hairline} solid CanvasText` },
  },
  // What the segment holds: a row's height, a row's type.
  levelPart: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
    minHeight: { default: ROW, [COARSE]: size.tapTarget, [onRail()]: ROW },
    margin: 0,
    paddingBlock: 0,
    borderWidth: 0,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    letterSpacing: size.sidebarTracking,
    textDecoration: "none",
    whiteSpace: "nowrap",
    backgroundColor: "transparent",
    transitionProperty: "color, background-color",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  // Lit under the pointer: the parts that go somewhere.
  levelPress: {
    cursor: "pointer",
    backgroundColor: {
      default: "transparent",
      [HOVER]: { default: "transparent", ":hover": colors.sidebarHover },
    },
  },
  // The way back: its chevron alone, centred on the rows' icon column, the segment's start corners.
  levelBack: {
    justifyContent: "center",
    flexShrink: 0,
    width: { default: ACTION, [COARSE]: size.tapTarget, [onRail()]: ROW },
    marginInline: { default: 0, [onRail()]: SQUARE_MARGIN },
    borderStartStartRadius: SEGMENT_CORNER,
    borderEndStartRadius: SEGMENT_CORNER,
    borderStartEndRadius: { default: 0, [onRail()]: SEGMENT_CORNER },
    borderEndEndRadius: { default: 0, [onRail()]: SEGMENT_CORNER },
    cornerShape: radius.shape,
    color: {
      default: colors.sidebarSecondaryForeground,
      [HOVER]: {
        default: colors.sidebarSecondaryForeground,
        ":hover": colors.sidebarForeground,
      },
      [FORCED]: "LinkText",
    },
  },
  // A level's name: a heading, holding its icon and words, and with `asChild` the link to the
  // level's own first page. Folded to its icons, its icon alone in a row's square.
  levelTitle: {
    display: "flex",
    flexGrow: { default: 1, [onRail()]: 0 },
    minWidth: 0,
    width: { default: null, [onRail()]: ROW },
    margin: 0,
    marginInline: { default: 0, [onRail()]: SQUARE_MARGIN },
    fontSize: "inherit",
    fontWeight: "inherit",
  },
  levelHome: {
    flexGrow: 1,
    gap: size.sidebarIconGap,
    minWidth: 0,
    overflow: "hidden",
    paddingInline: {
      default: `calc(${size.sidebarRowInline} - ${SEGMENT_INSET})`,
      [onRail()]: SQUARE_PADDING,
    },
    borderStartEndRadius: SEGMENT_CORNER,
    borderEndEndRadius: SEGMENT_CORNER,
    borderStartStartRadius: { default: 0, [onRail()]: SEGMENT_CORNER },
    borderEndStartRadius: { default: 0, [onRail()]: SEGMENT_CORNER },
    cornerShape: radius.shape,
    color: { default: colors.sidebarForeground, [FORCED]: "CanvasText" },
  },
  levelHomeLink: { color: { default: null, [FORCED]: "LinkText" } },
  // A group that folds: the box a Collapsible draws, round its SidebarGroup.
  collapsible: {
    display: "grid",
    width: "100%",
    minWidth: 0,
  },
});

// ---- State ---------------------------------------------------------------------------------------

/** What `useSidebar()` gives: the sidebar's state, and what changes it. */
interface SidebarApi {
  /** `expanded` or `collapsed`, on a wide window. */
  state: "expanded" | "collapsed";
  /** Open on a wide window. */
  open: boolean;
  /** Opens or folds it on a wide window. */
  setOpen: (open: boolean | ((open: boolean) => boolean)) => void;
  /** The sheet is open, on a narrow window. */
  openMobile: boolean;
  /** Opens or closes the sheet, on a narrow window. */
  setOpenMobile: (open: boolean | ((open: boolean) => boolean)) => void;
  /** The window is narrow (under the lg breakpoint): the sidebar is a sheet. */
  isMobile: boolean;
  /** Folds or opens it, or opens or closes the sheet on a narrow window. */
  toggleSidebar: () => void;
}

interface SidebarState extends SidebarApi {
  /** The id of the sidebar's panel, which the trigger controls. */
  id: string;
  /** The keys, as `aria-keyshortcuts` names them and as a person reads them; none when off. */
  keys: { aria: string; text: string } | undefined;
  /** Where the person's choices are kept, when they are. */
  storageKey: string | undefined;
}

const SidebarContext = createContext<SidebarState | null>(null);

const useSidebarState = (part: string): SidebarState => {
  const state = use(SidebarContext);
  if (state === null) {
    throw new Error(`${part} belongs inside a SidebarProvider.`);
  }
  return state;
};

/** The sidebar's state and what changes it, inside a SidebarProvider. */
export const useSidebar = (): SidebarApi => {
  const {
    id: _id,
    keys: _keys,
    storageKey: _storageKey,
    ...api
  } = useSidebarState("useSidebar");
  return api;
};

/** The side the sidebar stands on, for its parts (the tooltips open away from it). */
type Side = "start" | "end";
const SideContext = createContext<Side>("start");

// The kept choice, read where it can be: on the server, and while the page wakes, there is none.
const readKept = (key?: string): boolean | undefined => {
  if (key === undefined) {
    return undefined;
  }
  try {
    const kept = localStorage.getItem(key);
    if (kept === "true") {
      return true;
    }
    return kept === "false" ? false : undefined;
  } catch {
    return undefined;
  }
};

const keep = (key: string | undefined, open: boolean) => {
  if (key === undefined) {
    return;
  }
  try {
    localStorage.setItem(key, String(open));
  } catch {
    // Storage refused (a private window, a full disk): the choice lasts the page.
  }
};

// Another tab's choice shows here too, until the person chooses on this page.
const watchKept = (change: () => void) => {
  window.addEventListener("storage", change);
  return () => {
    window.removeEventListener("storage", change);
  };
};

const watchMobile = (change: () => void) => {
  const query = window.matchMedia(MOBILE);
  query.addEventListener("change", change);
  return () => {
    query.removeEventListener("change", change);
  };
};
const onMobile = () => window.matchMedia(MOBILE).matches;
const notOnMobile = () => false;
const nothingKept = () => readKept();

// Every provider on the page, so that only one answers the keys.
const providers = new Set<HTMLElement>();

/** Whether this provider answers the keys: the one holding focus, else the first on the page. */
const answers = (element: HTMLElement | null) => {
  const active = document.activeElement;
  const all = [
    ...document.querySelectorAll<HTMLElement>('[data-slot="sidebar-wrapper"]'),
  ].filter((each) => providers.has(each));
  const holder = all.find((each) => active !== null && each.contains(active));
  return (holder ?? all[0]) === element;
};

/** A value or an updater of it, applied. */
const applied = (
  value: boolean | ((open: boolean) => boolean),
  now: boolean
) => (typeof value === "function" ? value(now) : value);

/**
 * A state the caller may keep (`given`, with its `onChange`) or leave to the provider, else
 * `fallback`; kept by the caller, the caller's is the only copy. An updater builds on the call
 * before it in the same task (two in one event apply twice, as React's setState): what was set is
 * held until the task ends, whether or not the caller took it.
 */
const useHeld = (
  given: boolean | undefined,
  fallback: boolean,
  onChange: ((now: boolean) => void) | undefined
) => {
  const [own, setOwn] = useState<boolean>();
  const value = given ?? own ?? fallback;
  const unseen = useRef<boolean | null>(null);
  const set = (next: boolean | ((now: boolean) => boolean)) => {
    const now = applied(next, unseen.current ?? value);
    if (unseen.current === null) {
      queueMicrotask(() => {
        unseen.current = null;
      });
    }
    unseen.current = now;
    if (given === undefined) {
      setOwn(now);
    }
    onChange?.(now);
  };
  return [value, set] as const;
};

/**
 * Whether focus can be on an element now: in the page, drawn (not in a folded group, not a nested
 * row or an action the rail hides), not out of reach (`inert`, as a level not shown is), and not in
 * a sidebar folded off the canvas. Its `visibility` is not read: a sidebar sliding in is hidden
 * until its slide has begun, and one sliding away is drawn until it ends.
 */
const inReach = (element: Element) =>
  element.isConnected &&
  element.checkVisibility() &&
  element.closest(
    '[inert], [data-slot="sidebar"][data-collapsible="offcanvas"][data-state="collapsed"]'
  ) === null;

/**
 * Where focus lands in a level it is moved into, or in a sidebar that opened while what held it went:
 * what held it there before, on the way back to a level; else the page you are on, its row before its
 * head's name; else its first
 * stop. One that cannot take focus now (its group folded, its row gone) is passed over.
 */
const landingIn = (level: HTMLElement, opener?: HTMLElement) =>
  [
    opener !== undefined && level.contains(opener) ? opener : null,
    // The page's row first: the level's name in its head may say it is the page too.
    level.querySelector<HTMLElement>(
      '[data-slot="sidebar-content"] [aria-current="page"]'
    ),
    level.querySelector<HTMLElement>('[aria-current="page"]'),
    ...level.querySelectorAll<HTMLElement>("a[href], button:not(:disabled)"),
  ].find((stop) => stop !== null && inReach(stop));

/** Every prop a SidebarProvider takes. */
export interface SidebarProviderProps {
  /** The Sidebar and the SidebarInset beside it. */
  children: ReactNode;
  /** Open now. Pass it with `onOpenChange` to keep the state yourself (a cookie read on the server). */
  open?: boolean;
  /**
   * Open at first, when you do not keep the state and nothing is kept under `storageKey`.
   * @default true
   */
  defaultOpen?: boolean;
  /** Runs with the new state when the trigger or the keys fold or open it. */
  onOpenChange?: (open: boolean) => void;
  /**
   * The sheet is open now, on a narrow window. Pass it with `onOpenMobileChange` to keep the state
   * yourself (a store that outlives the frame, a sign-out that closes it).
   */
  openMobile?: boolean;
  /** Runs with the new state when the trigger, the keys or the sheet itself open or close the sheet. */
  onOpenMobileChange?: (open: boolean) => void;
  /**
   * Where the person's choices are kept in localStorage, so they stay as they left them: whether
   * it is open, and which SidebarCollapsible groups are folded (each under `storageKey:name`). Put
   * `sidebarStateScript(storageKey)` in the page's head to draw them so before the page wakes.
   * Without it nothing is read or kept.
   */
  storageKey?: string;
  /**
   * The keys that fold and open it from anywhere on the page: `mod` is Cmd on a Mac and Ctrl
   * elsewhere. `false` turns them off. In rich text too, unless the editor handles the keys itself
   * (it binds them for bold and marks them handled, `preventDefault`), as every shortcut of UI
   * SDK's is passed over once handled.
   * @default "mod+b"
   */
  keyboardShortcut?: string | false;
  /** Layout only: its height, in a frame of its own. It fills the window's height by default. */
  style?: LayoutStyle;
}

/** Holds whether the sidebar is open, and the row the sidebar and the page stand in. */
export const SidebarProvider = ({
  children,
  open: given,
  defaultOpen = true,
  onOpenChange,
  openMobile: givenMobile,
  onOpenMobileChange,
  storageKey,
  keyboardShortcut = SIDEBAR_KEYBOARD_SHORTCUT,
  style,
}: SidebarProviderProps) => {
  const { toggle } = useI18n().sidebar;
  const kept = useSyncExternalStore(
    watchKept,
    () => readKept(storageKey),
    nothingKept
  );
  const isMobile = useSyncExternalStore(watchMobile, onMobile, notOnMobile);
  const [open, setOpen] = useHeld(given, kept ?? defaultOpen, (now) => {
    keep(storageKey, now);
    onOpenChange?.(now);
  });
  const [openMobile, setOpenMobile] = useHeld(
    givenMobile,
    false,
    onOpenMobileChange
  );
  const id = useId();
  const element = useRef<HTMLDivElement | null>(null);

  // What held focus as the trigger or the keys folded or opened it. Once the change is
  // drawn and the sidebar has slid (none of it with reduced motion), if that went out of reach
  // (folded away with it, hidden on the rail, or a trigger in the page that shows only while the
  // sidebar is away), focus goes to a trigger still in reach, else to the open sidebar's current
  // row; unless it folds or opens again first, which starts its own turn.
  const held = useRef<Element | null>(null);
  const turns = useRef(0);
  useEffect(() => {
    const before = held.current;
    held.current = null;
    if (before === null || inReach(before)) {
      return;
    }
    turns.current += 1;
    const turn = turns.current;
    const wrapper = element.current;
    const sidebar = wrapper?.querySelector<HTMLElement>(
      '[data-slot="sidebar"]'
    );
    const land = () => {
      const active = document.activeElement;
      // Not after another turn, and not over a place the person moved focus to themselves meanwhile.
      if (
        turn !== turns.current ||
        (active !== null && active !== before && active !== document.body)
      ) {
        return;
      }
      const trigger = [
        ...(wrapper?.querySelectorAll<HTMLElement>(
          '[data-slot="sidebar-trigger"]'
        ) ?? []),
      ].find(inReach);
      (trigger ?? (open && sidebar ? landingIn(sidebar) : undefined))?.focus();
    };
    // The slide itself: the panel's own transitions, never what moves inside it (a working mark,
    // a spinner), which may run for ever.
    const sliding =
      sidebar
        ?.querySelector<HTMLElement>('[data-slot="sidebar-container"]')
        ?.getAnimations() ?? [];
    const afterSlide = async () => {
      await Promise.allSettled(
        sliding.map(async ({ finished }) => await finished)
      );
      land();
    };
    void afterSlide();
  });

  const toggleSidebar = () => {
    if (isMobile) {
      setOpenMobile((now) => !now);
      return;
    }
    held.current = document.activeElement;
    setOpen((now) => !now);
  };

  const shortcut = keyboardShortcut === false ? "" : keyboardShortcut;
  // The hint formats a real shortcut only: with none, the default's is read and never shown.
  const hint = useShortcutHint(
    shortcut === "" ? SIDEBAR_KEYBOARD_SHORTCUT : shortcut
  );
  useShortcut(shortcut === "" ? null : shortcut, toggleSidebar, {
    when: () => answers(element.current),
    // The sidebar's own layer: on a narrow window its sheet, so the keys close it as they opened it.
    // The id is escaped: React builds it from the app's identifierPrefix, and a colon or a dot in
    // that would make a bare "#id" an invalid selector, throwing inside the keys' handler.
    layer: () =>
      document.querySelector(`#${CSS.escape(id)}`) ?? element.current,
    description: toggle,
  });

  const watch = (node: HTMLDivElement | null) => {
    element.current = node;
    if (node !== null) {
      providers.add(node);
    }
    return () => {
      if (node !== null) {
        providers.delete(node);
      }
    };
  };

  const state: SidebarState = {
    state: open ? "expanded" : "collapsed",
    open,
    setOpen,
    openMobile,
    setOpenMobile,
    isMobile,
    toggleSidebar,
    id,
    keys:
      shortcut === ""
        ? undefined
        : { aria: hint.ariaKeyshortcuts, text: hint.text },
    storageKey,
  };

  return (
    // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
    <SidebarContext value={state}>
      <div
        ref={watch}
        data-slot="sidebar-wrapper"
        data-sidebar-key={storageKey}
        {...stylex.props(sidebarWrapperMarker, styles.wrapper, style)}
      >
        {children}
      </div>
    </SidebarContext>
  );
};

// A string as a script's literal: JSON's, with `<` escaped too, so no key can close the script tag.
const literal = (text: string) =>
  JSON.stringify(text).replaceAll("<", String.raw`\u003c`);

/** Where a SidebarCollapsible's fold is kept: under the provider's key, by its name. */
const foldKey = (storageKey: string | undefined, name: string) =>
  storageKey === undefined ? undefined : `${storageKey}:${name}`;

/**
 * The head script that draws the kept state before the page wakes, as the theme's does: pass the
 * SidebarProvider's `storageKey`. It sets each of that provider's sidebars folded or open, and each
 * SidebarCollapsible's panel shown or hidden (its label saying so), as the parser reaches them, so
 * nothing moves when React takes over. Run once the page is read (a client router running it again), it sets them
 * once and watches nothing.
 *
 *   <script is:inline set:html={sidebarStateScript("app-sidebar")} />                    Astro
 *   <script dangerouslySetInnerHTML={{ __html: sidebarStateScript("app-sidebar") }} />   React
 */
export const sidebarStateScript = (storageKey: string): string =>
  "(()=>{try{" +
  `const k=${literal(storageKey)},w=${literal(`[data-sidebar-key=${JSON.stringify(storageKey)}] `)},` +
  'g=(n)=>{const v=localStorage.getItem(n);return v==="true"||v==="false"?v:null;},' +
  "d=()=>{const v=g(k);" +
  'if(v)for(const e of document.querySelectorAll(w+"[data-slot=sidebar]"))e.dataset.state=v==="true"?"expanded":"collapsed";' +
  'for(const e of document.querySelectorAll(w+"[data-sidebar-fold]")){' +
  'const f=g(k+":"+e.dataset.sidebarFold);if(!f)continue;' +
  'const p=e.querySelector("[data-slot=collapsible-content],[data-slot=collapsible-panel]"),t=e.querySelector("[aria-expanded]");' +
  'if(p)p[f==="true"?"removeAttribute":"setAttribute"]("hidden","until-found");' +
  'if(t)t.setAttribute("aria-expanded",f);}};' +
  'if(document.readyState!=="loading"){d();return;}' +
  "const o=new MutationObserver(d);o.observe(document,{childList:true,subtree:true});" +
  'addEventListener("DOMContentLoaded",()=>{d();o.disconnect();},{once:true});' +
  "}catch(e){}})()";

// ---- The sidebar ---------------------------------------------------------------------------------

/** Every prop a Sidebar takes. */
export interface SidebarProps {
  /** Its SidebarHeader, SidebarContent and SidebarFooter, top to bottom. */
  children: ReactNode;
  /**
   * The side it stands on. Both follow the reading direction: `start` is the left in English.
   * Put it after the SidebarInset for `end`.
   * @default "start"
   */
  side?: Side;
  /**
   * `sidebar` stands on its own ground beside the page; `floating` is a raised panel a little in
   * from the window's edges; `inset` leaves the page as a card on the sidebar's ground.
   * @default "sidebar"
   */
  variant?: "sidebar" | "floating" | "inset";
  /**
   * How it folds: `offcanvas` slides it off the side, whole; `icon` folds it to a rail of its
   * icons (each row's words show in a tooltip); `none` never folds, on a phone too.
   * @default "offcanvas"
   */
  collapsible?: "offcanvas" | "icon" | "none";
  /**
   * What the sidebar is, said as a landmark.
   * @default the I18nProvider's `sidebar.name` ("Sidebar")
   */
  "aria-label"?: string;
  /** Layout only. */
  style?: LayoutStyle;
}

/** The sidebar: an aside beside the page, or a sheet from its side on a narrow window. */
export const Sidebar = ({
  children,
  side = "start",
  variant = "sidebar",
  collapsible = "offcanvas",
  "aria-label": named,
  style,
}: SidebarProps) => {
  const { name } = useI18n().sidebar;
  const { state, openMobile, setOpenMobile, isMobile, id } =
    useSidebarState("Sidebar");
  const label = named ?? name;
  const floating = variant === "floating";
  // Its ground parts it from the page; in forced colours a line does, on the page's side.
  const edge =
    variant === "sidebar" &&
    (side === "start" ? styles.edgeStart : styles.edgeEnd);

  let sidebar: ReactNode;
  if (collapsible === "none") {
    sidebar = (
      <aside
        aria-label={label}
        data-slot="sidebar"
        data-side={side}
        data-variant={variant}
        data-collapsible="none"
        {...stylex.props(styles.aside, styles.asideFixed, style)}
      >
        <div
          data-sidebar="sidebar"
          {...stylex.props(styles.ground, styles.inner, edge)}
        >
          {children}
        </div>
      </aside>
    );
  } else if (isMobile) {
    sidebar = (
      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        <SheetContent side={side} showCloseButton={false} aria-label={label}>
          <div
            id={id}
            data-slot="sidebar"
            data-sidebar="sidebar"
            data-mobile="true"
            data-side={side}
            {...stylex.props(sidebarMarker, styles.ground, styles.sheet)}
          >
            {children}
          </div>
        </SheetContent>
      </Sheet>
    );
  } else {
    sidebar = (
      <aside
        aria-label={label}
        data-slot="sidebar"
        data-state={state}
        data-collapsible={collapsible}
        data-variant={variant}
        data-side={side}
        // The head script may have set the kept state before React woke.
        suppressHydrationWarning
        {...stylex.props(
          sidebarMarker,
          styles.aside,
          floating && styles.asideFloating,
          style
        )}
      >
        <div
          id={id}
          data-slot="sidebar-container"
          {...stylex.props(
            styles.container,
            collapsible === "offcanvas" && styles.offcanvas,
            collapsible === "offcanvas" &&
              side === "start" &&
              styles.offcanvasStart,
            floating && styles.roomy,
            edge
          )}
        >
          <div
            data-sidebar="sidebar"
            {...stylex.props(
              styles.ground,
              styles.inner,
              floating && styles.floating
            )}
          >
            {children}
          </div>
        </div>
      </aside>
    );
  }
  return <SideContext value={side}>{sidebar}</SideContext>;
};

/** A button's title: its name, and its keys when it has them. */
const titled = (label: string, keys: SidebarState["keys"]) =>
  keys === undefined ? label : `${label} (${keys.text})`;

/** Every prop a SidebarTrigger takes. */
export interface SidebarTriggerProps {
  /** Runs when it is pressed, before it folds or opens the sidebar. */
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  /**
   * Its name.
   * @default the I18nProvider's `sidebar.toggle` ("Show or hide the sidebar")
   */
  "aria-label"?: string;
  /** Layout only. */
  style?: LayoutStyle;
}

/**
 * The button that folds and opens the sidebar, or opens its sheet on a narrow window: a round icon
 * button in the rows' colours. It says whether the sidebar is open and its keys. Put it in the
 * sidebar's head, and in the page's bar for while the sidebar is away.
 */
export const SidebarTrigger = ({
  onClick,
  "aria-label": named,
  style,
}: SidebarTriggerProps) => {
  const { toggle } = useI18n().sidebar;
  const { open, openMobile, isMobile, toggleSidebar, id, keys } =
    useSidebarState("SidebarTrigger");
  const label = named ?? toggle;
  return (
    <button
      type="button"
      data-slot="sidebar-trigger"
      data-sidebar="trigger"
      aria-label={label}
      aria-expanded={isMobile ? openMobile : open}
      aria-controls={isMobile ? undefined : id}
      aria-keyshortcuts={keys?.aria}
      title={titled(label, keys)}
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      {...stylex.props(
        styles.button,
        styles.icon,
        styles.trigger,
        focusRingInset,
        style
      )}
    >
      <Icon icon={PanelLeftIcon} />
    </button>
  );
};

/** Every prop a SidebarInset takes. */
export interface SidebarInsetProps {
  /** The page: its bar, with the SidebarTrigger, and its content. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** The page beside the sidebar: the main landmark, a card on its ground beside an inset sidebar. */
export const SidebarInset = ({ children, style }: SidebarInsetProps) => (
  <main data-slot="sidebar-inset" {...stylex.props(styles.inset, style)}>
    {children}
  </main>
);

// ---- The parts -----------------------------------------------------------------------------------

/** What a layout part takes. */
interface PartProps {
  children?: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** A part's own element's props, less what the part sets itself. */
type Own<Tag extends "a" | "button" | "div" | "h2" | "li" | "nav" | "ul"> =
  Omit<ComponentProps<Tag>, "className" | "style" | "children">;

/**
 * A part that is its element and its look (SidebarHeader, SidebarMenu, …): the element with
 * its slot names (`sidebar-header`, `data-sidebar="header"`) and the caller's props on it.
 */
const part = <Tag extends "div" | "li" | "ul">(
  tag: Tag,
  name: string,
  look: stylex.StyleXStyles,
  { children, style, ...rest }: PartProps & Own<Tag>
) =>
  createElement(
    tag,
    {
      ...rest,
      "data-slot": `sidebar-${name}`,
      "data-sidebar": name,
      ...stylex.props(look, style),
    },
    children
  );

/** Every prop a SidebarHeader takes. */
export interface SidebarHeaderProps extends PartProps, Own<"div"> {
  /** What stands at the top: a workspace's switcher, a search, a SidebarInput. */
  children: ReactNode;
}

/** The top of the sidebar, which stays while the content scrolls. */
export const SidebarHeader = (props: SidebarHeaderProps) =>
  part("div", "header", styles.header, props);

/** Every prop a SidebarFooter takes. */
export interface SidebarFooterProps extends PartProps, Own<"div"> {
  /** What stands at the foot: the person signed in and their menu, a theme control. */
  children: ReactNode;
}

/** The foot of the sidebar, which stays while the content scrolls. */
export const SidebarFooter = (props: SidebarFooterProps) =>
  part("div", "footer", styles.footer, props);

/** Every prop a SidebarContent takes. */
export interface SidebarContentProps extends PartProps, Own<"nav"> {
  /** Its SidebarGroups, top to bottom. */
  children: ReactNode;
  /**
   * What its places are, said as a navigation landmark.
   * @default the I18nProvider's `sidebar.main` ("Main")
   */
  "aria-label"?: string;
}

/** The groups between the header and the footer: a navigation, and the one part that scrolls. */
export const SidebarContent = ({
  children,
  "aria-label": named,
  style,
  ...rest
}: SidebarContentProps) => {
  const { main } = useI18n().sidebar;
  return (
    <nav
      {...rest}
      aria-label={named ?? main}
      data-slot="sidebar-content"
      data-sidebar="content"
      {...stylex.props(styles.content, scrollbarHidden, style)}
    >
      {children}
    </nav>
  );
};

/** Every prop a SidebarSeparator takes. */
export interface SidebarSeparatorProps {
  /** Layout only. */
  style?: LayoutStyle;
}

/** A hairline between the sidebar's parts, as far in as the rows: over the footer, between groups. */
export const SidebarSeparator = ({ style }: SidebarSeparatorProps) => (
  <div
    role="none"
    data-slot="sidebar-separator"
    data-sidebar="separator"
    {...stylex.props(styles.separator, style)}
  />
);

/** Every prop a SidebarInput takes: those of Input. Name it, by `aria-label`. */
export type SidebarInputProps = InputProps;

/** A small field in the sidebar's header: a filter of its rows, a search. */
export const SidebarInput = (props: SidebarInputProps) => (
  <div data-slot="sidebar-input" {...stylex.props(styles.input)}>
    <Input size="sm" {...props} />
  </div>
);

/** What a part that can draw its child instead takes. */
interface SlotPartProps extends PartProps {
  /**
   * Draw the one element given as the child (a link, a CollapsibleTrigger's button) as this part,
   * with the part's look.
   * @default false
   */
  asChild?: boolean;
}

/** A part's props, with `type="button"` when it draws its own button rather than the caller's. */
const asButton = <Rest extends object>(
  asChild: boolean | undefined,
  rest: Rest
) => (asChild === true ? rest : { type: "button", ...rest });

/** A part's own element, or with `asChild` the caller's, with the part's props merged onto it. */
const drawn = (
  tag: string,
  asChild: boolean | undefined,
  children: ReactNode,
  rest: Record<string, unknown>,
  own: Record<string, unknown>
) => {
  const slot = slotProps(asChild, children);
  return renderElement(
    tag,
    mergeProps(rest, own, { children: slot.children }),
    slot.render
  );
};

/**
 * A row's children with its own words (bare text) in one element that ends in an ellipsis where the
 * row does, and those words as one string. An icon, a mark and any element the caller wrote stay as
 * given: StyleX gives a part no selector for its children.
 */
const withLabel = (children: ReactNode) => {
  const parts: ReactNode[] = [];
  let words = "";
  let run = "";
  const flush = () => {
    if (run === "") {
      return;
    }
    parts.push(
      <span
        key={parts.length}
        data-slot="sidebar-menu-label"
        {...stylex.props(styles.label)}
      >
        {run}
      </span>
    );
    words += run;
    run = "";
  };
  for (const child of listOf(children)) {
    if (typeof child === "string" || typeof child === "number") {
      run += String(child);
    } else {
      flush();
      parts.push(<Fragment key={parts.length}>{child}</Fragment>);
    }
  }
  flush();
  return { parts, words };
};

/** Whether a row's own words run past their box. */
const isCut = (row: HTMLElement | null) => {
  const label = row?.querySelector(':scope > [data-slot="sidebar-menu-label"]');
  return (label?.scrollWidth ?? 0) > (label?.clientWidth ?? 0);
};

interface RowElementProps {
  tag: "a" | "button";
  /** The caller's element, with `asChild`. */
  render: ReactElement<Record<string, unknown>> | undefined;
  /** The row's own props and the caller's, merged. */
  base: Record<string, unknown>;
  /** The tooltip repeats the row's own words: it describes nothing new. */
  repeats: boolean;
  children: ReactNode;
}

/**
 * A row's element as its tooltip's trigger: the trigger's props arrive here, merged onto the row,
 * which keeps its own slot.
 */
const RowElement = ({
  tag,
  render,
  base,
  repeats,
  children,
  ...trigger
}: RowElementProps & Record<string, unknown>) => {
  const {
    "aria-describedby": description,
    "data-slot": _slot,
    ...plain
  } = trigger;
  return renderElement(
    tag,
    mergeProps(
      base,
      repeats ? plain : { ...plain, "aria-describedby": description },
      { children }
    ),
    render
  );
};

interface RowProps {
  tag: "a" | "button";
  asChild: boolean | undefined;
  children: ReactNode;
  /** The row's own props and the caller's, merged. */
  base: Record<string, unknown>;
  /** The caller's name for it, shown while the sidebar is folded to its icons. */
  tooltip?: ReactNode;
}

/**
 * A row of the menu (SidebarMenuButton, SidebarMenuSubButton): its words cut where the row ends,
 * and a tooltip at the row's far side that shows them whole while they are cut, or, folded to its
 * icons, the caller's `tooltip`. Not on a narrow window, where nothing hovers.
 */
const Row = ({ tag, asChild, children, base, tooltip }: RowProps) => {
  const { state, isMobile } = useSidebarState("SidebarMenuButton");
  const side = use(SideContext);
  const element = useRef<HTMLElement | null>(null);
  const slot = slotWords(asChild, children);
  const { parts, words } = withLabel(slot.children);
  const named = state === "collapsed" && tooltip !== undefined;
  if (!named && words === "") {
    return renderElement(
      tag,
      mergeProps(base, { children: parts }),
      slot.render
    );
  }
  const onlyWhileCut: TooltipProps["onOpenChange"] = (open, details) => {
    if (open && !named && !isCut(element.current)) {
      details.cancel();
    }
  };
  return (
    <Tooltip disabled={isMobile} onOpenChange={onlyWhileCut}>
      <TooltipTrigger
        asChild
        ref={(node: HTMLElement | null) => {
          element.current = node;
        }}
      >
        <RowElement tag={tag} render={slot.render} base={base} repeats={!named}>
          {parts}
        </RowElement>
      </TooltipTrigger>
      <TooltipContent side={side === "start" ? "end" : "start"}>
        {named ? tooltip : words}
      </TooltipContent>
    </Tooltip>
  );
};

/** Every prop a SidebarGroup takes. */
export interface SidebarGroupProps extends PartProps, Own<"div"> {
  /** Its SidebarGroupLabel, SidebarGroupAction and SidebarGroupContent. */
  children: ReactNode;
}

/** A group of places: a label over a menu. */
export const SidebarGroup = (props: SidebarGroupProps) =>
  part("div", "group", styles.group, props);

/** Every prop a SidebarCollapsible takes. */
export interface SidebarCollapsibleProps {
  /** A SidebarGroup whose SidebarGroupLabel is a CollapsibleTrigger and whose rows stand in a CollapsibleContent. */
  children: ReactNode;
  /**
   * What its fold is kept under, unique among the provider's: with the SidebarProvider's
   * `storageKey`, the person's choice stays as they left it, in every level.
   */
  name: string;
  /** Whether it is open. Pass it with `onOpenChange` to keep the state yourself. */
  open?: boolean;
  /**
   * Open at first, when you do not keep the state and nothing is kept for it.
   * @default true
   */
  defaultOpen?: boolean;
  /** Runs with the new state when its trigger is pressed. */
  onOpenChange?: (open: boolean) => void;
}

/** What takes focus inside an element, in the page's order. */
const stopsIn = (element: HTMLElement | null): HTMLElement[] => [
  ...(element?.querySelectorAll<HTMLElement>(
    "a[href], button, input, [tabindex]"
  ) ?? []),
];

/**
 * A group that folds: a Collapsible whose state the sidebar keeps by `name`, as it keeps whether
 * it is open. The server and the waking page draw `defaultOpen`, and `sidebarStateScript` shows or
 * hides the panel as kept before that; once awake, a kept fold that differs is drawn anew in one
 * step, so nothing opens or folds in front of the person.
 */
export const SidebarCollapsible = ({
  children,
  name,
  open: given,
  defaultOpen = true,
  onOpenChange,
}: SidebarCollapsibleProps) => {
  const key = foldKey(useSidebarState("SidebarCollapsible").storageKey, name);
  const kept = useSyncExternalStore(
    watchKept,
    () => readKept(key),
    nothingKept
  );
  const [own, setOwn] = useState<boolean>();
  // Whether the fold kept differed from the one first drawn, said once, as the page wakes: the
  // Collapsible is then a new one (its key), which starts as kept with nothing to move. Said in a
  // layout effect, so the new one is drawn before the first paint after waking: never a frame of
  // the first one folded where the head script had opened it.
  const [start, setStart] = useState<"first" | "same" | "kept">("first");
  useLayoutEffect(() => {
    const now = readKept(key);
    // oxlint-disable-next-line react/set-state-in-effect -- what the head script drew is known only once the page runs, and must be drawn before it paints
    setStart(now !== undefined && now !== defaultOpen ? "kept" : "same");
  }, [key, defaultOpen]);
  // Drawn anew, the group's elements are new ones: focus that stood in it before the page woke
  // (on its label, most often) is put back on the same stop, or on the first when that one is
  // now folded away.
  const box = useRef<HTMLDivElement>(null);
  const stood = useRef(-1);
  useLayoutEffect(() => {
    const focused = document.activeElement;
    stood.current =
      focused instanceof HTMLElement
        ? stopsIn(box.current).indexOf(focused)
        : -1;
  }, []);
  useLayoutEffect(() => {
    if (start !== "kept" || stood.current === -1) {
      return;
    }
    const stops = stopsIn(box.current);
    const stop = stops[stood.current];
    stood.current = -1;
    stop?.focus();
    if (document.activeElement !== stop) {
      stops[0]?.focus();
    }
  }, [start]);
  return (
    <Collapsible
      key={start === "kept" ? "kept" : "first"}
      asChild
      open={given ?? own ?? kept ?? defaultOpen}
      onOpenChange={(now: boolean) => {
        keep(key, now);
        setOwn(now);
        onOpenChange?.(now);
      }}
    >
      <div
        ref={box}
        data-slot="sidebar-collapsible"
        data-sidebar-fold={name}
        {...stylex.props(styles.collapsible)}
      >
        {children}
      </div>
    </Collapsible>
  );
};

/** Every prop a SidebarGroupLabel takes: these, and the rest of a <div>. */
export interface SidebarGroupLabelProps extends SlotPartProps, Own<"div"> {
  /** The label ("Projects"); with `asChild`, the element that holds it. */
  children: ReactNode;
}

/** The small label over a group's menu, in the rows' ink. Folded to its icons, it gives its room up. */
export const SidebarGroupLabel = ({
  asChild,
  children,
  style,
  ...rest
}: SidebarGroupLabelProps) =>
  drawn("div", asChild, children, rest, {
    "data-slot": "sidebar-group-label",
    "data-sidebar": "group-label",
    // As a SidebarCollapsible's trigger, the head script may have set whether it says it is open
    // before the page woke: that is not a fault.
    suppressHydrationWarning: true,
    ...stylex.props(styles.groupLabel, focusRingInset, style),
  });

/** Every prop a SidebarGroupAction takes: these, and the rest of a <button>. */
export interface SidebarGroupActionProps extends SlotPartProps, Own<"button"> {
  /** Its icon; name it by `aria-label`. With `asChild`, the element drawn. */
  children: ReactNode;
}

/** A small button at the end of a group's label ("Add a project"). */
export const SidebarGroupAction = ({
  asChild,
  children,
  style,
  ...rest
}: SidebarGroupActionProps) =>
  drawn("button", asChild, children, asButton(asChild, rest), {
    "data-slot": "sidebar-group-action",
    "data-sidebar": "group-action",
    ...stylex.props(styles.action, styles.groupAction, focusRingInset, style),
  });

/** Every prop a SidebarGroupContent takes. */
export interface SidebarGroupContentProps extends PartProps, Own<"div"> {
  /** Its SidebarMenu. */
  children: ReactNode;
}

/** What a group holds, under its label. */
export const SidebarGroupContent = (props: SidebarGroupContentProps) =>
  part("div", "group-content", styles.groupContent, props);

/** Every prop a SidebarMenu takes. */
export interface SidebarMenuProps extends PartProps, Own<"ul"> {
  /** Its SidebarMenuItems, in order. */
  children: ReactNode;
}

/** A list of places: links, not a menu of commands, so Tab and Enter do what they do on a page. */
export const SidebarMenu = (props: SidebarMenuProps) =>
  part("ul", "menu", styles.menu, props);

/** Every prop a SidebarMenuItem takes. */
export interface SidebarMenuItemProps extends PartProps, Own<"li"> {
  /** Its SidebarMenuButton, and its SidebarMenuAction, SidebarMenuBadge or SidebarMenuSub. */
  children: ReactNode;
}

/** One place in the menu. */
export const SidebarMenuItem = (props: SidebarMenuItemProps) =>
  part("li", "menu-item", [sidebarMenuItemMarker, styles.menuItem], props);

/** Every prop a SidebarMenuButton takes: these, and the rest of a <button>. */
export interface SidebarMenuButtonProps extends SlotPartProps, Own<"button"> {
  /**
   * An `<Icon />` and the words, as bare text; with `asChild`, the link that holds them
   * (`<a href>`, a router's link). The words end in an ellipsis where the row does, and a tooltip
   * shows them whole while they are cut, giving way before anything beside them. An element you
   * write (a count, a product's working mark) is drawn as given; a name over a second line, in one
   * element marked `data-sidebar-lines`, grows the row to hold both.
   */
  children: ReactNode;
  /**
   * The page you are on: filled, and said as the current page (`aria-current`).
   * @default false
   */
  isActive?: boolean;
  /**
   * What its tooltip says while the sidebar is folded to its icons, when not its own words (a
   * row with a picture and no bare text). Not shown on a narrow window.
   * @default its own words
   */
  tooltip?: ReactNode;
  /**
   * `sm` 28px, `default` 32px, `lg` 46px for a row with a picture and two lines (a workspace, a
   * person), `icon` a round 28px button that is only its icon, named by `aria-label` (a search in
   * the header). On a touch screen all but `lg` are 44px.
   * @default "default"
   */
  size?: "default" | "sm" | "lg" | "icon";
  /**
   * `default` lies on the sidebar's ground, a place's words in the medium weight; `quiet`, a thing
   * in a list of them (a chat, a file), its words in the regular weight, cut and shown whole in a
   * tooltip as any row's; `outline` stands on the page's ground with a hairline.
   * @default "default"
   */
  variant?: "default" | "quiet" | "outline";
  /**
   * Something there the person has not seen yet (an unread chat): its words in the semibold
   * weight, over its variant's, as a mail list draws unread mail. Marked `data-unread`. The
   * weight is only seen, never heard: say "Unread" in words in the row too, as AppShellNav's
   * unread dot does; the button adds no words of its own.
   * @default false
   */
  unread?: boolean;
}

/** A place: a link (with `asChild`) or a button, with its icon and its words. */
export const SidebarMenuButton = ({
  asChild,
  children,
  isActive = false,
  tooltip,
  size: sized = "default",
  variant = "default",
  unread = false,
  style,
  ...rest
}: SidebarMenuButtonProps) => {
  const own = {
    "data-slot": "sidebar-menu-button",
    "data-sidebar": "menu-button",
    "data-size": sized,
    "data-active": isActive ? "true" : undefined,
    "data-unread": unread ? "true" : undefined,
    "aria-current": isActive ? "page" : undefined,
    ...stylex.props(
      styles.button,
      sized === "sm" && styles.sm,
      sized === "lg" && styles.lg,
      sized === "icon" && styles.icon,
      variant === "outline" && styles.outline,
      variant === "quiet" && styles.quiet,
      unread && styles.unread,
      isActive && styles.active,
      focusRingInset,
      style
    ),
  };
  return (
    <Row
      tag="button"
      asChild={asChild}
      base={mergeProps(asButton(asChild, rest), own)}
      tooltip={tooltip}
    >
      {children}
    </Row>
  );
};

/** Every prop a SidebarMenuAction takes: these, and the rest of a <button>. */
export interface SidebarMenuActionProps extends SlotPartProps, Own<"button"> {
  /** Its icon; name it by `aria-label` ("More for Weekly numbers"). With `asChild`, the element drawn. */
  children: ReactNode;
  /**
   * Shown only while the pointer is on its row, focus is in the row or its menu is open; always
   * on a touch screen.
   * @default false
   */
  showOnHover?: boolean;
}

/** A small button at a row's end: its menu, most often (a DropdownMenuTrigger's `asChild`). */
export const SidebarMenuAction = ({
  asChild,
  children,
  showOnHover = false,
  style,
  ...rest
}: SidebarMenuActionProps) =>
  drawn("button", asChild, children, asButton(asChild, rest), {
    "data-slot": "sidebar-menu-action",
    "data-sidebar": "menu-action",
    ...stylex.props(
      styles.action,
      styles.menuAction,
      showOnHover && styles.showOnHover,
      focusRingInset,
      style
    ),
  });

/** Every prop a SidebarMenuBadge takes. */
export interface SidebarMenuBadgeProps extends PartProps, Own<"div"> {
  /** A count of what waits there. */
  children: ReactNode;
}

/** A count at a row's end. */
export const SidebarMenuBadge = (props: SidebarMenuBadgeProps) =>
  part("div", "menu-badge", styles.badge, props);

/** Every prop a SidebarMenuSkeleton takes. */
export interface SidebarMenuSkeletonProps {
  /**
   * A square where the row's icon will be.
   * @default false
   */
  showIcon?: boolean;
  /** Layout only. */
  style?: LayoutStyle;
}

const skeletonWidth = stylex.create({
  words: (width: string) => ({
    display: "flex",
    flexGrow: 1,
    maxWidth: width,
  }),
});

/** A width between half and nine tenths of the row, the same on the server and in the browser. */
const widthOf = (id: string) => {
  let sum = 0;
  for (const letter of id) {
    sum = (sum * 31 + (letter.codePointAt(0) ?? 0)) % 997;
  }
  return `${50 + (sum % 41)}%`;
};

/**
 * Placeholders in a row's own box, before the rows arrive: an icon's square and a line of words. Hidden from a screen reader: say what is
 * loading where the menu stands (`aria-busy`).
 */
export const SidebarMenuSkeleton = ({
  showIcon = false,
  style,
}: SidebarMenuSkeletonProps) => {
  const id = useId();
  return (
    <div
      aria-hidden="true"
      data-slot="sidebar-menu-skeleton"
      data-sidebar="menu-skeleton"
      {...stylex.props(styles.skeleton, style)}
    >
      {showIcon && (
        <span {...stylex.props(styles.skeletonIcon)}>
          <Skeleton variant="rectangular" />
        </span>
      )}
      <span {...stylex.props(skeletonWidth.words(widthOf(id)))}>
        <Skeleton />
      </span>
    </div>
  );
};

/** Every prop a SidebarMenuSub takes. */
export interface SidebarMenuSubProps extends PartProps, Own<"ul"> {
  /** Its SidebarMenuSubItems, in order. */
  children: ReactNode;
}

/** The places within a place, under its row, their words in line with its words. Folded to its icons, they go. */
export const SidebarMenuSub = (props: SidebarMenuSubProps) =>
  part("ul", "menu-sub", styles.sub, props);

/** Every prop a SidebarMenuSubItem takes. */
export interface SidebarMenuSubItemProps extends PartProps, Own<"li"> {
  /** Its SidebarMenuSubButton. */
  children: ReactNode;
}

/** One place within a place. */
export const SidebarMenuSubItem = (props: SidebarMenuSubItemProps) =>
  part("li", "menu-sub-item", styles.subItem, props);

/** Every prop a SidebarMenuSubButton takes: these, and the rest of an <a>. */
export interface SidebarMenuSubButtonProps extends SlotPartProps, Own<"a"> {
  /**
   * Its words, as bare text; with `asChild`, the link that holds them (a router's link). They end
   * in an ellipsis where the row does, and a tooltip shows them whole while they are cut.
   */
  children: ReactNode;
  /**
   * The page you are on: filled, and said as the current page (`aria-current`).
   * @default false
   */
  isActive?: boolean;
  /**
   * `sm` in the small words, `default` in the rows' own.
   * @default "default"
   */
  size?: "sm" | "default";
}

/** A place within a place: a link. */
export const SidebarMenuSubButton = ({
  asChild,
  children,
  isActive = false,
  size: sized = "default",
  style,
  ...rest
}: SidebarMenuSubButtonProps) => (
  <Row
    tag="a"
    asChild={asChild}
    base={mergeProps(rest, {
      "data-slot": "sidebar-menu-sub-button",
      "data-sidebar": "menu-sub-button",
      "data-size": sized,
      "data-active": isActive ? "true" : undefined,
      "aria-current": isActive ? "page" : undefined,
      ...stylex.props(
        styles.button,
        styles.subButton,
        sized === "sm" && styles.subSm,
        isActive && styles.active,
        focusRingInset,
        style
      ),
    })}
  >
    {children}
  </Row>
);

// ---- Levels --------------------------------------------------------------------------------------

interface LevelsState {
  /** The level shown. */
  value: string;
  setValue: (value: string) => void;
  /** A SidebarLevel's element, kept under its value while it is in the page. */
  register: (value: string, element: HTMLElement) => () => void;
}

const LevelsContext = createContext<LevelsState | null>(null);

const useLevels = (name: string): LevelsState => {
  const levels = use(LevelsContext);
  if (levels === null) {
    throw new Error(`${name} belongs inside a SidebarLevels.`);
  }
  return levels;
};

/** Every prop a SidebarLevels takes. */
export interface SidebarLevelsProps {
  /** Its SidebarLevels, the main one first and each deeper one after it. */
  children: ReactNode;
  /**
   * The level shown, when you keep it: the router's (`"settings"` under `/settings`). Pair it
   * with `onValueChange` where a SidebarLevelTrigger changes it.
   */
  value?: string;
  /** The level shown at first, when you do not keep it. One of `value` and `defaultValue` is needed. */
  defaultValue?: string;
  /** Runs with the level a SidebarLevelTrigger asks for. */
  onValueChange?: (value: string) => void;
  /** Layout only. */
  style?: LayoutStyle;
}

/**
 * The levels of a sidebar, between its header and its footer, which stay: the main list, and one
 * for each area that has a navigation of its own. One is shown at a time, the one `value` names;
 * the rest stay in the page, unseen and out of reach, each with its scroll place. A level moves in
 * from the way the person went, by the order the levels stand in the page. When focus was in the
 * level left, it goes to the new one's current row, and on the way back to what held it there
 * before; the new level's name (its SidebarContent's) is said once.
 */
export const SidebarLevels = ({
  children,
  value: given,
  defaultValue,
  onValueChange,
  style,
}: SidebarLevelsProps) => {
  const [own, setOwn] = useState(defaultValue);
  const value = given ?? own;
  if (value === undefined) {
    throw new Error("SidebarLevels needs a `value` or a `defaultValue`.");
  }
  const setValue = (next: string) => {
    setOwn(next);
    onValueChange?.(next);
  };

  // Each level's element, by its value: wherever it stands under here, a wrapper round it or not.
  const elements = useRef(new Map<string, HTMLElement>());
  const register = (name: string, element: HTMLElement) => {
    elements.current.set(name, element);
    return () => {
      if (elements.current.get(name) === element) {
        elements.current.delete(name);
      }
    };
  };
  const shown = useRef(value);
  // What held focus in each level as it was left, for the way back to it.
  const held = useRef(new Map<string, HTMLElement>());
  // The name waiting to be said: a level left again before it was said is never said.
  const saying = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Before the browser paints the new level, and before it takes focus off what is now out of
  // reach: whether focus was in the level left is read while it still says so.
  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = value;
    const from = elements.current.get(before);
    const to = elements.current.get(value);
    if (before === value || to === undefined) {
      return;
    }
    const back =
      from !== undefined &&
      // oxlint-disable-next-line no-bitwise -- the DOM's own flags
      (from.compareDocumentPosition(to) & Node.DOCUMENT_POSITION_PRECEDING) !==
        0;
    if (from !== undefined) {
      delete from.dataset.entering;
    }
    to.dataset.entering = back ? "back" : "forward";
    const name = to
      .querySelector('[data-slot="sidebar-content"]')
      ?.getAttribute("aria-label");
    clearTimeout(saying.current ?? undefined);
    saying.current = null;
    if (name !== null && name !== undefined) {
      saying.current = setTimeout(() => {
        announce(name);
      }, durations.ui);
    }
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || from?.contains(active) !== true) {
      // Focus is elsewhere (the page, the footer's menu): it is not the levels' to move.
      return;
    }
    held.current.set(before, active);
    const target = landingIn(to, back ? held.current.get(value) : undefined);
    held.current.delete(value);
    // The level keeps the scroll place it was left with; only a ring the keys would show out of
    // sight brings its row into view.
    target?.focus({ preventScroll: true });
    if (target?.matches(":focus-visible") === true) {
      target.scrollIntoView({ block: "nearest" });
    }
  }, [value]);
  useEffect(
    () => () => {
      clearTimeout(saying.current ?? undefined);
    },
    []
  );

  return (
    // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
    <LevelsContext value={{ value, setValue, register }}>
      <div data-slot="sidebar-levels" {...stylex.props(styles.levels, style)}>
        {children}
      </div>
    </LevelsContext>
  );
};

/** Every prop a SidebarLevel takes. */
export interface SidebarLevelProps extends PartProps {
  /** Its SidebarLevelHeader, when it is not the main one, and its SidebarContent. */
  children: ReactNode;
  /** What the SidebarLevels' `value` calls it (`"main"`, `"settings"`). */
  value: string;
}

/** One level: a navigation of its own between the header and the footer, shown while it is the SidebarLevels' `value`. */
export const SidebarLevel = ({ children, value, style }: SidebarLevelProps) => {
  const levels = useLevels("SidebarLevel");
  const shown = levels.value === value;
  return (
    <div
      ref={(element) =>
        element === null ? undefined : levels.register(value, element)
      }
      data-slot="sidebar-level"
      data-state={shown ? "active" : "inactive"}
      inert={!shown}
      onAnimationEnd={(event) => {
        // Arrived: nothing is left that could run again when the sidebar is drawn anew.
        if (event.target === event.currentTarget) {
          delete event.currentTarget.dataset.entering;
        }
      }}
      {...stylex.props(styles.level, !shown && styles.levelAway, style)}
    >
      {children}
    </div>
  );
};

/** Whether a part stands in a SidebarLevelHeader, which draws it as a part of its one row. */
const LevelHeaderContext = createContext(false);

/** Every prop a SidebarLevelHeader takes. */
export interface SidebarLevelHeaderProps extends PartProps, Own<"div"> {
  /** The way back (a SidebarLevelTrigger), then the SidebarLevelTitle. */
  children: ReactNode;
}

/**
 * The top of a level, which stays while its content scrolls: the way back, its chevron alone, and
 * the level's name, as one raised row. Folded to its icons, the two stand one over the other.
 */
export const SidebarLevelHeader = ({
  children,
  style,
  ...rest
}: SidebarLevelHeaderProps) => (
  <div
    {...rest}
    data-slot="sidebar-level-header"
    data-sidebar="level-header"
    {...stylex.props(styles.levelHeader, style)}
  >
    <div {...stylex.props(styles.levelTrack)}>
      <div
        data-slot="sidebar-level-segment"
        {...stylex.props(styles.levelSegment)}
      >
        <LevelHeaderContext value>{children}</LevelHeaderContext>
      </div>
    </div>
  </div>
);

/** Every prop a SidebarLevelTitle takes: these, and the rest of an <h2>. */
export interface SidebarLevelTitleProps extends PartProps, Own<"h2"> {
  /**
   * An `<Icon />` (or a picture of the level's own) and the level's name, as bare text
   * ("Settings"); with `asChild`, the link to the level's own first page that holds them. Folded to
   * its icons, the sidebar shows the icon alone.
   */
  children: ReactNode;
  /**
   * Draws the one element given as the child (`<a href>`, a router's link) inside the heading: the
   * name opens the level's own first page.
   * @default false
   */
  asChild?: boolean;
  /**
   * The level's own first page is the page you are on (`aria-current`).
   * @default false
   */
  isActive?: boolean;
}

/** A level's name: a heading beside the way back, and with `asChild` the link to its first page. */
export const SidebarLevelTitle = ({
  children,
  asChild,
  isActive = false,
  style,
  ...rest
}: SidebarLevelTitleProps) => {
  const slot = slotWords(asChild, children);
  return (
    <h2
      {...rest}
      data-slot="sidebar-level-title"
      data-sidebar="level-title"
      {...stylex.props(styles.levelTitle, style)}
    >
      {renderElement(
        "span",
        {
          "aria-current": isActive ? "page" : undefined,
          className: className(
            styles.levelPart,
            styles.levelHome,
            slot.render !== undefined && [
              styles.levelPress,
              styles.levelHomeLink,
              focusRingInset,
            ]
          ),
          children: withLabel(slot.children).parts,
        },
        slot.render
      )}
    </h2>
  );
};

/** Every prop a SidebarLevelTrigger takes: a SidebarMenuButton's, and the level it shows. */
export interface SidebarLevelTriggerProps extends Omit<
  SidebarMenuButtonProps,
  "value" | "children"
> {
  /** The level it shows: that SidebarLevel's `value`. */
  value: string;
  /**
   * An `<Icon />` and the words; with `asChild`, the link that holds them. In a SidebarLevelHeader
   * it is the way back, its chevron alone: give it no words (with `asChild`, an empty link) and name
   * it with `aria-label` ("Back").
   */
  children?: ReactNode;
}

/**
 * A row that shows another level, in a sidebar that keeps the level itself: a SidebarMenuButton, a
 * link with `asChild`. The row into a level and the way back are both one; in a SidebarLevelHeader
 * it is the way back, the head's chevron. Where the address says which level is shown, it is a
 * link too, the router's, and the address decides.
 */
export const SidebarLevelTrigger = ({
  value,
  onClick,
  children,
  asChild,
  "aria-label": named,
  style,
  isActive,
  tooltip,
  size: sized,
  variant,
  ...rest
}: SidebarLevelTriggerProps) => {
  const { setValue } = useLevels("SidebarLevelTrigger");
  const inHeader = use(LevelHeaderContext);
  const { back } = useI18n().sidebar;
  const show = (event: MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (!event.defaultPrevented) {
      setValue(value);
    }
  };
  if (!inHeader) {
    return (
      <SidebarMenuButton
        {...rest}
        asChild={asChild}
        isActive={isActive}
        tooltip={tooltip}
        size={sized}
        variant={variant}
        aria-label={named}
        style={style}
        onClick={show}
      >
        {children}
      </SidebarMenuButton>
    );
  }
  const slot = slotWords(asChild, children);
  const label = named ?? back;
  return renderElement(
    "button",
    mergeProps(rest, {
      type: slot.render === undefined ? "button" : undefined,
      "aria-label": label,
      title: label,
      "data-slot": "sidebar-level-back",
      className: className(
        styles.levelPart,
        styles.levelPress,
        styles.levelBack,
        focusRingInset,
        style
      ),
      onClick: show,
      children:
        listOf(slot.children).length > 0 ? (
          slot.children
        ) : (
          <Icon icon={ChevronLeftIcon} />
        ),
    }),
    slot.render
  );
};
