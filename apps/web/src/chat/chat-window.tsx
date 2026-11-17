import type { ChatSearchHit, ChatSummary } from "@grasp-os/shared/chat";
import {
  chatPlatformName,
  chatTitleMaxLength,
  chatTitleSchema,
} from "@grasp-os/shared/chat";
import { hasEvery } from "@grasp-os/shared/chat-search";
import { failureText } from "@grasp-os/shared/errors";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { AgentIndicator } from "../grasp/agent-indicator/index.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Command } from "../grasp/command/index.ts";
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
  Conversation,
  Edit,
  Plus,
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
// which loads this file the first time it opens): Grasp UI's Command in
// its Dialog, as the library's command dialog is until it can be opened
// from outside. "New chat" is its first row; then the chats by the day
// they were last used, each with its time at the end, or the Working mark
// while its agent answers, and its More: rename, archive, delete. Typing
// narrows them by title at once, then to what core found was said in
// them (`chats.search`), a chat found that way showing where. Archived
// chats are a quiet row at the end, a list of their own.
//
// Not yet: the open chat marked as current, and a foot of key hints,
// which the library's Command doesn't draw yet.

const styles = stylex.create({
  // The rename field, where the list stood.
  rename: {
    display: "grid",
    gap: grasp.space4,
    padding: grasp.space4,
  },
  actions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: grasp.space2,
  },
  failure: { paddingInline: grasp.space4, paddingBlockEnd: grasp.space4 },
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

/** Reads the person's chats (or the ones they archived) as the window opens, again on each `read`. */
const useListed = (archived: boolean) => {
  const core = useCore();
  const [listed, setListed] = useState<ChatSummary[]>();
  const [failure, setFailure] = useState<string>();
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let current = true;
    const read = async (): Promise<void> => {
      try {
        const chats = await core.withSession(
          async (session) =>
            await session.chats.list(archived ? { archived: true } : undefined)
        );
        // An older read that answers late doesn't show.
        if (current) {
          setListed(chats);
          setFailure(undefined);
        }
      } catch (error) {
        if (current) {
          setFailure(failureText(error));
        }
      }
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

/** A chat's new name, where the list stood: Enter keeps it, Escape goes back to the list. */
const RenameChat = ({
  chat,
  onDone,
}: {
  chat: ChatSummary;
  onDone: (name: string | null) => void;
}) => {
  const { t } = useLingui();
  const [name, setName] = useState(chat.title);
  return (
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
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              // Back to the list, not out of the window.
              event.preventDefault();
              event.stopPropagation();
              onDone(null);
            }
          }}
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
        <Button type="submit">
          {t({ message: "Rename", context: "a chat" })}
        </Button>
      </div>
    </form>
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

/**
 * The person's chats as Command rows, by day: each by its title, the chat
 * app it came through or where a search found it under it, and its time
 * at the end, or the Working mark while its agent answers.
 */
const useChatRows = (actions: CommandRowAction[]) => {
  const { t, i18n } = useLingui();
  const dayName = useDayName();
  return (
    chats: readonly ChatSummary[],
    hits: ReadonlyMap<string, ChatSearchHit>
  ): CommandItems =>
    chatsByDay(chats, new Date()).map(({ day, chats: inDay }) => ({
      type: "group" as const,
      label: dayName(day),
      items: inDay.map((chat): CommandEntry => {
        const said = hits.get(chat.id)?.said ?? null;
        const app = chat.via === "web" ? null : chatPlatformName(chat.via);
        const where =
          said === null ? null : `${said.before}${said.found}${said.after}`;
        let description: string | undefined;
        if (app !== null && where !== null) {
          description = t`via ${app} · ${where}`;
        } else if (app !== null) {
          description = t`via ${app}`;
        } else if (where !== null) {
          description = where;
        }
        const time = timeOfDay(chat.lastAt, i18n.locale);
        return {
          value: chatValue(chat.id),
          label: chat.title,
          icon: Conversation,
          ...(description === undefined ? {} : { description }),
          end: chat.running ? (
            <>
              <AgentIndicator />
              <span {...stylex.props(visuallyHidden)}>{t`Answering`}</span>
            </>
          ) : (
            <time dateTime={chat.lastAt}>{time}</time>
          ),
          actions,
        };
      }),
    }));
};

/** Why the list couldn't be read or changed, under it. */
const Failure = ({ failure }: { failure: string | undefined }) =>
  failure === undefined ? null : (
    <div {...stylex.props(styles.failure)}>
      <Alert tone="danger">{failure}</Alert>
    </div>
  );

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

/** The rows round the chats: "New chat" first and "Archived chats" last, or back to all chats first. */
const useListEnds = (archived: boolean) => {
  const { t } = useLingui();
  const first: CommandEntry = archived
    ? { value: "back", label: t`All chats`, icon: ArrowLeft }
    : { value: "new", label: t`New chat`, icon: Plus };
  const last: CommandEntry = {
    value: "archived",
    label: t`Archived chats`,
    icon: Archive,
  };
  return { first, last };
};

/** What the list says when nothing is in it: honest about what was searched. */
const useEmpty = (archived: boolean, query: string): string => {
  const { t } = useLingui();
  if (query === "") {
    return archived ? t`No archived chats` : t`No chats yet`;
  }
  // Archived chats are searched by title alone.
  return archived
    ? t`No archived chat called “${query}”`
    : t`No chat has “${query}” in its name or what was said`;
};

/**
 * The window's list: the chats (`archived` false: "New chat" first,
 * "Archived chats" last) or the archived ones (back to all chats first),
 * with a search over them. Archived chats are searched by title alone:
 * core's search reads the person's list.
 */
const ChatsCommand = ({
  archived,
  onArchived,
  onClose,
}: {
  archived: boolean;
  onArchived: (archived: boolean) => void;
  onClose: () => void;
}) => {
  const { t } = useLingui();
  const goTo = useGoToChat();
  const activeId = useActiveChat();
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<ChatSummary>();
  const [deleting, setDeleting] = useState<ChatSummary>();
  const said = useSaidSearch();
  const listing = useListed(archived);
  const changes = useChanges(() => {
    listing.read();
  });
  const rowsOf = useChatRows(useChatActions(archived));
  const trimmed = query.trim();
  const empty = useEmpty(archived, trimmed);
  const searching = trimmed !== "";
  const read = listing.listed !== undefined;
  const chats = listing.listed ?? [];
  const answered =
    !archived && said.found?.query === trimmed ? said.found : undefined;
  const hits = new Map((answered?.hits ?? []).map((hit) => [hit.chat.id, hit]));
  const byValue = new Map(chats.map((chat) => [chatValue(chat.id), chat]));
  const ends = useListEnds(archived);
  const items: CommandItems = [
    ...(searching ? [] : [ends.first]),
    ...rowsOf(shownChats({ chats, query: trimmed, found: answered }), hits),
    ...(searching || archived || !read ? [] : [ends.last]),
  ];
  if (renaming !== undefined) {
    return (
      <RenameChat
        chat={renaming}
        onDone={(name) => {
          setRenaming(undefined);
          if (name !== null) {
            void changes.rename(renaming, name);
          }
        }}
      />
    );
  }
  const failure = listing.failure ?? said.failure ?? changes.failure;
  const label = archived ? t`Search archived chats` : t`Search chats`;
  const lookingForSaid = searching && !archived && answered === undefined;
  return (
    <>
      <Command
        aria-label={label}
        bare
        empty={empty}
        filter={false}
        items={items}
        loading={!read || lookingForSaid}
        loadingLabel={read ? t`Searching what was said` : t`Loading chats`}
        onAction={(value) => {
          if (value === "archived" || value === "back") {
            onArchived(value === "archived");
            return;
          }
          onClose();
          goTo(value === "new" ? undefined : byValue.get(value)?.id);
        }}
        onQueryChange={(next) => {
          setQuery(next);
          if (!archived) {
            said.search(next);
          }
        }}
        onRowAction={(value, action) => {
          const chat = byValue.get(value);
          if (chat === undefined) {
            return;
          }
          if (action === "rename") {
            setRenaming(chat);
          } else if (action === "delete") {
            setDeleting(chat);
          } else {
            void changes.archive(chat, action === "archive");
          }
        }}
        placeholder={label}
        query={query}
      />
      <Failure failure={failure} />
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

/** The chats window: open while `open`, closed by Escape, a press outside, or a chat chosen. */
export const ChatWindow = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const { t } = useLingui();
  const [archived, setArchived] = useState(false);
  // Each time it opens, it opens on the chats.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setArchived(false);
    }
  }
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogTitle>{archived ? t`Archived chats` : t`Chats`}</DialogTitle>
        {/* Afresh each time it opens, and for each list: no search from before. */}
        {open ? (
          <ChatsCommand
            archived={archived}
            key={archived ? "archived" : "chats"}
            onArchived={setArchived}
            onClose={() => {
              onOpenChange(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
