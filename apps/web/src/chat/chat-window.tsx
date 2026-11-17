import type { ChatSearchHit, ChatSummary } from "@grasp-os/shared/chat";
import {
  chatPlatformName,
  chatTitleMaxLength,
  chatTitleSchema,
} from "@grasp-os/shared/chat";
import { failureText } from "@grasp-os/shared/errors";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { AgentIndicator } from "../grasp/agent-indicator/index.ts";
import { Button } from "../grasp/button/index.ts";
import { CommandDialog, CommandMatch } from "../grasp/command/index.ts";
import type {
  CommandEntry,
  CommandItems,
  CommandRowAction,
} from "../grasp/command/index.ts";
import { Dialog, DialogContent, DialogTitle } from "../grasp/dialog/index.ts";
import { Field, FieldLabel } from "../grasp/field/index.ts";
import { visuallyHidden } from "../grasp/hidden/hidden.ts";
import {
  Archive,
  ArrowLeft,
  Edit,
  Plus,
  Retry,
  Trash,
  Undo,
} from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCore } from "../use-core.ts";
import { useActiveChat } from "./active-chat.ts";
import { chatsByDay, dayWrittenOut, timeOfDay } from "./chat-history.ts";
import type { ChatDay } from "./chat-history.ts";
import { useGoToChat } from "./chat-link.ts";
import { DeleteChatDialog } from "./delete-chat-dialog.tsx";

// The person's chats in one window, ⌘K away on every page and opened by
// the sidebar's "All chats" (`ChatSwitcherProvider` in chat-switcher.tsx,
// which holds it open and loads this file the first time it opens): Grasp
// UI's CommandDialog, as its Chats window pattern makes it. "New chat"
// first; then the chats by the day they were last used, each with its time
// at the end, or the Working mark while its agent answers, the open one
// marked as current, and its More: rename, archive, delete; "Archived"
// last, with how many. Typing searches core (`chats.search`): its results
// as given, each found in what was said with where, the words marked; a
// search that failed is tried again in place. The archived chats are a
// list of their own, searched by title.
//
// Delete still asks first: core deletes a chat for good, with nothing to
// bring it back, so an Undo after it could not keep its word.

const styles = stylex.create({
  // The rename field, in a dialog of its own.
  rename: {
    display: "grid",
    gap: grasp.space4,
    paddingInline: grasp.space6,
    paddingBlockEnd: grasp.space6,
  },
  actions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: grasp.space2,
  },
  time: {
    color: grasp.muted,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontVariantNumeric: "tabular-nums",
  },
});

const today = msg({ message: "Today", context: "chats from today" });
const yesterday = msg({
  message: "Yesterday",
  context: "chats from yesterday",
});

/** How long typing rests before core is asked what was said. */
const searchRestMs = 200;

/** A chat's value in the list, apart from the window's own rows. */
const chatValue = (chatId: string): string => `chat:${chatId}`;

/** What core found for a search, or that it failed. */
type Search =
  | { query: string; state: "found"; hits: ChatSearchHit[] }
  | { query: string; state: "failed" };

/**
 * Asks core what was said in the chats, once typing rests: the latest
 * search only, so an answer that comes late for an earlier one is dropped.
 */
const useChatSearch = () => {
  const core = useCore();
  const [search, setSearch] = useState<Search>();
  const timer = useRef(0);
  const latest = useRef("");
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    []
  );
  const ask = async (query: string): Promise<void> => {
    try {
      const hits = await core.withSession(
        async (session) => await session.chats.search(query)
      );
      if (latest.current === query) {
        setSearch({ query, state: "found", hits });
      }
    } catch {
      if (latest.current === query) {
        setSearch({ query, state: "failed" });
      }
    }
  };
  return {
    search,
    /** Asks for `text` once typing rests. */
    find: (text: string): void => {
      const query = text.trim();
      latest.current = query;
      window.clearTimeout(timer.current);
      if (query !== "") {
        timer.current = window.setTimeout(() => {
          void ask(query);
        }, searchRestMs);
      }
    },
    /** Asks again, at once, for what is in the field. */
    retry: (): void => {
      setSearch(undefined);
      void ask(latest.current);
    },
  };
};

