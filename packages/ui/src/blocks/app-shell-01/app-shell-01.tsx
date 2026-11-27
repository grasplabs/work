// App shell: the frame a product's pages stand in, composed of Sidebar, SidePanel, Sheet and
// Resizable. The product's sidebar down the start under its head (the product's mark, a search,
// the fold); beside it the page (the main landmark) as a card on the sidebar's ground, which
// scrolls on its own. Each page draws its own bar across the card's top (AppShellHeader: the fold
// while the sidebar is away, where the page is, its actions), which stays as the page scrolls under
// it, and its body (AppShellPage). At the end, one panel the person resizes by its handle.
//
//   <AppShell
//     storageKey="app.sidebar"
//     mark={<a href="/" aria-label="Home"><Icon icon={Logo} /></a>}
//     searchOpen={searching}
//     onSearchOpenChange={setSearching}
//     sidebar={<SidebarContent>…</SidebarContent>}
//     panel={<SidePanel aria-label="Details">…</SidePanel>}
//   >
//     <AppShellHeader
//       breadcrumb={[{ label: "Projects", render: <Link to="/projects" /> }]}
//       title={name}
//       onRename={setName}
//       actions={<Button size="sm">Share</Button>}
//     />
//     <AppShellPage>
//       <PageHeader title={name} />
//     </AppShellPage>
//   </AppShell>
//
// AppShell is the parts composed for a frame of its own. A product that lays more round the page
// (a chat beside it, a dock over its foot) composes the same parts itself inside SidebarProvider:
// AppShellSidebar, then its own wrapper round AppShellCard (`overlay` over the card, `covered`
// under a panel that covers it), holding AppShellContent, the page's scroller. A dock laid over
// the card's foot keeps its room under a page that fills the card with
// `appShellVars.contentRoomBelow`, set on an element round the page.
//
// On a narrow window (under lg) the sidebar is Sidebar's own sheet from the start, and the panel a
// Sheet from the end, opened by the bar's panel button; a plain link followed in the sidebar's sheet
// closes it. On a phone the bar says the page and the step before it. Its words come from the
// I18nProvider (`appShell`). A block: install it and edit it.
//
// It is a window's frame: as tall as the window unless `style` gives it its frame's height, and
// its two sheets are fixed to the window (the breakpoint is the window's width too). In a box of
// its own, such as a gallery's card, the box gives it a height (`style` with `height: "100%"` and
// `minHeight: 0` fills it) and is the containing block of what is fixed (`contain: layout`, or a
// transform), so the sheets open in the box.
"use client";

import * as stylex from "@stylexjs/stylex";
import { renderElement } from "@ui-sdk/react/primitive";
import { useShortcut, useShortcutHint } from "@ui-sdk/react/shortcuts";
import {
  createContext,
  Fragment,
  use,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactElement, ReactNode, Ref } from "react";

import { alertVars } from "../../components/alert.stylex";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../../components/breadcrumb";
import { breadcrumbVars } from "../../components/breadcrumb.stylex";
import { Button } from "../../components/button";
import { InlineEdit } from "../../components/inline-edit";
import { pageBandVars } from "../../components/page-header.stylex";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../../components/resizable";
import { Sheet, SheetContent } from "../../components/sheet";
import { SidePanelPlacementProvider } from "../../components/side-panel";
import {
  Sidebar,
  SidebarHeader,
  SidebarInset,
  SidebarMenuButton,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "../../components/sidebar";
import type { SidebarProviderProps } from "../../components/sidebar";
import {
  sidebarMarker,
  sidebarWrapperMarker,
} from "../../components/sidebar.stylex";
import { Skeleton } from "../../components/skeleton";
import { useI18n } from "../../lib/i18n";
import { Icon, PanelRightIcon, SearchIcon, XIcon } from "../../lib/icons";
import { focusRingText } from "../../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size,
  space,
} from "../../lib/tokens.stylex";
import { px } from "../../lib/tokens.values";
import { isBlank } from "../../lib/utils";
import type { LayoutStyle } from "../../lib/utils";
import { iconVars } from "../../lib/vars.stylex";
import { appShellVars } from "./app-shell-01.stylex";

/** The search's keys by default: Cmd+K on a Mac, Ctrl+K elsewhere. */
const SEARCH_SHORTCUT = "mod+k";

/** The page's panel, told to the bar so it draws the panel's button: AppShell's own. */
interface PanelState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const PanelContext = createContext<PanelState | undefined>(undefined);

// The panel's first width, and its least, in pixels: Resizable takes lengths, not variables, so
// these restate the side-panel-width token (420px) and a floor a SidePanel's sections still read at.
const PANEL_WIDTH = "420px";
const PANEL_MIN = "320px";
const PANEL_MAX = "50%";

