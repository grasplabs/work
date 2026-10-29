import { useSyncExternalStore } from "react";

// How the chat dock sits (chat-dock.tsx), for the pages that make room for
// it: its bar alone, a frame around it, or a drawer down the right side,
// which the brain's atlas keeps clear of where it is wide enough.

/** How the dock sits. */
export type DockMode = "bar" | "frame" | "drawer";

/**
 * How wide the dock is as a drawer, in pixels: 442 at first, dragged by
 * its edge (drawer-edge.tsx) never narrower than it reads at, nor wider
 * than its most; past its least it gives a little before it closes.
 */
export const dockDrawer = { normal: 442, least: 340, most: 640, give: 70 };

/** The widest the drawer may be in this window: never more than 45% of it, so the page beside it stays a page. */
export const widestDockDrawer = (): number =>
  Math.max(
    dockDrawer.least,
    Math.min(dockDrawer.most, Math.round(window.innerWidth * 0.45))
  );

const listeners = new Set<() => void>();

let drawerWidth = dockDrawer.normal;

/** Makes the drawer `width` pixels wide, at most its most. */
export const setDockDrawerWidth = (width: number): void => {
  const next = Math.round(Math.min(dockDrawer.most, Math.max(0, width)));
  if (next === drawerWidth) {
    return;
  }
  drawerWidth = next;
  for (const listener of listeners) {
    listener();
  }
};

let mode: DockMode = "bar";

/** Moves the dock to `next`. */
export const setDockMode = (next: DockMode): void => {
  if (next === mode) {
    return;
  }
  mode = next;
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** How the dock sits now. */
export const useDockMode = (): DockMode =>
  useSyncExternalStore(subscribe, () => mode);

/** How wide the dock is as a drawer now, for the pages that make room for it. */
export const useDockDrawerWidth = (): number =>
  useSyncExternalStore(subscribe, () => drawerWidth);
