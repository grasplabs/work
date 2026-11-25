import { useSyncExternalStore } from "react";

// Whether the page has room beside Grasp's chat docked, as the frame's
// panels measure the room they share with the page's card
// (frame/panels/panels.tsx): where it has none, the docked chat lies over
// the page, so a page about the chat's subject can't keep it open
// (global-chat.tsx). Measured again on every load, never kept.

let tight = false;
const listeners = new Set<() => void>();

/** Says whether the page would be squeezed under its least beside the docked chat. */
export const setNoRoomBeside = (squeezed: boolean): void => {
  if (squeezed === tight) {
    return;
  }
  tight = squeezed;
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (changed: () => void): (() => void) => {
  listeners.add(changed);
  return () => {
    listeners.delete(changed);
  };
};

/** Whether the docked chat would lie over the page for want of room; never on the server. */
export const useNoRoomBeside = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => tight,
    () => false
  );
