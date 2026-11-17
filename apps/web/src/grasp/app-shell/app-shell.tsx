"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { DrawerClose as ClosePrimitive } from "@ui-sdk/react/drawer";
import {
  isValidElement,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { MouseEvent, ReactNode, RefObject, UIEvent } from "react";

import { Button } from "../button";
import { focus } from "../focus/focus";
import { Cross, Icon, PanelToggle, SidebarToggle } from "../icons";
import type { LayoutStyle } from "../layout/layout";
import { simply } from "../motion/simply.stylex";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "../sheet";
import { SidebarShellProvider } from "../sidebar/shell";
import { grasp, media } from "../tokens/tokens.stylex";
import { useWords, withGiven } from "../words/words";
import { PageBar } from "./bar";
import type { AppShellCrumb } from "./bar";
import { CardLine } from "./card-line";
import { cardLine } from "./card-line.stylex";
import type { PanelPlacement } from "./float-window";
import type { PanelPosition } from "./floating";
import { FOCUSABLE, placeOf } from "./focus-place";
import { Panels, ShellCoverContext } from "./panels";
import type { Cover } from "./panels";
import { appShellWords } from "./words";

/** What a caller may style: the shell's size and where it sits. Never its look. */
export type AppShellLayoutStyle = LayoutStyle;

/** Every prop an AppShell takes. */
export interface AppShellProps {
  /**
   * The product's main navigation: a Sidebar, or a component of your own that renders one (with its
   * own data and hooks); the shell reaches the Sidebar inside through context, never by its type.
   * It stands down the start, or in a sheet when narrow.
   * `false` for a page with none, such as a start page: the card takes the whole width, with no
   * menu button.
   */
  sidebar: ReactNode;
  /**
   * The page: usually a PageHeader, then what the page holds. It stands in a block that scrolls
   * under the bar. A page that fills the card (an open chat with its box at the foot) takes
   * `height: 100%` with `page="whole"`, and lays out its own column inside.
   */
  children: ReactNode;
  /**
   * Who draws the page bar: `frame`, the shell, from `crumbs`, `trailing` and `actions`; `page`, the
   * page itself, with an AppShellBar at its top; `none`, nobody, and the page has the whole card.
   * The frame's bar with nothing to hold (no crumbs, trailing, actions, brand or middle, and no
   * sidebar or panels) is not drawn: the page starts at the card's top with its usual room.
   * @default "frame"
   */
  bar?: "frame" | "page" | "none";
  /** Where the page is, in the frame's page bar: its steps, the page itself last. */
  crumbs?: readonly AppShellCrumb[];
  /**
   * Which crumbs a phone-wide card (under 40rem) keeps: the page and the step before it, the page
   * alone, or the first step alone. At any width a step that does not fit whole goes, the first
   * first, and the page's own name is cut only when no step is left beside it.
   * @default "last-two"
   */
  phoneCrumbs?: "last-two" | "last" | "first";
  /**
   * In the frame's page bar after the crumbs: where the page's subject stands, such as a status.
   * Where the page's name would be cut beside it, it gives way first, so the name is cut last.
   */
  end?: ReactNode;
  /** @deprecated Use `end`. */
  trailing?: ReactNode;
  /** At the end of the frame's page bar: the page's own buttons. */
  actions?: ReactNode;
  /**
   * The shell's width under which the sidebar leaves its column for the phone's menu (the menu
   * button, the sheet, the crumbs' narrow rules, all together): `40rem`, a phone; `64rem`, a tablet
   * too, so a page that needs its room keeps it beside no sidebar; `68rem`, until the page's column
   * beside an open sidebar is as wide as it is with the sidebar covered.
   * @default "40rem"
   */
  sheetBelow?: "40rem" | "64rem" | "68rem";
  /**
   * Above the page's bar, across the card: a notice for the whole product on every page, such as a
   * Banner. The page's bar, or its floating Menu button, stands under it.
   */
  banner?: ReactNode;
  /**
   * At the start of the frame's page bar, before the crumbs: the product's mark and name. Where the
   * Menu button leads the bar (a narrow shell with a sidebar), it stands in the menu's head instead.
   */
  brand?: ReactNode;
  /**
   * Where `brand` stands: `bar`, in the bar, and in the menu's head where the Menu button leads the
   * bar; `sidebar`, only at the start of the sidebar's
   * head: pinned, peeking, and in the menu's head on a narrow shell. Never in the bar, at any width:
   * the bar's start keeps only the fold or the Menu button (Ruben, 15 November).
   * @default "bar"
   */
  brandIn?: "bar" | "sidebar";
  /** In the middle of the frame's page bar: a short switch between the product's sections. */
  middle?: ReactNode;
  /**
   * Where `middle` goes on a phone's window (under 40rem): `bar`, a row of its own under the bar;
   * `sheet`, the top of the phone's menu, above the sidebar, so the bar keeps one row.
   * @default "bar"
   */
  phoneMiddle?: "bar" | "sheet";
  /**
   * The page's room in the card: `padded`, the usual room above and below; `whole`, none, so a start
   * page runs to the card's edges under the bar. `bar="none"` is always whole.
   * @default "padded"
   */
  page?: "padded" | "whole";
  /**
   * The room under the last thing on the page: `page` for the usual, `chat` when a chat box floats
   * over the page's foot, so the last row scrolls clear of it. With a `dock`, `chat` unless you say.
   * @default "page"
   */
  roomBelow?: "page" | "chat";
  /**
   * The name of the crumbs' navigation, said to a screen reader.
   * @default "Breadcrumb"
   */
  breadcrumbLabel?: string;
  /**
   * The name of the button that opens the sidebar in a sheet, and of the sheet, when narrow.
   * @default "Menu"
   */
  menuLabel?: string;
  /**
   * The name of the menu's close button, in its sidebar's head after search.
   * @default "Close the menu"
   */
  menuCloseLabel?: string;
  /**
   * Whether the phone's menu is open, when you keep it: pass it with `onMenuOpenChange`. Leave both
   * out and App shell keeps it itself. Pass `false` to close the menu from outside it, as when a
   * row in it starts something of your own.
   */
  menuOpen?: boolean;
  /** Runs when the phone's menu opens or closes: its Menu button, its close button, Escape, a link followed, a layer opened from it. */
  onMenuOpenChange?: (open: boolean) => void;
  /**
   * Beside the page's card, at the end: a docked chat or a second page, as a card of its own. On a
   * narrow shell it takes the whole window, over the page. The page's card never goes under 360px:
   * where the room beside the sidebar cannot hold it next to the panels at their least, the panels
   * cover the page as a card of their own, over the page faded out and out of reach, until there
   * is room again. Then they take the page's focus, and close on Escape or their close button
   * (`onPanelsClose`). While they go full screen or dock again, what is in them keeps the width it
   * ends at and rides their moving start; a head whose end button should keep to the card's seen
   * end takes `inline-size: 100cqi` (the card is a size container).
   */
  panels?: ReactNode;
  /**
   * Whether the panels show, when you keep `panels` given: they come in from the end as the page
   * narrows beside them, and turning this off plays their leaving, after which `onPanelsGone` runs.
   * Clearing `panels` itself still works, and takes them away at once.
   * @default true
   */
  panelsOpen?: boolean;
  /** Runs once the panels have arrived and stand still. */
  onPanelsShown?: () => void;
  /** Runs once the panels have left, after `panelsOpen` was turned off. */
  onPanelsGone?: () => void;
  /**
   * Closes the panels while they cover the page for want of room: shows a close button on them
   * and closes them on Escape. Clear `panels` in it.
   */
  onPanelsClose?: () => void;
  /**
   * The name of that close button.
   * @default "Close the panel"
   */
  panelsCloseLabel?: string;
  /**
   * On a phone the panels take the window under the bar's row, over the page. A button at the
   * row's end, expanded while they show, sets them aside for the page and brings them back, as the
   * Sidebar's own button folds it: its name.
   * @default "Show or hide the panel"
   */
  panelsToggleLabel?: string;
  /**
   * How wide the panels are, in pixels, docked or floating. Keep it in your own state with
   * `onPanelWidthChange`. Unset, 416 docked and 400 floating.
   */
  panelWidth?: number;
  /** Runs as the panels are resized, by pointer or keys, with their new width in pixels. */
  onPanelWidthChange?: (width: number) => void;
  /**
   * Where the panels stand: beside the page (`docked`), or over it as a window the person moves by
   * its head and resizes from its start edge and its top (`floating`), kept inside the shell. The
   * same panels either way: switching never draws them anew. On a phone, floating falls back to
   * the panels over the window, as docked does. Keep it in your own state with
   * `onPanelPlacementChange`; `AppShellPanelHead` gives the person the switch.
   * @default "docked"
   */
  panelPlacement?: PanelPlacement;
  /** Runs when the person switches the placement (`AppShellPanelHead`'s control), with the new one. */
  onPanelPlacementChange?: (placement: PanelPlacement) => void;
  /**
   * Where the floating window stands, in pixels: its end edge `x` from the shell's end, its foot `y`
   * from the shell's foot, so it keeps to its corner as the window resizes. Unset, its first place:
   * the bottom end corner, the shell's margins in. Keep it in your own state with
   * `onPanelPositionChange`; nothing in the shell stores it.
   */
  panelPosition?: PanelPosition;
  /** Runs as the floating window is moved, by its head's drag or its arrow keys, with its new place. */
  onPanelPositionChange?: (position: PanelPosition) => void;
  /**
   * How tall the floating window is, in pixels. Unset, 560, never more than the shell has. Keep it
   * in your own state with `onPanelHeightChange`.
   */
  panelHeight?: number;
  /** Runs as the floating window is resized from its top, by pointer or keys, with its new height. */
  onPanelHeightChange?: (height: number) => void;
  /**
   * The least the panels get, in pixels.
   * @default 340
   */
  minPanelWidth?: number;
  /**
   * The most the panels get, in pixels; never past half the shell, unless that is under the least.
   * @default 720
   */
  maxPanelWidth?: number;
  /**
   * The name of the handle between the page and the panels, said to a screen reader.
   * @default "Resize the panel"
   */
  panelResizeLabel?: string;
  /**
   * A 1px line at the foot of the panels' head row, one bar's height down, level with the line under
   * the page's bar, so the two read as one bar across the top. Off for panels that do not start with
   * a head row of the bar's height.
   * @default true
   */
  panelsHeadLine?: boolean;
  /** Over the card's foot, centred: what stays at hand as the page scrolls, such as the chat's idle bar. */
  dock?: ReactNode;
  /**
   * Whether the dock shows, when you keep `dock` given: off, it sinks away and takes no presses or
   * keys, and what is in it keeps its state; on, it rises back.
   * @default true
   */
  dockShown?: boolean;
  /**
   * Where the dock stands across the card's foot: `center`, the chat's idle bar; `end`, a chat box
   * floating at the foot's end. Either way it keeps the page's room from the card's sides.
   * @default "center"
   */
  dockAlign?: "center" | "end";
  /**
   * A panel lies over the whole page: the panels, or one of your own. The page fades out and takes
   * no presses or keys.
   * @default false
   */
  covered?: boolean;
  /**
   * The whole shell takes no presses or keys, such as while a tour runs over it.
   * @default false
   */
  inert?: boolean;
  /** @deprecated Use `layout`. */
  style?: AppShellLayoutStyle;
  /**
   * Layout only: its size and where it sits. It fills the width and height it is given; in a
   * parent that shrinks to fit its content (a flex item, a float), give it a width.
   */
  layout?: AppShellLayoutStyle;
}

// The width under which the sidebar folds into a sheet: the system's phone width, 40rem. A
// container query cannot read a variable, so it is written here. The script never measures the
// width itself: it asks whether the menu button is shown, so the two can never disagree.
const NARROW = "@container app-shell (width < 40rem)";
// The crowded rule guessed in CSS until the panels have measured their column (panels.tsx CROWDED).
const CROWDED = "@container app-shell-column (width < 706px)";
const FORCED = media.forced;
// A phone's window, whatever the shell folds by (bar.tsx keeps the same): where the bar's middle
// moves into the menu with `phoneMiddle="sheet"`.
const PHONE = "@media (width < 40rem)";
// The Menu button is a Button `xs` with an iconSm glyph in its middle: the rim of its box round
// the glyph, given back to the bar so the glyph, not the box, lines up.
const MENU_HANG = `calc((${grasp.iconSm} - ${grasp.controlXs}) / 2)`;

const styles = stylex.create({
  // The outer box is the container the shell measures itself by.
  shell: {
    containerType: "inline-size",
    containerName: "app-shell",
    display: "block",
    width: "100%",
    height: "100%",
    minHeight: 0,
    minWidth: 0,
  },
  // Folding into the sheet under 64rem: the shell measures itself 24rem short (its content box, by
  // an end padding the grid reaches back over), so every rule written for 40rem holds at 64rem.
  // The padding is never more than the shell has: under 40rem the shell is narrow either way, and
  // its content box stays under 40rem while the shell is under 64rem, and only then. The grid stands
  // on the shell's whole box, not its content, so nothing overflows at any width (320px too).
  shellSheetWide: {
    position: "relative",
    boxSizing: "border-box",
    paddingInlineEnd: "max(0px, min(calc(64rem - 40rem), calc(100% - 16rem)))",
  },
  gridSheetWide: { position: "absolute", inset: 0 },
  // The same at 68rem: 28rem short, and never more than the shell has.
  shellSheetWider: {
    paddingInlineEnd: "max(0px, min(calc(68rem - 40rem), calc(100% - 12rem)))",
  },
  // The window's ground, which the sidebar and the card stand on.
  grid: {
    display: "grid",
    gridTemplateColumns: {
      default: "auto minmax(0, 1fr)",
      [NARROW]: "minmax(0, 1fr)",
    },
    gridTemplateRows: "minmax(0, 1fr)",
    height: "100%",
    minHeight: 0,
    backgroundColor: grasp.shellGround,
    color: grasp.shellText,
    fontFamily: grasp.fontSans,
  },
  // No sidebar: the card has the whole width.
  gridAlone: { gridTemplateColumns: "minmax(0, 1fr)" },
  side: {
    display: { default: "flex", [NARROW]: "none" },
    minHeight: 0,
  },
  // The page's card: a hair off the window's edges, its edge a line inside it, round all four corners
  // (FRESH.md F89: a lift drawn outside the card was cut where the card meets the panels' side, and
  // its shadow left the gutter a lighter ground than the frame). The line is a layer of its own, last in
  // the card and over what it holds (card-line.tsx), so no bar's ground covers it; the card says how
  // wide it is. On a phone the card is the whole window, with no line. In forced colours the line is
  // the system's ink.
  card: {
    // The card's width, which the bar inside it reads to know when to wrap (bar.tsx CARD_NARROW).
    containerType: "inline-size",
    containerName: "app-shell-card",
    position: "relative",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gridTemplateRows: "auto minmax(0, 1fr)",
    minWidth: 0,
    minHeight: 0,
    margin: { default: grasp.shellInset, [NARROW]: 0 },
    overflow: "clip",
    borderRadius: { default: grasp.shellCardCorner, [NARROW]: 0 },
    backgroundColor: grasp.shellCard,
    [cardLine.width]: {
      default: grasp.hairline,
      [NARROW]: { default: "0px", [FORCED]: grasp.hairline },
    },
  },
  // No bar from the frame: the page has the card from its top.
  cardNoBar: { gridTemplateRows: "minmax(0, 1fr)" },
  // A banner above them (row 5): a row of its own at the card's top.
  cardBanner: { gridTemplateRows: "auto auto minmax(0, 1fr)" },
  cardNoBarBanner: { gridTemplateRows: "auto minmax(0, 1fr)" },
  banner: { minWidth: 0 },
  // With a banner, a floating Menu or panels button stands in the page's own cell, at its top,
  // instead of the card's: under the banner by the grid, its insets the same offsets as before.
  floatUnderBanner: {
    position: "relative",
    gridRow: "-2 / -1",
    gridColumn: "1",
    alignSelf: "start",
    justifySelf: "start",
  },
  floatUnderBannerEnd: { justifySelf: "end" },
  // Panels beside it: the gutter between the two cards is the handle that resizes them. On a narrow
  // shell the card spans the column, under the panels.
  cardBeside: {
    marginInlineEnd: { default: 0, [NARROW]: 0 },
    position: { default: "relative", [NARROW]: "absolute" },
    inset: { default: null, [NARROW]: 0 },
  },
  // The guess before measuring: crowded, the card spans the column under the panels, as covered.
  cardGuess: {
    position: {
      default: "relative",
      [CROWDED]: "absolute",
      [NARROW]: "absolute",
    },
    inset: { default: null, [CROWDED]: grasp.shellInset, [NARROW]: 0 },
    margin: { default: grasp.shellInset, [CROWDED]: 0, [NARROW]: 0 },
    marginInlineEnd: { default: 0, [CROWDED]: 0, [NARROW]: 0 },
  },
  fadedGuess: {
    opacity: { default: 1, [CROWDED]: 0, [NARROW]: 0 },
    transitionDelay: {
      default: simply.stagger,
      [CROWDED]: "0s",
      [NARROW]: "0s",
    },
  },
  // Covered: the card spans the column beside the sidebar, as the ground the panels stand on.
  cardCovered: {
    position: "absolute",
    inset: { default: grasp.shellInset, [NARROW]: 0 },
    margin: 0,
  },
  // What is in the card fades out while something lies over it, and back in a beat after.
  fades: {
    opacity: 1,
    transitionProperty: "opacity",
    transitionDuration: simply.ui,
    transitionDelay: simply.stagger,
    transitionTimingFunction: grasp.ease,
  },
  faded: { opacity: 0, transitionDelay: "0s" },
  // While panels beside the page go full screen or come back (panels.tsx `ShellCoverContext`), the
  // page stays shown, at once and with no delay: the panels' card slides over it or off it, so its
  // head and words are there from the first frame the card is seen, never an empty card (FRESH.md
  // F82, batch 4). On a phone the panels are see-through over the page, which stays faded there.
  shownMoving: {
    opacity: { default: 1, [NARROW]: 0 },
    transitionDuration: { default: "0s", [NARROW]: simply.ui },
    transitionDelay: "0s",
  },
  shownMovingBar: {
    opacity: 1,
    transitionDuration: { default: "0s", [NARROW]: simply.ui },
    transitionDelay: "0s",
  },
  // Once they lie over it, the page goes at once: the panels are see-through then.
  goneCovered: { transitionDuration: { default: "0s", [NARROW]: simply.ui } },
  fadedNarrow: {
    opacity: { default: 1, [NARROW]: 0 },
    transitionDelay: { default: simply.stagger, [NARROW]: "0s" },
  },
  // The bar's row: faded under panels that cover the page on a wide shell, never on a narrow one,
  // where it stays over them (F20).
  fadedWide: {
    opacity: { default: 0, [NARROW]: 1 },
    transitionDelay: { default: "0s", [NARROW]: simply.stagger },
  },
  fadedGuessWide: {
    opacity: { default: 1, [CROWDED]: 0, [NARROW]: 1 },
    transitionDelay: {
      default: simply.stagger,
      [CROWDED]: "0s",
      [NARROW]: simply.stagger,
    },
  },
  // In the frame's bar, the menu button leads it, on a narrow shell only.
  menu: {
    display: { default: "none", [NARROW]: "flex" },
    flexShrink: 0,
  },
  // In the bar, the button's empty rim hangs out either side, so its glyph stands where the page's
  // words begin and the bar's gap from the crumbs, ink to ink (bar.tsx, FLAWS.md F06, F08).
  menuInBar: { marginInline: MENU_HANG },
  // With a page's own bar, the menu button floats where it would stand in the bar, over its start.
  menuOverBar: {
    position: "absolute",
    insetBlockStart: 0,
    insetInlineStart: `calc(${grasp.shellPageInline} + ${MENU_HANG})`,
    zIndex: grasp.shellLayer,
    alignItems: "center",
    height: grasp.shellBar,
  },
  // With no bar, it floats at the top start corner, raised: a white control of its own that reads
  // over any page or backdrop (the Sidebar's raised reopen button). In forced colours a border.
  menuRaised: {
    position: "absolute",
    insetBlockStart: grasp.shellGutter,
    insetInlineStart: grasp.shellGutter,
    zIndex: grasp.shellLayer,
    // The Button's own corner round it, as the Sidebar's raised reopen button has (F35).
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlXs} / 2))`,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.shellCard,
    boxShadow: grasp.liftLow,
    borderWidth: { default: 0, [FORCED]: grasp.hairline },
    borderStyle: "solid",
    borderColor: "CanvasText",
  },
  // The panels' button on a phone (F20): at the end of the bar's row, as the Menu button at its
  // start, and only on a narrow shell with panels.
  toggle: {
    display: { default: "none", [NARROW]: "flex" },
    flexShrink: 0,
  },
  // With a page's own bar, or none, it floats at the row's end, as the Menu button at its start.
  toggleOverBar: {
    position: "absolute",
    insetBlockStart: 0,
    insetInlineEnd: `calc(${grasp.shellPageInline} + ${MENU_HANG})`,
    zIndex: grasp.shellLayer,
    alignItems: "center",
    height: grasp.shellBar,
  },
  toggleRaised: {
    position: "absolute",
    insetBlockStart: grasp.shellGutter,
    insetInlineEnd: grasp.shellGutter,
    zIndex: grasp.shellLayer,
    // The Button's own corner round it, as the Sidebar's raised reopen button has (F35).
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlXs} / 2))`,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.shellCard,
    boxShadow: grasp.liftLow,
    borderWidth: { default: 0, [FORCED]: grasp.hairline },
    borderStyle: "solid",
    borderColor: "CanvasText",
  },
  // The page under the bar, which scrolls on its own. A block, on purpose: as a flex column a child
  // with a height of its own (a chart's box, a frame) shrank under it and the page stopped scrolling.
  // A page that must fill the card (an open chat, its thread scrolling inside and its box at the
  // foot) takes height 100% with page="whole" and lays its own column out inside (full-height.tsx).
  main: {
    // Always the card's last row, so a banner's row above and a button laid in its cell never move it.
    gridRow: "-2 / -1",
    gridColumn: "1",
    minWidth: 0,
    minHeight: 0,
    // The page scrolls down, never sideways: a child wider than the page is cut at its edge, as the
    // card cuts what leaves it. A part that may be wide (a Table, a Code block, a Data grid) scrolls
    // in its own box. (Beside a scroll down, a clip computes to hidden: no wheel, swipe or key moves
    // it sideways, and handlePageScroll puts back what a focus or a script moved.)
    overflowX: "hidden",
    overflowY: "auto",
    overscrollBehavior: "auto",
    // No bar (PRODUCT-RULES, src/scroll), the page's own scroller too.
    scrollbarWidth: "none",
    paddingBlockStart: grasp.space7,
    paddingBlockEnd: grasp.shellPageRoomBelow,
    // The page's words stand this far in; the bar's first and last ink keep it too (bar.tsx).
    paddingInline: grasp.shellPageInline,
  },
  // A page's own bar stands at its very top: the bar keeps the room under itself.
  mainUnderOwnBar: { paddingBlockStart: 0 },
  // No bar: the page has the whole card, edge to edge, such as a backdrop.
  mainWhole: { paddingBlockStart: 0, paddingBlockEnd: 0, paddingInline: 0 },
  roomForChat: { paddingBlockEnd: grasp.shellPageRoomChat },
  // The dock: over the card's foot, centred, its sides the page's room in from the card's (FLAWS.md
  // F36: at a phone's width it stood 8px wider than the words each side). It lets presses through
  // where it has nothing.
  dock: {
    position: "absolute",
    insetInline: grasp.shellPageInline,
    insetBlockEnd: grasp.space4,
    zIndex: grasp.shellPageLayer,
    display: "flex",
    justifyContent: "center",
    pointerEvents: "none",
  },
  // At the foot's end (dockAlign="end"): a chat box floating there, its end where the words end (F37).
  dockEnd: { justifyContent: "flex-end" },
  dockHeld: { maxWidth: "100%", pointerEvents: "auto" },
  // The dock comes up and sinks away as a movement; away, nothing in it can be seen or reached.
  dockMoves: {
    transitionProperty: "opacity, translate, visibility",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  dockAway: {
    opacity: 0,
    translate: `0 ${grasp.space2}`,
    visibility: "hidden",
    transitionDuration: simply.leave,
  },
  // Behind the dock the page fades into the card's ground (F36). Taller than the dock by a group's
  // room, and whole by the dock's top edge: the page's words are gone before the dock begins, so no
  // line is cut by its edge. At the page's end, where the room below is clear, it lies on nothing.
  dockFade: {
    position: "absolute",
    insetInline: 0,
    insetBlockEnd: 0,
    height: `calc(${grasp.shellPageRoomChat} + ${grasp.space8})`,
    zIndex: grasp.shellPageLayer,
    pointerEvents: "none",
    backgroundImage: `linear-gradient(to bottom, transparent, ${grasp.shellCard} calc(100% - ${grasp.space4} - ${grasp.space12} - ${grasp.space2}))`,
    transitionProperty: "opacity",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
    display: { default: "block", [FORCED]: "none" },
  },
  dockFadeAway: { opacity: 0 },
  // In the sheet the sidebar runs the rest of the panel, on its own ground from edge to edge, so
  // the sheet reads as the sidebar itself, and scrolls when the links outrun the window.
  sheetSidebar: {
    display: "flex",
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
    scrollbarWidth: "none",
    backgroundColor: grasp.shellGround,
    borderRadius: "inherit",
    cornerShape: "inherit",
    // The sidebar's head stands on the bar's row the menu opens from (F17): the row's centre below
    // the shell's top (measured from the Menu button, useMenuBounds; else the card's inset and half
    // the bar) less the sheet's own inset and half the head's icon button (a tap's on a touch
    // screen), never under nothing. A banner's height is not counted (placeMenu, F59).
    "--grasp-shell-head": {
      default: `max(0px, calc(var(--grasp-shell-menu-row, ${grasp.shellInset} + ${grasp.shellBar} / 2) - ${grasp.sheetInset} - ${grasp.shellIconButton} / 2))`,
      [media.coarse]: `max(0px, calc(var(--grasp-shell-menu-row, ${grasp.shellInset} + ${grasp.shellBar} / 2) - ${grasp.sheetInset} - ${grasp.tap} / 2))`,
    },
  },
  // The menu's close, in the sidebar's head beside its search: the head's own icon button look
  // (sidebar.tsx iconButton), one ink, corner, size and fill under the pointer with it (F34).
  sheetClose: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    boxSizing: "border-box",
    width: { default: grasp.shellIconButton, [media.coarse]: grasp.tap },
    height: { default: grasp.shellIconButton, [media.coarse]: grasp.tap },
    padding: 0,
    borderWidth: { default: 0, [FORCED]: grasp.hairline },
    borderStyle: "solid",
    borderColor: "ButtonText",
    borderRadius: `min(${grasp.corner}, calc(${grasp.shellIconButton} / 2))`,
    cornerShape: grasp.cornerShape,
    color: {
      default: grasp.shellTextSecondary,
      [media.hover]: {
        default: grasp.shellTextSecondary,
        ":hover": grasp.shellText,
      },
    },
    backgroundColor: {
      default: "transparent",
      [media.hover]: { default: "transparent", ":hover": grasp.shellHover },
    },
    cursor: "pointer",
    transitionProperty: "color, background-color",
    transitionDuration: grasp.shellAnswer,
    transitionTimingFunction: grasp.ease,
  },
  // Before the page wakes, or with no script at all: the browser's own popover holds the sidebar,
  // down the start, over the page; it opens from the menu button and closes on Escape or a press
  // outside it, with no script. Once awake, the Sheet takes over.
  // The bar's middle at the top of the phone's menu, on the sidebar's ground, above its rows.
  sheetTop: {
    // Only where the bar has given the middle up: a phone's window (bar.tsx PHONE).
    display: { default: "none", [PHONE]: "flex" },
    flexShrink: 0,
    flexDirection: "column",
    gap: grasp.space2,
    paddingBlockEnd: grasp.space2,
    paddingInline: grasp.shellGutter,
    backgroundColor: grasp.shellGround,
  },
  asleep: {
    position: "fixed",
    insetBlock: 0,
    insetInlineStart: 0,
    insetInlineEnd: "auto",
    width: `min(${grasp.shellSidebar}, calc(100vw - ${grasp.tap}))`,
    height: "100%",
    maxHeight: "none",
    margin: 0,
    padding: 0,
    borderWidth: 0,
    overflowY: "auto",
    scrollbarWidth: "none",
    backgroundColor: grasp.shellGround,
    boxShadow: grasp.shellCardShadow,
    "::backdrop": { backgroundColor: grasp.dialogScrim },
  },
});

