import { useSyncExternalStore } from "react";

// The person's open chats in this tab: `chat`, the one Chat shows and the
// chat dock on every other page carries on, so what is asked there goes
// on in Chat and shows in its list; and `brain`, the brain's own, which
// the dock carries on over the brain's atlas, a conversation apart from
// the other (it shows in Chat's list too). Kept for the tab (session
// storage), so a reload keeps them; nothing about the chats is kept.

/** Which of the tab's open chats. */
export type ChatSlot = "chat" | "brain";

const keys: Record<ChatSlot, string> = {
  chat: "grasp.chat.active",
  brain: "grasp.chat.brain",
};

const listeners = new Set<() => void>();

const read = (slot: ChatSlot): string | undefined => {
  try {
    return sessionStorage.getItem(keys[slot]) ?? undefined;
  } catch {
    // A private window may refuse storage: the dock starts a new chat.
    return undefined;
  }
};

const active: Record<ChatSlot, string | undefined> = {
  chat: read("chat"),
  brain: read("brain"),
};

/**
 * Makes `chatId` the open chat of `slot`, or none, so the next question
 * there starts one.
 */
export const setActiveChat = (
  chatId: string | undefined,
  slot: ChatSlot = "chat"
): void => {
  if (chatId === active[slot]) {
    return;
  }
  active[slot] = chatId;
  try {
    if (chatId === undefined) {
      sessionStorage.removeItem(keys[slot]);
    } else {
      sessionStorage.setItem(keys[slot], chatId);
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
  setActiveChat(undefined, "chat");
  setActiveChat(undefined, "brain");
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The open chat of `slot` in this tab, if there is one, read once. */
export const activeChat = (slot: ChatSlot = "chat"): string | undefined =>
  active[slot];

/** The open chat of `slot` in this tab, if there is one. */
export const useActiveChat = (slot: ChatSlot = "chat"): string | undefined =>
  useSyncExternalStore(subscribe, () => active[slot]);
