import { useSyncExternalStore } from "react";

// How the chat dock sits (chat-dock.tsx), for the pages that make room for
// it: its bar alone, a frame around it, or a drawer down the right side,
// which the brain's atlas keeps clear of where it is wide enough.

/** How the dock sits. */
export type DockMode = "bar" | "frame" | "drawer";

/**
 * How wide the dock is as a drawer (and as a frame), in pixels: the
 * prototype's 442, `dockDrawerClass`.
 */
export const dockDrawerWidth = 442;

/** The dock's width as a drawer or frame, as a class: `dockDrawerWidth`. */
export const dockDrawerClass = "w-110.5";

/**
 * The room a page leaves the drawer on a wide window: `dockDrawerWidth`
 * and the 8 pixels (`right-2`) the drawer keeps off the window's edge.
 */
export const dockDrawerRoom = "lg:pr-112.5";

const listeners = new Set<() => void>();

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
