import { useSyncExternalStore } from "react";

// How the chat dock sits (chat-dock.tsx), for the pages that make room for
// it: its bar alone, a frame around it, or a drawer down the right side,
// which the brain's atlas keeps clear of where it is wide enough.

/** How the dock sits. */
export type DockMode = "bar" | "frame" | "drawer";

/** How wide the dock is as a drawer, in pixels: its `w-110`. */
export const dockDrawerWidth = 440;

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
