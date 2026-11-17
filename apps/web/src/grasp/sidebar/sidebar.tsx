"use client";

import * as stylex from "@stylexjs/stylex";
import {
  createElement,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { MouseEvent, ReactElement, ReactNode, RefObject } from "react";

import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { ChevronLeft, Icon, Search, SidebarToggle } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { layoutOf } from "../layout/layout";
import type { LayoutStyle } from "../layout/layout";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { useFoldKeys } from "./fold-keys";
import { SidebarNav } from "./nav";
import type { SidebarFilter } from "./nav";
import { SidebarProfile } from "./profile";
import type { SidebarProfileProps } from "./profile";
import { RowActions, rowActionsRoom } from "./row-actions";
import type { RowActionProps } from "./row-actions";
import {
  SectionHead,
  SidebarTabs,
  SwapArea,
  TabPanel,
  listKey,
  useSwap,
} from "./section";
import type { SidebarBack, SidebarTab } from "./section";
import { useSidebarInShell } from "./shell";
import type { SidebarInShell } from "./shell";

/**
 * One of a row's own rows, under its name: a link to a page within it. With `actions` it has three
 * dots at its end and their menu; with `onRename` it can be renamed in place (row-actions.tsx).
 */
export interface SidebarSubRow extends Omit<RowActionProps, "label"> {
  /** What tells this row from the others in its list, when two may share a name. @default `label` and `href` */
  id?: string;
  /** The page's name ("Requests"). It names the link. */
  label: string;
  /** Where it goes. Leave it out when `render` gives the link. */
  href?: string;
  /**
   * The link itself, when a router draws it: `<Link to="/workflows/requests" />`. It takes the
   * row's look, its name and `aria-current`.
   */
  render?: ReactElement;
  /** The page you are on: the selected fill, said as the current page. */
  current?: boolean;
}

/** One row: a link to a page, with its icon, and a count where something waits. */
export interface SidebarRow extends SidebarSubRow {
  /** An icon before the name. From the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /** How many things wait there: a small pill at the row's end. None at 0. */
  count?: number;
  /**
   * What a screen reader hears of the count instead of the bare number ("3 things waiting").
   * @default the number
   */
  countLabel?: string;
  /** Runs when the row is pressed. A row with neither `href` nor `render` is a button. */
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  /** Its own rows, under its name: the pages within it. */
  rows?: readonly SidebarSubRow[];
  /** More words the filter finds it by, beside its name ("dropdown" for Select). */
  keywords?: readonly string[];
  /**
   * A second, quieter line under its name ("Expense approval, Sanne"): the row grows to two lines.
   * For a list of what happened (Activity).
   */
  detail?: string;
  /** Short words at the row's end, quiet, instead of a count: when it happened ("2m"). */
  end?: string;
  /**
   * What a screen reader hears of `end` ("2 minutes ago").
   * @default `end`
   */
  endLabel?: string;
}

/** A run of rows, with a label over it when it is not the main one. */
export interface SidebarGroup {
  /**
   * The name of a part this group starts, over its label: a level above the group labels, for a
   * long list in a few parts ("Docs", "Components"). The groups after it belong to it until the
   * next group with a part.
   */
  part?: string;
  /** Where the part's name leads, its own page (an overview): the name is then a link. */
  partHref?: string;
  /** The part's own page is the one open: its name takes the current look. */
  partCurrent?: boolean;
  /** A small label over the rows ("From your Apps"). Leave it out for the first, main run. */
  label?: string;
  /** Its rows, in order. */
  rows: readonly SidebarRow[];
  /** What its fold is kept under in `storageKey`. @default its label */
  id?: string;
  /** Its label is a button that folds the rows away and opens them again. Needs a `label`. */
  collapsible?: boolean;
  /** Folded at first, when nothing is kept and you do not keep it in state. @default false */
  defaultCollapsed?: boolean;
  /** Folded or open, when you keep it in state. Pair it with `onCollapsedChange`. */
  collapsed?: boolean;
  /** Called with the new state when its label folds or opens it. */
  onCollapsedChange?: (collapsed: boolean) => void;
  /** A number beside its label (how many rows). While filtering, the number that match instead. */
  count?: number;
}

/**
 * A section of the product that takes the sidebar (Settings, one agent): Back at the top, its name,
 * then its own groups, between the head and the foot, which stay. The host passes it while the
 * person is in the section, and leaves it out elsewhere.
 */
export interface SidebarSection {
  /** What tells this section from another, for the swap between them. @default `title` */
  id?: string;
  /** Its name, under Back ("Settings"). It names its navigation too, unless `navLabel` does. */
  title: string;
  /** An icon before its name. From the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /** The host's own mark before its name, in the icon's box (an agent's colour), instead of `icon`. */
  mark?: ReactNode;
  /** The Back row at the top: a link to the parent or the last main page. */
  back: SidebarBack;
  /** Its rows, in runs, top to bottom, as the main list's `groups`. */
  groups: readonly SidebarGroup[];
  /** Where its groups' folds are kept in localStorage, apart from the main list's. */
  storageKey?: string;
  /** What its rows are, said to a screen reader as a navigation landmark. @default `title` */
  navLabel?: string;
}

export type { SidebarBack, SidebarTab } from "./section";

/** What a caller may style: where the sidebar sits and how tall it is. Never its look or width. */
export type SidebarLayoutStyle = LayoutStyle;

/** Every prop a Sidebar takes. */
export interface SidebarProps {
  /** The rows, in runs, top to bottom. */
  groups: readonly SidebarGroup[];
  /**
   * What stands at the top start: the product's mark, or a link home holding it. The head gives it
   * a 20px box (shell-mark), and an svg or img passed here fills that box, even one with no width or
   * height of its own. For the mark with the product's name beside it, use App shell's `brand`.
   */
  head?: ReactNode;
  /**
   * The product's mark and name, as a link home, at the start of the head (wider than `head`'s 20px
   * mark box). Shown while the sidebar is open or peeking; folded away it is left out, as the host's
   * bar holds it then on a narrow shell (App shell's `brandIn="sidebar"` passes it here).
   */
  brand?: ReactNode;
  /** Shows a search button at the top, and runs when it is pressed (to open the search). */
  onSearch?: () => void;
  /**
   * The search button's name.
   * @default "Search"
   */
  searchLabel?: string;
  /** The keys that open the search elsewhere, shown in the button's title ("⌘K"). */
  searchShortcut?: string;
  /**
   * The same keys as a screen reader hears them, in aria-keyshortcuts' form ("Meta+K Control+K"),
   * set on the search button.
   */
  searchKeyShortcuts?: string;
  /**
   * At the head's end, after search: what the host closes the sidebar's layer with (App shell's
   * menu puts its sheet's close button here, so the menu has one head). Shown only while it fills.
   */
  headEnd?: ReactNode;
  /**
   * Under the head, before the rows: what the host puts there while it fills its layer (App shell's
   * menu puts the bar's section switch here on a phone, so the head stays first).
   */
  headBelow?: ReactNode;
  /** The person signed in, at the foot, with their menu. */
  profile?: SidebarProfileProps;
  /** Open at first, when you do not keep it in state. @default true */
  defaultOpen?: boolean;
  /** Open or folded away, when you keep it in state. Pair it with `onOpenChange`. */
  open?: boolean;
  /** Called with the new state when the fold opens or folds it. */
  onOpenChange?: (open: boolean) => void;
  /**
   * The keys that fold the sidebar away and open it again, from anywhere on the page: `mod` is Cmd on
   * a Mac and Ctrl elsewhere ("mod+b", "ctrl+shift+s"). Shown in the fold button's tooltip. `false`
   * turns them off. Not in the phone's menu, and not in rich text, where the same keys make text bold.
   * Where a page holds several sidebars, the one holding focus answers, else the first.
   * @default "mod+b"
   */
  foldShortcut?: string | false;
  /**
   * The fold button's name, at the top, and the name of the button that opens it again.
   * @default "Show or hide the sidebar"
   */
  foldLabel?: string;
  /**
   * What the sidebar is, said to a screen reader as a landmark.
   * @default "Sidebar"
   */
  label?: string;
  /**
   * What its rows are, said to a screen reader as a navigation landmark.
   * @default "Main"
   */
  navLabel?: string;
  /**
   * Fills its container's width, for a sheet or a panel it stands alone in, so its rows and its
   * foot run to the edge. Beside a page, leave it off: it is 240px wide.
   * @default false
   */
  fill?: boolean;
  /**
   * Folded, a button at the top start corner opens it again, floating above the page's card. Pass
   * `false` for a host that draws its own button to open it.
   * @default true
   */
  reopen?: boolean;
  /**
   * How the reopen button looks: `raised`, a white control of its own that reads over any page or
   * backdrop; `quiet`, a bare icon, for a white bar it stands in (App shell's page bar).
   * @default "raised"
   */
  reopenLook?: "raised" | "quiet";
  /**
   * A field at the top of the rows that filters them by name and `keywords`: groups with no match
   * hide, the rest open. Escape clears it and ↓ moves into the rows.
   */
  filter?: SidebarFilter;
  /** The filter field, so the page can focus it from a key of its own. */
  filterRef?: RefObject<HTMLInputElement | null>;
  /** Where the groups' folds are kept in localStorage, so they stay as the person left them. */
  storageKey?: string;
  /**
   * `tab`: every row is a tab stop, as links on any page. `list`: the rows are one tab stop, and
   * ↑/↓, Home and End move among the rows and group labels, → opens a group and ← folds it.
   * @default "tab"
   */
  keys?: "tab" | "list";
  /**
   * On a narrow window (under 48rem), open, it covers the page as a card of its own, and its fold
   * closes it. `false` for a host that keeps it in a column of its own there (App shell does).
   * @default true
   */
  cover?: boolean;
  /**
   * The section the person is in: its list takes the place of `groups`, with Back and its name on
   * top. The head and the foot stay. Leave it out on the main list.
   */
  section?: SidebarSection;
  /**
   * Tabs under the head, for the main list only (Home, Activity): the host passes the list for the
   * chosen one as `groups`. Inside a section they give way to Back and the section's name.
   */
  tabs?: readonly SidebarTab[];
  /** The chosen tab's `value`, when you keep it in state. Pair it with `onTabChange`. @default the first */
  tab?: string;
  /** Called with the `value` of the tab the person chooses. */
  onTabChange?: (value: string) => void;
  /**
   * What the tabs are, said to a screen reader.
   * @default "Views"
   */
  tabsLabel?: string;
  /** One quiet sentence where the rows would be, when the list has none ("Nothing needs you yet"). */
  empty?: string;
  /** Layout only: where it sits and how tall it is. */
  style?: SidebarLayoutStyle;
  /** The same as `style`, by a name a style lint does not take for an inline style attribute. */
  layout?: SidebarLayoutStyle;
}

export type { SidebarFilter } from "./nav";

/** How long the pointer rests on the edge before the sidebar peeks in, in ms. */
const PEEK_AFTER = 120;

/** How long the pointer may be off the peeking sidebar before it goes, in ms. */
const LEAVE_AFTER = 240;

const HOVER = media.hover;
const COARSE = media.coarse;
const FORCED = media.forced;

// The fade past a peek's end (F85): twice the page's room wide; the card's ground whole for its first
// 12px, three quarters at 24px, clear at its end.
const BAND = `calc(2 * ${grasp.shellPageInline})`;
const BAND_STOPS = `${grasp.shellCard} ${grasp.space3}, color-mix(in oklch, ${grasp.shellCard} 75%, transparent) ${grasp.space6}, transparent`;

// The reopen button coming in once the fold has made room for it.
const revealIn = stylex.keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});