// The room a crumb's link keeps round its words for its focus ring on a phone, given back by a
// negative margin, and the reach of that ring past the words, which the trail's clip keeps clear of.
const CRUMB_ROOM = `calc(${space["1"]} - ${size.hairline})`;
const RING_REACH = `calc(${size.ringWidth} + ${size.ringOffsetText} + ${CRUMB_ROOM})`;

const styles = stylex.create({
  // What the page holds, laid over the SidebarInset's box: the inset is as tall as the shell (the
  // window's height, or the frame's), never as tall as the page, so the page scrolls inside it and
  // its bar stays. The card's own ground at every width: beside the sidebar, and filling the window
  // on a phone. A layer of its own, so the line inside the card's edge stands over all of it, the
  // page's bar too.
  frame: {
    position: "absolute",
    inset: 0,
    zIndex: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "clip",
    backgroundColor: colors.sidebarCard,
    borderRadius: "inherit",
    cornerShape: "inherit",
  },
  // Across the card's top a banner Alert is a band: no corner of its own (alertVars). Under a panel
  // that covers the page it fades out with the page, and back a beat after the panel starts to go.
  banner: {
    flexShrink: 0,
    [alertVars.bannerCorner]: "0px",
    transitionProperty: "opacity",
    transitionDuration: duration.ui,
    transitionTimingFunction: duration.ease,
    transitionDelay: duration.press,
  },
  // Under the banner: the page (and its panel), and what the product lays over the card.
  area: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
  },
  held: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    transitionProperty: "opacity",
    transitionDuration: duration.ui,
    transitionTimingFunction: duration.ease,
    transitionDelay: duration.press,
  },
  covered: { opacity: 0, transitionDelay: "0s" },
  body: { flexGrow: 1, minHeight: 0 },
  // The page under the banner: its bar, then its body. It scrolls up and down only; what is wider
  // than the card is cut at its edge.
  page: {
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
    height: "100%",
    minHeight: 0,
    // Room under the page for what a product lays over the card's foot (a dock), so the page's
    // end scrolls clear of it. AppShellPage keeps its own room below as well.
    paddingBlockEnd: appShellVars.contentRoomBelow,
    overflowX: "clip",
    overflowY: "auto",
    scrollbarWidth: "none",
  },
  panel: { height: "100%", minHeight: 0 },
  contents: { display: "contents" },

  // ---- The sidebar's head ----
  // The mark at the start, the search and the fold at the end, in one row the icon buttons'
  // height; the fold's glyph ends where the rows' ink does.
  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: size.sidebarRowGap,
    minHeight: size.sidebarIconButton,
  },
  // In the sheet the head stands a step under the sheet's top: SidebarHeader keeps its room less
  // the sheet's own inset there, which would put it lower.
  headInSheet: {
    marginBlockStart: `calc(${space["1"]} - (${space["4"]} - ${size.sheetPadding}))`,
  },
  mark: {
    [iconVars.size]: size.appShellMark,
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    height: size.sidebarIconButton,
    paddingInlineStart: size.sidebarRowInline,
    color: colors.sidebarForeground,
  },
  tools: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    marginInlineStart: "auto",
    marginInlineEnd: `calc(${size.sidebarRowInline} - (${size.sidebarIconButton} - ${size.sidebarIcon}) / 2)`,
  },

  // ---- The page's bar ----
  // One row the bar's height, across the page's column from edge to edge at the top of the page,
  // which scrolls under it: on the card's own ground, a hairline at its foot. On a phone the line is
  // the frame's own neutral rule, the card's edge, not the page's tinted one.
  bar: {
    position: "sticky",
    insetBlockStart: 0,
    zIndex: 20,
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space["2"],
    boxSizing: "border-box",
    minWidth: 0,
    height: size.appShellBar,
    paddingInline: size.appShellPageInline,
    paddingInlineEnd: `calc(${size.appShellPageInline} + ${appShellVars.barEndRoom})`,
    backgroundColor: colors.sidebarCard,
    borderBlockEndWidth: size.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: {
      default: colors.border,
      [media.maxSm]: colors.sidebarCardBorder,
      [media.forcedColors]: "CanvasText",
    },
  },
  // Where the page is, then what trails it: they give way to the actions, never the other way
  // round. The path in the sidebar's neutral inks (the steps back in its rows' words, the slashes
  // quieter, the page in its ink); what trails it keeps the page's.
  where: {
    display: "flex",
    flexGrow: 1,
    alignItems: "center",
    gap: space["3"],
    minWidth: 0,
    // Cut along the bar, never across it: a link's 44px reach on a touch screen stands past the
    // words' line. Room at the end for the renamable name's own padding, or its ring is cut.
    overflowX: "clip",
    paddingInlineEnd: space["1"],
    [breadcrumbVars.mutedForeground]: colors.sidebarSecondaryForeground,
    [breadcrumbVars.subtleForeground]: colors.sidebarTertiaryForeground,
    [breadcrumbVars.foreground]: colors.sidebarForeground,
    // A slash stands a step from each step, as far as the steps' words are from a chevron's box.
    [breadcrumbVars.separatorInset]: space["1"],
  },
  // The fold's empty rim hangs out past the bar's room, so its glyph stands where the page's words
  // begin. Drawn by the server too and shown by the sidebar's state alone (its head script sets it
  // before the page wakes): on a narrow window, where the sidebar is a sheet, or while the sidebar
  // is folded away; otherwise the sidebar's head holds the fold. On a phone it is the bar's menu
  // button: in the page's ink, not the sidebar's greys.
  trigger: {
    display: {
      default: "none",
      [media.maxLg]: "flex",
      [stylex.when.ancestor(
        ':has([data-slot="sidebar"][data-state="collapsed"])',
        sidebarWrapperMarker
      )]: "flex",
    },
    flexShrink: 0,
    marginInlineStart: `calc((${size.sidebarIcon} - ${size.sidebarIconButton}) / 2)`,
    marginInlineEnd: `calc(-1 * ${size.sidebarRowGap})`,
    "--damsko-sidebar-secondary-foreground": {
      default: null,
      [media.maxSm]: colors.foreground,
    },
  },
  // A step that leads nowhere: in the page's ink and weight, as the page's own name.
  step: {
    display: "block",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: breadcrumbVars.foreground,
    fontWeight: font.weightMedium,
  },
  // The renamable name in the page's ink and weight, as BreadcrumbPage draws it.
  rename: {
    minWidth: 0,
    color: breadcrumbVars.foreground,
    fontWeight: font.weightMedium,
  },
  actions: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space["2"],
    marginInlineStart: "auto",
  },

  // ---- A phone's trail ----
  // The page and the step before it, a slash between, on one line. Laid end to start, the page
  // first to take its room and the step after it, whole or not at all: a step that does not fit
  // beside the page at its least wraps onto a second line, which the trail's clip hides, so the
  // page stands alone.
  phoneTrail: {
    display: "flex",
    minWidth: `calc(${space["8"]} + 2 * ${RING_REACH})`,
    overflow: "clip",
    padding: RING_REACH,
    margin: `calc(-1 * ${RING_REACH})`,
    marginInlineEnd: `calc(2 * ${space["3"]} - ${space["2"]} - ${RING_REACH})`,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  phoneCrumbs: {
    display: "flex",
    flexDirection: "row-reverse",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    alignItems: "center",
    alignContent: "flex-start",
    columnGap: space["2"],
    rowGap: RING_REACH,
    blockSize: {
      default: font.textSmLine,
      [media.pointerCoarse]: size.tapTarget,
    },
    minWidth: 0,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  // The step: its link, then the slash before the page, whole.
  phoneStep: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space["2"],
    minBlockSize: { default: null, [media.pointerCoarse]: size.tapTarget },
    color: colors.sidebarSecondaryForeground,
  },
  phoneSlash: {
    display: "flex",
    flexShrink: 0,
    color: colors.sidebarTertiaryForeground,
  },
  // The step's link: the sidebar's secondary words, its own ink under the pointer, a finger's
  // height on a touch screen.
  phoneLink: {
    display: "inline-flex",
    minWidth: 0,
    alignItems: "center",
    minHeight: { default: null, [media.pointerCoarse]: size.tapTarget },
    borderRadius: radius.sm,
    cornerShape: radius.shape,
    color: {
      default: colors.sidebarSecondaryForeground,
      ":hover": { default: null, [media.hover]: colors.sidebarForeground },
    },
    textDecoration: "none",
    whiteSpace: "nowrap",
    paddingInline: CRUMB_ROOM,
    marginInline: `calc(-1 * ${CRUMB_ROOM})`,
  },
  // The page: first on the line, whole beside its step, cut to fit alone, never under a stub of
  // its first letters.
  phonePage: {
    order: -100,
    display: "flex",
    alignItems: "center",
    flexShrink: 1,
    minWidth: space["8"],
    minBlockSize: { default: null, [media.pointerCoarse]: size.tapTarget },
  },
  phonePageWords: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: colors.sidebarForeground,
    fontWeight: font.weightMedium,
  },

  // ---- The page's body ----
  // A column as wide as the card in the page's room, its parts a step apart: one width through the
  // product, so every page's edges stand under the bar's and a banner's. It fills what the bar
  // leaves, so a state that stands for the page (an Empty that grows) takes the card's middle. The
  // room is told to a banner PageHeader (pageBandVars), which takes it back to stand flush.
  pageBody: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    gap: space["6"],
    boxSizing: "border-box",
    width: "100%",
    paddingBlockStart: space["7"],
    paddingInline: size.appShellPageInline,
    paddingBlockEnd: size.appShellPageRoomBelow,
    [pageBandVars.top]: space["7"],
    [pageBandVars.inline]: size.appShellPageInline,
  },
  // The page while it loads: a heading and its line, then lines of content, in the page's room.
  skeletonHeading: {
    display: "flex",
    flexDirection: "column",
    gap: space["2"],
  },
  skeletonTitle: { width: "12rem", maxWidth: "100%" },
  skeletonLead: { width: "18rem", maxWidth: "100%" },
  skeletonLines: {
    display: "flex",
    flexDirection: "column",
    gap: space["2"],
    width: "100%",
  },
  skeletonLastLine: { width: "66%" },
});