/** Watches the shell while the sheet is open: widened past the fold, the menu button is hidden, and
 * the sheet closes. Returns the clean-up. */
const watchFold = (
  element: HTMLElement,
  button: HTMLElement,
  close: () => void
) => {
  const observer = new ResizeObserver(() => {
    if (getComputedStyle(button).display === "none") {
      close();
    }
  });
  observer.observe(element);
  return () => {
    observer.disconnect();
  };
};

/** The sidebar in the sheet, asked through the shell's context (sidebar/shell.ts) to fill it and
 * stay open there, though it is folded beside the page; the menu's head always says which product
 * it is, so the brand goes there wherever it stands beside the page (F18). Any element: a bare
 * Sidebar or a product's own component that renders one. */
const Filled = ({
  sidebar,
  brand,
  headEnd,
  headBelow,
}: {
  sidebar: ReactNode;
  brand?: ReactNode;
  headEnd?: ReactNode;
  headBelow?: ReactNode;
}) => (
  <SidebarShellProvider value={{ place: "sheet", brand, headEnd, headBelow }}>
    {sidebar}
  </SidebarShellProvider>
);

/** The sidebar in its column. Folded, its reopen button stands in the white page bar, so it is the
 * quiet one; with no bar it floats over the page, so it keeps its raised look. The shell hears each
 * fold through the context, whoever keeps the sidebar's state. */
