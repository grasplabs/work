import { useSyncExternalStore } from "react";

/**
 * Whether the phone's menu is open, kept outside the frame: the frame that
 * stands while core says who is in (shell-pending.tsx) hands over to the
 * real one (app-frame.tsx), and a menu opened meanwhile stays open across.
 */
let open = false;
const watchers = new Set<() => void>();

const watch = (changed: () => void): (() => void) => {
  watchers.add(changed);
  return () => {
    watchers.delete(changed);
  };
};

const setMenuOpen = (next: boolean): void => {
  open = next;
  for (const changed of watchers) {
    changed();
  }
};

/** The phone's menu: whether it is open, and how to open or close it. */
export const usePhoneMenu = (): [boolean, (open: boolean) => void] => [
  useSyncExternalStore(watch, () => open),
  setMenuOpen,
];