/** Whether a press follows a link to its page here: not a new tab, a new window or a download. */
const followsLink = (event: globalThis.MouseEvent): boolean => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) {
    return false;
  }
  const link =
    event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (link === null || link.hasAttribute("download")) {
    return false;
  }
  const target = link.getAttribute("target") ?? "";
  return target === "" || target === "_self";
};

// ---- The sidebar ---------------------------------------------------------------------------------

/** Every prop an AppShellSidebar takes. */
export interface AppShellSidebarProps {
  /** What stands under the head: its SidebarContent (or SidebarLevels), then its SidebarFooter. */
  children: ReactNode;
  /** At the head's start: the product's mark, most often a link home. */
  mark?: ReactNode;
  /**
   * Opens and closes the product's own search: a search button in the head opens it, and its keys
   * (`searchShortcut`) open it from anywhere on the page, rich text too, and close it again while
   * `searchOpen`. An editor that binds the same keys itself (and so marks the key handled,
   * `preventDefault`) keeps them. On a narrow window the sidebar's sheet closes first.
   */
  onSearchOpenChange?: (open: boolean) => void;
  /**
   * Whether the search is open, so its keys close it again, from inside its dialog too. Without
   * it the keys only open it, and pause while any dialog is open.
   */
  searchOpen?: boolean;
  /**
   * The keys that open (and with `searchOpen`, close) the search: `mod` is Cmd on a Mac and Ctrl elsewhere. `false` turns them
   * off.
   * @default "mod+k"
   */
  searchShortcut?: string | false;
  /**
   * Whether the shell listens for `searchShortcut` itself. `false` when the product already does
   * (a search of its own on the same keys): the button still shows them.
   * @default true
   */
  listenToSearchShortcut?: boolean;
}

