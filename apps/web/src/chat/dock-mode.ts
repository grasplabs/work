import { useSyncExternalStore } from "react";

// How the chat dock sits (chat-dock.tsx), for the pages that make room for
// it: its bar alone, a frame around it, or a drawer down the right side,
// which the brain's atlas keeps clear of where it is wide enough.

/** How the dock sits. */
export type DockMode = "bar" | "frame" | "drawer";

/**
 * How wide the dock is as a frame and as a drawer, in pixels: the frame
 * and the drawer at first are `normal`. Its edge (drawer-edge.tsx) drags
 * the drawer no narrower than it reads at (`least`) nor wider than its
 * `most`; past its least it gives a little, and pulled `give` further it
 * closes. An arrow key moves the edge `step`.
 */
export const dockDrawer = {
  normal: 442,
  least: 340,
  most: 640,
  give: 70,
  step: 24,
  /** How far the drawer keeps off the window's right edge (its `right-2`). */
  inset: 8,
} as const;

/**
 * The room a page leaves the drawer on a wide window: as wide as the
 * drawer and its inset, through `--dock-room`, which the dock sets on the
 * document as the drawer's width is kept (dock-frame.tsx).
 */
export const dockDrawerRoom = "lg:pr-(--dock-room)";

/** How much of the pull past its least width the drawer still follows: it resists. */
const resistance = 0.3;

/** The most of the window the drawer may take, so the page beside it stays a page. */
const mostOfWindow = 0.45;

/** The widest the drawer may be in a window `windowWidth` pixels wide. */
export const widestDockDrawer = (windowWidth: number): number =>
  Math.max(
    dockDrawer.least,
    Math.min(dockDrawer.most, Math.round(windowWidth * mostOfWindow))
  );

/** Where the drawer settles: between its least and the widest it may be. */
export const settledDrawerWidth = (width: number, widest: number): number =>
  Math.round(Math.min(widest, Math.max(dockDrawer.least, width)));

/**
 * Where a drag of the edge to `wanted` pixels leaves the drawer: as wide
 * as wanted up to its widest; under its least it resists; pulled `give`
 * past its least, closed.
 */
export const draggedDrawerWidth = (
  wanted: number,
  widest: number
): number | "closed" => {
  if (wanted < dockDrawer.least - dockDrawer.give) {
    return "closed";
  }
  if (wanted < dockDrawer.least) {
    return Math.round(
      dockDrawer.least - (dockDrawer.least - wanted) * resistance
    );
  }
  return Math.round(Math.min(widest, wanted));
};

/** Where an arrow key moves the edge: left makes the drawer wider. */
export const steppedDrawerWidth = (
  width: number,
  key: "ArrowLeft" | "ArrowRight",
  widest: number
): number =>
  settledDrawerWidth(
    key === "ArrowLeft" ? width + dockDrawer.step : width - dockDrawer.step,
    widest
  );

const listeners = new Set<() => void>();

const notify = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

let drawerWidth: number = dockDrawer.normal;

/** How wide the drawer is now. */
export const dockDrawerWidth = (): number => drawerWidth;

/** Makes the drawer `width` pixels wide, settled into what it may be. */
export const setDockDrawerWidth = (width: number): void => {
  const next = settledDrawerWidth(width, dockDrawer.most);
  if (next === drawerWidth) {
    return;
  }
  drawerWidth = next;
  notify();
};

let mode: DockMode = "bar";

/** Moves the dock to `next`. */
export const setDockMode = (next: DockMode): void => {
  if (next === mode) {
    return;
  }
  mode = next;
  notify();
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

/**
 * How wide the dock is as a drawer, for the pages that make room for it.
 * It changes when a drag ends, not on every move of it.
 */
export const useDockDrawerWidth = (): number =>
  useSyncExternalStore(subscribe, () => drawerWidth);