const InColumn = ({
  sidebar,
  look,
  brand,
  peekBrand,
  onFold,
  onPeek,
}: {
  sidebar: ReactNode;
  look: "raised" | "quiet";
  brand?: ReactNode;
  peekBrand?: ReactNode;
  onFold: (open: boolean) => void;
  onPeek: (peeking: boolean) => void;
}) => (
  <SidebarShellProvider
    value={{
      place: "column",
      reopenLook: look,
      brand,
      peekBrand,
      onOpen: onFold,
      onPeek,
    }}
  >
    {sidebar}
  </SidebarShellProvider>
);

/** An attribute that is there, empty, while `on`, and gone otherwise. */
const presence = (on: boolean) => (on ? "" : undefined);

/** The brands the sidebar in its column is handed: its own head's where the brand stands in the
 * sidebar; else, where the frame's bar holds it, the bar's for the head of a peek that covers the bar
 * (FRESH.md F76). */
const columnBrands = (
  bar: AppShellProps["bar"],
  brand: ReactNode,
  brandIn: AppShellProps["brandIn"]
) => {
  if (brandIn === "sidebar") {
    return { brand, peekBrand: undefined };
  }
  return { brand: undefined, peekBrand: bar === "frame" ? brand : undefined };
};

/** Whether the sidebar in the column is open, as the shell knows it: its own `open` when the page
 * keeps it, else followed through its fold. The shell's grid says so (data-sidebar-folded), so the
 * bar's rules ask the grid, never search the whole page below it (a :has() over the page restyled
 * every element in it whenever anything in it changed). */
