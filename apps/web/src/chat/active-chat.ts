import { useSyncExternalStore } from "react";

import { forgetCardGround } from "../brain/thinking/card-ground.ts";
import { forgetThinking } from "../brain/thinking/log.ts";

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

/**
 * Forgets every open chat, and what the tab saw and read of their thinking
 * (brain/thinking/log.ts, card-ground.ts): they were the person's who
 * signed out.
 */
export const forgetActiveChats = (): void => {
  forgetThinking();
  forgetCardGround();
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
