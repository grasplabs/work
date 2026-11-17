import type { ChatSummary } from "@grasp-os/shared/chat";
import { chatTitleSchema } from "@grasp-os/shared/chat";
import { useLingui } from "@lingui/react/macro";
import { Link, useMatchRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import type { MenuEntries } from "../grasp/context-menu/index.ts";
import { Archive, ArrowRight, Edit, Trash } from "../grasp/icons/index.ts";
import type { SidebarRow } from "../grasp/sidebar/index.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { chatLink, useGoToChat } from "./chat-link.ts";
import { useAskDeleteChat } from "./chat-switcher.tsx";

// The person's recent chats in the sidebar: the most recently used first,
// a few of them, each a link to its page, with its menu (open, rename,
// archive, delete) and renamed in place too;
// search (the sidebar's, ⌘K) finds the rest. Read from core when the
// sidebar first shows and again after each page the router resolves:
// opening a chat, asking a first question (which goes to the new chat's
// page), a rename or a delete (each reads the page again: chat-menus.tsx,
// delete-chat-dialog.tsx).

/** How many recent chats the sidebar lists. */
const recentCount = 8;

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
 * Renaming and archiving a chat from its row, then reading the page again,
 * so the sidebar's list and the chat's page show the change. As the chats
 * window does it (`useChatChanges` in chat-menus.tsx), for any of the rows.
 */
const useRowChanges = () => {
  const router = useRouter();
  const { run } = useCoreAction();
  const change = async (
    action: (session: Parameters<Parameters<typeof run>[0]>[0]) => Promise<void>
  ): Promise<void> => {
    const changed = await run(async (session) => {
      await action(session);
      return true;
    });
    if (changed === true) {
      await router.invalidate();
    }
  };
  return {
    rename: async (chat: ChatSummary, name: string): Promise<void> => {
      if (!chatTitleSchema.safeParse(name).success) {
        return;
      }
      await change(async (session) => {
        await session.chats.rename(chat.id, name);
      });
    },
    archive: async (chat: ChatSummary): Promise<void> => {
      await change(async (session) => {
        await session.chats.archive(chat.id);
      });
    },
  };
};

/**
 * The sidebar's recent chats, as rows: each a link to its page, by its
 * title alone, marked while the person is on it, with its menu and renamed
 * in place. None when the person has none, or `enabled` is false.
 */
export const useRecentChats = ({
  enabled,
}: {
  enabled: boolean;
}): SidebarRow[] => {
  const { t } = useLingui();
  const chats = useChats(enabled);
  const matchRoute = useMatchRoute();
  const goTo = useGoToChat();
  const askDelete = useAskDeleteChat();
  const changes = useRowChanges();
  const actions: MenuEntries = [
    { value: "open", label: t`Open`, icon: ArrowRight },
    { value: "rename", label: t`Rename`, icon: Edit },
    { value: "archive", label: t`Archive`, icon: Archive },
    { type: "separator" },
    { value: "delete", label: t`Delete`, icon: Trash, danger: true },
  ];
  return chats.slice(0, recentCount).map((chat) => {
    const { title } = chat;
    return {
      id: chat.id,
      label: title,
      render: <Link {...chatLink(chat.id)} />,
      current: matchRoute(chatLink(chat.id)) !== false,
      // Its agent is still answering: the Working mark at the row's end.
      working: chat.running,
      workingLabel: t`Answering`,
      actions,
      actionsLabel: t`More for ${title}`,
      renameLabel: t`Rename ${title}`,
      renamedLabel: (name: string) => t`Renamed to ${name}`,
      onAction: (value: string) => {
        if (value === "open") {
          goTo(chat.id);
        } else if (value === "archive") {
          void changes.archive(chat);
        } else if (value === "delete") {
          askDelete(chat);
        }
      },
      onRename: (name: string) => {
        void changes.rename(chat, name);
      },
    };
  });
};
