// AppShell: the frame a product's pages stand in, as Ruben drew it for Grasp's product (the product
// repo, frame/app-frame.tsx and grasp/frame/page-bar.tsx, 14 November 2026). The Sidebar stands on
// the window's ground at the start; the page is a white card on the same ground, a hair off the
// window's edges and lifted by a hair. Across the card's top runs the page bar, flush on the card
// with no edge: where the page is (its crumbs) at the start, what it is about after them, and the
// page's actions at the end. Under it the page scrolls on its own, so the bar stays.
//
// The bar is the frame's (`bar="frame"`, from its props), a page's own (`bar="page"`: the page
// renders AppShellBar at its top), or none (`bar="none"`, Chat's start over a backdrop). Beside the
// card, at the end, the shell's panels (a docked chat, a second page) stand as a card of their own,
// as wide as the host keeps them; `covered` puts them over the page, which fades out and goes
// inert. Over the card's foot, centred, the dock (the chat's idle bar) stays put as the page
// scrolls, and the page keeps room under its last row for it.
//
// On a narrow window (under 40rem, measured on the shell itself, so it also works in a narrow
// panel) the card is the whole window, the sidebar folds away, and a menu button at the card's top
// start opens the same sidebar in a Sheet from the start: in the frame's bar, at the start of a
// page's own bar, or floating on its own with no bar. Following a link in it closes the sheet; so
// does widening the window. Panels on a narrow window take the window under the bar's row, over
// the page; the row stays, with the Menu button at its start and, at its end, a button that sets
// the panels aside for the page and brings them back.
// Folded on a wide window, the Sidebar's own button to open it again stands at the bar's start,
// and the bar begins after it; with no bar it floats there, raised.
//
//   <AppShell
//     sidebar={<Sidebar groups={...} />}
//     crumbs={[{ label: "Projects", href: "/projects" }, { label: "Spring launch" }]}
//     actions={<Button>Share</Button>}
//   >
//     <PageHeader title="Spring launch" />
//   </AppShell>
//
// Plain semantic HTML: a header for the page bar, a nav for the crumbs, a main for the page. Every
// value is a token (src/tokens). A caller may set layout only (the `style` prop).
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
  useSyncExternalStore,
} from "react";
import type { MouseEvent, ReactElement, ReactNode, RefObject } from "react";

import { Button } from "../button";
import { PanelToggle, SidebarToggle } from "../icons";
import { simply } from "../motion/simply.stylex";
import {
  Sheet,
  SheetClose,
  SheetPanel,
  SheetTitle,
  SheetTrigger,
} from "../sheet";
import { grasp, media } from "../tokens/tokens.stylex";
import { PageBar } from "./bar";
import type { AppShellCrumb } from "./bar";
import { FOCUSABLE, placeOf } from "./focus-place";
import { Panels } from "./panels";

type Layout = string | number | null;

/** What a caller may style: the shell's size and where it sits. Never its look. */
export type AppShellLayoutStyle = stylex.StyleXStyles<{
  width?: Layout;
  maxWidth?: Layout;
  height?: Layout;
  minHeight?: Layout;
  maxHeight?: Layout;
  margin?: Layout;
  gridArea?: Layout;
}>;