/** The person's chats (or the ones they archived) and how many they archived, as core lists them. */
const listOf = async (
  core: ReturnType<typeof useCore>,
  archived: boolean
): Promise<
  | { listed: { chats: ChatSummary[]; archived: number }; failure?: undefined }
  | { listed?: undefined; failure: string }
> => {
  const options = archived ? { archived: true } : undefined;
  try {
    const [chats, put] = await core.withSession(
      async (session) =>
        await Promise.all([
          session.chats.list(options),
          session.chats.list({ archived: true }),
        ])
    );
    return { listed: { chats, archived: put.length } };
  } catch (error) {
    return { failure: failureText(error) };
  }
};

/**
 * Reads the person's chats (or the ones they archived) and how many they
 * archived, as the window opens, again on each `read`.
 */
const useListed = (archived: boolean) => {
  const core = useCore();
  const [listed, setListed] = useState<{
    chats: ChatSummary[];
    archived: number;
  }>();
  const [failure, setFailure] = useState<string>();
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let current = true;
    const read = async (): Promise<void> => {
      const answer = await listOf(core, archived);
      // An older read that answers late doesn't show.
      if (!current) {
        return;
      }
      if (answer.failure === undefined) {
        setListed(answer.listed);
      }
      setFailure(answer.failure);
    };
    void read();
    return () => {
      current = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `reads` says when to read again
  }, [core, archived, reads]);
  return {
    listed,
    failure,
    /** Reads them again, after a change made in the window. */
    read: () => {
      setReads(reads + 1);
    },
  };
};

/** Renaming, archiving and bringing back a chat, then reading the page again. */
const useChanges = (onChanged: () => void) => {
  const core = useCore();
  const router = useRouter();
  const [failure, setFailure] = useState<string>();
  const change = async (
    action: (
      chats: Parameters<Parameters<typeof core.withSession>[0]>[0]["chats"]
    ) => Promise<void>
  ): Promise<void> => {
    setFailure(undefined);
    try {
      await core.withSession(async (session) => {
        await action(session.chats);
      });
    } catch (error) {
      setFailure(failureText(error));
      return;
    }
    onChanged();
    // The sidebar and the chat's page show the change too.
    await router.invalidate();
  };
  return {
    failure,
    rename: async (chat: ChatSummary, name: string): Promise<void> => {
      const trimmed = name.trim();
      if (
        trimmed === chat.title ||
        !chatTitleSchema.safeParse(trimmed).success
      ) {
        return;
      }
      await change(async (chats) => {
        await chats.rename(chat.id, trimmed);
      });
    },
    archive: async (chat: ChatSummary, archived: boolean): Promise<void> => {
      await change(async (chats) => {
        await (archived ? chats.archive(chat.id) : chats.unarchive(chat.id));
      });
    },
  };
};

/** A chat's new name, in a dialog of its own: Enter keeps it. */
const RenameChat = ({
  chat,
  onDone,
}: {
  chat: ChatSummary | undefined;
  onDone: (name: string | null) => void;
}) => {
  const { t } = useLingui();
  const [name, setName] = useState(chat?.title ?? "");
  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          onDone(null);
        }
      }}
      open={chat !== undefined}
    >
      <DialogContent>
        <DialogTitle>{t`Rename chat`}</DialogTitle>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onDone(name);
          }}
          {...stylex.props(styles.rename)}
        >
          <Field>
            <FieldLabel>{t`Chat name`}</FieldLabel>
            <Input
              // It opens to be typed in.
              autoFocus
              maxLength={chatTitleMaxLength}
              onValueChange={setName}
              value={name}
            />
          </Field>
          <div {...stylex.props(styles.actions)}>
            <Button
              onClick={() => {
                onDone(null);
              }}
              variant="ghost"
            >
              {t`Cancel`}
            </Button>
            <Button type="submit" variant="ink">
              {t({ message: "Rename", context: "a chat" })}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/** A day's name over its chats, in the page's language. */
