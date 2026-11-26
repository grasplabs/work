import type { Identity } from "@grasp-os/shared/rpc";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@grasp-os/ui/components/sidebar";
import { sidebarMarker } from "@grasp-os/ui/components/sidebar.stylex";
import { Toaster } from "@grasp-os/ui/components/toast";
import {
  colors,
  duration,
  media,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { ChatPanels } from "../chat/chat-panel.tsx";
import { ChatToggle } from "../chat/chat-toggle.tsx";
import type { CoreConnection } from "../core-connection.ts";
import { AiKeyBanner, providersOf } from "./ai-key-banner.tsx";
import type { FailingProvider } from "./ai-key-banner.tsx";
import { AppSidebar } from "./app-sidebar.tsx";
import { InFrame } from "./in-frame.ts";
import { PageWithPanel } from "./page-panel.tsx";
import {
  ChatPanelsBeside,
  useChatCover,
} from "./panels/chat-panels-beside.tsx";

/**
 * Where the person's sidebar choices are kept in this browser: whether it
 * is folded, and which of its groups (SidebarCollapsible) are.
 */
export const sidebarKey = "grasp.sidebar";

const styles = stylex.create({
  // What the card holds, laid over its box, as Damsko's app-shell-01 lays
  // it: the card is as tall as the window, never as the page, so the page
  // scrolls inside it and its bar (SiteHeader) stays.
  frame: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "clip",
    borderRadius: "inherit",
    // A layer of its own, so the line inside the card's edge stands over
    // all of it, the page's bar too, as the reference's.
    zIndex: 0,
    // The card's ground under the lg breakpoint too, as #2503's card
    // (shell-card) is on a phone: Damsko's SidebarInset is a card only from
    // lg and takes the page's ground under it, which in dark is the brand's
    // night, a step darker than the card. From lg the card draws it.
    backgroundColor: { default: colors.sidebarCard, [media.lg]: "transparent" },
  },
  // The page, under the banner: it scrolls up and down only, what is wider
  // than the card is cut at its edge. Laid out down the card, at least as
  // tall as it, as the pages expect (Chat's start fills it).
  page: {
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
    height: "100%",
    minHeight: 0,
    overflowX: "clip",
    overflowY: "auto",
    scrollbarWidth: "none",
    // A panel gone full screen lies over the card: the page fades out
    // under it, and back a beat after the panel starts to leave.
    transitionProperty: "opacity",
    transitionDuration: duration.ui,
    transitionTimingFunction: duration.ease,
    transitionDelay: duration.press,
  },
  covered: { opacity: 0, transitionDelay: "0s" },
  // The AI providers' banner across the card's top fades with the page
  // under a panel gone full screen, whose head stands where it is.
  banner: {
    flexShrink: 0,
    transitionProperty: "opacity",
    transitionDuration: duration.ui,
    transitionTimingFunction: duration.ease,
    transitionDelay: duration.press,
  },
  // The page and its panel, under the banner: what the chat's button
  // stands over.
  area: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
  },
  // The chat's button at the card's end, at the page bar's height, its
  // empty rim hanging out past the page's room, as the reference's (over
  // the page's panel too, when it has one).
  chatToggle: {
    position: "absolute",
    insetBlockStart: `calc((${size.appShellBar} - ${size.sidebarIconButton}) / 2)`,
    insetInlineEnd: `calc(${size.appShellPageInline} - (${size.sidebarIconButton} - ${size.sidebarIcon}) / 2)`,
    zIndex: 25,
  },
  // On a phone the menu's button is #2503's Menu button, a ghost Button:
  // in the chat button's ink, not the sidebar's greys (site-header.tsx).
  menuInk: {
    display: "contents",
    "--damsko-sidebar-secondary-foreground": {
      default: null,
      [media.maxSm]: colors.foreground,
    },
  },
  // The menu's button at the row's start on a phone, where the page's bar
  // has its trigger (site-header.tsx), while the chat covers the page.
  menu: {
    position: "absolute",
    insetBlockStart: `calc((${size.appShellBar} - ${size.sidebarIconButton}) / 2)`,
    insetInlineStart: `calc(${size.appShellPageInline} + (${size.sidebarIcon} - ${size.sidebarIconButton}) / 2)`,
    zIndex: 25,
  },
  // Over the page, centred at the card's foot, clear of its edges: what
  // stays at hand on every page. Not in the card's own box, which is the
  // main landmark (SidebarInset), so it is no part of the page's content:
  // over it, on the card's edges as the card publishes them. Placed on the
  // document, not the window, so it moves with the card where the document
  // scrolls (a phone's page scrolled to its end), as #2503's dock, which
  // stands in its card. Presses go through where it has nothing.
  dock: {
    position: "absolute",
    insetInlineStart: `calc(var(--app-shell-main-left, 0px) + ${space["4"]})`,
    insetInlineEnd: `calc(var(--app-shell-main-right, 0px) + ${space["4"]})`,
    insetBlockEnd: `calc(var(--app-shell-main-bottom, 0px) + ${space["4"]})`,
    zIndex: 30,
    display: "flex",
    justifyContent: "center",
    pointerEvents: "none",
    transitionProperty: "opacity",
    transitionDuration: duration.ui,
    transitionTimingFunction: duration.ease,
    // On a phone it stands in the card, which is the window, and nothing
    // of it (its shadow, its light) reaches past the card's foot, as
    // #2503's dock in its card: cut at the card's foot, `space4` under it.
    clipPath: {
      default: null,
      [media.maxSm]: `inset(-100vh -100vw calc(-1 * ${space["4"]}) -100vw)`,
    },
  },
  // The window's room on the document, the dock's own: what the dock holds
  // (its light, a bar sunk away under the foot) is cut at it, so it never
  // makes the document taller, as #2503's dock in its card never does.
  dockLayer: {
    position: "absolute",
    inset: 0,
    zIndex: 30,
    overflow: "clip",
    pointerEvents: "none",
  },
  // What it holds takes presses again: inherited, through a wrapper that
  // draws no box of its own.
  docked: { display: "contents", pointerEvents: "auto" },
  // Beside the chat's panels the card keeps no room at its end: the gutter
  // between the two is the panels' handle, as wide as the card's margin
  // (#2503's shell, frame/panels/panels.tsx), which is the card's end
  // margin when no panel stands there.
  card: { marginInlineEnd: 0 },
  // Room under a page that fills the card while the dock stands over its
  // foot, as #2503's shell keeps it (its `roomForDock`): the page's foot is
  // as tall as the dock, its inset from the card's foot and the gap above
  // it, in place of the page's usual room (never less). Such a page (an
  // App's workspace, a workflow) keeps that usual room inside itself
  // (`space8`, the shell's room below), so the frame adds only the rest.
  roomForDock: (height: number) => ({
    paddingBlockEnd: `max(0px, calc(${height}px + ${space["4"]} + ${space["6"]} - ${space["8"]}))`,
  }),
  // Under the chat lying over it (full screen, or for want of room), the
  // card spans the room beside the sidebar, its margins in, edge to edge on
  // a phone: the ground the chat stands on (#2503's `cardCovered`).
  spans: {
    position: "absolute",
    inset: { default: size.sidebarCardGap, [media.maxSm]: 0 },
    margin: 0,
  },
});

