import { useSyncExternalStore } from "react";

import { forgetCardGround } from "../brain/thinking/card-ground.ts";
import { forgetThinking } from "../brain/thinking/log.ts";
import { resetChatLayout } from "./chat-layout.ts";

// The person's open chats in this tab: `chat`, the one Grasp's chat
// carries on from page to page (global-chat.tsx), so what is asked there
// goes on in Chat and shows in its list; and one for each subject a page
// gives Grasp's chat (chat-subject.ts), as the App an App's workspace
// builds (`app:<id>`), which leaves the person's other chats alone. Kept for the tab (session storage), so a reload keeps
// them; nothing about the chats is kept.

/** Which of the tab's open chats: the person's, or a subject's. */
export type ChatSlot = "chat" | `${string}:${string}`;

const isSubjectSlot = (slot: string): slot is `${string}:${string}` =>
  slot.includes(":");

/** Where the tab keeps a subject's slot: its key, after this. */
const slotKeys = "grasp.chat.slot.";

const keyOf = (slot: ChatSlot): string =>
  slot === "chat" ? "grasp.chat.active" : `${slotKeys}${slot}`;

/** The subjects' slots this tab keeps, those from before this page loaded too. */
const keptSlots = (): ChatSlot[] => {
  try {
    return Array.from(
      { length: sessionStorage.length },
      (_, index) => sessionStorage.key(index) ?? ""
    ).flatMap((key): ChatSlot[] => {
      const slot = key.slice(slotKeys.length);
      return key.startsWith(slotKeys) && isSubjectSlot(slot) ? [slot] : [];
    });
  } catch {
    // See `read`: nothing was kept.
    return [];
  }
};

const listeners = new Set<() => void>();

const notify = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

/** The slot Grasp's chat shows: a subject's while its page is open, and its name. */
let shown: { slot: ChatSlot; name?: string } = { slot: "chat" };

/**
 * What a slot holds after `startAfresh`: no chat, and none to find, so the
 * next question starts one there.
 */
const afresh = "afresh";

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

/** What `slot` holds: a chat's ID, `afresh`, or nothing. */
const heldIn = (slot: ChatSlot): string | undefined => {
  if (!active.has(slot)) {
    active.set(slot, read(slot));
  }
  return active.get(slot);
};

const activeIn = (slot: ChatSlot): string | undefined => {
  const held = heldIn(slot);
  return held === afresh ? undefined : held;
};

/**
 * Makes `chatId` the open chat of `slot` (the one Grasp's chat shows, by
 * default), or none, so the next question there starts one.
 */
export const setActiveChat = (
  chatId: string | undefined,
  slot: ChatSlot = shown.slot
): void => {
  if (chatId === heldIn(slot)) {
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
  notify();
};

/**
 * Forgets chat `chatId` wherever the tab holds it open: in the person's
 * slot or a subject's, as after it was deleted, so the next question
 * there starts afresh (a subject's slot asks core for its chat again).
 */
export const forgetChat = (chatId: string): void => {
  for (const slot of new Set<ChatSlot>([
    "chat",
    ...active.keys(),
    ...keptSlots(),
  ])) {
    if (activeIn(slot) === chatId) {
      setActiveChat(undefined, slot);
    }
  }
};

/**
 * Forgets every open chat, what the tab saw and read of their thinking
 * (brain/thinking/log.ts, card-ground.ts), and where the chat was open
 * (chat-layout.ts): they were the person's who signed out.
 */
export const forgetActiveChats = (): void => {
  forgetThinking();
  forgetCardGround();
  resetChatLayout();
  for (const slot of new Set<ChatSlot>([
    "chat",
    ...active.keys(),
    ...keptSlots(),
  ])) {
    setActiveChat(undefined, slot);
  }
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The open chat of `slot` in this tab, if there is one, read once. */
export const activeChat = (slot: ChatSlot = shown.slot): string | undefined =>
  activeIn(slot);

/**
 * Leaves `slot` with no chat and none to find (a subject's, which would
 * otherwise find the one that last worked on it): its next question
 * starts one.
 */
export const startAfresh = (slot: ChatSlot): void => {
  setActiveChat(afresh, slot);
};

/** Whether `slot` was left to start afresh (`startAfresh`). */
export const useAfresh = (slot: ChatSlot): boolean =>
  useSyncExternalStore(subscribe, () => heldIn(slot) === afresh);

/**
 * The open chat of `slot` in this tab, if there is one: by default, the
 * one Grasp's chat shows.
 */
export const useActiveChat = (slot?: ChatSlot): string | undefined =>
  useSyncExternalStore(subscribe, () => activeIn(slot ?? shown.slot));

/** The slot Grasp's chat shows. */
export const useShownSlot = (): ChatSlot =>
  useSyncExternalStore(subscribe, () => shown.slot);

/** The name of what the shown slot is about; none for the person's own. */
export const useShownName = (): string | undefined =>
  useSyncExternalStore(subscribe, () => shown.name);

/** Has Grasp's chat show `slot`, about `name` (chat-subject.ts says which). */
export const showSlot = (slot: ChatSlot, name?: string): void => {
  if (slot !== shown.slot || name !== shown.name) {
    shown = name === undefined ? { slot } : { slot, name };
    notify();
  }
};