const useSidebarOpen = (sidebar: ReactNode) => {
  const given = isValidElement<{ open?: boolean; defaultOpen?: boolean }>(
    sidebar
  )
    ? sidebar.props
    : undefined;
  const [own, setOwn] = useState(given?.defaultOpen ?? true);
  return [given?.open ?? own, setOwn] as const;
};

/** Whether a press inside the sheet follows a link to its page here: not one opened in a new tab
 * or window (a modified or middle press, a target) or a download. A press the page stopped counts
 * (F41): a router's Link stops the browser's own navigation and moves the address itself, and the
 * docs' preview guard stops it to stay put; either way the person chose a page, so the sheet goes. */
const followsLink = (event: MouseEvent<HTMLDivElement>): boolean => {
  if (event.button !== 0) {
    return false;
  }
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }
  const link =
    event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (link === null || link.hasAttribute("download")) {
    return false;
  }
  const target = link.getAttribute("target");
  return target === null || target === "" || target === "_self";
};

// A layer that takes the page: a dialog, an alert dialog, or a sheet (UI SDK marks each aria-modal).
const MODAL = '[aria-modal="true"]';
// How many frames a press in the sheet is watched for a layer it opens: React draws it within one or
// two; a few more for a layer that waits on a fetch's first answer.
const WATCH_FRAMES = 12;