/**
 * The sidebar beside the page's card, an inset Sidebar under its head: the product's mark, the
 * search, and the fold (in its sheet on a narrow window, a close button). A link followed in the
 * sheet closes it. Inside a SidebarProvider; AppShell puts it there.
 */
export const AppShellSidebar = ({
  children,
  mark,
  onSearchOpenChange,
  searchOpen = false,
  searchShortcut = SEARCH_SHORTCUT,
  listenToSearchShortcut = true,
}: AppShellSidebarProps) => {
  const words = useI18n().appShell;
  const { isMobile, setOpenMobile } = useSidebar();
  const keys =
    onSearchOpenChange === undefined || searchShortcut === false
      ? ""
      : searchShortcut;
  // The hint formats a real shortcut only: with none, the default's is read and never shown.
  const hint = useShortcutHint(keys === "" ? SEARCH_SHORTCUT : keys);
  // The search opens over the page: the sidebar's sheet goes first.
  const search = () => {
    setOpenMobile(false);
    onSearchOpenChange?.(true);
  };
  // Here, not on the button: the button is in the sheet, which is not there while it is closed.
  // The keys open the search as a page shortcut, which pauses under any open dialog; while the
  // search is open they belong to the layer that holds the focus (the search's own, as a dialog
  // keeps the focus inside it), so the same keys close what they opened. In rich text they run
  // unless the editor handled them itself: UI SDK passes over a key marked handled.
  useShortcut(
    keys === "" || !listenToSearchShortcut ? null : keys,
    () => {
      if (searchOpen) {
        onSearchOpenChange?.(false);
      } else {
        search();
      }
    },
    {
      layer: () => (searchOpen ? document.activeElement : document.body),
      description: words.search,
    }
  );
  // Heard on the way up from the links inside, which are the keyboard's stops themselves (Enter on
  // a link is a click too).
  const watch = (node: HTMLDivElement) => {
    const press = (event: globalThis.MouseEvent) => {
      if (isMobile && followsLink(event)) {
        setOpenMobile(false);
      }
    };
    node.addEventListener("click", press);
    return () => {
      node.removeEventListener("click", press);
    };
  };
  return (
    <Sidebar variant="inset">
      <div ref={watch} {...stylex.props(styles.contents)}>
        <SidebarHeader>
          <div
            data-slot="app-shell-head"
            {...stylex.props(styles.head, isMobile && styles.headInSheet)}
          >
            <span {...stylex.props(styles.mark)}>{mark}</span>
            <div {...stylex.props(styles.tools)}>
              {onSearchOpenChange === undefined ? null : (
                <SidebarMenuButton
                  size="icon"
                  aria-label={words.search}
                  aria-keyshortcuts={
                    keys === "" ? undefined : hint.ariaKeyshortcuts
                  }
                  title={
                    keys === ""
                      ? words.search
                      : `${words.search} (${hint.text})`
                  }
                  onClick={search}
                >
                  <Icon icon={SearchIcon} />
                </SidebarMenuButton>
              )}
              {/* The fold stays here while the sidebar is open; in its sheet, the way out. */}
              {isMobile ? (
                <SidebarMenuButton
                  size="icon"
                  aria-label={words.close}
                  onClick={() => {
                    setOpenMobile(false);
                  }}
                >
                  <Icon icon={XIcon} />
                </SidebarMenuButton>
              ) : (
                <SidebarTrigger />
              )}
            </div>
          </div>
        </SidebarHeader>
        {children}
      </div>
    </Sidebar>
  );
};