const useDayName = () => {
  const { i18n } = useLingui();
  return (day: ChatDay): string => {
    if (day.kind === "today") {
      return i18n._(today);
    }
    if (day.kind === "yesterday") {
      return i18n._(yesterday);
    }
    return dayWrittenOut(day.day, day.sameYear, i18n.locale);
  };
};

/** What can be done with a chat from its row: to an archived one, less. */
const useChatActions = (archived: boolean): CommandRowAction[] => {
  const { t } = useLingui();
  const remove = {
    value: "delete",
    label: t`Delete`,
    icon: Trash,
    danger: true,
  };
  return archived
    ? [{ value: "unarchive", label: t`Unarchive`, icon: Undo }, remove]
    : [
        {
          value: "rename",
          label: t({ message: "Rename", context: "a chat" }),
          icon: Edit,
        },
        { value: "archive", label: t`Archive`, icon: Archive },
        remove,
      ];
};

/**
 * One chat as a row: its title; under it the chat app it came through,
 * or where a search found it, the words marked; at its end its time, or
 * the Working mark while its agent answers; current while it is open.
 */
const useChatRow = (archived: boolean) => {
  const { t, i18n } = useLingui();
  const actions = useChatActions(archived);
  const activeId = useActiveChat();
  return (chat: ChatSummary, hit?: ChatSearchHit): CommandEntry => {
    const said = hit?.said ?? null;
    const app = chat.via === "web" ? null : chatPlatformName(chat.via);
    const where: ReactNode =
      said === null ? null : (
        <>
          {said.before}
          <CommandMatch>{said.found}</CommandMatch>
          {said.after}
        </>
      );
    let description: ReactNode;
    if (app !== null && where !== null) {
      description = (
        <>
          {t`via ${app}`} · {where}
        </>
      );
    } else if (app !== null) {
      description = t`via ${app}`;
    } else if (where !== null) {
      description = where;
    }
    const time = timeOfDay(chat.lastAt, i18n.locale);
    return {
      value: chatValue(chat.id),
      label: chat.title,
      ...(description === undefined ? {} : { description }),
      current: chat.id === activeId,
      end: chat.running ? (
        <>
          <AgentIndicator />
          <span {...stylex.props(visuallyHidden)}>{t`Answering`}</span>
        </>
      ) : (
        <time dateTime={chat.lastAt} {...stylex.props(styles.time)}>
          {time}
        </time>
      ),
      actions,
    };
  };
};

/** The list at rest: back first (archived) or New chat, the chats by day, Archived last with its count. */
const useResting = (archived: boolean) => {
  const { t } = useLingui();
  const dayName = useDayName();
  const rowOf = useChatRow(archived);
  return (
    chats: readonly ChatSummary[],
    archivedCount: number
  ): CommandItems => [
    archived
      ? { value: "back", label: t`All chats`, icon: ArrowLeft }
      : { value: "new", label: t`New chat`, icon: Plus },
    ...chatsByDay(chats, new Date()).map(({ day, chats: inDay }) => ({
      type: "group" as const,
      label: dayName(day),
      items: inDay.map((chat) => rowOf(chat)),
    })),
    ...(archived || archivedCount === 0
      ? []
      : [
          { type: "separator" as const },
          {
            value: "archived",
            label: t`Archived`,
            icon: Archive,
            description: t`${plural(archivedCount, { one: "# chat", other: "# chats" })}`,
          },
        ]),
  ];
};

/**
 * The list while searching: core's results as given, each as the list
 * has it now (a rename made since shows); a failed search, a row to try
 * it again. Archived chats are searched by title, here.
 */
