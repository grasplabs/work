import type { ChatSummary } from "@grasp-os/shared/chat";
import { useLingui } from "@lingui/react/macro";
import { Link, useMatchRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { formatDateTime } from "../format.ts";
import type { SidebarRow } from "../grasp/sidebar/index.ts";
import { useCore } from "../use-core.ts";
import { periodOf, whenShort } from "./chat-history.ts";
import { chatLink } from "./chat-link.ts";

// The person's recent chats in the sidebar: the most recently used first,
// a few of them, each a link to its page with when it was last used;
// search (the sidebar's, ⌘K) finds the rest. Read from core when the
// sidebar first shows and again after each page the router resolves:
// opening a chat, asking a first question (which goes to the new chat's
// page), a rename or a delete (each reads the page again: chat-menus.tsx,
// delete-chat-dialog.tsx).

/** How many recent chats the sidebar lists. */
const recentCount = 8;

const minuteMs = 60 * 1000;
const minutesPerHour = 60;

/**
 * When a chat was last used, as short as a row's end has room for: today
 * how long ago in the page's language's narrowest units ("2m", "3h"),
 * before that the day as the chats window shows it ("Tue", "4 Mar").
 */
const whenAtEnd = (lastAt: string, now: Date, locale: string): string => {
  if (periodOf(lastAt, now) !== "today") {
    return whenShort(lastAt, now, locale);
  }
  const minutes = Math.max(
    1,
    Math.floor((now.getTime() - new Date(lastAt).getTime()) / minuteMs)
  );
  const [amount, unit] =
    minutes < minutesPerHour
      ? [minutes, "minute"]
      : [Math.floor(minutes / minutesPerHour), "hour"];
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "narrow",
  }).format(amount);
};

/** The person's chats from core, the most recently used first; none while `enabled` is false. */
const useChats = (enabled: boolean): ChatSummary[] => {
  const core = useCore();
  const router = useRouter();
  const [chats, setChats] = useState<ChatSummary[]>([]);
  // Only the latest read's answer shows: an earlier one may come back after it.
  const latest = useRef(0);
  const read = useEffectEvent(() => {
    latest.current += 1;
    const asked = latest.current;
    void (async () => {
      try {
        const listed = await core.withSession(
          async (session) => await session.chats.list()
        );
        if (asked === latest.current) {
          setChats(listed);
        }
      } catch {
        // The sidebar keeps what it last read; the chats window says why.
      }
    })();
  });
  useEffect(() => {
    const readIf = (): void => {
      if (enabled) {
        read();
      }
    };
    readIf();
    return router.subscribe("onResolved", readIf);
  }, [enabled, router]);
  return enabled ? chats : [];
};

/**
 * The sidebar's recent chats, as rows: each a link to its page, marked
 * while the person is on it, with when it was last used at its end. None
 * when the person has none, or `enabled` is false.
 */
export const useRecentChats = ({
  enabled,
}: {
  enabled: boolean;
}): SidebarRow[] => {
  const { i18n } = useLingui();
  const chats = useChats(enabled);
  const matchRoute = useMatchRoute();
  const now = new Date();
  return chats.slice(0, recentCount).map((chat) => ({
    label: chat.title,
    render: <Link {...chatLink(chat.id)} />,
    current: matchRoute(chatLink(chat.id)) !== false,
    end: whenAtEnd(chat.lastAt, now, i18n.locale),
    endLabel: formatDateTime(chat.lastAt),
  }));
};
