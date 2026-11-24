import { useMatches } from "@tanstack/react-router";

import { useShownSlot } from "./active-chat.ts";
import { chatPlacement, openChat } from "./chat-layout.ts";
import type { ChatPlacement } from "./chat-layout.ts";
import { subjectOf } from "./chat-subject.ts";

// Where Grasp's one chat may show on a page (global-chat.tsx): a page
// says so on its route, in TanStack Router's own static data, and the
// deepest route that says it is the one that holds, so a page's own pages
// follow it; every other page has the chat everywhere. A page about a
// subject (chat-subject.ts) has it docked, whatever its route says. A route the router
// doesn't nest (an escaped one, `$app_`) says it for itself.
//
//   export const Route = createFileRoute("/_shell/")({
//     staticData: { chat: chatPresence.hidden },
//   });
//
// Where the chat was last put and isn't allowed, it doesn't show, and
// isn't closed: on another page it shows there again. Opened on a page,
// it opens where it was put if the page allows that, or where the page
// allows first (`placementOn`).

/** Where the chat may show on a page, and whether its idle bar does. */
export interface ChatPresence {
  placements: readonly ChatPlacement[];
  bar: boolean;
}

/** The chat's presences pages choose from. */
export const chatPresence = {
  /** Every page's but those that say otherwise: the bar, and the chat anywhere. */
  everywhere: { placements: ["docked", "floating"], bar: true },
  /**
   * A page the chat builds, about its subject (an App's workspace, a
   * workflow's page: chat-subject.ts): the chat docked beside it, part of
   * the page rather than a window over it, and no bar.
   */
  docked: { placements: ["docked"], bar: false },
  /**
   * A page where Grasp's chat has no place: none of it, nor its bar. Chat's
   * start and a chat's own page, which are where to ask already.
   */
  hidden: { placements: [], bar: false },
} as const satisfies Record<string, ChatPresence>;

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** Where Grasp's chat may show on this route's pages (chat/chat-presence.ts). */
    chat?: ChatPresence;
  }
}

/** Where the chat may show on this page: its deepest route's say, or everywhere. */
export const useChatPresence = (): ChatPresence =>
  useMatches().findLast(({ staticData }) => staticData.chat !== undefined)
    ?.staticData.chat ?? chatPresence.everywhere;

/** Whether the chat may show `placement` on a page with `presence`. */
export const allows = (
  presence: ChatPresence,
  placement: ChatPlacement
): boolean => presence.placements.includes(placement);

/**
 * Where the chat opens on a page with `presence`: `wanted` where the page
 * allows it, or where it allows first; none where it allows nowhere.
 */
export const placementOn = (
  presence: ChatPresence,
  wanted: ChatPlacement
): ChatPlacement | undefined =>
  allows(presence, wanted) ? wanted : presence.placements[0];

/**
 * Opens the chat on this page: `wanted`, or where it was last put, where
 * the page allows that, or where the page allows first; not at all on a
 * page that allows it nowhere.
 */
export const useOpenChat = (): ((wanted?: ChatPlacement) => void) => {
  const routed = useChatPresence();
  // A page about a subject has it docked, whatever its route says.
  const presence =
    subjectOf(useShownSlot()) === undefined ? routed : chatPresence.docked;
  return (wanted) => {
    const placement = placementOn(presence, wanted ?? chatPlacement());
    if (placement !== undefined) {
      openChat(placement);
    }
  };
};