const useSearching = (archived: boolean) => {
  const { t } = useLingui();
  const rowOf = useChatRow(archived);
  return (
    chats: readonly ChatSummary[],
    query: string,
    search: Search | undefined
  ): CommandItems => {
    if (archived) {
      const words = query.toLocaleLowerCase();
      return chats
        .filter((chat) => chat.title.toLocaleLowerCase().includes(words))
        .map((chat) => rowOf(chat));
    }
    if (search?.query !== query) {
      return [];
    }
    if (search.state === "failed") {
      return [
        {
          value: "retry-search",
          label: t`Try the search again`,
          icon: Retry,
          description: t`The search did not answer. Nothing was changed.`,
        },
      ];
    }
    const byId = new Map(chats.map((chat) => [chat.id, chat]));
    return search.hits.flatMap((hit) => {
      const chat = byId.get(hit.chat.id);
      return chat === undefined ? [] : [rowOf(chat, hit)];
    });
  };
};

/** The window's field and what its list says empty: honest about what was searched. */
const useWindowWords = (archived: boolean, query: string) => {
  const { t } = useLingui();
  const label = archived ? t`Search archived chats` : t`Search chats`;
  if (query === "") {
    return {
      label,
      empty: archived ? t`No archived chats` : t`No chats yet`,
    };
  }
  return {
    label,
    // Archived chats are searched by title alone.
    empty: archived
      ? t`No archived chat called “${query}”`
      : t`No chat has “${query}” in its name or what was said`,
  };
};

/** The chats window, held open by the page (`open`), its own words through Grasp UI's catalogue. */
export const ChatWindow = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const { t } = useLingui();
  const goTo = useGoToChat();
  const activeId = useActiveChat();
  const [archived, setArchived] = useState(false);
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<ChatSummary>();
  const [deleting, setDeleting] = useState<ChatSummary>();
  // Each time it opens, it opens on the chats, with nothing searched.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setArchived(false);
      setQuery("");
    }
  }
  const search = useChatSearch();
  const listing = useListed(archived);
  const changes = useChanges(() => {
    listing.read();
  });
  const resting = useResting(archived);
  const searching = useSearching(archived);
  const chats = listing.listed?.chats ?? [];
  const trimmed = query.trim();
  const looking = trimmed !== "";
  const items = looking
    ? searching(chats, trimmed, search.search)
    : resting(chats, listing.listed?.archived ?? 0);
  const byValue = new Map(chats.map((chat) => [chatValue(chat.id), chat]));
  const { label, empty } = useWindowWords(archived, trimmed);
  const failure = listing.failure ?? changes.failure;
  return (
    <>
      <CommandDialog
        aria-label={label}
        empty={failure ?? empty}
        filter={false}
        items={listing.listed === undefined ? [] : items}
        loading={
          listing.listed === undefined ||
          (looking && !archived && search.search?.query !== trimmed)
        }
        loadingLabel={
          listing.listed === undefined ? t`Loading chats` : t`Searching chats`
        }
        onAction={(value) => {
          if (value === "retry-search") {
            search.retry();
            return false;
          }
          if (value === "archived" || value === "back") {
            setQuery("");
            setArchived(value === "archived");
            return false;
          }
          goTo(value === "new" ? undefined : byValue.get(value)?.id);
          // Gone, and the window closes after it.
          return true;
        }}
        onOpenChange={onOpenChange}
        onQueryChange={(next) => {
          setQuery(next);
          if (!archived) {
            search.find(next);
          }
        }}
        onRowAction={(value, action) => {
          const chat = byValue.get(value);
          if (chat === undefined) {
            // Gone meanwhile: the list is read again.
            listing.read();
          } else if (action === "rename") {
            // The window gives way to the rename dialog, so focus has one place to go.
            onOpenChange(false);
            setRenaming(chat);
          } else if (action === "delete") {
            setDeleting(chat);
          } else {
            void changes.archive(chat, action === "archive");
          }
        }}
        open={open}
        placeholder={label}
        query={query}
        // The page holds it: ⌘K and the sidebar's "All chats" open it.
        shortcut={null}
        trigger={null}
      />
      <RenameChat
        chat={renaming}
        key={renaming?.id ?? "none"}
        onDone={(name) => {
          const chat = renaming;
          setRenaming(undefined);
          if (chat !== undefined && name !== null) {
            void changes.rename(chat, name);
          }
        }}
      />
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