/** After a press in the sheet: when a layer that takes the page opens outside the sheet (a dialog, an
 * alert dialog, another sheet), the sheet closes behind it (F47), so it is never left open under
 * the layer, and the layer keeps the focus it took. A press on a control that opens a layer of its
 * own inside the sheet (it says so with aria-haspopup) is left alone: that layer belongs to the
 * sidebar, and closing the sheet would take it away with it. */
const closeBehindLayer = (
  event: MouseEvent<HTMLDivElement>,
  close: () => void
) => {
  const own = event.currentTarget.closest(MODAL);
  const pressed =
    event.target instanceof Element
      ? event.target.closest("button, a[href], [role=menuitem], [role=option]")
      : null;
  if (
    own === null ||
    pressed === null ||
    pressed.hasAttribute("aria-haspopup")
  ) {
    return;
  }
  const before = new Set(document.querySelectorAll(MODAL));
  let frames = 0;
  const look = () => {
    const opened = [...document.querySelectorAll(MODAL)].some(
      (layer) =>
        !before.has(layer) && !own.contains(layer) && !layer.contains(own)
    );
    if (opened) {
      close();
      return;
    }
    frames += 1;
    if (frames < WATCH_FRAMES) {
      requestAnimationFrame(look);
    }
  };
  requestAnimationFrame(look);
};

/** Whether the page has woken: false on the server and in the first draw, true after. */
const ignore = () => {
  // Waking happens once: there is nothing to watch.
};
const noChange = () => ignore;
const useAwake = () =>
  useSyncExternalStore(
    noChange,
    () => true,
    () => false
  );

/** The menu with no script: a plain button that opens the browser's own popover of the sidebar. */
const AsleepMenu = ({
  sidebar,
  brand,
  label,
  top,
}: {
  sidebar: ReactNode;
  brand?: ReactNode;
  label: string;
  top: ReactNode;
}) => {
  const id = useId();
  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        icon={SidebarToggle}
        aria-label={label}
        render={
          <button
            type="button"
            aria-label={label}
            popoverTarget={`${id}-menu`}
          />
        }
      />
      <div
        id={`${id}-menu`}
        popover="auto"
        aria-label={label}
        {...stylex.props(styles.asleep)}
      >
        {top !== undefined && (
          <div {...stylex.props(styles.sheetTop)}>{top}</div>
        )}
        <Filled sidebar={sidebar} brand={brand} />
      </div>
    </>
  );
};

// Where the shell stands in the window, for the menu and its shade to keep to it (F33): the sheet
// stands in the browser's top layer, over the window, and a shell may be narrower (an example, a
// pane). Read while the menu is open, on the shell's own element, from which the sheet inherits it.
// And the centre of the Menu button's row, below the shell's top, for the menu's head to stand on.
const BOUNDS = [
  "--grasp-shell-menu-start",
  "--grasp-shell-menu-top",
  "--grasp-shell-menu-width",
  "--grasp-shell-menu-height",
  "--grasp-shell-menu-row",
  "--grasp-shell-menu-corner",
  "--grasp-shell-menu-corner-shape",
] as const;

/** How many boxes up from the shell a window round it is looked for. */
const WINDOW_DEPTH = 4;

/** The corner of the window the shell fills, when it has one (F62): the nearest box from the shell
 * up that clips what is in it, is rounded and stands where the shell does (an example's window, a
 * host's pane). The menu's shade takes it, so it never shows past the window's round corners. */
const windowCorner = (
  element: HTMLElement,
  box: DOMRect
): [string | null, string | null] => {
  let at: HTMLElement | null = element;
  for (let depth = 0; at !== null && depth < WINDOW_DEPTH; depth += 1) {
    const style = getComputedStyle(at);
    const rect = at.getBoundingClientRect();
    const same =
      Math.abs(rect.left - box.left) < 1 &&
      Math.abs(rect.top - box.top) < 1 &&
      Math.abs(rect.width - box.width) < 1 &&
      Math.abs(rect.height - box.height) < 1;
    if (!same) {
      return [null, null];
    }
    // One corner read for all four: a window's corners are one.
    const radius = style.borderTopLeftRadius;
    if (style.overflowX !== "visible" && radius !== "" && radius !== "0px") {
      const shape = style.getPropertyValue("corner-top-left-shape");
      return [radius, shape === "" ? null : shape];
    }
    at = at.parentElement;
  }
  return [null, null];
};

/** How tall the banner above the Menu button's row is, when the card has one: 0 without. */
const bannerAbove = (button: HTMLElement | null) => {
  const banner = button
    ?.closest("[data-slot=app-shell-card]")
    ?.querySelector(":scope > [data-slot=app-shell-banner]");
  return banner === null || banner === undefined
    ? 0
    : banner.getBoundingClientRect().height;
};

/** A length in pixels, or nothing. */
const px = (value: number | null) => (value === null ? null : `${value}px`);

/** Writes where the shell stands, from the window's start edge (its right one, right to left), and
 * where the Menu button's row is centred in it. A banner above the row is left out (F59): the sheet
 * covers the banner too, so its head stands at the sheet's top, as it does with no banner, never on
 * the row the banner pushed down with an empty band above it. */
const placeMenu = (element: HTMLElement, button: HTMLElement | null) => {
  const box = element.getBoundingClientRect();
  const start =
    getComputedStyle(element).direction === "rtl"
      ? document.documentElement.clientWidth - box.right
      : box.left;
  const at = button?.getBoundingClientRect();
  const row =
    at === undefined || at.height === 0
      ? null
      : at.top + at.height / 2 - box.top - bannerAbove(button);
  const [corner, shape] = windowCorner(element, box);
  const values = [
    px(start),
    px(box.top),
    px(box.width),
    px(box.height),
    px(row),
    corner,
    shape,
  ];
  for (const [index, name] of BOUNDS.entries()) {
    const value = values[index];
    if (value === null || value === undefined) {
      element.style.removeProperty(name);
    } else {
      element.style.setProperty(name, value);
    }
  }
};

/** The cleanup of an effect that watched nothing. */
const keepOpen = () => {
  // Nothing was watched, so nothing stops.
};

/** While the menu is open, keeps where the shell stands written on it: before the sheet is first
 * painted, and again as the shell or the window changes. */
const useMenuBounds = (
  open: boolean,
  shell: RefObject<HTMLDivElement | null>,
  menu: RefObject<HTMLSpanElement | null>
) => {
  useLayoutEffect(() => {
    const element = shell.current;
    if (!open || element === null) {
      return keepOpen;
    }
    const place = () => {
      placeMenu(element, menu.current);
    };
    place();
    const watch =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    watch?.observe(element);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      watch?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, shell, menu]);
};

/** The menu's close, in the look of the sidebar's head it stands in (F34). */
const MenuClose = ({ label }: { label: string }) => (
  <ClosePrimitive
    render={(props: Record<string, unknown>) => (
      <button
        type="button"
        {...props}
        aria-label={label}
        title={label}
        {...stylex.props(styles.sheetClose, focus.ring)}
      >
        <Icon icon={Cross} />
      </button>
    )}
  />
);