/**
 * Says where the page's column stands in the window, on the document, as
 * the sidebar folds, a panel opens beside it and the window resizes: its
 * start, the card's, for the chat gone full screen over it (the kit's
 * DockablePanel reads `--app-shell-main-left`), and its end and foot for
 * the dock, which so stands in the middle of the page and not of its panel.
 */
const usePublishedPage = () => {
  const page = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = page.current;
    if (element === null) {
      return () => {
        // Nothing was watched.
      };
    }
    const root = document.documentElement;
    const publish = () => {
      const box = element.getBoundingClientRect();
      root.style.setProperty("--app-shell-main-left", `${box.left}px`);
      root.style.setProperty(
        "--app-shell-main-right",
        `${root.clientWidth - box.right}px`
      );
      // On the document, as the dock is placed: the same wherever the
      // document stands scrolled when it is measured.
      root.style.setProperty(
        "--app-shell-main-bottom",
        `${root.clientHeight - (box.bottom + window.scrollY)}px`
      );
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    observer.observe(root);
    return () => {
      observer.disconnect();
      for (const edge of ["left", "right", "bottom"]) {
        root.style.removeProperty(`--app-shell-main-${edge}`);
      }
    };
  }, []);
  return page;
};

/**
 * How tall the dock's bar is while `on`, followed as it changes (a box
 * that grows with what is typed); null while off or not yet measured.
 */
const useDockHeight = (on: boolean): number | null => {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const held = on
      ? document.querySelector<HTMLElement>(
          "[data-slot=app-shell-dock] > * > *"
        )
      : null;
    if (held === null) {
      return () => {
        // Nothing was watched.
      };
    }
    const observer = new ResizeObserver(() => {
      setHeight(Math.ceil(held.getBoundingClientRect().height));
    });
    observer.observe(held);
    return () => {
      observer.disconnect();
    };
  }, [on]);
  return on ? height : null;
};