const styles = stylex.create({
  aside: {
    position: "relative",
    display: "flex",
    flexShrink: 0,
    alignSelf: "stretch",
    width: grasp.shellSidebar,
    height: "100%",
    minHeight: 0,
    transitionProperty: "width",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  // Opened by its reopen button, the panel keeps its whole width and comes in from the start under
  // the page card's moving edge, as it slides out on a fold (App shell FRESH.md F58): it stands at
  // the column's end and what is not in yet is cut off at the column's start.
  asideUnfolds: { justifyContent: "flex-end", overflowX: "clip" },
  // Where it covers the page on a narrow window it is no column: nothing there to cut.
  asideUnfoldsCovers: {
    overflowX: { default: "clip", [media.belowTablet]: "visible" },
  },
  // Opened from a peek, the panel is already in: it stays over the card, which slides away under it.
  asideFromPeek: { zIndex: grasp.shellLayer },
  // Folded, it is a layer of its own above the page's card, so its reopen button and its peek
  // stand over the card in any host.
  // In a sheet, or any container it should fill (`fill`): its rows and its foot run to the edge.
  filled: {
    width: "100%",
    // The sheet round it is a card (12px round): the person button at its foot nests in that (F71b).
    "--grasp-sidebar-corner": grasp.shellCardCorner,
  },
  asideFolded: { width: 0, zIndex: grasp.shellLayer },
  // In forced colours its own end line only where nothing else draws that edge: filling a sheet, the
  // sheet's border does (App shell FLAWS.md F31); in App shell's column, the card's outline beside it
  // does (F23). Two lines there stood 1px and 6px apart.
  edgeless: { borderInlineEndWidth: 0 },
  // What the sidebar holds, standing in its place while it is open.
  panel: {
    display: "flex",
    // Never squeezed while its column grows or shrinks: its rows keep their width (F58).
    flexShrink: 0,
    boxSizing: "border-box",
    width: grasp.shellSidebar,
    height: "100%",
    overflow: "hidden",
    backgroundColor: grasp.shellGround,
    // In forced colours the ground is dropped, so a line marks its edge.
    borderInlineEndWidth: { default: 0, [FORCED]: grasp.hairline },
    borderInlineEndStyle: "solid",
    borderInlineEndColor: "CanvasText",
  },
  // Folded, it waits off the start edge, and slides in over the page as a floating card while it
  // peeks. In right to left it waits off the right edge. It leaves from the very box it had in its
  // column (no step down or in as the fold starts, App shell FLAWS.md F12), and floats in from the
  // window's edges, rounding its corners, only as it peeks.
  panelFolded: {
    position: "absolute",
    insetBlock: 0,
    insetInlineStart: 0,
    height: "auto",
    borderRadius: 0,
    // Its lift only while it peeks: waiting off the edge, its wide shadow would tint the page's edge.
    boxShadow: "none",
    borderWidth: { default: 0, [FORCED]: grasp.hairline },
    borderStyle: "solid",
    borderColor: "CanvasText",
    transform: {
      default: `translateX(calc(-100% - 2 * ${grasp.shellInset}))`,
      ":dir(rtl)": `translateX(calc(100% + 2 * ${grasp.shellInset}))`,
    },
    // Hidden once it has slid away (visibility turns at the end of its time), so nothing in it can
    // be pressed or seen where it waits, past the start edge: not by a pointer, a tool or a reader.
    visibility: "hidden",
    transitionProperty:
      "transform, box-shadow, visibility, inset-block-start, inset-block-end, inset-inline-start, border-radius, background-color",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  // Peeking it reads lifted in both themes (App shell FRESH.md F66): in dark a step lighter than the
  // card it lies on, with a shadow that shows on a dark card, never a darker hole in the page.
  panelPeeking: {
    insetBlock: grasp.shellInset,
    insetInlineStart: grasp.shellInset,
    borderRadius: grasp.shellCardCorner,
    transform: { default: "none", ":dir(rtl)": "none" },
    backgroundColor: grasp.shellPeek,
    boxShadow: grasp.shellPeekShadow,
    visibility: "visible",
    // A card of its own while it peeks: what nests at its corners takes its corner (F71b).
    "--grasp-sidebar-corner": grasp.shellCardCorner,
  },
  // Past the end of the panel while it lies over the page (a peek, or covering on a narrow window),
  // the page goes under the card's ground (App shell FRESH.md F85): solid for its first 12px, so no
  // letter is seen cut at the panel's edge, then easing to clear over the next 36px, so the words come
  // up gradually; top to bottom, as the bar's start fades whole under a peek (F76). Under the panel in
  // its layer, so the panel's shadow still falls on it (F66), and it rides in and out with the panel,
  // from further off so its edge is never ahead of the panel's.
  band: {
    position: "absolute",
    insetBlock: grasp.shellInset,
    insetInlineStart: `calc(${grasp.shellInset} + ${grasp.shellSidebar})`,
    width: BAND,
    pointerEvents: "none",
    backgroundImage: {
      default: `linear-gradient(to right, ${BAND_STOPS})`,
      ":dir(rtl)": `linear-gradient(to left, ${BAND_STOPS})`,
    },
    display: { default: "block", [FORCED]: "none" },
    transform: {
      default: `translateX(calc(-1 * (${grasp.shellSidebar} + 3 * ${grasp.shellInset} + ${BAND})))`,
      ":dir(rtl)": `translateX(calc(${grasp.shellSidebar} + 3 * ${grasp.shellInset} + ${BAND}))`,
    },
    visibility: "hidden",
    transitionProperty: "transform, visibility",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  bandShown: { transform: "none", visibility: "visible" },
  // Open over the page on a narrow window: on the covering card's layer, under the card itself.
  bandCovers: {
    zIndex: { default: null, [media.belowTablet]: grasp.shellLayer },
    transform: {
      default: `translateX(calc(-1 * (${grasp.shellSidebar} + 3 * ${grasp.shellInset} + ${BAND})))`,
      ":dir(rtl)": `translateX(calc(${grasp.shellSidebar} + 3 * ${grasp.shellInset} + ${BAND}))`,
      [media.belowTablet]: { default: "none", ":dir(rtl)": "none" },
    },
    visibility: { default: "hidden", [media.belowTablet]: "visible" },
  },
  // What opens from the sidebar (the person's menu, a host's menu in its head) stands on the shell's
  // own surfaces, not the system's tinted popup (App shell FRESH.md F84): every popup inside it reads
  // these through popup-fill and popup-line. Menus open in place (the top layer), so they inherit them.
  surfaces: {
    "--grasp-popup-fill": grasp.shellPopup,
    "--grasp-popup-line": grasp.shellPopupLine,
  },
  // Pinned from a peek (its fold pressed while it peeks): it eases from the peek's floating box into
  // the very box it has in its column, its insets, corner and lift going together on the fold's time,
  // never a step in one frame (App shell FRESH.md F81). Laid over its column's box, which is the
  // same; on a narrow window where it covers the page it keeps that card's place instead.
  panelPinning: {
    position: { default: "absolute", [media.belowTablet]: "absolute" },
    insetBlock: { default: 0, [media.belowTablet]: grasp.shellInset },
    insetInlineStart: { default: 0, [media.belowTablet]: grasp.shellInset },
    zIndex: { default: null, [media.belowTablet]: grasp.shellLayer },
    height: "auto",
    borderRadius: { default: 0, [media.belowTablet]: grasp.shellCardCorner },
    boxShadow: { default: "none", [media.belowTablet]: grasp.shellCardShadow },
    "--grasp-sidebar-corner": {
      default: null,
      [media.belowTablet]: grasp.shellCardCorner,
    },
    transitionProperty:
      "inset-block-start, inset-block-end, inset-inline-start, border-radius, box-shadow, background-color",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  // The start edge, where resting the pointer brings it back.
  edge: {
    position: "absolute",
    insetBlock: 0,
    insetInlineStart: 0,
    width: grasp.shellInset,
  },
  inner: {
    [iconVars.size]: grasp.shellIcon,
    [iconVars.stroke]: grasp.iconStroke,
    display: "flex",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    minHeight: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.shellText,
  },
  // The head: the mark at the start, search and the fold at the end.
  // The brand at the head's start, cut short before the icon buttons; gone while folded, back while it peeks.
  brand: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
    paddingInlineStart: grasp.shellRowInline,
  },
  brandFolded: { display: "none" },
  // The bar's brand, which App shell hands the head for a peek (App shell FRESH.md F76): the peek
  // covers the bar's start, so while it peeks its head says which product it is, as the phone's
  // menu does (F18). Drawn only while folded (unseen and out of reach until it peeks) or pinned from
  // a peek, where it fades out as the bar gets its brand back; it fades out as the peek leaves too.
  peekBrand: {
    opacity: 1,
    transitionProperty: "opacity, visibility",
    transitionDuration: simply.leave,
    transitionTimingFunction: grasp.ease,
  },
  peekBrandAway: { opacity: 0, visibility: "hidden" },
  head: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.shellRowGap,
    paddingBlockStart: grasp.shellHead,
    paddingInlineStart: grasp.shellGutter,
    // The fold's glyph ends where the rows' ink ends (a count's pill, 16px in: the gutter and a row's
    // side room), not 2px past it: its button's empty rim hangs out into that room (FLAWS.md F21).
    paddingInlineEnd: {
      default: `calc(${grasp.shellGutter} + ${grasp.shellRowInline} - (${grasp.shellIconButton} - ${grasp.shellIcon}) / 2)`,
      [COARSE]: `calc(${grasp.shellGutter} + ${grasp.shellRowInline} - (${grasp.tap} - ${grasp.shellIcon}) / 2)`,
    },
    paddingBlockEnd: grasp.space1,
  },
  // Peeking, the panel floats shellInset in from the top: its head rises by as much, so peeking it
  // stands on the bar's row it covers, as pinned (App shell FLAWS.md F10). Folded, the two move
  // together, so the head's row never steps while the panel floats in or out.
  headMoves: {
    transitionProperty: "padding-block-start",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  headFloating: {
    paddingBlockStart: `calc(${grasp.shellHead} - ${grasp.shellInset})`,
  },
  mark: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    height: grasp.shellIconButton,
    paddingInlineStart: grasp.shellRowInline,
    color: grasp.shellText,
  },
  // The mark's own 20px box.
  markBox: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: grasp.shellMark,
    height: grasp.shellMark,
  },
  // The caller's svg or img fills the box, whatever size it has of its own.
  markFill: {
    display: "block",
    width: "100%",
    height: "100%",
    objectFit: "contain",
  },
  tools: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    // The bar's rule between its parts, 12px ink to ink (FLAWS.md F08), here too: each button's
    // empty rim round its glyph counts toward it (FRESH.md F77: 14px before). A finger's buttons
    // stand side by side, their glyphs as near as their 44px boxes let them.
    gap: {
      default: `calc(${grasp.space3} - (${grasp.shellIconButton} - ${grasp.shellIcon}))`,
      [COARSE]: 0,
    },
    marginInlineStart: "auto",
  },
  // The host's control at the head's end (headEnd): on a finger, a tap-sized box of its own, so its
  // press area and search's sit side by side and never overlap.
  headEnd: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: { default: null, [COARSE]: grasp.tap },
    minHeight: { default: null, [COARSE]: grasp.tap },
  },
  iconButton: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    boxSizing: "border-box",
    width: { default: grasp.shellIconButton, [COARSE]: grasp.tap },
    height: { default: grasp.shellIconButton, [COARSE]: grasp.tap },
    padding: 0,
    // A control keeps an edge in forced colours, where its hover fill is dropped.
    borderWidth: { default: 0, [FORCED]: grasp.hairline },
    borderStyle: "solid",
    borderColor: "ButtonText",
    // The system's one button corner, as a Button xs has it: the same shape as the bar's Menu
    // button and the sheet's close beside these (App shell FLAWS.md F35).
    borderRadius: `min(${grasp.corner}, calc(${grasp.shellIconButton} / 2))`,
    cornerShape: grasp.cornerShape,
    color: {
      default: grasp.shellTextSecondary,
      [HOVER]: { default: grasp.shellTextSecondary, ":hover": grasp.shellText },
    },
    backgroundColor: {
      default: "transparent",
      [HOVER]: { default: "transparent", ":hover": grasp.shellHover },
    },
    cursor: "pointer",
    transitionProperty: "color, background-color",
    transitionDuration: grasp.shellAnswer,
    transitionTimingFunction: grasp.ease,
  },
  // On a phone the sidebar is in a sheet, which closes as any sheet does: no fold there.
  // In a sheet, which closes as any sheet does: no fold there.
  foldGone: { display: "none" },
  // On a narrow window the open sidebar covers the page as a card of its own, rather than leaving
  // the page a sliver beside it; its fold closes it again.
  asideCovers: {
    width: { default: grasp.shellSidebar, [media.belowTablet]: 0 },
  },
  panelCovers: {
    position: { default: null, [media.belowTablet]: "absolute" },
    insetBlock: { default: null, [media.belowTablet]: grasp.shellInset },
    insetInlineStart: { default: null, [media.belowTablet]: grasp.shellInset },
    zIndex: { default: null, [media.belowTablet]: grasp.shellLayer },
    height: { default: "100%", [media.belowTablet]: "auto" },
    borderRadius: { default: null, [media.belowTablet]: grasp.shellCardCorner },
    boxShadow: { default: null, [media.belowTablet]: grasp.shellCardShadow },
    "--grasp-sidebar-corner": {
      default: null,
      [media.belowTablet]: grasp.shellCardCorner,
    },
  },
  // Folded, the button that opens it again stands at the top start corner of the host's card (which
  // stands shellInset in), centred on its bar's row (shellBar), its glyph where the page's words
  // begin (shellPageInline in), as an App shell's bar starts its ink (App shell FLAWS.md F09); an App
  // shell keeps its bar clear of it (bar.tsx REOPEN_INK_END).
  // It is placed from the column's end, where the card begins: folded, the column is no width and it
  // stands where it always did; while the fold plays it rides in with the card's edge, never on the
  // ground outside it (App shell FLAWS.md F12). It comes in a beat after the card starts, once the
  // bar's crumbs have made room for it, and fades away while the sidebar peeks over it (F60).
  reveal: {
    position: "absolute",
    insetBlockStart: {
      default: `calc(${grasp.shellInset} + (${grasp.shellBar} - ${grasp.shellIconButton}) / 2)`,
      [COARSE]: `calc(${grasp.shellInset} + (${grasp.shellBar} - ${grasp.tap}) / 2)`,
    },
    insetInlineStart: {
      default: `calc(100% + ${grasp.shellInset} + ${grasp.shellPageInline} - (${grasp.shellIconButton} - ${grasp.shellIcon}) / 2)`,
      [COARSE]: `calc(100% + ${grasp.shellInset} + ${grasp.shellPageInline} - (${grasp.tap} - ${grasp.shellIcon}) / 2)`,
    },
    opacity: 1,
    transitionProperty: "opacity, color, background-color",
    transitionDuration: `${simply.leave}, ${grasp.shellAnswer}, ${grasp.shellAnswer}`,
    transitionTimingFunction: grasp.ease,
  },
  // While it peeks, the panel slides in over it: it stays where it is and fades, so nothing at the
  // bar's start jumps or flies with the panel (App shell FRESH.md F60).
  revealUnder: { opacity: 0, pointerEvents: "none" },
  // Folded by the person: it fades in a beat after the card starts to move (F12). A page that loads
  // folded shows it at once, with nothing arriving.
  revealArrives: {
    animationName: revealIn,
    animationDuration: simply.leave,
    animationDelay: simply.stagger,
    animationTimingFunction: grasp.ease,
    animationFillMode: "backwards",
  },
  // Raised: a white control of its own, the card's fill with the soft edge and low lift, so it
  // reads over anything, a busy backdrop too. Hover and press change its icon's ink only, on the
  // same surface, so nothing moves. In forced colours a real border draws it.
  raised: {
    backgroundColor: grasp.shellCard,
    boxShadow: grasp.liftLow,
    borderWidth: { default: 0, [FORCED]: grasp.hairline },
    borderStyle: "solid",
    borderColor: "CanvasText",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.shellRowGap,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  sub: { marginBlockStart: grasp.shellRowGap },
  row: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: grasp.shellIconGap,
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    // A finger needs 44px: on a touch screen the row is that tall.
    height: { default: grasp.shellRow, [COARSE]: grasp.tap },
    margin: 0,
    paddingBlock: grasp.shellRowBlock,
    paddingInline: grasp.shellRowInline,
    borderWidth: 0,
    borderStyle: "solid",
    borderColor: "CanvasText",
    borderRadius: grasp.shellCorner,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    letterSpacing: grasp.shellTracking,
    color: {
      default: grasp.shellTextSecondary,
      [HOVER]: { default: grasp.shellTextSecondary, ":hover": grasp.shellText },
    },
    backgroundColor: {
      default: "transparent",
      [HOVER]: { default: "transparent", ":hover": grasp.shellHover },
    },
    textDecoration: "none",
    textAlign: "start",
    whiteSpace: "nowrap",
    cursor: "pointer",
    transitionProperty: "color, background-color",
    transitionDuration: grasp.shellAnswer,
    transitionTimingFunction: grasp.ease,
  },
  // A row under a row: its name lines up with the name above.
  subRow: {
    paddingInlineStart: `calc(${grasp.shellRowInline} + ${grasp.shellIcon} + ${grasp.shellIconGap})`,
  },
  // Where the person is. In forced colours the fill is dropped, so a border marks it.
  current: {
    color: grasp.shellText,
    backgroundColor: grasp.shellSelected,
    borderWidth: { default: 0, [FORCED]: grasp.hairline },
  },
  name: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "0%",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  // A row with a second line (Activity): as tall as its lines, its name in ink (it asks for the
  // person, so it never reads as dimmed), its second line and its end quiet.
  rowTall: {
    height: "auto",
    minHeight: { default: grasp.shellRow, [COARSE]: grasp.tap },
    paddingBlock: grasp.space2,
    alignItems: "flex-start",
    color: grasp.shellText,
  },
  // In a tall row the icon stands on the name's line, not the middle of every line.
  onFirstLine: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    height: grasp.textSmLine,
  },
  words: { display: "flex", flexDirection: "column" },
  wordsLine: { overflow: "hidden", textOverflow: "ellipsis" },
  // The second line: smaller and quieter than the name.
  // Up to two lines, so a row keeps its point at the sidebar's width; cut only past them. In the
  // muted ink (5.5:1 on the ground), firmer than the shell's secondary (4.86:1) for 12px words.
  detail: {
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
    whiteSpace: "normal",
    textWrap: "pretty",
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightRegular,
    letterSpacing: "normal",
    color: grasp.muted,
  },
  // Short words at the row's end (a time): quiet, never cut.
  // On the name's line: the name's line height, so it stands level with it in a tall row.
  end: {
    flexShrink: 0,
    marginInlineStart: "auto",
    fontSize: grasp.textXs,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightRegular,
    letterSpacing: "normal",
    fontVariantNumeric: "tabular-nums",
    color: grasp.muted,
  },
  // One quiet sentence where the rows would be.
  empty: {
    margin: 0,
    paddingBlockStart: `calc(${grasp.shellGutter} + ${grasp.shellRowBlock})`,
    paddingInline: `calc(${grasp.shellGutter} + ${grasp.shellRowInline})`,
    textWrap: "pretty",
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.shellTextSecondary,
  },
  // A count: a small pill at the row's end.
  count: {
    flexShrink: 0,
    marginInlineStart: "auto",
    paddingInline: grasp.shellCountInline,
    borderWidth: grasp.hairline,
    borderStyle: "solid",
    borderColor: grasp.shellRule,
    borderRadius: grasp.cornerPill,
    backgroundColor: grasp.shellCard,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
    letterSpacing: "normal",
    fontVariantNumeric: "tabular-nums",
    color: grasp.shellTextSecondary,
  },
  // The foot: a rule over the person, then the person. The rule stops the gutter in from each side,
  // as the rules between the groups do (FRESH.md F78: it ran edge to edge into the window's ring),
  // and the person's button stands in the same gutter.
  foot: {
    display: "flex",
    flexShrink: 0,
    justifyContent: "center",
    paddingBlock: grasp.shellGutter,
    paddingInline: 0,
    marginInline: grasp.shellGutter,
    borderBlockStartWidth: grasp.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: { default: grasp.shellRule, [FORCED]: "CanvasText" },
  },
});

