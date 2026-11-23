import { Toaster as KitToaster } from "@grasp-os/app-kit/components/toast";
import { TooltipProvider as KitTooltipProvider } from "@grasp-os/app-kit/components/tooltip";
import type { Identity } from "@grasp-os/shared/rpc";
import { SidebarInset, SidebarProvider } from "@grasp-os/ui/components/sidebar";
import { Toaster } from "@grasp-os/ui/components/toast";
import { duration, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { AiKeyBanner, providersOf } from "./ai-key-banner.tsx";
import type { FailingProvider } from "./ai-key-banner.tsx";
import { AppSidebar } from "./app-sidebar.tsx";
import { InFrame } from "./in-frame.ts";

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
  },
  // The page, under the banner: it scrolls up and down only, what is wider
  // than the card is cut at its edge. Laid out down the card, at least as
  // tall as it, as the pages expect (Chat's start fills it).
  page: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
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
});

/**
 * Says where the page's card stands in the window, on the document, as the
 * sidebar folds, the chat docks beside it and the window resizes: its start
 * for the chat gone full screen over it (the kit's DockablePanel reads
 * `--app-shell-main-left`), and its end and foot for the dock.
 */
const usePublishedCard = () => {
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = card.current;
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
  return card;
};

/**
 * The signed-in product's frame, on Damsko: its Sidebar beside the page,
 * or a sheet from the start on a narrow window, folded as the person left
 * it (`storageKey`); the page as a card on the sidebar's ground
 * (SidebarInset, the main landmark), the AI providers' banner across its
 * top, the page under it with its own bar (SiteHeader), and over its foot
 * what stays at hand on every page (`dock`); beside or over the page, its
 * panels (`panels`), Grasp's chat. The shell's pages are in it, with all
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
  covered = false,
  children,
}: {
  core: CoreConnection;
  identity: Identity;
  /** The AI providers that fail, read before the page showed (`failingUpFront`). */
  failing?: FailingProvider[];
  /** Over the page, centred at its foot: the chat's idle bar. */
  dock?: ReactNode;
  /** Beside or over the page: the chat. */
  panels?: ReactNode;
  /** A panel is full screen over the page, whose content fades out under it. */
  covered?: boolean;
  children: ReactNode;
}) => {
  const card = usePublishedCard();
  return (
    // The kit's toasts and tooltips, for the pages still on it; Damsko's
    // toasts (below) for the frame's own, such as a sign-out core didn't
    // carry out.
    <KitToaster>
      <KitTooltipProvider>
        <SidebarProvider storageKey={sidebarKey}>
          <AppSidebar core={core} identity={identity} />
          <SidebarInset>
            <div ref={card} {...stylex.props(styles.frame)}>
              <AiKeyBanner
                failing={failing}
                identity={identity}
                providers={providersOf(core)}
              />
              <div
                data-slot="app-shell-page"
                inert={covered}
                {...stylex.props(styles.page, covered && styles.covered)}
              >
                <InFrame value>{children}</InFrame>
              </div>
            </div>
          </SidebarInset>
          {dock === undefined ? null : (
            <div
              data-slot="app-shell-dock"
              inert={covered}
              {...stylex.props(styles.dock, covered && styles.covered)}
            >
              <div {...stylex.props(styles.docked)}>{dock}</div>
            </div>
          )}
          {panels}
        </SidebarProvider>
        <Toaster />
      </KitTooltipProvider>
    </KitToaster>
  );
};
