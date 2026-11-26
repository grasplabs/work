import { SidebarInset, SidebarProvider } from "@grasp-os/ui/components/sidebar";
import { colors, media } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

const styles = stylex.create({
  // What the card holds, laid over its box, as Damsko's app-shell-01 lays
  // it: the card is as tall as the window, never as the page, so the page
  // scrolls inside it and its bar (PageBar) stays.
  frame: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "clip",
    borderRadius: "inherit",
    zIndex: 0,
    // The card's ground under lg too: Damsko's SidebarInset is a card only
    // from lg and takes the page's ground under it.
    backgroundColor: { default: colors.sidebarCard, [media.lg]: "transparent" },
  },
  banner: { flexShrink: 0 },
  // The page: it scrolls up and down only, what is wider than the card is
  // cut at its edge.
  page: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    boxSizing: "border-box",
    minHeight: 0,
    overflowX: "clip",
    overflowY: "auto",
    scrollbarWidth: "none",
  },
});

/**
 * The signed-in frame: the sidebar beside the page, or a sheet from the
 * start on a narrow window, folded as the person left it (`storageKey`);
 * the page as a card on the sidebar's ground (SidebarInset, the main
 * landmark), a banner across its top when there is one, and the page under
 * it, which draws its own bar (PageBar). What a product adds around the
 * page (a chat beside it, a dock over its foot) it lays round `children`.
 */
export const FrameShell = ({
  sidebar,
  storageKey,
  banner,
  children,
}: {
  sidebar: ReactNode;
  storageKey: string;
  banner?: ReactNode;
  children: ReactNode;
}) => (
  <SidebarProvider storageKey={storageKey}>
    {sidebar}
    <SidebarInset>
      <div {...stylex.props(styles.frame)}>
        {banner === undefined ? null : (
          <div {...stylex.props(styles.banner)}>{banner}</div>
        )}
        <div data-slot="app-shell-page" {...stylex.props(styles.page)}>
          {children}
        </div>
      </div>
    </SidebarInset>
  </SidebarProvider>
);