// The brand's place in the head: there while the sidebar is open or peeking, folded away otherwise.
const brandLook = (open: boolean, peeking: boolean) =>
  open || peeking ? null : styles.brandFolded;

// The host's control at the head's end, only while the sidebar fills its layer and there is one.
const HeadEnd = ({
  shown,
  children,
}: {
  shown: boolean;
  children: ReactNode;
}) => {
  if (!shown || children === undefined) {
    return null;
  }
  return (
    <span data-slot="sidebar-head-end" {...stylex.props(styles.headEnd)}>
      {children}
    </span>
  );
};

// The host's row under the head, only while the sidebar fills its layer and there is one.
const HeadBelow = ({
  shown,
  children,
}: {
  shown: boolean;
  children: ReactNode;
}) => {
  if (!shown || children === undefined) {
    return null;
  }
  return <div data-slot="sidebar-head-below">{children}</div>;
};

/** Words only a screen reader reads. */
const Unseen = ({ children }: { children: ReactNode }) => (
  <span {...stylex.props(visuallyHidden)}>{children}</span>
);

/** The row's element: the caller's link, a plain link, or a button. */
/** What a row gives the caller's link element: its look, its name and whether it is the page. */
interface LinkProps {
  className?: string;
  style?: ReturnType<typeof stylex.props>["style"];
  children?: ReactNode;
  "aria-current"?: "page";
  "data-sidebar-item"?: string;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
}

