import { useSyncExternalStore } from "react";

// The person's open chat in this tab: the one Chat shows, and the one the
// chat dock on every other page carries on, so what is asked there goes
// on in Chat and shows in its list. Kept for the tab (session storage), so
// a reload keeps it; nothing about the chat itself is kept.

const key = "grasp.chat.active";

const listeners = new Set<() => void>();

const read = (): string | undefined => {
  try {
    return sessionStorage.getItem(key) ?? undefined;
  } catch {
    // A private window may refuse storage: the dock starts a new chat.
    return undefined;
  }
};

let active = read();

/** Makes `chatId` the open chat, or none, so the next question starts one. */
export const setActiveChat = (chatId: string | undefined): void => {
  if (chatId === active) {
    return;
  }
  active = chatId;
  try {
    if (chatId === undefined) {
      sessionStorage.removeItem(key);
    } else {
      sessionStorage.setItem(key, chatId);
    }
  } catch {
    // See `read`: it lasts until the page reloads.
  }
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

/** The open chat in this tab, if there is one. */
export const useActiveChat = (): string | undefined =>
  useSyncExternalStore(subscribe, () => active);