/**
 * The signed-in product's frame, on Damsko: its Sidebar beside the page,
 * or a sheet from the start on a narrow window, folded as the person left
 * it (`storageKey`); the page as a card on the sidebar's ground
 * (SidebarInset, the main landmark), the AI providers' banner across its
 * top, the page under it with its own bar (SiteHeader) and, when the page
 * has one, its side panel (page-panel.tsx), and over its foot what stays
 * at hand on every page (`dock`); beside or over the page, its panels
 * (`panels`), Grasp's chat. The shell's pages are in it, with all
 * of them, and a page outside the shell for someone signed in, such as a
 * decision opened from a link, with none of them.
 *
 * Composed from the parts Damsko's app-shell-01 composes, the way it lays
 * them, not the block itself: the block keeps the fold to itself, draws the
 * page's bar from props, and has one resizable panel and no dock, where
 * here each page draws its bar and the chat docks, floats and covers the
 * page. It moves onto the block once the block takes those.
 */
export const AppFrame = ({
  core,
  identity,
  failing,
  dock,
  dockRoom = false,
  panels,

  children,
}: {
  core: CoreConnection;
  identity: Identity;
  /** The AI providers that fail, read before the page showed (`failingUpFront`). */
  failing?: FailingProvider[];
  /** Over the page, centred at its foot: the chat's idle bar. */
  dock?: ReactNode;
  /** The page fills the card and the dock stands over its foot: the page keeps room for it. */
  dockRoom?: boolean;
  /** Beside the page, floating over it, or over it full screen: Grasp's chat. */
  panels?: ChatPanels;
  children: ReactNode;
}) => {
  const { t } = useLingui();
  const page = usePublishedPage();
  const dockHeight = useDockHeight(dockRoom);
  const cover = useChatCover(panels);
  const { covered, phone } = cover.place;
  const card = (
    <SidebarInset
      style={[panels !== undefined && styles.card, covered && styles.spans]}
    >
      <div {...stylex.props(styles.frame)}>
        <div
          inert={covered}
          {...stylex.props(styles.banner, covered && styles.covered)}
        >
          <AiKeyBanner
            failing={failing}
            identity={identity}
            providers={providersOf(core)}
          />
        </div>
        <div {...stylex.props(styles.area)}>
          <PageWithPanel>
            <div
              data-slot="app-shell-page"
              inert={covered}
              ref={page}
              {...stylex.props(
                styles.page,
                covered && styles.covered,
                dockHeight !== null && styles.roomForDock(dockHeight)
              )}
            >
              <InFrame value>{children}</InFrame>
            </div>
          </PageWithPanel>
          <ChatToggle style={styles.chatToggle} />
          {/* On a phone the chat lies over the page under the bar's row,
              which keeps the menu's button, as #2503's shell does. */}
          {phone ? (
            <span {...stylex.props(styles.menuInk)}>
              <SidebarTrigger
                aria-label={t`Show or hide the sidebar`}
                style={styles.menu}
              />
            </span>
          ) : null}
        </div>
      </div>
    </SidebarInset>
  );
  return (
    // Damsko's Toaster (below) is the app's one place for toasts: a page
    // mounts none of its own and calls Damsko's `toast`.
    <>
      <SidebarProvider storageKey={sidebarKey}>
        <AppSidebar core={core} identity={identity} />
        {panels === undefined ? (
          card
        ) : (
          <ChatPanelsBeside
            card={
              <>
                {/* Damsko's SidebarInset is a card only beside an inset
                  Sidebar, its sibling; beside the chat it stands in the
                  panels' group, so it is given that sibling's mark here
                  (registry gap of 24 Nov 2026: an inset that is a card
                  wherever it stands). */}
                <span
                  aria-hidden="true"
                  data-variant="inset"
                  hidden
                  {...stylex.props(sidebarMarker)}
                />
                {card}
              </>
            }
            cover={cover}
            panels={panels}
          />
        )}
        {dock === undefined ? null : (
          <div {...stylex.props(styles.dockLayer)}>
            <div
              data-slot="app-shell-dock"
              inert={panels?.covered === true}
              {...stylex.props(
                styles.dock,
                panels?.covered === true && styles.covered
              )}
            >
              <div {...stylex.props(styles.docked)}>{dock}</div>
            </div>
          </div>
        )}
      </SidebarProvider>
      <Toaster />
    </>
  );
};