const Linked = ({
  row,
  item,
  look,
  children,
  onClick,
}: {
  row: SidebarSubRow;
  item: boolean;
  look: ReturnType<typeof stylex.props>;
  children: ReactNode;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
}) => {
  const shared = {
    "aria-current": row.current === true ? ("page" as const) : undefined,
    "data-sidebar-item": item ? "" : undefined,
    onClick,
  };
  if (row.render !== undefined && isValidElement<LinkProps>(row.render)) {
    const own = row.render.props.className;
    const props: LinkProps = {
      ...shared,
      ...look,
      className: [own, look.className]
        .filter((part) => part !== undefined && part !== "")
        .join(" "),
      children,
    };
    // The caller's element again, its own props and the row's together.
    return createElement(row.render.type, { ...row.render.props, ...props });
  }
  if (row.href !== undefined) {
    return (
      <a href={row.href} {...shared} {...look}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" {...shared} {...look}>
      {children}
    </button>
  );
};

/** A row's words: its name, and its second line under it when it has one. */
const RowWords = ({
  label,
  detail,
}: {
  label: string;
  detail: string | undefined;
}) => {
  if (detail === undefined || detail === "") {
    return <span {...stylex.props(styles.name)}>{label}</span>;
  }
  return (
    <span {...stylex.props(styles.name, styles.words)}>
      <span {...stylex.props(styles.wordsLine)}>{label}</span>
      <span {...stylex.props(styles.detail)}>{detail}</span>
    </span>
  );
};

/** The row's quiet words at its end (a time), with what a screen reader hears of them. */
const RowEnd = ({
  end,
  label,
}: {
  end: string | undefined;
  label: string | undefined;
}) => {
  if (end === undefined || end === "") {
    return null;
  }
  const said = label !== undefined && label !== "";
  return (
    <>
      <span aria-hidden={said ? true : undefined} {...stylex.props(styles.end)}>
        {end}
      </span>
      {said && <Unseen>{` ${label}`}</Unseen>}
    </>
  );
};

const hasDetail = (row: SidebarRow) =>
  row.detail !== undefined && row.detail !== "";

/** The row's icon; in a tall row, on the name's line. */
const RowIcon = ({
  icon,
  tall,
}: {
  icon: IconData | undefined;
  tall: boolean;
}) => {
  if (icon === undefined) {
    return null;
  }
  return tall ? (
    <span aria-hidden="true" {...stylex.props(styles.onFirstLine)}>
      <Icon icon={icon} />
    </span>
  ) : (
    <Icon icon={icon} />
  );
};

/** Whether a row has its own menu, so keeps room at its end for the dots. */
const hasActions = (row: SidebarSubRow) =>
  row.actions !== undefined && row.actions.length > 0;

/** A row under a row, with its actions where it has them. */
const SubRow = ({ sub, item }: { sub: SidebarSubRow; item: boolean }) => {
  const look = stylex.props(
    styles.row,
    styles.subRow,
    sub.current === true && styles.current,
    hasActions(sub) && rowActionsRoom,
    focus.inside
  );
  return (
    <RowActions {...sub} look={look}>
      <Linked row={sub} item={item} look={look}>
        <span {...stylex.props(styles.name)}>{sub.label}</span>
      </Linked>
    </RowActions>
  );
};

const Row = ({ row, item }: { row: SidebarRow; item: boolean }) => {
  const counted = row.count !== undefined && row.count > 0;
  const { onClick: handleClick } = row;
  const look = stylex.props(
    styles.row,
    hasDetail(row) && styles.rowTall,
    row.current === true && styles.current,
    hasActions(row) && rowActionsRoom,
    focus.inside
  );
  return (
    <li>
      <RowActions {...row} look={look}>
        <Linked row={row} item={item} onClick={handleClick} look={look}>
          <RowIcon icon={row.icon} tall={hasDetail(row)} />
          <RowWords label={row.label} detail={row.detail} />
          <RowEnd end={row.end} label={row.endLabel} />
          {counted && (
            <>
              <span aria-hidden="true" {...stylex.props(styles.count)}>
                {row.count}
              </span>
              <Unseen>{` ${row.countLabel ?? String(row.count)}`}</Unseen>
            </>
          )}
        </Linked>
      </RowActions>
      {row.rows !== undefined && row.rows.length > 0 && (
        <ul {...stylex.props(styles.list, styles.sub)}>
          {row.rows.map((sub) => (
            <li key={sub.id ?? `${sub.label}-${sub.href ?? ""}`}>
              <SubRow item={item} sub={sub} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
};

/** While it is folded, the peeking panel stays while the pointer or the keys are on it, and goes
 * when they leave it or on Escape. Returns the clean-up. */
const watchPeek = (
  element: HTMLElement,
  on: { stay: () => void; leave: () => void; close: () => void }
) => {
  const blur = (event: FocusEvent) => {
    const to = event.relatedTarget;
    if (!(to instanceof Node && element.contains(to))) {
      on.close();
    }
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      on.close();
    }
  };
  // Sliding in, the panel passes under a pointer resting on the edge and leaves it there: leaving
  // for the edge is not leaving.
  const left = (event: PointerEvent) => {
    const to = event.relatedTarget;
    if (
      to instanceof Element &&
      to.closest("[data-slot=sidebar-edge]") !== null
    ) {
      on.stay();
      return;
    }
    on.leave();
  };
  element.addEventListener("pointerenter", on.stay);
  element.addEventListener("pointerleave", left);
  element.addEventListener("focusin", on.stay);
  element.addEventListener("focusout", blur);
  element.addEventListener("keydown", escape);
  return () => {
    element.removeEventListener("pointerenter", on.stay);
    element.removeEventListener("pointerleave", left);
    element.removeEventListener("focusin", on.stay);
    element.removeEventListener("focusout", blur);
    element.removeEventListener("keydown", escape);
  };
};

/** Whether a key was pressed in a layer open inside the panel (the person's menu, a popover, a
 * dialog): its own Escape closes it first, and the panel waits for the next (App shell F42). */
const inLayer = (
  panel: HTMLElement | null,
  target: EventTarget | null
): boolean => {
  const layer =
    target instanceof Element
      ? target.closest(
          '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], [popover]'
        )
      : null;
  return layer !== null && layer !== panel && panel?.contains(layer) === true;
};

/** While the open sidebar covers the page (a narrow window), Escape closes it, as any covering
 * panel closes; beside the page, Escape is left to what has focus. */
const useCoverEscape = (
  panel: RefObject<HTMLDivElement | null>,
  covering: boolean,
  close: () => void
) => {
  useEffect(() => {
    const element = covering ? panel.current : null;
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !inLayer(element, event.target) &&
        window.matchMedia("(width < 48rem)").matches
      ) {
        event.preventDefault();
        close();
      }
    };
    element?.addEventListener("keydown", escape);
    return () => {
      element?.removeEventListener("keydown", escape);
    };
  });
};

/** The caller's mark, made to fill its box: an svg or img with no size of its own fills it too. */
const Mark = ({ head }: { head: ReactElement<{ className?: string }> }) => {
  const look = stylex.props(styles.markFill);
  const className = [head.props.className, look.className]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  return createElement(head.type, { ...head.props, className });
};

/** The head's mark, in its 20px box; nothing when there is none. */
const HeadMark = ({ head }: { head: ReactNode }) =>
  head === undefined ? null : (
    <div {...stylex.props(styles.mark)}>
      <span {...stylex.props(styles.markBox)}>
        {isValidElement<{ className?: string }>(head) ? (
          <Mark head={head} />
        ) : (
          head
        )}
      </span>
    </div>
  );

/** Search, at the head's end, with the keys that open it elsewhere in its title. App shell stands
 * the same button in its bar while the sidebar is folded (`brandIn="sidebar"`). */
export const SearchButton = ({
  onSearch,
  label,
  shortcut,
  keys,
}: {
  onSearch?: () => void;
  label: string;
  shortcut?: string;
  keys?: string;
}) => {
  if (onSearch === undefined) {
    return null;
  }
  const title =
    shortcut !== undefined && shortcut !== ""
      ? `${label} (${shortcut})`
      : label;
  return (
    <button
      type="button"
      aria-label={label}
      aria-keyshortcuts={keys}
      title={title}
      onClick={() => {
        onSearch();
      }}
      {...stylex.props(styles.iconButton, focus.ring)}
    >
      <Icon icon={Search} />
    </button>
  );
};

/** Folded, the button at the top start corner that opens it again; faded under the panel while it
 * peeks; none when the host draws its own. */
const Reopen = ({
  ref,
  reopen,
  peeking,
  look,
  label,
  title,
  keys,
  controls,
  arrives,
  onOpen,
}: {
  ref: RefObject<HTMLButtonElement | null>;
  reopen: boolean;
  peeking: boolean;
  look: "raised" | "quiet";
  label: string;
  /** Its tooltip: the name, with the keys that do the same. */
  title: string;
  /** The keys, as a screen reader hears them. */
  keys: string | undefined;
  controls: string;
  /** The person folded it here: it fades in as it arrives. */
  arrives: boolean;
  onOpen: (byKeys: boolean) => void;
}) =>
  reopen ? (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={title}
      aria-keyshortcuts={keys}
      aria-expanded={false}
      aria-controls={controls}
      onClick={(event) => {
        onOpen(event.detail === 0);
      }}
      {...stylex.props(
        styles.iconButton,
        styles.reveal,
        arrives && styles.revealArrives,
        look === "raised" && styles.raised,
        peeking && styles.revealUnder,
        focus.ring
      )}
    >
      <Icon icon={SidebarToggle} />
    </button>
  ) : null;

/** Where the sidebar stands and how wide: beside the page, filling a sheet, or folded away. */
const asideLook = ({
  open,
  fill,
  cover,
  fromPeek,
}: {
  open: boolean;
  fill: boolean;
  cover: boolean;
  fromPeek: boolean;
}) => [
  styles.aside,
  styles.surfaces,
  open && !fill && !fromPeek && styles.asideUnfolds,
  open && !fill && !fromPeek && cover && styles.asideUnfoldsCovers,
  open && !fill && fromPeek && styles.asideFromPeek,
  cover && !fill && styles.asideCovers,
  fill && styles.filled,
  !open && styles.asideFolded,
];

/** The fade past the panel's end while it lies over the page: peeking, or open over it on a narrow
 * window; away with the panel otherwise. None in a layer it fills. */
const PageFade = ({
  open,
  fill,
  cover,
  peeking,
}: {
  open: boolean;
  fill: boolean;
  cover: boolean;
  peeking: boolean;
}) =>
  fill ? null : (
    // A span, so the sidebar's own direct divs stay its edge alone (a host's tests find it so).
    <span
      aria-hidden="true"
      data-slot="sidebar-page-fade"
      {...stylex.props(
        styles.band,
        !open && peeking && styles.bandShown,
        open && cover && styles.bandCovers
      )}
    />
  );

/** The panel: in its column, covering the page on a narrow window, folded away, peeking, or pinned
 * from a peek. */
const panelLook = ({
  open,
  fill,
  cover,
  peeking,
  fromPeek,
  beside,
}: {
  open: boolean;
  fill: boolean;
  cover: boolean;
  peeking: boolean;
  fromPeek: boolean;
  beside: boolean | undefined;
}) => [
  styles.panel,
  fill && styles.filled,
  (fill || (beside === true && open && !cover)) && styles.edgeless,
  open && cover && !fill && styles.panelCovers,
  open && fromPeek && !fill && styles.panelPinning,
  !open && styles.panelFolded,
  !open && peeking && styles.panelPeeking,
];

/** The head: it floats up with the panel while it peeks, and moves with it while folded and as a
 * peek is pinned (F81). */
const headLook = (open: boolean, peeking: boolean, fromPeek: boolean) => [
  styles.head,
  (!open || fromPeek) && styles.headMoves,
  !open && peeking && styles.headFloating,
];

/** Whether this change opens the sidebar from a peek, the panel already in over the page. */
const opensFromPeek = (next: boolean, open: boolean, peeking: boolean) =>
  next && !open && peeking;

/** Whether a list has no rows at all. */
const isEmpty = (groups: readonly SidebarGroup[]) =>
  groups.every((group) => group.rows.length === 0);

/** Back, drawn as one of the sidebar's rows, with the chevron that points back. */
const BackRow = ({ back }: { back: SidebarBack & { label: string } }) => (
  <ul {...stylex.props(styles.list)}>
    <Row
      row={{
        label: back.label,
        href: back.href,
        render: back.render,
        onClick: back.onClick,
        icon: ChevronLeft,
      }}
      item={false}
    />
  </ul>
);

interface ListAreaProps {
  id: string;
  list: string;
  area: RefObject<HTMLDivElement | null>;
  groups: readonly SidebarGroup[];
  section: SidebarSection | undefined;
  tabs: readonly SidebarTab[] | undefined;
  tab: string | undefined;
  onTabChange: ((value: string) => void) | undefined;
  tabsLabel: string | undefined;
  navLabel: string;
  filter: SidebarFilter | undefined;
  filterRef: RefObject<HTMLInputElement | null> | undefined;
  storageKey: string | undefined;
  keys: "tab" | "list" | undefined;
  empty: string | undefined;
}

/** The list between the head and the foot: the main list (under its tabs), or a section's. */
const ListArea = ({
  id,
  list,
  area,
  groups,
  section,
  tabs,
  tab,
  onTabChange,
  tabsLabel = "Views",
  navLabel,
  filter,
  filterRef,
  storageKey,
  keys,
  empty,
}: ListAreaProps) => {
  const [ownTab, setOwnTab] = useState<string>();
  const tabbed = section === undefined && tabs !== undefined && tabs.length > 0;
  const chosen = tab ?? ownTab ?? tabs?.[0]?.value ?? "";
  const shown = section?.groups ?? groups;
  const nav = (
    <>
      {empty !== undefined && empty !== "" && isEmpty(shown) && (
        <p {...stylex.props(styles.empty)}>{empty}</p>
      )}
      <SidebarNav
        groups={shown}
        label={
          section === undefined ? navLabel : (section.navLabel ?? section.title)
        }
        id={id}
        filter={filter}
        filterRef={filterRef}
        storageKey={section === undefined ? storageKey : section.storageKey}
        keys={keys}
        renderRow={(row, item) => (
          <Row
            key={row.id ?? `${row.label}-${row.href ?? ""}`}
            row={row}
            item={item}
          />
        )}
      />
    </>
  );
  return (
    <SwapArea key={list} ref={area}>
      {section !== undefined && (
        <SectionHead
          title={section.title}
          icon={section.icon}
          mark={section.mark}
          back={section.back}
          backLabel={section.back.label}
          renderBack={(back) => <BackRow back={back} />}
        />
      )}
      {tabbed && (
        <SidebarTabs
          id={id}
          tabs={tabs}
          value={chosen}
          label={tabsLabel}
          onChoose={(value) => {
            setOwnTab(value);
            onTabChange?.(value);
          }}
        />
      )}
      {tabbed ? (
        <TabPanel id={id} value={chosen}>
          {nav}
        </TabPanel>
      ) : (
        nav
      )}
    </SwapArea>
  );
};

/** What App shell hands the Sidebar beside its props (shell.ts): it hears each fold and peek, and the
 * bar's brand for the head of a peek. */
interface ShellExtras {
  onOpen?: (open: boolean) => void;
  onPeek?: (peeking: boolean) => void;
  peekBrand?: ReactNode;
  /** In App shell's column, beside the page's card, whose outline draws the edge between them. */
  beside?: boolean;
}

/** Tells App shell each time the sidebar starts or stops peeking over the page (FRESH.md F76). */
const useTellPeek = (
  onPeek: ((peeking: boolean) => void) | undefined,
  peeking: boolean
) => {
  useLayoutEffect(() => {
    onPeek?.(peeking);
  }, [onPeek, peeking]);
};

/** The bar's brand in the head of a peek (FRESH.md F76): drawn only while folded, or pinned from a
 * peek (it fades out then): open in its column the bar holds the brand, and no unseen link stands in
 * the head. Nothing where the Sidebar has a brand of its own. */
const PeekBrand = ({
  brand,
  peekBrand,
  open,
  peeking,
  fromPeek,
}: {
  brand: ReactNode;
  peekBrand: ReactNode;
  open: boolean;
  peeking: boolean;
  fromPeek: boolean;
}) => {
  const drawn =
    brand === undefined && peekBrand !== undefined && (!open || fromPeek);
  if (!drawn) {
    return null;
  }
  return (
    <div
      data-slot="sidebar-brand"
      {...stylex.props(
        styles.brand,
        styles.peekBrand,
        (open || !peeking) && styles.peekBrandAway
      )}
    >
      {peekBrand}
    </div>
  );
};

/** An attribute that is there, empty, while `on`, and gone otherwise. */
const flag = (on: boolean) => (on ? "" : undefined);

/** The Sidebar as it is drawn, given its props and what App shell asks of it (shellParts). */
const SidebarDrawn = ({
  groups,
  head,
  brand,
  peekBrand,
  headEnd,
  headBelow,
  onSearch,
  searchLabel = "Search",
  searchShortcut,
  searchKeyShortcuts,
  profile,
  defaultOpen = true,
  open: given,
  onOpenChange,
  foldLabel = "Show or hide the sidebar",
  foldShortcut,
  label = "Sidebar",
  navLabel = "Main",
  reopen = true,
  reopenLook = "raised",
  fill = false,
  filter,
  filterRef,
  storageKey,
  keys,
  cover = true,
  section,
  tabs,
  tab,
  onTabChange,
  tabsLabel,
  empty,
  style: styleProp,
  layout,
  onOpen,
  onPeek,
  beside,
}: SidebarProps & ShellExtras) => {
  const [own, setOwn] = useState(defaultOpen);
  const open = given ?? own;
  // Whether the person has folded or opened it on this page: only then does the reopen button fade
  // in as it arrives; a page that loads folded shows it at once.
  const [foldedHere, setFoldedHere] = useState(false);
  // In App shell's column the shell hears whether it is open, at first and on every change, kept or
  // its own (shell.ts): a product's own component round the Sidebar keeps that state where it likes.
  useLayoutEffect(() => {
    onOpen?.(open);
  }, [onOpen, open]);
  const [peeking, setPeeking] = useState(false);
  // In App shell's column the shell hears when it peeks over the page, so its bar fades what the
  // peek covers (FRESH.md F76).
  const peeksOver = !open && peeking;
  useTellPeek(onPeek, peeksOver);
  // Whether it was opened from a peek, already in over the page, rather than by its reopen button.
  const [fromPeek, setFromPeek] = useState(false);
  // 0 is never a timer's id: clearing it does nothing.
  const timer = useRef(0);
  const panel = useRef<HTMLDivElement>(null);
  const foldButton = useRef<HTMLButtonElement>(null);
  const revealButton = useRef<HTMLButtonElement>(null);
  // Where focus goes once the fold has changed it, when the keys did it.
  const refocus = useRef<"fold" | "reveal" | null>(null);
  const id = useId();
  // The list between the head and the foot, and the swap when it changes.
  const area = useRef<HTMLDivElement>(null);
  const list = listKey(section);
  const pressed = useSwap(list, section !== undefined, area, panel);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    []
  );

  // Once the keys have folded or opened it, focus goes to the button that now stands in its place.
  useEffect(() => {
    const button = open ? foldButton.current : revealButton.current;
    const target =
      refocus.current === (open ? "fold" : "reveal") ? button : null;
    refocus.current = null;
    target?.focus();
  }, [open]);

  /** Peeks in, or goes, after `ms`, unless the pointer changes its mind. */
  const peekAfter = (next: boolean, ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      // A menu open from the sidebar (the person's) stands outside it: the sidebar stays meanwhile.
      // Only a control that opens a popup counts: an open group's disclosure is expanded too, and
      // a folded sidebar with an open group would never go.
      const menuOpen =
        (panel.current?.querySelector(
          '[aria-haspopup]:not([aria-haspopup="false"])[aria-expanded="true"]'
        ) ?? null) !== null;
      if (next || !menuOpen) {
        setPeeking(next);
      }
    }, ms);
  };

  // While it is folded, the peeking sidebar stays while the pointer or the keys are on it, and goes
  // when they leave it or on Escape.
  useEffect(() => {
    const element = panel.current;
    return open || element === null
      ? undefined
      : watchPeek(element, {
          stay: () => {
            window.clearTimeout(timer.current);
          },
          leave: () => {
            peekAfter(false, LEAVE_AFTER);
          },
          close: () => {
            setPeeking(false);
          },
        });
  });

  const change = (next: boolean, byKeys: boolean) => {
    setFoldedHere(true);
    window.clearTimeout(timer.current);
    setFromPeek(opensFromPeek(next, open, peeking));
    setPeeking(false);
    if (byKeys) {
      refocus.current = next ? "fold" : "reveal";
    }
    if (given === undefined) {
      setOwn(next);
    }
    onOpenChange?.(next);
  };

  // The fold: folds the open sidebar away, and keeps a peeking one open.
  const fold = (event: MouseEvent<HTMLButtonElement>) => {
    change(!open, event.detail === 0);
  };

  // Its keys, from anywhere on the page; focus moves only when it was inside the sidebar. None in a
  // layer it fills (the phone's menu).
  const aside = useRef<HTMLElement>(null);
  const foldKeys = useFoldKeys({
    shortcut: foldShortcut,
    off: fill,
    label: foldLabel,
    aside,
    toggle: () => {
      change(!open, panel.current?.contains(document.activeElement) === true);
    },
  });

  useCoverEscape(panel, open && cover && !fill, () => {
    change(false, true);
  });

  const shown = open || peeking;

  return (
    <aside
      ref={aside}
      aria-label={label}
      data-slot="sidebar"
      data-folded={open ? undefined : ""}
      data-peeking={flag(peeksOver)}
      {...stylex.props(
        ...asideLook({ open, fill, cover, fromPeek }),
        layoutOf(layout, styleProp)
      )}
    >
      {!open && (
        <>
          <div
            aria-hidden="true"
            onPointerEnter={(event) => {
              if (event.pointerType === "mouse") {
                peekAfter(true, PEEK_AFTER);
              }
            }}
            onPointerLeave={(event) => {
              const to = event.relatedTarget;
              if (!peeking) {
                window.clearTimeout(timer.current);
              } else if (
                !(to instanceof Node && panel.current?.contains(to) === true)
              ) {
                // Off the edge and not onto the panel: it goes, as when the pointer leaves the panel.
                peekAfter(false, LEAVE_AFTER);
              }
            }}
            data-slot="sidebar-edge"
            {...stylex.props(styles.edge)}
          />
          <Reopen
            ref={revealButton}
            reopen={reopen}
            peeking={peeking}
            look={reopenLook}
            label={foldLabel}
            title={foldKeys.title}
            keys={foldKeys.keys}
            controls={`${id}-panel`}
            arrives={foldedHere}
            onOpen={(byKeys) => {
              change(true, byKeys);
            }}
          />
        </>
      )}
      <PageFade open={open} fill={fill} cover={cover} peeking={peeking} />
      <div
        id={`${id}-panel`}
        ref={panel}
        // Off the window and out of reach while it is folded and not peeking: no tab stop lands on
        // what cannot be seen.
        inert={!shown}
        onClickCapture={pressed}
        {...stylex.props(
          ...panelLook({ open, fill, cover, peeking, fromPeek, beside })
        )}
      >
        <div {...stylex.props(styles.inner)}>
          <div {...stylex.props(...headLook(open, peeking, fromPeek))}>
            <HeadMark head={head} />
            {brand !== undefined && (
              <div
                data-slot="sidebar-brand"
                {...stylex.props(styles.brand, brandLook(open, peeking))}
              >
                {brand}
              </div>
            )}
            <PeekBrand
              brand={brand}
              peekBrand={peekBrand}
              open={open}
              peeking={peeking}
              fromPeek={fromPeek}
            />
            <div {...stylex.props(styles.tools)}>
              <SearchButton
                onSearch={onSearch}
                label={searchLabel}
                shortcut={searchShortcut}
                keys={searchKeyShortcuts}
              />
              <HeadEnd shown={fill}>{headEnd}</HeadEnd>
              <button
                ref={foldButton}
                type="button"
                aria-label={foldLabel}
                title={foldKeys.title}
                aria-keyshortcuts={foldKeys.keys}
                aria-expanded={open}
                aria-controls={`${id}-panel`}
                onClick={fold}
                {...stylex.props(
                  styles.iconButton,
                  fill && styles.foldGone,
                  focus.ring
                )}
              >
                <Icon icon={SidebarToggle} />
              </button>
            </div>
          </div>
          <HeadBelow shown={fill}>{headBelow}</HeadBelow>
          <ListArea
            id={id}
            list={list}
            area={area}
            groups={groups}
            section={section}
            tabs={tabs}
            tab={tab}
            onTabChange={onTabChange}
            tabsLabel={tabsLabel}
            navLabel={navLabel}
            filter={filter}
            filterRef={filterRef}
            storageKey={storageKey}
            keys={keys}
            empty={empty}
          />
          {profile !== undefined && (
            <div data-slot="sidebar-foot" {...stylex.props(styles.foot)}>
              <SidebarProfile {...profile} />
            </div>
          )}
        </div>
      </div>
    </aside>
  );
};

/**
 * What App shell around it asks (shell.ts), over the Sidebar's own props, as the shell's copy of the
 * element did: in the sheet it fills it and stays open, with the shell's head end and what stands
 * under the head; in the column its own reopen look and cover win, and the shell hears each fold.
 * The rest of its props (its section, its tabs, its rows) are its own, wrapped or bare.
 */
const shellParts = (
  props: SidebarProps,
  shell: SidebarInShell | null
): Partial<SidebarProps> & ShellExtras => {
  if (shell === null) {
    return {};
  }
  const brand = shell.brand === undefined ? {} : { brand: shell.brand };
  if (shell.place === "sheet") {
    return {
      ...brand,
      fill: true,
      open: true,
      defaultOpen: true,
      ...(shell.headEnd === undefined ? {} : { headEnd: shell.headEnd }),
      ...(shell.headBelow === undefined ? {} : { headBelow: shell.headBelow }),
    };
  }
  return {
    ...brand,
    ...(shell.peekBrand === undefined ? {} : { peekBrand: shell.peekBrand }),
    reopenLook: props.reopenLook ?? shell.reopenLook,
    cover: props.cover ?? false,
    beside: true,
    ...(shell.onOpen === undefined ? {} : { onOpen: shell.onOpen }),
    ...(shell.onPeek === undefined ? {} : { onPeek: shell.onPeek }),
  };
};

/** A product's main navigation down the start, that folds away and peeks back in. */
export const Sidebar = (props: SidebarProps) => {
  const shell = useSidebarInShell();
  return <SidebarDrawn {...props} {...shellParts(props, shell)} />;
};
