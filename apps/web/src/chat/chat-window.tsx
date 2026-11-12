import type { ChatSearchHit, ChatSummary } from "@grasp-os/shared/chat";
import { chatPlatformName } from "@grasp-os/shared/chat";
import { hasEvery } from "@grasp-os/shared/chat-search";
import { failureText } from "@grasp-os/shared/errors";
import { Button } from "@grasp-os/ui/components/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@grasp-os/ui/components/command";
import { cn } from "@grasp-os/ui/lib/utils";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { PlusIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCore } from "../use-core.ts";
import { setActiveChat, useActiveChat } from "./active-chat.ts";
import { groupChats, whenShort } from "./chat-history.ts";
import type { ChatPeriod } from "./chat-history.ts";
import {
  ChatMenu,
  chatTitleMaxLength,
  RenameField,
  useChatChanges,
} from "./chat-menus.tsx";
import { useOpenChat } from "./chat-presence.ts";
import { DeleteChatDialog } from "./delete-chat-dialog.tsx";

// The person's chats in one window, one quiet icon and ⌘K away, in place
// of a list beside the chat (grasplabs/prototype
// `components/chat/chat-switcher.tsx`). The window is the frame's, on
// every page (`ChatSwitcherProvider` in chat-switcher.tsx, mounted in the
// shell, which loads this file the first time it opens): ⌘K opens it
// anywhere, and a page's header may show the icon that does too
// (`ChatSwitcherButton`). It reads the chats as it opens, and again after
// a change made in it: a new chat on top, then the chats by when they
// were last used, each with when that was. A search on top narrows them
// to the chats with every word in their title or what was said in them:
// by title at once, then by what was said as core finds it
// (`chats.search`), a chat found that way showing where. The keys move
// through the chats and Enter opens one; a row's three dots, where it is
// pointed at, rename it or delete it.

const periodLabel: Record<ChatPeriod, MessageDescriptor> = {
  today: msg({ message: "Today", context: "chats from today" }),
  week: msg({ message: "Last 7 days", context: "chats from the past week" }),
  earlier: msg({ message: "Earlier", context: "older chats" }),
};

/** How long typing rests before core is asked what was said. */
const searchRestMs = 200;

/** The chat platform a chat came through, before its time. */
const ChannelName = ({ via }: { via: string }) => {
  const { t } = useLingui();
  const app = chatPlatformName(via);
  return <>{t`via ${app}`} · </>;
};

/**
 * One chat: its title, and on the right when it was last used; found by
 * what was said in it, where it was said under the title. Its three dots take the time's place where
 * it is pointed at.
 */