/** Every prop an AppShell takes. */
export interface AppShellProps {
  /**
   * The product's main navigation: a Sidebar. It stands down the start, or in a sheet when narrow.
   * `false` for a page with none, such as a start page: the card takes the whole width, with no
   * menu button.
   */
  sidebar: ReactNode;
  /** The page: usually a PageHeader, then what the page holds. */
  children: ReactNode;
  /**
   * Who draws the page bar: `frame`, the shell, from `crumbs`, `trailing` and `actions`; `page`, the
   * page itself, with an AppShellBar at its top; `none`, nobody, and the page has the whole card.
   * @default "frame"
   */
  bar?: "frame" | "page" | "none";
  /** Where the page is, in the frame's page bar: its steps, the page itself last. */
  crumbs?: readonly AppShellCrumb[];
  /**
   * Which crumbs a narrow shell keeps: the page and the step before it, the page alone, or the
   * first step alone. However many stay, the steps before the page give way before the page's own
   * name is cut.
   * @default "last-two"
   */
  phoneCrumbs?: "last-two" | "last" | "first";
  /** In the frame's page bar after the crumbs: where the page's subject stands, such as a status. */
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
  /** At the start of the frame's page bar, before the crumbs: the product's mark and name. */
  brand?: ReactNode;
  /**
   * Where `brand` stands: `bar`, always in the bar; `sidebar`, only at the start of the sidebar's
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
   * (`onPanelsClose`).
   */
  panels?: ReactNode;
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
   * How wide the panels are, in pixels. Keep it in your own state with `onPanelWidthChange`.
   * @default 416
   */
  panelWidth?: number;
  /** Runs as the panels are resized, by pointer or keys, with their new width in pixels. */
  onPanelWidthChange?: (width: number) => void;
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
  /** Over the card's foot, centred: what stays at hand as the page scrolls, such as the chat's idle bar. */
  dock?: ReactNode;
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
  /**
   * Layout only: its size and where it sits. It fills the width and height it is given; in a
   * parent that shrinks to fit its content (a flex item, a float), give it a width.
   */
  style?: AppShellLayoutStyle;
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
  // The page's card: a hair off the window's edges, lifted by a hair. On a phone the card is the
  // whole window. In forced colours the lift is dropped, so a line draws its edge.
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
    boxShadow: { default: grasp.shellCardShadow, [NARROW]: "none" },
    outlineWidth: { default: 0, [FORCED]: grasp.hairline },
    outlineStyle: "solid",
    outlineColor: "CanvasText",
    outlineOffset: `calc(-1 * ${grasp.hairline})`,
  },
  // No bar from the frame: the page has the card from its top.
  cardNoBar: { gridTemplateRows: "minmax(0, 1fr)" },
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
  // The page under the bar, which scrolls on its own.
  main: {
    minWidth: 0,
    minHeight: 0,
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
  // The dock: over the card's foot, centred, clear of its edges. It lets presses through where it
  // has nothing.
  dock: {
    position: "absolute",
    insetInline: grasp.space4,
    insetBlockEnd: grasp.space4,
    zIndex: grasp.shellPageLayer,
    display: "flex",
    justifyContent: "center",
    pointerEvents: "none",
  },
  dockHeld: { maxWidth: "100%", pointerEvents: "auto" },
  // In the sheet the sidebar runs the rest of the panel, on its own ground from edge to edge, so
  // the sheet reads as the sidebar itself, and scrolls when the links outrun the window.
  sheetSidebar: {
    display: "flex",
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
    scrollbarWidth: "none",
    backgroundColor: grasp.shellGround,
    // The panel's own corners, all four: the sidebar's head is the menu's top now (no title bar
    // above it), so its ground must not square off the top corners either (Ruben, 15 November).
    borderRadius: "inherit",
    cornerShape: "inherit",
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

/** The sidebar in the sheet, asked to fill it through its own `fill` prop, and open there, though
 * it is folded beside the page. */
const Filled = ({
  sidebar,
  headEnd,
  headBelow,
}: {
  sidebar: ReactElement<{
    fill?: boolean;
    headEnd?: ReactNode;
    headBelow?: ReactNode;
  }>;
  headEnd?: ReactNode;
  headBelow?: ReactNode;
}) =>
  createElement(sidebar.type, {
    ...sidebar.props,
    fill: true,
    open: true,
    defaultOpen: true,
    ...(headEnd === undefined ? {} : { headEnd }),
    ...(headBelow === undefined ? {} : { headBelow }),
  });

/** The sidebar given the brand for its head, when the brand follows the sidebar. */
const withBrand = (
  sidebar: ReactNode,
  { brand, brandIn }: { brand?: ReactNode; brandIn?: "bar" | "sidebar" }
): ReactNode =>
  brandIn === "sidebar" &&
  brand !== undefined &&
  isValidElement<{ brand?: ReactNode }>(sidebar)
    ? createElement(sidebar.type, { ...sidebar.props, brand })
    : sidebar;

/** The sidebar in its column. Folded, its reopen button stands in the white page bar, so it is the
 * quiet one; with no bar it floats over the page, so it keeps its raised look. */
const InColumn = ({
  sidebar,
  look,
  onFold,
}: {
  sidebar: ReactElement<{
    reopenLook?: "raised" | "quiet";
    cover?: boolean;
    onOpenChange?: (open: boolean) => void;
  }>;
  look: "raised" | "quiet";
  onFold: (open: boolean) => void;
}) =>
  createElement(sidebar.type, {
    reopenLook: look,
    cover: false,
    ...sidebar.props,
    onOpenChange: (open: boolean) => {
      onFold(open);
      sidebar.props.onOpenChange?.(open);
    },
  });

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
  label,
  top,
}: {
  sidebar: ReactNode;
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
        label={label}
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
        {isValidElement<{ fill?: boolean }>(sidebar) ? (
          <Filled sidebar={sidebar} />
        ) : (
          sidebar
        )}
      </div>
    </>
  );
};

