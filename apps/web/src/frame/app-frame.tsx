import { Toaster as KitToaster } from "@grasp-os/app-kit/components/toast";
import { TooltipProvider as KitTooltipProvider } from "@grasp-os/app-kit/components/tooltip";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@grasp-os/ui/components/sidebar";
import { sidebarMarker } from "@grasp-os/ui/components/sidebar.stylex";
import { Toaster } from "@grasp-os/ui/components/toast";
import { duration, media, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";
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
  // over it, on the card's edges as the card publishes them. Presses go
  // through where it has nothing.
  dock: {
    position: "fixed",
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
  },
  // What it holds takes presses again: inherited, through a wrapper that
  // draws no box of its own.
  docked: { display: "contents", pointerEvents: "auto" },
  // Beside the chat's panels the card keeps no room at its end: the gutter
  // between the two is the panels' handle, as wide as the card's margin
  // (#2503's shell, frame/panels/panels.tsx), which is the card's end
  // margin when no panel stands there.
  card: { marginInlineEnd: 0 },
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
      root.style.setProperty(
        "--app-shell-main-bottom",
        `${root.clientHeight - box.bottom}px`
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
  panels,

  children,
}: {
  core: CoreConnection;
  identity: Identity;
  /** The AI providers that fail, read before the page showed (`failingUpFront`). */
  failing?: FailingProvider[];
  /** Over the page, centred at its foot: the chat's idle bar. */
  dock?: ReactNode;
  /** Beside the page, floating over it, or over it full screen: Grasp's chat. */
  panels?: ChatPanels;
  children: ReactNode;
}) => {
  const { t } = useLingui();
  const page = usePublishedPage();
  const cover = useChatCover(panels);
  const { covered, phone } = cover.place;
  const card = (
    <SidebarInset
      style={[panels !== undefined && styles.card, covered && styles.spans]}
    >
      <div {...stylex.props(styles.frame)}>
        <AiKeyBanner
          failing={failing}
          identity={identity}
          providers={providersOf(core)}
        />
        <div {...stylex.props(styles.area)}>
          <PageWithPanel>
            <div
              data-slot="app-shell-page"
              inert={covered}
              ref={page}
              {...stylex.props(styles.page, covered && styles.covered)}
            >
              <InFrame value>{children}</InFrame>
            </div>
          </PageWithPanel>
          <ChatToggle style={styles.chatToggle} />
          {/* On a phone the chat lies over the page under the bar's row,
              which keeps the menu's button, as #2503's shell does. */}
          {phone ? (
            <SidebarTrigger
              aria-label={t`Show or hide the sidebar`}
              style={styles.menu}
            />
          ) : null}
        </div>
      </div>
    </SidebarInset>
  );
  return (
    // Damsko's Toaster (below) is the app's one place for toasts: a page
    // mounts none of its own and calls Damsko's `toast`. The kit's stays
    // only for the four files that still call the kit's `toast.add`
    // (copy.ts, chat/chat-more.tsx, drafts/share-with-team.tsx,
    // brain/memories-page.tsx), each toast in the one region of the API it
    // was given to; it goes with the last of them. The kit's tooltips are
    // for the pages still on the kit.
    <KitToaster>
      <KitTooltipProvider>
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
          )}
        </SidebarProvider>
        <Toaster />
      </KitTooltipProvider>
    </KitToaster>
  );
};