/** The phone's Menu button and the sheet it opens with the sidebar in it. */
const ShellMenu = ({
  shell,
  sidebar,
  brand,
  bar,
  underBanner = false,
  label,
  closeLabel: closeGiven,
  middle,
  phoneMiddle,
  open,
  setOpen,
}: {
  /** Whether the menu is open: App shell keeps it, and its grid says so, for the bar's brand. */
  open: boolean;
  setOpen: (open: boolean) => void;
  shell: RefObject<HTMLDivElement | null>;
  sidebar: ReactNode;
  /** The product's mark and name for the menu's head, wherever the brand stands beside the page. */
  brand?: ReactNode;
  bar: "frame" | "page" | "none";
  /** It floats (no frame bar) under a banner: it stands in the page's cell (floatUnderBanner). */
  underBanner?: boolean;
  label: string;
  closeLabel?: string;
  /** The bar's middle: at the top of the menu, above the sidebar, when `phoneMiddle` is `sheet`. */
  middle: ReactNode;
  phoneMiddle: "bar" | "sheet" | undefined;
}) => {
  const { closeMenu: closeLabel } = withGiven(
    useWords("appShell", appShellWords),
    { closeMenu: closeGiven }
  );
  const top = phoneMiddle === "sheet" ? middle : undefined;
  // Opened by a press, focus goes to the layer itself, so no ring shows on its first item; by the
  // keyboard, to the first item, as it always did.
  const [byPointer, setByPointer] = useState(false);
  const menu = useRef<HTMLSpanElement>(null);
  const awake = useAwake();
  useMenuBounds(open, shell, menu);

  // Widened past the fold, the menu button is hidden and the sidebar is back in its column: the
  // sheet has no reason to stay. The CSS decides the fold; this only reads what it decided.
  useEffect(() => {
    const element = shell.current;
    const button = menu.current;
    return !open ||
      element === null ||
      button === null ||
      typeof ResizeObserver === "undefined"
      ? undefined
      : watchFold(element, button, () => {
          setOpen(false);
        });
  }, [open, setOpen, shell]);

  // Following a link in the sheet goes to its page: close the sheet behind it. A press that opens
  // a dialog or another sheet outside it closes it too, once that layer is open (F47).
  const followed = (event: MouseEvent<HTMLDivElement>) => {
    if (followsLink(event)) {
      setOpen(false);
      return;
    }
    closeBehindLayer(event, () => {
      setOpen(false);
    });
  };
  const sheetTop =
    top === undefined ? undefined : (
      <div
        data-slot="app-shell-sheet-top"
        role="presentation"
        onClick={followed}
        {...stylex.props(styles.sheetTop)}
      >
        {top}
      </div>
    );

  // No sidebar, no menu.
  if (sidebar === false) {
    return null;
  }
  return (
    <span
      ref={menu}
      {...stylex.props(
        styles.menu,
        bar === "frame" && styles.menuInBar,
        bar === "page" && styles.menuOverBar,
        bar === "none" && styles.menuRaised,
        underBanner && styles.floatUnderBanner,
        stylex.defaultMarker()
      )}
    >
      {awake ? (
        <Sheet
          side="start"
          open={open}
          onOpenChange={(next: boolean) => {
            setOpen(next);
          }}
        >
          <SheetTrigger
            variant="ghost"
            size="xs"
            icon={SidebarToggle}
            label={label}
            onPointerDown={() => {
              setByPointer(true);
            }}
            onKeyDown={() => {
              setByPointer(false);
            }}
          />
          {/* One head (Ruben, 15 November): the sidebar's own. The sheet's title names the layer for a
              screen reader only, and its close button stands in the sidebar's head, after search. */}
          <SheetContent
            close="none"
            corner="shell"
            bounds="shell"
            initialFocus={byPointer ? "content" : "auto"}
          >
            <SheetTitle hidden>{label}</SheetTitle>
            {/* The panel is mounted only while the sheet is open or closing, so the sidebar is
                only here then, and stays through the closing slide. */}
            <div
              data-slot="app-shell-sheet"
              role="presentation"
              onClick={followed}
              {...stylex.props(styles.sheetSidebar)}
            >
              <Filled
                sidebar={sidebar}
                brand={brand}
                headEnd={<MenuClose label={closeLabel} />}
                headBelow={sheetTop}
              />
            </div>
          </SheetContent>
        </Sheet>
      ) : (
        <AsleepMenu sidebar={sidebar} brand={brand} label={label} top={top} />
      )}
    </span>
  );
};

/** On a phone, the panels' button at the end of the bar's row: expanded while the panels show over
 * the page; a press sets them aside for the page, and brings them back (F20), as the Sidebar's own
 * button folds it. */
const PanelsToggle = ({
  bar,
  label,
  aside,
  setAside,
  underBanner = false,
}: {
  bar: "frame" | "page" | "none";
  label: string;
  aside: boolean;
  setAside: (aside: boolean) => void;
  underBanner?: boolean;
}) => (
  <span
    data-slot="app-shell-panels-toggle"
    {...stylex.props(
      styles.toggle,
      bar === "frame" && styles.menuInBar,
      bar === "page" && styles.toggleOverBar,
      bar === "none" && styles.toggleRaised,
      underBanner && styles.floatUnderBanner,
      underBanner && styles.floatUnderBannerEnd
    )}
  >
    <Button
      variant="ghost"
      size="xs"
      icon={PanelToggle}
      aria-label={label}
      aria-expanded={!aside}
      onClick={() => {
        setAside(!aside);
      }}
    />
  </span>
);

type CardProps = Pick<
  AppShellProps,
  | "children"
  | "crumbs"
  | "phoneCrumbs"
  | "trailing"
  | "end"
  | "actions"
  | "brand"
  | "brandIn"
  | "middle"
  | "phoneMiddle"
  | "page"
  | "roomBelow"
  | "breadcrumbLabel"
  | "menuLabel"
  | "menuCloseLabel"
  | "dock"
  | "dockShown"
  | "dockAlign"
  | "banner"
> & {
  sidebar: ReactNode;
  bar: "frame" | "page" | "none";
  shell: RefObject<HTMLDivElement | null>;
  /** Where focus stood in the page when the card was last taken down, for the panels to carry on. */
  keep: RefObject<number>;
  paneled: boolean;
  /** Panels beside it whose column is not yet measured: the CSS guesses the crowded rule. */
  guessing: boolean;
  /** The whole card takes no presses or keys: panels cover it on a wide shell. */
  inertCard: boolean;
  /** The page under the panels: on a phone the bar's row stays, the page goes under them. */
  under: boolean;
  covered: boolean;
  /** The card is laid over the column, out of its side: panels cover it for want of room, or before
   * the column is measured. Full screen by the host's word, its side takes the column instead, so
   * the change is a movement (F13). */
  spans: boolean;
  /** The panels lie over the card for want of room, as their own card with its own line. */
  crowded: boolean;
  /** On a phone, the panels set aside for the page, and the button that does it. */
  aside: boolean;
  setAside: (aside: boolean) => void;
  panelsToggleLabel: string;
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
};

/** What fades while something lies over the page: the page, unless a phone set the panels aside
 * for it; the bar's row only under panels on a wide shell, as on a phone it stays over them. */
const fadesOf = ({
  paneled,
  guessing,
  covered,
  aside,
  cover,
}: {
  paneled: boolean;
  guessing: boolean;
  covered: boolean;
  aside: boolean;
  cover: Cover;
}) => {
  // The panels moving between beside the page and over it: the page stays shown (F82, batch 4).
  const moving =
    cover === "lifting" || cover === "covering" || cover === "docking";
  const settled = cover === "covered" && styles.goneCovered;
  return {
    fading: [
      styles.fades,
      paneled && !aside && styles.fadedNarrow,
      guessing && styles.fadedGuess,
      covered && !aside && styles.faded,
      covered && aside && styles.fadedWide,
      moving && !aside && styles.shownMoving,
      settled,
    ],
    barFading: [
      styles.fades,
      guessing && styles.fadedGuessWide,
      covered && (paneled ? styles.fadedWide : styles.faded),
      moving && styles.shownMovingBar,
      settled,
    ],
  };
};

