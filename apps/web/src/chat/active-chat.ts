import { useSyncExternalStore } from "react";

// The person's open chats in this tab: `chat`, the one Chat shows and the
// chat dock on every other page carries on, so what is asked there goes
// on in Chat and shows in its list; `brain`, the brain's own, which the
// dock carries on over the brain's atlas, a conversation apart from the
// other (it shows in Chat's list too); and one for each App the person
// changes (`app:<id>`), the App's own chat the dock holds on its page,
// which leaves their other chats alone. Kept for the tab (session
// storage), so a reload keeps them; nothing about the chats is kept.

/** Which of the tab's open chats. */
export type ChatSlot = "chat" | "brain" | `app:${string}`;

/** The slot of App `app`'s own chat. */
export const appSlot = (app: string): ChatSlot => `app:${app}`;

const keyOf = (slot: ChatSlot): string => {
  if (slot === "chat") {
    return "grasp.chat.active";
  }
  return slot === "brain" ? "grasp.chat.brain" : `grasp.chat.${slot}`;
};

const listeners = new Set<() => void>();

const read = (slot: ChatSlot): string | undefined => {
  try {
    return sessionStorage.getItem(keyOf(slot)) ?? undefined;
  } catch {
    // A private window may refuse storage: the dock starts a new chat.
    return undefined;
  }
};

/** Each slot's open chat, read from the tab's storage when first asked. */
const active = new Map<ChatSlot, string | undefined>();

const activeIn = (slot: ChatSlot): string | undefined => {
  if (!active.has(slot)) {
    active.set(slot, read(slot));
  }
  return active.get(slot);
};

/**
 * Makes `chatId` the open chat of `slot`, or none, so the next question
 * there starts one.
 */
export const setActiveChat = (
  chatId: string | undefined,
  slot: ChatSlot = "chat"
): void => {
  if (chatId === activeIn(slot)) {
    return;
  }
  active.set(slot, chatId);
  try {
    if (chatId === undefined) {
      sessionStorage.removeItem(keyOf(slot));
    } else {
      sessionStorage.setItem(keyOf(slot), chatId);
    }
  } catch {
    // See `read`: it lasts until the page reloads.
  }
  for (const listener of listeners) {
    listener();
  }
};

/** Forgets every open chat: they were the person's who signed out. */
export const forgetActiveChats = (): void => {
  for (const slot of new Set<ChatSlot>(["chat", "brain", ...active.keys()])) {
    setActiveChat(undefined, slot);
  }
  // Apps' chats this tab kept before this page loaded, too.
  try {
    const kept = Array.from(
      { length: sessionStorage.length },
      (_, index) => sessionStorage.key(index) ?? ""
    );
    for (const key of kept) {
      if (key.startsWith(keyOf(appSlot("")))) {
        sessionStorage.removeItem(key);
      }
    }
  } catch {
    // See `read`: nothing was kept.
  }
};

/**
 * The App whose own chat in this tab is `chatId`, if one's is: what Chat
 * knows of a chat past the end of its list, which says it only of the
 * chats it lists.
 */
export const appOfChat = (chatId: string): string | undefined => {
  const prefix = keyOf(appSlot(""));
  let kept: string[] = [];
  try {
    kept = Array.from(
      { length: sessionStorage.length },
      (_, index) => sessionStorage.key(index) ?? ""
    ).filter((key) => key.startsWith(prefix));
  } catch {
    // See `read`: only the chats this page opened are known.
  }
  const apps = new Set([
    ...kept.map((key) => key.slice(prefix.length)),
    ...[...active.keys()].flatMap((slot) =>
      slot.startsWith("app:") ? [slot.slice("app:".length)] : []
    ),
  ]);
  return [...apps].find((app) => activeIn(appSlot(app)) === chatId);
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The open chat of `slot` in this tab, if there is one, read once. */
export const activeChat = (slot: ChatSlot = "chat"): string | undefined =>
  activeIn(slot);

/** The open chat of `slot` in this tab, if there is one. */
export const useActiveChat = (slot: ChatSlot = "chat"): string | undefined =>
  useSyncExternalStore(subscribe, () => activeIn(slot));