/** The phone's Menu button and the sheet it opens with the sidebar in it. */
const ShellMenu = ({
  shell,
  sidebar,
  bar,
  label,
  closeLabel = "Close the menu",
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
  bar: "frame" | "page" | "none";
  label: string;
  closeLabel?: string;
  /** The bar's middle: at the top of the menu, above the sidebar, when `phoneMiddle` is `sheet`. */
  middle: ReactNode;
  phoneMiddle: "bar" | "sheet" | undefined;
}) => {
  const top = phoneMiddle === "sheet" ? middle : undefined;
  // Opened by a press, focus goes to the layer itself, so no ring shows on its first item; by the
  // keyboard, to the first item, as it always did.
  const [byPointer, setByPointer] = useState(false);
  const menu = useRef<HTMLSpanElement>(null);
  const awake = useAwake();

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
  // On a phone the bar's middle stands under the sidebar's head in the menu (Ruben, 15 November:
  // the head first, then the switch, across the menu's width).
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
          <SheetPanel
            close="none"
            corner="shell"
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
              {isValidElement<{ fill?: boolean }>(sidebar) ? (
                <Filled
                  sidebar={sidebar}
                  headEnd={<SheetClose label={closeLabel} size="xs" />}
                  headBelow={sheetTop}
                />
              ) : (
                sidebar
              )}
            </div>
          </SheetPanel>
        </Sheet>
      ) : (
        <AsleepMenu sidebar={sidebar} label={label} top={top} />
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
}: {
  bar: "frame" | "page" | "none";
  label: string;
  aside: boolean;
  setAside: (aside: boolean) => void;
}) => (
  <span
    data-slot="app-shell-panels-toggle"
    {...stylex.props(
      styles.toggle,
      bar === "frame" && styles.menuInBar,
      bar === "page" && styles.toggleOverBar,
      bar === "none" && styles.toggleRaised
    )}
  >
    <Button
      variant="ghost"
      size="xs"
      icon={PanelToggle}
      label={label}
      aria-expanded={!aside}
      onClick={() => {
        setAside(!aside);
      }}
    />
  </span>
);

/** The panels' width when the host gives none: the product's chat, docked. */
const PANEL_WIDTH = 416;

