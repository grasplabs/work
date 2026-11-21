import { useSyncExternalStore } from "react";

import type {
  AppShellPanelPlacement,
  AppShellPanelPosition,
} from "../grasp/app-shell/index.ts";

// How Grasp's one chat is laid out beside a page (global-chat.tsx), as
// App shell's panels take it: open or closed to its idle bar, docked
// beside the page or floating over it, where the person last moved the
// window and how tall they made it, as wide as they made it (docked and
// floating share it), and whether it covers the page, full screen. A chat
// as a whole page is its own page (chat-page.tsx), not a layout. Kept in
// this browser (local storage), so a reload or a new tab finds it the same.

/** Where the chat stands beside a page: docked, or floating over it. */
export type ChatPlacement = AppShellPanelPlacement;

export interface ChatLayout {
  open: boolean;
  placement: ChatPlacement;
  /** Where the floating chat was moved, once it was (App shell's `panelPosition`). */
  position: AppShellPanelPosition | null;
  /** How tall the floating chat was made, once it was. */
  height: number | null;
  /** How wide the chat is, in pixels. */
  width: number;
  /** Whether it covers the page, full screen. */
  expanded: boolean;
}

/** How wide the docked chat is at first, and at least and most, in pixels. */
export const chatWidth = { initial: 416, min: 340, max: 720 } as const;

const storageKey = "grasp.chat.layout";

const initialLayout: ChatLayout = {
  open: false,
  placement: "docked",
  position: null,
  height: null,
  width: chatWidth.initial,
  expanded: false,
};

/** A place the chat is kept in: docked or floating. */
const isKeptPlacement = (value: unknown): value is ChatPlacement =>
  value === "docked" || value === "floating";

const isPosition = (value: unknown): value is AppShellPanelPosition =>
  typeof value === "object" &&
  value !== null &&
  "x" in value &&
  "y" in value &&
  typeof value.x === "number" &&
  typeof value.y === "number";

const read = (): ChatLayout => {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (typeof raw !== "object" || raw === null) {
      return initialLayout;
    }
    const kept = (field: keyof ChatLayout): unknown => Reflect.get(raw, field);
    const placement = kept("placement");
    const position = kept("position");
    const height = kept("height");
    const width = kept("width");
    return {
      open: kept("open") === true,
      placement: isKeptPlacement(placement) ? placement : "docked",
      position: isPosition(position) ? position : null,
      height: typeof height === "number" ? height : null,
      width:
        typeof width === "number"
          ? Math.min(chatWidth.max, Math.max(chatWidth.min, width))
          : chatWidth.initial,
      expanded: kept("expanded") === true,
    };
  } catch {
    // A private window may refuse storage, or what was kept is unreadable.
    return initialLayout;
  }
};

let layout: ChatLayout | undefined;

const current = (): ChatLayout => {
  layout ??= read();
  return layout;
};

const listeners = new Set<() => void>();

const update = (changes: Partial<ChatLayout>): void => {
  layout = { ...current(), ...changes };
  try {
    localStorage.setItem(storageKey, JSON.stringify(layout));
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

/** Where the chat was last put, outside React (an opener's choice). */
export const chatPlacement = (): ChatPlacement => current().placement;

/** The chat's layout now. */
export const useChatLayout = (): ChatLayout =>
  useSyncExternalStore(subscribe, current);

/** Opens the chat `placement`, or where it last was; moves it, when open. */
export const openChat = (placement?: ChatPlacement): void => {
  update({ open: true, placement: placement ?? current().placement });
};

/** Closes the chat to its idle bar; it opens again where it was, as large, but not full screen. */
export const closeChat = (): void => {
  update({ open: false, expanded: false });
};

/** Keeps where the person moved the floating chat. */
export const moveChat = (position: AppShellPanelPosition): void => {
  update({ position });
};

/** Keeps how wide the person made the chat. */
export const resizeChat = (width: number): void => {
  update({ width });
};

/** Keeps how tall the person made the floating chat. */
export const heightenChat = (height: number): void => {
  update({ height });
};

/** Takes the chat full screen, or back to where it was. */
export const expandChat = (expanded: boolean): void => {
  update({ expanded });
};

/** Forgets the layout, as for someone else signing in on this browser. */
export const resetChatLayout = (): void => {
  update(initialLayout);
};
