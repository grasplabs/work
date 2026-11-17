import type { ChatSummary } from "@grasp-os/shared/chat";
import { useMatchRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { ComponentProps } from "react";

import type { SidebarSubRow } from "../grasp/sidebar/index.ts";
import { useCore } from "../use-core.ts";
import { setActiveChat, useActiveChat } from "./active-chat.ts";
import { useChatLayout } from "./chat-layout.ts";
import { useOpenChat } from "./chat-presence.ts";

// The person's recent chats in the sidebar, under its Chat row: the most
// recently used first, a few of them; search (the sidebar's, ⌘K) finds
// the rest. Read from core when the sidebar first shows, again after each
// page the router resolves (a rename or a delete reads the page again,
// chat-menus.tsx, delete-chat-dialog.tsx) and when another chat is opened
// (asking a first question makes one).

/** How many recent chats the sidebar lists. */
const recentCount = 8;

/**
 * Opens chat `chatId` where the person is, as Recents does: the one way a
 * sidebar row opens a chat, until a chat has its own address and the row
 * is a link to it.
 */
const useOpenRecent = (): ((chatId: string) => void) => {
  const openHere = useOpenChat();
  return (chatId) => {
    setActiveChat(chatId);
    openHere();
  };
};

/**
 * A recent chat's row: the sidebar gives it its look, its name and
 * `aria-current`. A sub-row only links, so this is the element it draws;
 * its own `onClick` the sidebar leaves unset, so the chat opens from here.
 */
const RecentChat = ({
  chatId,
  onOpened,
  onClick: _unset,
  ...row
}: ComponentProps<"button"> & {
  chatId: string;
  /** After it opens: closes the phone's menu over the page. */
  onOpened: () => void;
}) => {
  const open = useOpenRecent();
  return (
    <button
      {...row}
      onClick={() => {
        onOpened();
        open(chatId);
      }}
      type="button"
    />
  );
};

/** The person's chats from core, the most recently used first; none while `enabled` is false. */
const useChats = (enabled: boolean): ChatSummary[] => {
  const core = useCore();
  const router = useRouter();
  const activeId = useActiveChat();
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
  useEffect(() => {
    if (enabled && activeId !== undefined) {
      read();
    }
  }, [enabled, activeId]);
  return enabled ? chats : [];
};

/**
 * The sidebar's recent chats, as rows under Chat: the chat open on Chat's
 * own page marked. None when the person has none, or `enabled` is false.
 */
export const useRecentChats = ({
  enabled,
  onOpened,
}: {
  enabled: boolean;
  /** After a row opens its chat: closes the phone's menu. */
  onOpened: () => void;
}): { rows: SidebarSubRow[]; anyCurrent: boolean } => {
  const chats = useChats(enabled);
  const activeId = useActiveChat();
  const { open } = useChatLayout();
  const onChat = useMatchRoute()({ to: "/" }) !== false;
  // Until a chat has its own page, the one open over Chat's page is where the person is.
  const currentId = onChat && open ? activeId : undefined;
  const rows = chats.slice(0, recentCount).map((chat) => ({
    label: chat.title,
    render: <RecentChat chatId={chat.id} onOpened={onOpened} />,
    current: chat.id === currentId,
  }));
  return { rows, anyCurrent: rows.some((row) => row.current) };
};