const ChatRow = ({
  chat,
  hit,
  active,
  now,
  onOpen,
  onChanged,
  onDelete,
}: {
  chat: ChatSummary;
  hit: ChatSearchHit | undefined;
  active: boolean;
  now: Date;
  onOpen: () => void;
  /** It was renamed: the window reads the chats again. */
  onChanged: () => void;
  onDelete: () => void;
}) => {
  const { t, i18n } = useLingui();
  const [renaming, setRenaming] = useState(false);
  const { failure, rename } = useChatChanges(chat);
  const when = whenShort(chat.lastAt, now, i18n.locale);
  const said = hit?.said ?? null;
  if (renaming) {
    return (
      <div className="px-2 py-1">
        <RenameField
          label={t`Chat name`}
          maxLength={chatTitleMaxLength}
          onDone={(name) => {
            setRenaming(false);
            void (async () => {
              await rename(name);
              onChanged();
            })();
          }}
          value={chat.title}
        />
      </div>
    );
  }
  return (
    <div className="group/row relative">
      <CommandItem check={false} onSelect={onOpen} value={chat.id}>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 px-1 py-0.5">
          <span className="flex items-baseline gap-3">
            <span
              className={cn("min-w-0 flex-1 truncate", active && "font-medium")}
            >
              {chat.title}
            </span>
            <span className="text-muted-foreground flex-none text-xs tabular-nums group-hover/row:invisible group-has-data-popup-open/row:invisible pointer-coarse:invisible">
              {chat.via === "web" ? null : <ChannelName via={chat.via} />}
              <time dateTime={chat.lastAt}>{when}</time>
            </span>
          </span>
          {said === null ? null : (
            <span className="text-muted-foreground truncate text-xs">
              {said.before}
              <mark className="text-foreground bg-transparent font-medium">
                {said.found}
              </mark>
              {said.after}
            </span>
          )}
        </span>
      </CommandItem>
      <ChatMenu
        chat={chat}
        onDelete={onDelete}
        onRename={() => {
          setRenaming(true);
        }}
      />
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

/** What core found for a search: the query it was asked, and the chats. */
interface Found {
  query: string;
  hits: ChatSearchHit[];
}

/**
 * Asks core what was said, once typing rests: the latest search only, so
 * an answer that comes late for an earlier one is dropped.
 */
const useSaidSearch = () => {
  const core = useCore();
  const [found, setFound] = useState<Found>();
  const [failure, setFailure] = useState<string>();
  const timer = useRef(0);
  const latest = useRef("");
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    []
  );
  const search = (text: string): void => {
    const query = text.trim();
    latest.current = query;
    window.clearTimeout(timer.current);
    setFailure(undefined);
    if (query === "") {
      return;
    }
    timer.current = window.setTimeout(() => {
      void (async () => {
        try {
          const hits = await core.withSession(
            async (session) => await session.chats.search(query)
          );
          if (latest.current === query) {
            setFound({ query, hits });
          }
        } catch (error) {
          if (latest.current === query) {
            setFailure(failureText(error));
          }
        }
      })();
    }, searchRestMs);
  };
  return { found, failure, search };
};

/** Reads the person's chats from core as the window opens, again on each `read`. */
const useListed = () => {
  const core = useCore();
  const [listed, setListed] = useState<ChatSummary[]>();
  const [failure, setFailure] = useState<string>();
  const read = (): void => {
    void (async () => {
      try {
        const chats = await core.withSession(
          async (session) => await session.chats.list()
        );
        setListed(chats);
        setFailure(undefined);
      } catch (error) {
        setFailure(failureText(error));
      }
    })();
  };
  return { listed, failure, read };
};

/**
 * The chats the window lists: all of them, and with a search, those whose
 * title holds every word until core has answered it; then what core
 * `found`, each chat as `chats` has it, so a rename made since shows.
 */
const shownChats = ({
  chats,
  query,
  found,
}: {
  chats: readonly ChatSummary[];
  query: string;
  found: Found | undefined;
}): ChatSummary[] => {
  if (query === "") {
    return [...chats];
  }
  if (found === undefined) {
    return chats.filter((chat) => hasEvery(query, chat.title));
  }
  const byId = new Map(chats.map((chat) => [chat.id, chat]));
  return found.hits.flatMap(({ chat }) => byId.get(chat.id) ?? []);
};

/**
 * The person's chats: a search on top, a new chat where it offers one
 * (`onNew`), then the chats by when they were last used, each to open,
 * rename or delete. Read each time it is `shown`, so it shows what changed
 * elsewhere. In the chats window and the Recents on Chat's own page.
 */
export const ChatList = ({
  shown,
  onOpen,
  onNew,
  fill = false,
}: {
  shown: boolean;
  onOpen: (chatId: string) => void;
  onNew?: () => void;
  /** Fills a window of fixed height, rather than sizing to the chats. */
  fill?: boolean;
}) => {
  const { t, i18n } = useLingui();
  const activeId = useActiveChat();
  const [search, setSearch] = useState("");
  const [deleting, setDeleting] = useState<ChatSummary>();
  const said = useSaidSearch();
  const listing = useListed();
  const [readWhenShown, setReadWhenShown] = useState(false);
  // Read again each time it shows, so it shows what changed elsewhere.
  if (shown !== readWhenShown) {
    setReadWhenShown(shown);
    if (shown) {
      setSearch("");
    }
  }
  const read = useEffectEvent(() => {
    listing.read();
  });
  useEffect(() => {
    if (shown) {
      read();
    }
  }, [shown]);

  const chats = listing.listed ?? [];
  const query = search.trim();
  const searching = query !== "";
  const answered = said.found?.query === query ? said.found : undefined;
  const hits = new Map((answered?.hits ?? []).map((hit) => [hit.chat.id, hit]));
  const now = new Date();
  const groups = groupChats(shownChats({ chats, query, found: answered }), now);
  return (
    <>
      <Command
        // cmdk names its search by a label of its own: this one.
        label={t`Search chats`}
        loop
        shouldFilter={false}
      >
        <CommandInput
          aria-label={t`Search chats`}
          onValueChange={(value) => {
            setSearch(value);
            said.search(value);
          }}
          placeholder={t`Search chats`}
          size={fill ? "lg" : "default"}
          value={search}
        />
        <div
          className={
            fill ? "flex h-112 min-h-0 flex-col" : "flex min-h-0 flex-col"
          }
        >
          {onNew === undefined ? null : (
            <div className="flex border-b p-2">
              <Button onClick={onNew} size="sm" variant="outline">
                <PlusIcon data-icon="inline-start" />
                <Trans>New chat</Trans>
              </Button>
            </div>
          )}
          <ErrorText>{listing.failure ?? said.failure}</ErrorText>
          <CommandList fill={fill}>
            {listing.listed === undefined ? null : (
              <CommandEmpty>
                {searching ? (
                  <Trans>No chat has that.</Trans>
                ) : (
                  <Trans>No chats here yet.</Trans>
                )}
              </CommandEmpty>
            )}
            {groups.map((group) => (
              <CommandGroup
                heading={i18n._(periodLabel[group.period])}
                key={group.period}
              >
                {group.chats.map((chat) => (
                  <ChatRow
                    active={chat.id === activeId}
                    chat={chat}
                    hit={hits.get(chat.id)}
                    key={chat.id}
                    now={now}
                    onChanged={() => {
                      listing.read();
                    }}
                    onDelete={() => {
                      setDeleting(chat);
                    }}
                    onOpen={() => {
                      onOpen(chat.id);
                    }}
                  />
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </div>
      </Command>
      {deleting === undefined ? null : (
        <DeleteChatDialog
          active={deleting.id === activeId}
          chat={deleting}
          onOpenChange={(next) => {
            if (!next) {
              setDeleting(undefined);
              listing.read();
            }
          }}
          open
        />
      )}
    </>
  );
};

/**
 * Opens chat `chatId`, or a new one, in Grasp's chat (global-chat.tsx),
 * where this page allows it (chat-presence.ts), so the person stays where
 * they are.
 */
export const useSelectChat = () => {
  const openHere = useOpenChat();
  return (chatId?: string): void => {
    setActiveChat(chatId);
    openHere();
  };
};

/** The window and what it shows, while it is open. */
export const ChatWindow = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const { t } = useLingui();
  const selectChat = useSelectChat();
  return (
    <CommandDialog
      className="top-1/8 sm:max-w-3xl"
      description={t`Search your chats, and open one.`}
      onOpenChange={onOpenChange}
      open={open}
      title={t`Chats`}
    >
      <ChatList
        fill
        onNew={() => {
          onOpenChange(false);
          selectChat();
        }}
        onOpen={(chatId) => {
          onOpenChange(false);
          selectChat(chatId);
        }}
        shown={open}
      />
    </CommandDialog>
  );
};