type CardProps = Pick<
  AppShellProps,
  | "children"
  | "crumbs"
  | "phoneCrumbs"
  | "trailing"
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
}: {
  paneled: boolean;
  guessing: boolean;
  covered: boolean;
  aside: boolean;
}) => ({
  fading: [
    styles.fades,
    paneled && !aside && styles.fadedNarrow,
    guessing && styles.fadedGuess,
    covered && !aside && styles.faded,
    covered && aside && styles.fadedWide,
  ],
  barFading: [
    styles.fades,
    guessing && styles.fadedGuessWide,
    covered && (paneled ? styles.fadedWide : styles.faded),
  ],
});

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
  aside,
  setAside,
  panelsToggleLabel,
  crumbs,
  phoneCrumbs,
  trailing,
  actions,
  brand,
  brandIn,
  middle,
  phoneMiddle,
  page = "padded",
  roomBelow,
  breadcrumbLabel,
  menuLabel = "Menu",
  menuCloseLabel,
  dock,
  menuOpen,
  setMenuOpen,
}: CardProps) => {
  const room = roomBelow ?? (dock === undefined ? "page" : "chat");
  const { fading, barFading } = fadesOf({ paneled, guessing, covered, aside });
  const menuButton = (
    <ShellMenu
      shell={shell}
      sidebar={sidebar}
      bar={bar}
      label={menuLabel}
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
    />
  ) : undefined;
  const own = useRef<HTMLDivElement>(null);

  // Panels coming or going draw the card again in a new place: note where focus stood in it as it
  // goes, so the panels can take it from there and give it back there.
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
        bar !== "frame" && styles.cardNoBar,
        paneled && styles.cardBeside,
        guessing && styles.cardGuess,
        covered && styles.cardCovered
      )}
    >
      {bar === "frame" ? (
        <div {...stylex.props(barFading)}>
          <PageBar
            look="frame"
            start={menuButton}
            end={toggle}
            crumbs={crumbs}
            phoneCrumbs={phoneCrumbs}
            trailing={trailing}
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
      <main
        data-slot="app-shell-page"
        inert={pageInert}
        {...stylex.props(
          styles.main,
          room === "chat" && styles.roomForChat,
          bar === "page" && styles.mainUnderOwnBar,
          (bar === "none" || page === "whole") && styles.mainWhole,
          fading
        )}
      >
        {children}
      </main>
      {dock !== undefined && (
        <div
          data-slot="app-shell-dock"
          inert={pageInert}
          {...stylex.props(styles.dock, fading)}
        >
          <div {...stylex.props(styles.dockHeld)}>{dock}</div>
        </div>
      )}
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
  };
};

export const AppShell = ({
  sidebar: given,
  bar = "frame",
  panels,
  panelWidth = PANEL_WIDTH,
  onPanelWidthChange,
  minPanelWidth = 340,
  maxPanelWidth = 720,
  panelResizeLabel = "Resize the panel",
  onPanelsClose,
  panelsCloseLabel = "Close the panel",
  panelsToggleLabel = "Show or hide the panel",
  covered = false,
  inert = false,
  sheetBelow,
  style,
  menuOpen: menuOpenGiven,
  onMenuOpenChange,
  ...page
}: AppShellProps) => {
  const sidebar = withBrand(given, page);
  const [sidebarOpen, setSidebarOpen] = useSidebarOpen(sidebar);
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

  const paneled = panels !== undefined && panels !== null;
  const { aside, setAside, over, guessing, phone, inertCard, under } =
    usePanelsPlace({ paneled, covered, crowded, narrow });

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
      aside={phone && aside}
      setAside={setAside}
      panelsToggleLabel={panelsToggleLabel}
      menuOpen={menuOpen}
      setMenuOpen={setMenuOpen}
    />
  );

  return (
    <div
      ref={shell}
      data-slot="app-shell"
      inert={inert}
      {...stylex.props(...look.shell, style)}
    >
      <div
        data-menu-open={menuOpen ? "" : undefined}
        data-sidebar-folded={look.folded}
        data-shell-panels={paneled ? "" : undefined}
        {...stylex.props(...look.grid, stylex.defaultMarker())}
      >
        {sidebar !== false && (
          <div {...stylex.props(styles.side)}>
            {isValidElement<{ reopenLook?: "raised" | "quiet" }>(sidebar) ? (
              <InColumn
                sidebar={sidebar}
                look={bar === "none" ? "raised" : "quiet"}
                onFold={setSidebarOpen}
              />
            ) : (
              sidebar
            )}
          </div>
        )}
        {paneled ? (
          <Panels
            card={card}
            panels={panels}
            width={panelWidth}
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
            closeLabel={panelsCloseLabel}
          />
        ) : (
          card
        )}
      </div>
    </div>
  );
};