/** Whether the page card's line goes under the panels' card: it lies over this one with a line of its
 * own, crowded or on its way to full screen and back. */
const lineUnder = (crowded: boolean, cover: Cover) =>
  crowded || cover === "lifting" || cover === "covering" || cover === "docking";

/** Notes where focus stands in the card, or the last thing pressed in it, as the card goes. */
const notePlace = (card: HTMLElement, keep: RefObject<number>) => {
  let pressed = -1;
  const press = (event: PointerEvent) => {
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>(FOCUSABLE)
        : null;
    pressed =
      target !== null && card.contains(target) ? placeOf(card, target) : -1;
  };
  card.addEventListener("pointerdown", press, true);
  return () => {
    card.removeEventListener("pointerdown", press, true);
    const active = document.activeElement;
    keep.current =
      active instanceof HTMLElement && card.contains(active)
        ? placeOf(card, active)
        : pressed;
  };
};

/** The dock over the card's foot, and the fade behind it: it sinks away while it is not shown. */
const ShellDock = ({
  dock,
  shown = true,
  align = "center",
  under,
  inert,
  fading,
}: {
  dock: ReactNode;
  shown?: boolean;
  align?: "center" | "end";
  under: boolean;
  inert: boolean;
  fading: ReturnType<typeof fadesOf>["fading"];
}) => (
  <>
    <div
      aria-hidden="true"
      data-slot="app-shell-dock-fade"
      {...stylex.props(
        styles.dockFade,
        (!shown || under) && styles.dockFadeAway
      )}
    />
    <div
      data-slot="app-shell-dock"
      data-shown={shown ? "" : undefined}
      inert={inert || !shown}
      {...stylex.props(styles.dock, align === "end" && styles.dockEnd, fading)}
    >
      <div
        {...stylex.props(
          styles.dockHeld,
          styles.dockMoves,
          !shown && styles.dockAway
        )}
      >
        {dock}
      </div>
    </div>
  </>
);

/** Whether there are panels to stand beside the page: given, and not turned off. */
const hasPanels = (panels: ReactNode, open: boolean | undefined) =>
  panels !== undefined && panels !== null && open !== false;

/** The card's rows: a banner's at the top when there is one, the frame's bar when it draws it, then the page. */
const cardRowsOf = (framed: boolean, banner: ReactNode) => {
  if (banner === undefined || banner === null || banner === false) {
    return [!framed && styles.cardNoBar];
  }
  return [framed ? styles.cardBanner : styles.cardNoBarBanner];
};

/** Whether a part of the bar is left out. */
const isNone = (node: ReactNode) =>
  node === undefined || node === null || node === false;

/** Whether the frame's bar would hold nothing (F05): no crumbs, nothing trailing them, no actions,
 * no middle, no brand in it, and no sidebar or panels to put a button at its ends. It is not drawn
 * then (an empty 48px header was an empty banner landmark): the page has the card from its top, with
 * its usual room above its words. */
const frameBarEmpty = ({
  sidebar,
  paneled,
  crumbs,
  trailing,
  actions,
  middle,
  brand,
  brandIn,
}: Pick<
  CardProps,
  | "sidebar"
  | "paneled"
  | "crumbs"
  | "trailing"
  | "actions"
  | "middle"
  | "brand"
  | "brandIn"
>) =>
  sidebar === false &&
  !paneled &&
  (crumbs === undefined || crumbs.length === 0) &&
  isNone(trailing) &&
  isNone(actions) &&
  isNone(middle) &&
  (isNone(brand) || brandIn === "sidebar");

/** Whether a floating Menu or panels button stands under a banner: a banner, and no frame bar to hold them. */
const floatsUnderBanner = (bar: "frame" | "page" | "none", banner: ReactNode) =>
  bar !== "frame" &&
  banner !== undefined &&
  banner !== null &&
  banner !== false;

/** The banner's row, when there is one. */
const BannerRow = ({ banner }: { banner: ReactNode }) =>
  banner === undefined || banner === null || banner === false ? null : (
    // Marked, so a Banner in it can square its corners to the card's (banner.tsx, FRESH.md F71).
    <div
      data-slot="app-shell-banner"
      {...stylex.props(styles.banner, stylex.defaultMarker())}
    >
      {banner}
    </div>
  );

/** Whether the page has the whole card, edge to edge, with no side room: no bar, or `page="whole"`. */
const isWhole = (
  bar: "frame" | "page" | "none",
  page: "padded" | "whole" | undefined
) => bar === "none" || page === "whole";

/**
 * The page never stands scrolled sideways: a focus moved into a child wider than the page, or a
 * script, can scroll a hidden axis, and the page goes back to its start at once.
 */
const handlePageScroll = (event: UIEvent<HTMLElement>) => {
  if (event.currentTarget.scrollLeft !== 0) {
    event.currentTarget.scrollLeft = 0;
  }
};

/** The white card: the frame's bar or the floating Menu button, the page, and the dock. */
const ShellCard = ({
  sidebar,
  children,
  bar,
  shell,
  keep,
  paneled,
  guessing,
  inertCard,
  under,
  covered,
  spans,
  crowded,
  aside,
  setAside,
  panelsToggleLabel,
  crumbs,
  phoneCrumbs,
  trailing: trailingDeprecated,
  end: trailing = trailingDeprecated,
  actions,
  brand,
  brandIn,
  middle,
  phoneMiddle,
  page = "padded",
  roomBelow,
  breadcrumbLabel,
  menuLabel,
  menuCloseLabel,
  dock,
  dockShown,
  dockAlign,
  menuOpen,
  setMenuOpen,
  banner,
}: CardProps) => {
  const menuWords = withGiven(useWords("appShell", appShellWords), {
    menu: menuLabel,
  });
  const room = roomBelow ?? (dock === undefined ? "page" : "chat");
  const whole = isWhole(bar, page);
  const framed =
    bar === "frame" &&
    !frameBarEmpty({
      sidebar,
      paneled,
      crumbs,
      trailing,
      actions,
      middle,
      brand,
      brandIn,
    });
  const underBanner = floatsUnderBanner(bar, banner);
  const cover = useContext(ShellCoverContext);
  const { fading, barFading } = fadesOf({
    paneled,
    guessing,
    covered,
    aside,
    cover,
  });
  // The menu covers the bar, its brand too: the menu's head says which product it is (F18), whichever
  // place the brand has beside the page.
  const menuButton = (
    <ShellMenu
      shell={shell}
      sidebar={sidebar}
      brand={brand}
      bar={bar}
      underBanner={underBanner}
      label={menuWords.menu}
      closeLabel={menuCloseLabel}
      middle={middle}
      phoneMiddle={phoneMiddle}
      open={menuOpen}
      setOpen={setMenuOpen}
    />
  );
  // On a phone the card stays live (its bar's row) and only the page and the dock go under the panels.
  const pageInert = under && !inertCard;
  const toggle = paneled ? (
    <PanelsToggle
      bar={bar}
      label={panelsToggleLabel}
      aside={aside}
      setAside={setAside}
      underBanner={underBanner}
    />
  ) : undefined;
  const own = useRef<HTMLDivElement>(null);

  // Note where focus stands in the card, so panels that come to cover it can take focus from there
  // and give it back there. (The card itself stays the same element: panels.tsx.)
  // A press counts too: not every browser focuses a button it presses.
  useLayoutEffect(() => {
    const element = own.current;
    return element === null ? undefined : notePlace(element, keep);
  }, [keep]);

  return (
    <div
      ref={own}
      data-slot="app-shell-card"
      data-covered={under ? "" : undefined}
      inert={inertCard}
      {...stylex.props(
        styles.card,
        ...cardRowsOf(framed, banner),
        styles.cardBeside,
        guessing && styles.cardGuess,
        spans && styles.cardCovered
      )}
    >
      <BannerRow banner={banner} />
      {framed ? (
        <div {...stylex.props(barFading)}>
          <PageBar
            look="frame"
            barStart={menuButton}
            barEnd={toggle}
            crumbs={crumbs}
            phoneCrumbs={phoneCrumbs}
            end={trailing}
            brand={brandIn === "sidebar" ? undefined : brand}
            middle={middle}
            phoneMiddle={phoneMiddle}
            actions={actions}
            breadcrumbLabel={breadcrumbLabel}
          />
        </div>
      ) : (
        <>
          {menuButton}
          {toggle}
        </>
      )}
      {/* A whole page has no side room: a page's own bar at its top (bar.tsx pageBar) does not reach
          out over room that is not there (row 33). */}
      <main
        data-slot="app-shell-page"
        data-page-whole={whole ? "" : undefined}
        inert={pageInert}
        onScroll={handlePageScroll}
        {...stylex.props(
          styles.main,
          room === "chat" && styles.roomForChat,
          bar === "page" && styles.mainUnderOwnBar,
          whole && styles.mainWhole,
          fading,
          stylex.defaultMarker()
        )}
      >
        {children}
      </main>
      {dock !== undefined && (
        <ShellDock
          dock={dock}
          shown={dockShown}
          align={dockAlign}
          under={under}
          inert={pageInert}
          fading={fading}
        />
      )}
      {/* Under the panels' card while it lies over this one with its own line, crowded or on its way
          to full screen and back; over it once it lies there at rest, as it has no line then. */}
      <CardLine under={lineUnder(crowded, cover)} />
    </div>
  );
};

