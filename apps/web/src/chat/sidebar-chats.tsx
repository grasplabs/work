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
import { announce } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import { Link, useMatchRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { RowAction, SidebarMore, SidebarRow } from "../frame/sidebar.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { useTabShown } from "../use-tab-shown.ts";
import { chatLink, useGoToChat } from "./chat-link.ts";
import { useChatsWindow } from "./chat-switcher.tsx";
import { onChatsChanged } from "./chats-changed.ts";
import { DeleteChatDialog } from "./delete-chat-dialog.tsx";
import { useChatOpenBeside } from "./global-chat.tsx";

// The person's recent chats in the sidebar, as the reference's (#2503's
// chat/sidebar-chats.tsx): the most recently used first, a few of them,
// each a link to its own page, with its menu (open, rename, archive,
// delete) and renamed in place too; the search (⌘K) finds the rest. Read
// from core when the sidebar first shows, again after each page the router
// resolves (a rename, an archive or a delete reads the page again), when
// an answer starts or ends or a chat is read (chats-changed.ts), so a
// row's Working mark and unread dot come and go with it, and when the
// person comes back to the tab, for what was answered while they were
// away. Core has no live word for a chat answering elsewhere (in the
// background, on another device): while a listed chat works and the tab
// is shown, the list is read again every few seconds, so its Working mark
// turns into the dot without the person moving; it stops once none works.

/** How many recent chats the sidebar lists. */
const recentCount = 8;

/** How often the list is read again while a listed chat works. */
export const workingReadMs = 3000;

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
    const unsubscribe = router.subscribe("onResolved", readIf);
    // An answer started or ended: its chat works, or no longer does.
    const unheard = onChatsChanged(readIf);
    const back = (): void => {
      if (document.visibilityState === "visible") {
        readIf();
      }
    };
    document.addEventListener("visibilitychange", back);
    return () => {
      unsubscribe();
      unheard();
      document.removeEventListener("visibilitychange", back);
    };
  }, [enabled, router]);
  // A chat works, answering where no page of this tab follows it: read
  // again until none does, while anyone can see it.
  const working =
    useTabShown() && enabled && chats.some(({ running }) => running);
  useEffect(() => {
    const timer = working
      ? setInterval(() => {
          read();
        }, workingReadMs)
      : undefined;
    return () => {
      clearInterval(timer);
    };
  }, [working]);
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
        // A screen reader hears it once core has kept it, never before.
        announce(t`Renamed to ${name}`);
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
 * The sidebar's recent chats, as rows: each opens its chat on its own
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
  const matchRoute = useMatchRoute();
  const goToChat = useGoToChat();
  const openChats = useChatsWindow();
  const { setOpenMobile } = useSidebar();
  const changes = useRowChanges();
  const beside = useChatOpenBeside();
  const [deleting, setDeleting] = useState<ChatSummary>();
  // The window doesn't navigate, so the phone's sheet would stay over it: it goes first.
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
    const current = matchRoute(chatLink(chat.id)) !== false;
    return {
      id: chat.id,
      label: title,
      // In the regular weight, as "All chats" under them is.
      quiet: true,
      // The chat's own page (chat-link.ts), marked while it is open.
      render: (look) => <Link {...look} {...chatLink(chat.id)} />,
      current,
      // Its agent is still answering: the Working mark at the row's end.
      working: chat.running,
      workingLabel: t`Answering`,
      // Answered while the person wasn't looking (chat/unread.ts): a dot,
      // never on the chat open in front of them, on its page or beside
      // this one, which is read as it ends.
      unread: chat.unread && !current && chat.id !== beside,
      unreadLabel: t`Unread`,
      actions,
      actionsLabel: t`More for ${title}`,
      renameLabel: t`Rename ${title}`,
      renameHint: t`Double-click or press F2 to rename`,
      onAction: (value) => {
        if (value === "open") {
          goToChat(chat.id);
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
        active={matchRoute(chatLink(deleting.id)) !== false}
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