// ---- The card ------------------------------------------------------------------------------------

/** Every prop an AppShellCard takes. */
export interface AppShellCardProps {
  /** The page: an AppShellContent, alone or in what the product lays beside it. */
  children: ReactNode;
  /** Above the page, across the card: a notice for the whole product, such as a Banner. */
  banner?: ReactNode;
  /**
   * Laid over the card under the banner, and never covered: a product's own buttons at the bar's
   * height (keep the bar's room for them with `appShellVars.barEndRoom`).
   */
  overlay?: ReactNode;
  /** A panel lies over the whole card: the banner and the page fade out and go out of reach. */
  covered?: boolean;
  /** Layout only: its margins and place, beside a product's own panels. */
  style?: LayoutStyle;
}

/**
 * The page's card beside the sidebar (SidebarInset, the main landmark): the banner across its top,
 * then the page, which scrolls inside it, never the card. Inside a SidebarProvider, after the
 * AppShellSidebar.
 */
export const AppShellCard = ({
  children,
  banner,
  overlay,
  covered = false,
  style,
}: AppShellCardProps) => (
  <>
    {/* An inset Sidebar's mark beside the card, which SidebarInset draws itself as a card by: the
      card is one wherever a product's own layout puts it, beside the sidebar or in a group of
      panels. */}
    <span
      aria-hidden="true"
      data-variant="inset"
      hidden
      {...stylex.props(sidebarMarker)}
    />
    <SidebarInset style={style}>
      <div {...stylex.props(styles.frame)}>
        {isBlank(banner) ? null : (
          <div
            data-slot="app-shell-banner"
            inert={covered}
            {...stylex.props(styles.banner, covered && styles.covered)}
          >
            {banner}
          </div>
        )}
        <div {...stylex.props(styles.area)}>
          <div
            inert={covered}
            {...stylex.props(styles.held, covered && styles.covered)}
          >
            {children}
          </div>
          {overlay}
        </div>
      </div>
    </SidebarInset>
  </>
);

/** Every prop an AppShellContent takes. */
export interface AppShellContentProps {
  /** The page: its AppShellHeader, then its AppShellPage. */
  children: ReactNode;
  /** The scroller itself, to measure it. */
  ref?: Ref<HTMLDivElement>;
  /** Layout only. */
  style?: LayoutStyle;
}

/**
 * The page's scroller in the card: its bar stays at the top as the page scrolls under it, up and
 * down only; what is wider than the card is cut at its edge. Under the page it keeps
 * `appShellVars.contentRoomBelow`, for what a product lays over the card's foot (a dock).
 */
export const AppShellContent = ({
  children,
  ref,
  style,
}: AppShellContentProps) => (
  <div
    ref={ref}
    data-slot="app-shell-page"
    {...stylex.props(styles.page, style)}
  >
    {children}
  </div>
);

// ---- The composition -----------------------------------------------------------------------------

/** Every prop an AppShell takes. */
export interface AppShellProps
  extends
    Pick<
      SidebarProviderProps,
      | "defaultOpen"
      | "onOpenChange"
      | "open"
      | "openMobile"
      | "onOpenMobileChange"
      | "keyboardShortcut"
    >,
    Omit<AppShellSidebarProps, "children"> {
  /**
   * The product's sidebar under its head: its SidebarContent (or SidebarLevels), then its
   * SidebarFooter.
   */
  sidebar: ReactNode;
  /** The page: its AppShellHeader, then its AppShellPage. It scrolls under its header. */
  children: ReactNode;
  /**
   * Where the person's choices are kept in localStorage: whether the sidebar is folded, and which
   * of its SidebarCollapsible groups are. Put `sidebarStateScript(storageKey)` in the page's head
   * (or just before the shell) so the frame is drawn as kept before the page wakes. Without it
   * nothing is kept.
   */
  storageKey?: string;
  /** One panel at the end of the page, resizable: a SidePanel, seated unframed. A Sheet on a narrow window. */
  panel?: ReactNode;
  /**
   * Whether the panel shows, when you keep it: pass it with `onPanelOpenChange`. Unset, it shows
   * beside a wide page and waits closed on a narrow window.
   */
  panelOpen?: boolean;
  /** Runs when the bar's panel button, or the panel's sheet, opens or closes the panel. */
  onPanelOpenChange?: (open: boolean) => void;
  /** Above the page and its bar, across the card: a notice for the whole product, such as a Banner. */
  banner?: ReactNode;
  /**
   * Layout only: its height, in a frame of its own (`{ height: "100%", minHeight: 0 }`). It fills
   * the window's height by default.
   */
  style?: LayoutStyle;
}

