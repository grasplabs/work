import type {
  DockablePlacement,
  FloatingOffset,
} from "@grasp-os/ui/components/dockable-panel";
import { useSyncExternalStore } from "react";

// How Grasp's one chat is laid out beside a page (global-chat.tsx): open or
// closed to its idle bar, docked beside the page or floating over it, where
// the person last moved it, and as wide as they last made it docked. A chat
// as a whole page is its own page (chat-page.tsx), not a layout. Kept in
// this browser (local storage), so a reload or a new tab finds it the same.

/** Where the chat stands beside a page: docked, or floating over it. */
export type ChatPlacement = Exclude<DockablePlacement, "fullscreen">;

export interface ChatLayout {
  open: boolean;
  placement: ChatPlacement;
  /** How far the floating chat was moved from its corner, once it was. */
  offset: FloatingOffset | null;
  /** How wide the docked chat is, in pixels. */
  width: number;
}

/** How wide the docked chat is at first, and at least and most, in pixels. */
export const chatWidth = { initial: 416, min: 340, max: 720 } as const;

/**
 * How much of the page's right the floating chat covers where it first
 * stands, in pixels: the kit's floating panel (`w-100`) and its margin.
 */
export const floatingChatCover = 416;

const storageKey = "grasp.chat.layout";

const initialLayout: ChatLayout = {
  open: false,
  placement: "docked",
  offset: null,
  width: chatWidth.initial,
};

/** A place the chat is kept in: docked or floating. */
const isKeptPlacement = (value: unknown): value is ChatPlacement =>
  value === "docked" || value === "floating";

const isOffset = (value: unknown): value is FloatingOffset =>
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
    const offset = kept("offset");
    const width = kept("width");
    return {
      open: kept("open") === true,
      placement: isKeptPlacement(placement) ? placement : "docked",
      offset: isOffset(offset) ? offset : null,
      width:
        typeof width === "number"
          ? Math.min(chatWidth.max, Math.max(chatWidth.min, width))
          : chatWidth.initial,
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

/** Closes the chat to its idle bar. */
export const closeChat = (): void => {
  update({ open: false });
};

/** Keeps where the person moved the floating chat. */
export const moveChat = (offset: FloatingOffset): void => {
  update({ offset });
};

/** Keeps how wide the person made the docked chat. */
export const resizeChat = (width: number): void => {
  update({ width });
};

/** Forgets the layout, as for someone else signing in on this browser. */
export const resetChatLayout = (): void => {
  update(initialLayout);
};