/** The shell and its grid: where it folds into the sheet, and whether there is a sidebar's column. */
const shellLook = (
  sheetBelow: AppShellProps["sheetBelow"],
  sidebar: ReactNode,
  sidebarOpen: boolean
) => {
  const wide = sheetBelow === "64rem" || sheetBelow === "68rem";
  return {
    shell: [
      styles.shell,
      wide && styles.shellSheetWide,
      sheetBelow === "68rem" && styles.shellSheetWider,
    ],
    grid: [
      styles.grid,
      wide && styles.gridSheetWide,
      sidebar === false && styles.gridAlone,
    ],
    // What the grid says of the sidebar in its column: folded, for the bar's rules (useSidebarOpen).
    folded: sidebar !== false && !sidebarOpen ? "" : undefined,
  };
};

/** Where the panels stand against the page, and whether a phone has set them aside for it. */
const usePanelsPlace = ({
  paneled,
  covered,
  crowded,
  narrow,
}: {
  paneled: boolean;
  covered: boolean;
  crowded: boolean | undefined;
  narrow: boolean;
}) => {
  // On a phone the panels may be set aside for the page (F20); they come up again whenever the host
  // gives panels anew.
  const [aside, setAside] = useState(false);
  const [hadPanels, setHadPanels] = useState(paneled);
  if (hadPanels !== paneled) {
    setHadPanels(paneled);
    setAside(false);
  }
  const over = covered || (paneled && crowded === true);
  // On a phone the bar's row stays over the panels and only the page goes under them; on a wide
  // shell panels that cover the page cover the whole card.
  const phone = paneled && narrow;
  return {
    aside,
    setAside,
    over,
    guessing: paneled && crowded === undefined,
    phone,
    inertCard: over && !phone,
    under: phone ? !aside : over,
    // Panels over the page for want of room, as their own card with its own line.
    crowdedOver: paneled && crowded === true,
  };
};

export const AppShell = ({
  sidebar: given,
  bar = "frame",
  panels,
  panelsOpen,
  onPanelsShown,
  onPanelsGone,
  panelWidth,
  onPanelWidthChange,
  panelPlacement,
  onPanelPlacementChange,
  panelPosition,
  onPanelPositionChange,
  panelHeight,
  onPanelHeightChange,
  minPanelWidth = 340,
  maxPanelWidth = 720,
  panelResizeLabel,
  panelsHeadLine,
  onPanelsClose,
  panelsCloseLabel,
  panelsToggleLabel,
  covered = false,
  inert = false,
  sheetBelow,
  style: styleProp,
  layout,
  menuOpen: menuOpenGiven,
  onMenuOpenChange,
  ...page
}: AppShellProps) => {
  const sidebar = given;
  const said = withGiven(useWords("appShell", appShellWords), {
    closePanel: panelsCloseLabel,
    togglePanel: panelsToggleLabel,
  });
  const [sidebarOpen, setSidebarOpen] = useSidebarOpen(sidebar);
  const [sidebarPeeking, setSidebarPeeking] = useState(false);
  const look = shellLook(sheetBelow, sidebar, sidebarOpen);
  // The phone's menu, open or not: kept here so the grid can say so to the bar's brand; the page's
  // own `menuOpen` when it keeps it (F47).
  const [menuOwn, setMenuOwn] = useState(false);
  const menuOpen = menuOpenGiven ?? menuOwn;
  const setMenuOpen = (open: boolean) => {
    setMenuOwn(open);
    onMenuOpenChange?.(open);
  };
  // Whether the shell is narrow, as its CSS decided: read only while panels stand beside the page,
  // which then lies under them and takes no presses or keys.
  const [narrow, setNarrow] = useState(false);
  // Whether the column is too narrow for the page at its least beside the panels at theirs: the
  // panels then cover the page, as `covered` does (the crowded rule; see panels.tsx PAGE_MIN).
  const [crowded, setCrowded] = useState<boolean | undefined>();
  const shell = useRef<HTMLDivElement>(null);
  const keep = useRef(-1);

  const paneled = hasPanels(panels, panelsOpen);
  const place = usePanelsPlace({ paneled, covered, crowded, narrow });
  const { aside, setAside, over, guessing, phone, inertCard, under } = place;

  const card = (
    <ShellCard
      {...page}
      sidebar={sidebar}
      bar={bar}
      shell={shell}
      keep={keep}
      paneled={paneled}
      guessing={guessing}
      inertCard={inertCard}
      under={under}
      covered={over}
      spans={over && !(covered && crowded === false)}
      crowded={place.crowdedOver}
      aside={phone && aside}
      setAside={setAside}
      panelsToggleLabel={said.togglePanel}
      menuOpen={menuOpen}
      setMenuOpen={setMenuOpen}
    />
  );

  return (
    <div
      ref={shell}
      data-slot="app-shell"
      inert={inert}
      {...stylex.props(...look.shell, layout ?? styleProp)}
    >
      <div
        data-menu-open={menuOpen ? "" : undefined}
        data-sidebar-folded={look.folded}
        // While the sidebar peeks over the page: the bar fades what the peek covers (F76).
        data-sidebar-peeking={presence(sidebarPeeking)}
        data-shell-panels={paneled ? "" : undefined}
        // A sidebar to put in the phone's menu: where the shell is narrow the Menu button leads the
        // bar, and the bar leaves the brand to the menu's head (bar.tsx `brand`, F88).
        data-shell-menu={sidebar === false ? undefined : ""}
        {...stylex.props(...look.grid, stylex.defaultMarker())}
      >
        {sidebar !== false && (
          <div {...stylex.props(styles.side)}>
            <InColumn
              sidebar={sidebar}
              look={bar === "none" ? "raised" : "quiet"}
              {...columnBrands(bar, page.brand, page.brandIn)}
              onFold={setSidebarOpen}
              onPeek={setSidebarPeeking}
            />
          </div>
        )}
        {/* Always in the group, so the card never changes place in the tree (panels.tsx). */}
        <Panels
          card={card}
          panels={panels}
          open={panelsOpen !== false}
          onShown={onPanelsShown}
          onGone={onPanelsGone}
          width={panelWidth}
          narrow={narrow}
          placement={panelPlacement}
          onPlacementChange={onPanelPlacementChange}
          position={panelPosition}
          onPositionChange={onPanelPositionChange}
          height={panelHeight}
          onHeightChange={onPanelHeightChange}
          min={minPanelWidth}
          max={maxPanelWidth}
          covered={over}
          aside={phone && aside}
          resizeLabel={panelResizeLabel}
          onWidthChange={onPanelWidthChange}
          onNarrowChange={setNarrow}
          onCrowdedChange={setCrowded}
          onClose={onPanelsClose}
          keep={keep}
          closeLabel={said.closePanel}
          headLine={panelsHeadLine}
        />
      </div>
    </div>
  );
};
