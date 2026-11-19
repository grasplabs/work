import type { Identity } from "@grasp-os/shared/rpc";
// The kit's toasts and tooltips stay mounted beside Grasp UI's while pages
// in other areas still call the kit's; each goes when its last caller
// moves to Grasp UI.
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useMatchRoute } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useState } from "react";
import type { ReactNode } from "react";

import type { ChatPanels } from "../chat/chat-panel.tsx";
import type { CoreConnection } from "../core-connection.ts";
import { keepFolded, readFolded } from "../fold.ts";
import { AppShell } from "../grasp/app-shell/index.ts";
import type { AppShellProps } from "../grasp/app-shell/index.ts";
import { useGraspSidebar } from "../grasp/frame/grasp-sidebar.tsx";
import { Sidebar } from "../grasp/sidebar/index.ts";
import { Toaster } from "../grasp/toast/index.ts";
import {
  FailingBanner,
  providersOf,
  useFailingProviders,
} from "./ai-key-banner.tsx";
import type { FailingProvider } from "./ai-key-banner.tsx";
import { InFrame } from "./in-frame.ts";
import { usePageFills, usePageWhole } from "./page-fill.ts";
import { PagePanelProvider, usePagePanelSlot } from "./page-panel.tsx";
import { PersonTheme } from "./person-theme.tsx";

const styles = stylex.create({
  // The window's height, which App shell fills.
  shell: {
    height: "100svh",
  },
  // The page lays itself out down the card, at least as tall as it, as
  // pages do: Chat's start fills it, a page's own bar stays at its top.
  page: {
    display: "flex",
    flexDirection: "column",
    minHeight: "100%",
  },
  // A page that fills the card (no bar, as Chat's start, or one whose
  // route says so, frame/page-fill.ts): as tall as the card, no taller, so
  // its own panes scroll inside it.
  fill: {
    height: "100%",
  },
});

/** Whether a key goes to a field someone is typing in, which keeps it. */
const typing = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement);

/**
 * Cmd/Ctrl+B folds or opens the sidebar, as the kit's sidebar did, unless
 * someone is typing (Bold, in a text box). Grasp UI's Sidebar has no key of
 * its own yet.
 */
const useFoldKey = (toggle: () => void) => {
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.key.toLowerCase() === "b" &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      !typing(event.target)
    ) {
      event.preventDefault();
      toggle();
    }
  });
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);
};

/** Grasp's chat as App shell's panel props take it: none outside the shell's pages. */
const shellPanelsOf = (
  panels: ChatPanels | undefined
): Partial<AppShellProps> =>
  panels === undefined
    ? {}
    : {
        panels: panels.panels,
        panelsOpen: panels.open,
        ...(panels.onOpenChange === undefined
          ? {}
          : { onPanelsOpenChange: panels.onOpenChange }),
        covered: panels.covered,
        panelWidth: panels.width,
        onPanelWidthChange: panels.onWidthChange,
        minPanelWidth: panels.minWidth,
        maxPanelWidth: panels.maxWidth,
        panelPlacement: panels.placement,
        ...(panels.onPlacementChange === undefined
          ? {}
          : { onPanelPlacementChange: panels.onPlacementChange }),
        panelPosition: panels.position,
        onPanelPositionChange: panels.onPositionChange,
        panelHeight: panels.height,
        onPanelHeightChange: panels.onHeightChange,
        ...(panels.onClose === undefined
          ? {}
          : { onPanelsClose: panels.onClose }),
      };

/**
 * The signed-in product's frame, Grasp UI's App shell: the product's
 * sidebar beside the page, or in the menu on a phone; the page's card, its
 * bar drawn by each page (`SiteHeader`), or none (`bar="none"`, Chat's start);
 * over the card's foot what stays at hand on every page (`dock`); beside
 * the page, Grasp's chat (`panels`), docked or floating over it. A page outside the shell for someone
 * signed in, such as a decision opened from a link, has the frame with none
 * of them.
 */
export const AppFrame = ({
  core,
  identity,
  failing,
  bar = "page",
  dock,
  dockShown = true,
  panels,
  children,
}: {
  core: CoreConnection;
  identity: Identity;
  /** The AI providers that fail, read before the page showed (`failingUpFront`). */
  failing?: FailingProvider[];
  /** `page`: the page draws its own bar (`SiteHeader`); `none`: the page has the whole card. */
  bar?: "page" | "none";
  /** Over the page, centred at its foot: the chat's idle bar. */
  dock?: ReactNode;
  /** Whether the dock stands at the foot now; off, the page keeps no room or fade for it. */
  dockShown?: boolean;
  /** Beside the page, floating over it, or over it full screen: Grasp's chat. */
  panels?: ChatPanels;
  children: ReactNode;
}) => {
  const { t } = useLingui();
  // Folded as the person left it in this browser.
  const [open, setOpen] = useState(() => readFolded("sidebar") !== true);
  const [menuOpen, setMenuOpen] = useState(false);
  const fold = (next: boolean) => {
    setOpen(next);
    void keepFolded("sidebar", !next);
  };
  useFoldKey(() => {
    fold(!open);
  });
  const fills = usePageFills() || bar === "none";
  // A chat's own page has the whole card, edge to edge, its box at the foot
  // with no room under it (App shell's page for an open chat), and no dock
  // over its foot: the chat is the page.
  // The address being loaded, so a chat's pending state already has its frame.
  const chatPage =
    useMatchRoute()({ to: "/chats/$chatId", pending: true }) !== false;
  const whole = usePageWhole();
  // A page's own side panel, which the shell seats (frame/page-panel.tsx).
  const pagePanel = usePagePanelSlot();
  const sidebar = useGraspSidebar({
    core,
    identity,
    open,
    onOpenChange: fold,
    closeMenu: () => {
      setMenuOpen(false);
    },
  });
  // Read here, where it stays as pages come and go; drawn above the page's
  // bar, in App shell's own place for a banner.
  const failingNow = useFailingProviders({
    identity,
    providers: providersOf(core),
    ...(failing === undefined ? {} : { failing }),
  });
  return (
    <PersonTheme userId={identity.userId}>
      <div {...stylex.props(styles.shell)}>
        <AppShell
          banner={
            failingNow.length === 0 ? undefined : (
              <FailingBanner failing={failingNow} />
            )
          }
          bar={bar}
          dock={chatPage ? undefined : dock}
          dockShown={dockShown}
          {...(dockShown ? {} : { roomBelow: "page" as const })}
          {...shellPanelsOf(panels)}
          {...pagePanel.shell}
          words={{
            closeMenu: t`Close the menu`,
            menu: t`Menu`,
            resize: t`Resize the chat`,
            closePanel: t`Close the chat`,
            togglePanel: t`Show or hide the chat`,
          }}
          menuOpen={menuOpen}
          onMenuOpenChange={setMenuOpen}
          page={chatPage || whole ? "whole" : "padded"}
          // No tree lines on nested rows: Ruben saw them and took them out (18 Nov 2026).
          sidebar={<Sidebar {...sidebar} guides={false} />}
        >
          <div {...stylex.props(styles.page, fills && styles.fill)}>
            <PagePanelProvider value={pagePanel.frame}>
              <InFrame value>{children}</InFrame>
            </PagePanelProvider>
          </div>
        </AppShell>
      </div>
      {/* Grasp UI's toasts, for what the page and the chat say of an action. */}
      <Toaster
        words={{
          close: t`Close`,
          failed: t`Not done`,
          pending: t`Still working`,
        }}
        aria-label={t`Notifications`}
      />
    </PersonTheme>
  );
};
