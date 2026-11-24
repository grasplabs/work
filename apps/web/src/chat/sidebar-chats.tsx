import type { ChatSummary } from "@grasp-os/shared/chat";
import { chatTitleSchema } from "@grasp-os/shared/chat";
import { useSidebar } from "@grasp-os/ui/components/sidebar";
import { toast } from "@grasp-os/ui/components/toast";
import {
  ArchiveIcon,
  ArrowRightIcon,
  PencilIcon,
  TrashIcon,
} from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { RowAction, SidebarMore, SidebarRow } from "../frame/sidebar.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { setActiveChat, useActiveChat } from "./active-chat.ts";
import { useOpenChat } from "./chat-presence.ts";
import { useChatsWindow } from "./chat-switcher.tsx";
import { DeleteChatDialog } from "./delete-chat-dialog.tsx";

// The person's recent chats in the sidebar, as the reference's (#2503's
// chat/sidebar-chats.tsx): the most recently used first, a few of them,
// each with its menu (open, rename, archive, delete) and renamed in place
// too; the search (⌘K) finds the rest. A row opens its chat in Grasp's chat
// beside the page, where chats open here. Read from core when the sidebar
// first shows and again after each page the router resolves (a rename,
// an archive or a delete reads the page again).

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
    if (!enabled) {
      return () => {
        // Nothing was read.
      };
    }
    read();
    return router.subscribe("onResolved", () => {
      read();
    });
  }, [enabled, router]);
  return enabled ? chats : [];
};

/**
 * Renaming and archiving a chat from its row, then reading the page again,
 * so the sidebar's list and the chat show the change. A row has no place
 * of its own to say it failed: a toast says it.
 */
const useRowChanges = () => {
  const { t } = useLingui();
  const router = useRouter();
  const { run } = useCoreAction();
  return {
    rename: async (chat: ChatSummary, name: string): Promise<void> => {
      const parsed = chatTitleSchema.safeParse(name);
      const renamed =
        parsed.success &&
        (await run(async (session) => {
          await session.chats.rename(chat.id, parsed.data);
          return true;
        }));
      if (renamed === true) {
        await router.invalidate();
        return;
      }
      toast.error(t`The chat couldn't be renamed. Try again.`);
    },
    archive: async (chat: ChatSummary): Promise<void> => {
      const archived = await run(async (session) => {
        await session.chats.archive(chat.id);
        return true;
      });
      if (archived === true) {
        await router.invalidate();
        return;
      }
      toast.error(t`The chat couldn't be archived. Try again.`);
    },
  };
};

/**
 * The sidebar's recent chats, as rows: each opens its chat beside the
 * page, by its title alone, marked while it is the open chat, with its menu
 * and renamed in place; All chats after them, the chats window; and the
 * question a delete asks first. No rows when the person has none, or
 * `enabled` is false.
 */
export const useRecentChats = ({
  enabled,
}: {
  enabled: boolean;
}): { rows: SidebarRow[]; more: SidebarMore; dialog: ReactNode } => {
  const { t } = useLingui();
  const chats = useChats(enabled);
  const activeId = useActiveChat();
  const openHere = useOpenChat();
  const openChats = useChatsWindow();
  const { setOpenMobile } = useSidebar();
  const changes = useRowChanges();
  const [deleting, setDeleting] = useState<ChatSummary>();
  // Neither navigates, so the phone's sheet would stay over them: it goes first.
  const open = (chat: ChatSummary) => {
    setOpenMobile(false);
    setActiveChat(chat.id);
    openHere();
  };
  const more: SidebarMore = {
    label: t`All chats`,
    onClick: () => {
      setOpenMobile(false);
      openChats(true);
    },
  };
  const actions: RowAction[] = [
    { value: "open", label: t`Open`, icon: ArrowRightIcon },
    { value: "rename", label: t`Rename`, icon: PencilIcon },
    { value: "archive", label: t`Archive`, icon: ArchiveIcon },
    "separator",
    { value: "delete", label: t`Delete`, icon: TrashIcon, danger: true },
  ];
  const rows = chats.slice(0, recentCount).map((chat): SidebarRow => {
    const { title } = chat;
    return {
      id: chat.id,
      label: title,
      // In the regular weight, as "All chats" under them is.
      quiet: true,
      onClick: () => {
        open(chat);
      },
      current: chat.id === activeId,
      // Its agent is still answering: the Working mark at the row's end.
      working: chat.running,
      workingLabel: t`Answering`,
      actions,
      actionsLabel: t`More for ${title}`,
      renameLabel: t`Rename ${title}`,
      onAction: (value) => {
        if (value === "open") {
          open(chat);
        } else if (value === "archive") {
          void changes.archive(chat);
        } else if (value === "delete") {
          setDeleting(chat);
        }
      },
      onRename: (name) => {
        void changes.rename(chat, name);
      },
    };
  });
  const dialog =
    deleting === undefined ? null : (
      <DeleteChatDialog
        active={deleting.id === activeId}
        chat={deleting}
        onOpenChange={(next) => {
          if (!next) {
            setDeleting(undefined);
          }
        }}
        open
      />
    );
  return { rows, more, dialog };
};