type ShellPageProps = Pick<
  AppShellProps,
  "children" | "panel" | "panelOpen" | "onPanelOpenChange" | "banner"
>;

/** The card with the page and its panel: one resizable group, a sheet on a narrow window. */
const ShellPage = ({
  children,
  panel,
  panelOpen,
  onPanelOpenChange,
  banner,
}: ShellPageProps) => {
  const words = useI18n().appShell;
  const { isMobile } = useSidebar();
  const [own, setOwn] = useState<boolean>();
  const hasPanel = panel !== undefined && panel !== null && panel !== false;
  // Unset, open beside a wide page and closed on a narrow window, where it would cover the page.
  const open = hasPanel && (panelOpen ?? own ?? !isMobile);
  const setOpen = (next: boolean) => {
    setOwn(next);
    onPanelOpenChange?.(next);
  };
  return (
    <PanelContext
      // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
      value={hasPanel ? { open, setOpen } : undefined}
    >
      <AppShellCard banner={banner}>
        {/* One group always, the page its first panel: the panel coming and going never draws
          the page anew, so it keeps its scroll place and what was typed in it. */}
        <div {...stylex.props(styles.body)}>
          <ResizablePanelGroup>
            <ResizablePanel>
              <AppShellContent>{children}</AppShellContent>
            </ResizablePanel>
            {open && !isMobile && (
              <>
                <ResizableHandle aria-label={words.resize} />
                <ResizablePanel
                  defaultSize={PANEL_WIDTH}
                  minSize={PANEL_MIN}
                  maxSize={PANEL_MAX}
                >
                  <div
                    data-slot="app-shell-panel"
                    {...stylex.props(styles.panel)}
                  >
                    <SidePanelPlacementProvider value="beside">
                      {panel}
                    </SidePanelPlacementProvider>
                  </div>
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        </div>
        {hasPanel && isMobile && (
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetContent aria-label={words.pagePanel}>
              <SidePanelPlacementProvider value="sheet">
                {panel}
              </SidePanelPlacementProvider>
            </SheetContent>
          </Sheet>
        )}
      </AppShellCard>
    </PanelContext>
  );
};

/**
 * The frame a product's pages stand in, the parts composed: the sidebar with its head, the page's
 * card, one end panel.
 */
export const AppShell = ({
  sidebar,
  mark,
  onSearchOpenChange,
  searchOpen,
  searchShortcut,
  listenToSearchShortcut,
  storageKey,
  open,
  defaultOpen,
  onOpenChange,
  openMobile,
  onOpenMobileChange,
  keyboardShortcut,
  style,
  ...page
}: AppShellProps) => (
  <SidebarProvider
    storageKey={storageKey}
    open={open}
    defaultOpen={defaultOpen}
    onOpenChange={onOpenChange}
    openMobile={openMobile}
    onOpenMobileChange={onOpenMobileChange}
    keyboardShortcut={keyboardShortcut}
    style={style}
  >
    <AppShellSidebar
      mark={mark}
      onSearchOpenChange={onSearchOpenChange}
      searchOpen={searchOpen}
      searchShortcut={searchShortcut}
      listenToSearchShortcut={listenToSearchShortcut}
    >
      {sidebar}
    </AppShellSidebar>
    <ShellPage {...page} />
  </SidebarProvider>
);

// ---- The page's bar ------------------------------------------------------------------------------

/** One step on the way to the page: its name, and where it leads. */
export interface AppShellCrumb {
  /** The step's name, as its own page's title says it. */
  label: string;
  /** Where the step leads. Without it (and without `render`) the step is its name alone. */
  href?: string;
  /**
   * The element the step's link is drawn as, for a router's link (`render: <Link to="/projects" />`):
   * it takes the step's look and its name, and keeps its own props.
   */
  render?: ReactElement<Record<string, unknown>>;
}

/** Every prop an AppShellHeader takes. */
export interface AppShellHeaderProps {
  /** The steps before the page, from the top down. The bar writes a slash between each two. */
  breadcrumb?: readonly AppShellCrumb[];
  /** The page's name: the last step. */
  title?: string;
  /** Renames the page in place (InlineEdit): a press on the title, Enter or F2. Keep the name in your state. */
  onRename?: (name: string) => void;
  /** Whether the title's field is open, when you keep it (a menu's Rename opens it): pass it with `onRenamingChange`. */
  renaming?: boolean;
  /** Runs when the title's field opens or closes. */
  onRenamingChange?: (renaming: boolean) => void;
  /**
   * After the path: where the page's subject stands, a status or its link. It gives way to the
   * actions; an item that hides itself on a narrow bar (`display: none`) leaves the path its room.
   */
  trailing?: ReactNode;
  /** At the bar's end: the page's own buttons, `sm`. */
  actions?: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

const NO_STEPS: readonly AppShellCrumb[] = [];

// A phone's window, under 640px: the bar keeps only the page and the step before it.
const PHONE = `(width < ${px.sm}px)`;

const onPhoneChange = (changed: () => void): (() => void) => {
  const list = matchMedia(PHONE);
  list.addEventListener("change", changed);
  return () => {
    list.removeEventListener("change", changed);
  };
};

/** Whether the window is a phone's now, followed as it changes; never on the server. */
const usePhone = (): boolean =>
  useSyncExternalStore(
    onPhoneChange,
    () => matchMedia(PHONE).matches,
    () => false
  );

/** A step's link with its name, in the look given: the router's element, or an `<a>`. */
const stepLink = (
  crumb: AppShellCrumb,
  look: Record<string, unknown> = {}
): ReactElement | undefined =>
  crumb.render === undefined && crumb.href === undefined
    ? undefined
    : renderElement(
        "a",
        { href: crumb.href, ...look, children: crumb.label },
        crumb.render
      );

/**
 * Puts a phone trail's step away while it wrapped out of sight: out of the tab order and the
 * accessibility tree too (`inert`). It stays laid out, so the next resize finds whether it fits
 * again.
 */
const watchStep = (item: HTMLLIElement | null): (() => void) | undefined => {
  const list = item?.parentElement;
  if (item === null || list === null || list === undefined) {
    return undefined;
  }
  const place = () => {
    item.inert =
      item.getBoundingClientRect().top >= list.getBoundingClientRect().bottom;
  };
  place();
  // The list keeps its size as a name grows or a font arrives; what stands in it does not.
  const observer = new ResizeObserver(place);
  observer.observe(list);
  for (const child of list.children) {
    observer.observe(child);
  }
  return () => {
    observer.disconnect();
  };
};

/** A phone trail's step: its link in the sidebar's quieter words, or its name in the page's look. */
const PhoneStep = ({ crumb }: { crumb: AppShellCrumb }) =>
  stepLink(crumb, stylex.props(styles.phoneLink, focusRingText)) ?? (
    <span title={crumb.label} {...stylex.props(styles.phonePageWords)}>
      {crumb.label}
    </span>
  );

/**
 * Where the page is on a phone: the page and the step before it, the step dropped where both do
 * not fit. Breadcrumb's own narrow form keeps only the step back, without the page.
 */
const PhoneTrail = ({
  step,
  page,
  label,
}: {
  step: AppShellCrumb | undefined;
  page: ReactNode;
  label: string;
}) => (
  <nav
    aria-label={label}
    data-slot="breadcrumb"
    {...stylex.props(styles.phoneTrail)}
  >
    <ol {...stylex.props(styles.phoneCrumbs)}>
      {step === undefined ? null : (
        <li ref={watchStep} {...stylex.props(styles.phoneStep)}>
          <PhoneStep crumb={step} />
          <span aria-hidden="true" {...stylex.props(styles.phoneSlash)}>
            /
          </span>
        </li>
      )}
      <li {...stylex.props(styles.phonePage)}>{page}</li>
    </ol>
  </nav>
);

/**
 * The bar across the page's top, which the page draws: the sidebar's fold while the sidebar is away
 * (folded, or a sheet on a narrow window; otherwise its head holds it), where the page is (a slash
 * between the steps; on a phone the page and the step before it), what trails it, and at its end
 * the page's actions, and the panel's button when the shell has a panel.
 */
export const AppShellHeader = ({
  breadcrumb = NO_STEPS,
  title,
  onRename,
  renaming,
  onRenamingChange,
  trailing,
  actions,
  style,
}: AppShellHeaderProps) => {
  const words = useI18n();
  const panel = use(PanelContext);
  const phone = usePhone();
  let name: ReactNode = title;
  if (title !== undefined && onRename !== undefined) {
    name = (
      <InlineEdit
        aria-label={words.appShell.rename}
        value={title}
        onSubmit={onRename}
        editing={renaming}
        onEditingChange={onRenamingChange}
      />
    );
  }
  // Where the page is: the steps before it, then the page itself, a slash between each two. The bar
  // writes every separator, so each is the same.
  const steps = [
    ...breadcrumb.map((crumb, at) => {
      const link = stepLink(crumb);
      return (
        <BreadcrumbItem key={`step-${String(at)}`}>
          {link === undefined ? (
            <span {...stylex.props(styles.step)}>{crumb.label}</span>
          ) : (
            <BreadcrumbLink asChild>{link}</BreadcrumbLink>
          )}
        </BreadcrumbItem>
      );
    }),
    ...(title === undefined
      ? []
      : [
          <BreadcrumbItem key="page">
            {/* BreadcrumbPage repeats its words in a tooltip when cut: a field is never repeated. */}
            {onRename === undefined ? (
              <BreadcrumbPage>{name}</BreadcrumbPage>
            ) : (
              <span aria-current="page" {...stylex.props(styles.rename)}>
                {name}
              </span>
            )}
          </BreadcrumbItem>,
        ]),
  ];
  let where: ReactNode = null;
  if (phone) {
    // The page, or with no title the last step; and the step before it.
    const last = breadcrumb.at(-1);
    let page: ReactNode = null;
    if (title !== undefined) {
      // A field is never cut by the words' box: its finger's reach stands past them.
      page =
        onRename === undefined ? (
          <span
            aria-current="page"
            title={title}
            {...stylex.props(styles.phonePageWords)}
          >
            {name}
          </span>
        ) : (
          <span aria-current="page" {...stylex.props(styles.rename)}>
            {name}
          </span>
        );
    } else if (last !== undefined) {
      page = <PhoneStep crumb={last} />;
    }
    where = page !== null && (
      <PhoneTrail
        step={breadcrumb.at(title === undefined ? -2 : -1)}
        label={words.breadcrumb.name}
        page={page}
      />
    );
  } else if (steps.length > 0) {
    where = (
      <Breadcrumb aria-label={words.breadcrumb.name}>
        <BreadcrumbList>
          {steps.map((step, at) => (
            <Fragment key={step.key}>
              {at > 0 && <BreadcrumbSeparator>/</BreadcrumbSeparator>}
              {step}
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
    );
  }
  return (
    <header data-slot="app-shell-header" {...stylex.props(styles.bar, style)}>
      <span {...stylex.props(styles.trigger)}>
        <SidebarTrigger />
      </span>
      <div {...stylex.props(styles.where)}>
        {where}
        {trailing}
      </div>
      {(actions !== undefined || panel !== undefined) && (
        <div {...stylex.props(styles.actions)}>
          {actions}
          {panel !== undefined && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={words.appShell.togglePanel}
              aria-expanded={panel.open}
              onClick={() => {
                panel.setOpen(!panel.open);
              }}
            >
              <Icon icon={PanelRightIcon} />
            </Button>
          )}
        </div>
      )}
    </header>
  );
};

// ---- The page's body -----------------------------------------------------------------------------

/** Every prop an AppShellPage takes. */
export interface AppShellPageProps {
  /** The page under its bar: its PageHeader, then its parts. A state that stands for the page is an Empty that grows (`flexGrow: 1`). */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/**
 * The page's body under its bar: a column as wide as the card, its sides in the page's room, its
 * parts a step apart, room under the last. What should stay narrower (a form, a line of text) holds
 * its own measure inside it.
 */
export const AppShellPage = ({ children, style }: AppShellPageProps) => (
  <div
    data-slot="app-shell-page-body"
    {...stylex.props(styles.pageBody, style)}
  >
    {children}
  </div>
);

/** Every prop an AppShellPageSkeleton takes. */
export interface AppShellPageSkeletonProps {
  /**
   * How many lines of content stand under the heading.
   * @default 4
   */
  lines?: number;
}

/**
 * The page's body while a slow read comes, in the page's room: the pages' usual layout (a heading,
 * a line under it, then lines of content) as skeletons, said once as loading. Put it under the
 * page's bar.
 */
export const AppShellPageSkeleton = ({
  lines = 4,
}: AppShellPageSkeletonProps) => {
  const words = useI18n().appShell;
  return (
    <AppShellPage>
      <div
        data-slot="app-shell-page-skeleton"
        {...stylex.props(styles.skeletonHeading)}
      >
        <div {...stylex.props(styles.skeletonTitle)}>
          <Skeleton size="lg" />
        </div>
        <div {...stylex.props(styles.skeletonLead)}>
          <Skeleton size="default" />
        </div>
      </div>
      <output
        aria-busy="true"
        aria-label={words.loading}
        {...stylex.props(styles.skeletonLines)}
      >
        {Array.from({ length: lines }, (_, line) => (
          <div
            key={line}
            {...stylex.props(line === lines - 1 && styles.skeletonLastLine)}
          >
            <Skeleton size="default" />
          </div>
        ))}
      </output>
    </AppShellPage>
  );
};
