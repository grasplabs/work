import { chatTitleSchema } from "@grasp-os/shared/chat";
import type { ChatSearchHit, ChatSummary } from "@grasp-os/shared/chat";
import { hasEvery } from "@grasp-os/shared/chat-search";
import { failureText } from "@grasp-os/shared/errors";
import { AgentIndicator } from "@grasp-os/ui/components/agent-indicator";
import { Button } from "@grasp-os/ui/components/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandHighlight,
  CommandInput,
  CommandList,
} from "@grasp-os/ui/components/command";
import type {
  CommandItemData,
  CommandItems,
} from "@grasp-os/ui/components/command";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { Text } from "@grasp-os/ui/components/text";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  TrashIcon,
  UndoIcon,
} from "@grasp-os/ui/lib/icons";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { setActiveChat, useActiveChat } from "./active-chat.ts";
import { groupChats, whenShort } from "./chat-history.ts";
import type { ChatPeriod } from "./chat-history.ts";
import { useOpenChat } from "./chat-presence.ts";
import { DeleteChatDialog } from "./delete-chat-dialog.tsx";
import { FailureLine } from "./failure-line.tsx";

// The person's chats in one window, ⌘K away on every page and loaded the
// first time it opens (`ChatSwitcherProvider` in chat-switcher.tsx), as
// Damsko's Command dialog and its chats window pattern make it: "New chat"
// first, then the chats by when they were last used, each with its time at
// the end (or the working mark while its agent answers), the open one
// marked as current, its actions on the row's arrow: Rename, Archive or
// Restore, Delete; "Archived" last, which lists the archived chats. Typing
// narrows the chats by their titles at once and asks core what was said
// (`chats.search`), whose chats show where the words were, marked.
// Renaming takes the window's place with a dialog of its own; as it goes,
// by Escape, Cancel or once renamed, the window comes back on the list it
// was in with the chat's row highlighted.
//
// Delete still asks first: core deletes a chat for good, with nothing to
// bring it back, so an Undo after it could not keep its word.

/** How long typing rests before core is asked what was said. */
const searchRestMs = 200;

const periodLabel: Record<ChatPeriod, MessageDescriptor> = {
  today: msg({ message: "Today", context: "chats from today" }),
  week: msg({ message: "Last 7 days", context: "chats from the past week" }),
  earlier: msg({ message: "Earlier", context: "older chats" }),
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

/**
 * Reads the person's chats from core, the archived ones or the rest, again
 * on each `read`: the latest read only, so an answer that comes late for
 * an earlier one is dropped, and kept with which list it is. With the
 * rest, how many they archived, as #2503 counts them for the Archived row,
 * read beside the list and never holding it up.
 */
const useListed = () => {
  const core = useCore();
  const [listed, setListed] = useState<{
    archived: boolean;
    chats: ChatSummary[];
  }>();
  const [archivedCount, setArchivedCount] = useState(0);
  const [failure, setFailure] = useState<string>();
  const latest = useRef(0);
  const count = (asked: number): void => {
    void (async () => {
      try {
        const put = await core.withSession(
          async (session) => await session.chats.list({ archived: true })
        );
        if (asked === latest.current) {
          setArchivedCount(put.length);
        }
      } catch {
        // Uncounted, the Archived row waits for the next read.
      }
    })();
  };
  const read = (archived: boolean): void => {
    latest.current += 1;
    const asked = latest.current;
    if (!archived) {
      count(asked);
    }
    void (async () => {
      try {
        const chats = await core.withSession(
          async (session) => await session.chats.list({ archived })
        );
        if (asked === latest.current) {
          setListed({ archived, chats });
          setFailure(undefined);
          if (archived) {
            setArchivedCount(chats.length);
          }
        }
      } catch (error) {
        if (asked === latest.current) {
          setFailure(failureText(error));
        }
      }
    })();
  };
  return { listed, archivedCount, failure, read };
};

/**
 * The chats the list shows: all of them, and with a search, those whose
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

/** Where what was said in a chat holds the search's words, the words marked. */
const saidOf = (hit: ChatSearchHit | undefined): ReactNode => {
  const said = hit?.said ?? null;
  return said === null ? undefined : (
    <>
      {said.before}
      <CommandHighlight>{said.found}</CommandHighlight>
      {said.after}
    </>
  );
};

/**
 * Renames a chat, in a dialog of its own: Rename (or Enter in the field)
 * works with the dialog open and closes it once core has the name; while
 * it works, the dialog holds.
 */
const RenameChatDialog = ({
  chat,
  onDone,
}: {
  chat: ChatSummary;
  onDone: () => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const formId = useId();
  const { busy, failure, run } = useCoreAction();
  const [name, setName] = useState(chat.title);
  const trimmed = name.trim();
  const valid = chatTitleSchema.safeParse(trimmed).success;
  const rename = async (): Promise<void> => {
    const renamed = await run(async (session) => {
      await session.chats.rename(chat.id, trimmed);
      return true;
    });
    if (renamed === true) {
      await router.invalidate();
      onDone();
    }
  };
  return (
    <Dialog
      onOpenChange={(open, details) => {
        if (busy) {
          details.cancel();
        } else if (!open) {
          onDone();
        }
      }}
      open
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Rename chat</Trans>
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              if (valid && trimmed !== chat.title) {
                void rename();
              }
            }}
          >
            <Field name="chat-name">
              <FieldLabel>{t`Chat name`}</FieldLabel>
              <Input onValueChange={setName} value={name} />
            </Field>
          </form>
          <FailureLine>{failure}</FailureLine>
        </DialogBody>
        <DialogFooter>
          <DialogClose>
            <Trans>Cancel</Trans>
          </DialogClose>
          <Button
            disabled={!valid || trimmed === chat.title || busy}
            form={formId}
            size="sm"
            type="submit"
          >
            <Trans>Rename</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** A row's end: the working mark while its agent answers, else when it was last used. */
const RowEnd = ({ chat, now }: { chat: ChatSummary; now: Date }) => {
  const { i18n } = useLingui();
  return chat.running ? (
    <AgentIndicator />
  ) : (
    <Text as="span" color="muted" size="xs">
      <time dateTime={chat.lastAt}>
        {whenShort(chat.lastAt, now, i18n.locale)}
      </time>
    </Text>
  );
};

/** What a row offers on its arrow: rename it, archive it, delete it; to an archived one, less. */
const useRowActions = (archived: boolean): CommandItemData["actions"] => {
  const { t } = useLingui();
  const remove = {
    value: "delete",
    label: t`Delete`,
    icon: TrashIcon,
    variant: "destructive" as const,
  };
  return archived
    ? [{ value: "unarchive", label: t`Unarchive`, icon: UndoIcon }, remove]
    : [
        { value: "rename", label: t`Rename`, icon: PencilIcon },
        { value: "archive", label: t`Archive`, icon: ArchiveIcon },
        remove,
      ];
};

/**
 * The chats as rows: at rest in groups by when they were last used; a
 * search's as it found them, as #2503 lists them.
 */
const groupsOf = (
  chats: readonly ChatSummary[],
  searching: boolean,
  now: Date,
  rowOf: (chat: ChatSummary) => CommandItemData,
  i18n: I18n
): CommandItems =>
  searching
    ? chats.map(rowOf)
    : groupChats(chats, now).map(({ period, chats: inPeriod }) => ({
        type: "group" as const,
        label: i18n._(periodLabel[period]),
        items: inPeriod.map(rowOf),
      }));

/**
 * The list's items: New chat first where it offers one, the chats by
 * when they were last used, Archived last with how many, where there are;
 * in the archived list the way back first; a search that failed, the one
 * row that tries it again.
 */
const useListItems = ({
  groups,
  archived,
  archivedCount,
  searching,
  offersNew,
  searchFailure,
}: {
  groups: CommandItems;
  archived: boolean;
  archivedCount: number;
  searching: boolean;
  offersNew: boolean;
  searchFailure: string | undefined;
}): CommandItems => {
  const { t } = useLingui();
  if (searchFailure !== undefined) {
    return [
      {
        value: "retry-search",
        label: t`Try the search again`,
        icon: RefreshCwIcon,
        description: searchFailure,
      },
    ];
  }
  if (archived) {
    return [
      { value: "back", label: t`All chats`, icon: ArrowLeftIcon },
      ...groups,
    ];
  }
  // A search lists chats alone: what it found, or the words that it found none.
  return [
    ...(offersNew && !searching
      ? [{ value: "new", label: t`New chat`, icon: PlusIcon }]
      : []),
    ...groups,
    ...(searching || archivedCount === 0
      ? []
      : [
          { type: "separator" as const },
          {
            value: "archived",
            label: t`Archived`,
            icon: ArchiveIcon,
            description: t`${plural(archivedCount, { one: "# chat", other: "# chats" })}`,
          },
        ]),
  ];
};

/** What a chat's row offers on its arrow. */
type RowAction = "rename" | "archive" | "unarchive" | "delete";

const isRowAction = (value: string): value is RowAction =>
  value === "rename" ||
  value === "archive" ||
  value === "unarchive" ||
  value === "delete";

/**
 * The person's chats as a Command's items, with what its search, its rows
 * and their actions do, for the window. Read each time it is `shown`, so
 * it shows what changed elsewhere.
 */
const useChatItems = ({
  shown,
  onOpen,
  onNew,
  onDialog,
  onRenamed,
}: {
  shown: boolean;
  onOpen: (chatId: string) => void;
  /** Where the list offers a new chat. */
  onNew?: () => void;
  /**
   * Before a row's dialog opens (Rename, Delete): the window it stands in
   * closes, so no dialog opens over another.
   */
  onDialog: () => void;
  /** Once the Rename dialog has gone, for the chat it renamed: the window comes back to its row. */
  onRenamed: (chatId: string) => void;
}) => {
  const { t, i18n } = useLingui();
  const router = useRouter();
  const activeId = useActiveChat();
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [deleting, setDeleting] = useState<ChatSummary>();
  const [renaming, setRenaming] = useState<ChatSummary>();
  // Back from Rename: the window shows again on the list it was in.
  const [renamed, setRenamed] = useState(false);
  const said = useSaidSearch();
  const listing = useListed();
  const { failure, run } = useCoreAction();
  const [readWhenShown, setReadWhenShown] = useState(false);
  // Read again each time it shows, so it shows what changed elsewhere.
  if (shown !== readWhenShown) {
    setReadWhenShown(shown);
    if (shown) {
      setSearch("");
      if (!renamed) {
        setArchived(false);
      }
      setRenamed(false);
    }
  }
  const read = useEffectEvent((which: boolean) => {
    listing.read(which);
  });
  useEffect(() => {
    if (shown) {
      read(archived);
    }
  }, [shown, archived]);

  // Only the list asked for: the other's rows would take this one's actions.
  const listed =
    listing.listed?.archived === archived ? listing.listed.chats : undefined;
  const chats = listed ?? [];
  const query = search.trim();
  const searching = query !== "";
  const answered = said.found?.query === query ? said.found : undefined;
  const hits = new Map((answered?.hits ?? []).map((hit) => [hit.chat.id, hit]));
  const now = new Date();
  const actions = useRowActions(archived);
  const rowOf = (chat: ChatSummary): CommandItemData => ({
    value: chat.id,
    label: chat.title,
    description: saidOf(hits.get(chat.id)),
    current: chat.id === activeId,
    end: <RowEnd chat={chat} now={now} />,
    actions,
  });
  const inList = shownChats({ chats, query, found: answered });
  const groups = groupsOf(inList, searching, now, rowOf, i18n);
  const items = useListItems({
    groups,
    archived,
    archivedCount: listing.archivedCount,
    searching,
    offersNew: onNew !== undefined,
    searchFailure: searching ? said.failure : undefined,
  });
  const onAction = (value: string): false | undefined => {
    if (value === "retry-search") {
      said.search(search);
      return false;
    }
    if (value === "archived" || value === "back") {
      setArchived(value === "archived");
      setSearch("");
      return false;
    }
    if (value === "new") {
      onNew?.();
      return undefined;
    }
    onOpen(value);
    return undefined;
  };
  const onItemAction = async (value: string, action: string) => {
    const chat = chats.find(({ id }) => id === value);
    if (chat === undefined || !isRowAction(action)) {
      return;
    }
    if (action === "rename" || action === "delete") {
      onDialog();
      (action === "rename" ? setRenaming : setDeleting)(chat);
    } else {
      const done = await run(async (session) => {
        await (action === "archive"
          ? session.chats.archive(chat.id)
          : session.chats.unarchive(chat.id));
        return true;
      });
      if (done === true) {
        listing.read(archived);
        await router.invalidate();
      }
    }
  };
  const command = {
    items,
    onAction,
    onItemAction,
    inputValue: search,
    onInputValueChange: (value: string) => {
      setSearch(value);
      said.search(value);
    },
    // Core's answer is the list: Command filters only by what it shows.
    filter: false,
    loading: listed === undefined,
  };
  let empty = searching ? t`No chat has that.` : t`No chats here yet.`;
  if (archived) {
    empty = t`No archived chats.`;
  }
  const dialogs = (
    <>
      {deleting === undefined ? null : (
        <DeleteChatDialog
          active={deleting.id === activeId}
          chat={deleting}
          onOpenChange={(next) => {
            if (!next) {
              setDeleting(undefined);
              listing.read(archived);
            }
          }}
          open
        />
      )}
      {renaming === undefined ? null : (
        <RenameChatDialog
          chat={renaming}
          onDone={() => {
            setRenaming(undefined);
            setRenamed(true);
            onRenamed(renaming.id);
          }}
        />
      )}
    </>
  );
  // How many only once the list has come: until then, no count.
  let label = t`Search chats`;
  if (archived && listed === undefined) {
    label = t`Archived chats`;
  } else if (archived) {
    const count = chats.length;
    label = t`${plural(count, { one: "# archived chat", other: "# archived chats" })}`;
  }
  return {
    command,
    empty,
    failure: listing.failure ?? failure,
    dialogs,
    label,
  };
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

/** How many frames the window may take to list a chat it comes back to. */
const rowWaitFrames = 120;

/**
 * Highlights chat `chatId`'s row once the window lists it, as the arrows
 * would: Damsko's CommandDialog takes no row to highlight (its Command
 * highlights the first), so the search field is given an arrow down a
 * frame at a time until it is that row. Then `done`.
 */
const useBackToRow = (
  chatId: string | undefined,
  listed: boolean,
  done: () => void
) => {
  useEffect(() => {
    if (chatId === undefined || !listed) {
      return () => {
        // Nothing to come back to yet.
      };
    }
    let frame = 0;
    let frames = 0;
    const step = (): void => {
      frames += 1;
      const row = document.querySelector<HTMLElement>(
        `[data-command-value="${CSS.escape(chatId)}"]`
      );
      const field = row
        ?.closest('[role="dialog"]')
        ?.querySelector<HTMLElement>('[role="combobox"]');
      if (row?.dataset.highlighted !== undefined || frames > rowWaitFrames) {
        done();
        return;
      }
      field?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        })
      );
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [chatId, listed, done]);
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
  // The chat a Rename dialog was for, while the window comes back to it.
  const [backTo, setBackTo] = useState<string>();
  const { command, empty, failure, dialogs, label } = useChatItems({
    shown: open,
    onNew: () => {
      onOpenChange(false);
      selectChat();
    },
    onOpen: (chatId) => {
      onOpenChange(false);
      selectChat(chatId);
    },
    onDialog: () => {
      onOpenChange(false);
    },
    onRenamed: (chatId) => {
      setBackTo(chatId);
      onOpenChange(true);
    },
  });
  const backDone = useCallback(() => {
    setBackTo(undefined);
  }, []);
  useBackToRow(open ? backTo : undefined, !command.loading, backDone);
  return (
    <>
      <CommandDialog
        {...command}
        aria-label={t`Chats`}
        onOpenChange={onOpenChange}
        open={open}
        shortcut={null}
        trigger={null}
      >
        <CommandInput aria-label={label} placeholder={label} />
        <FailureLine>{failure}</FailureLine>
        <CommandEmpty>{empty}</CommandEmpty>
        <CommandList />
      </CommandDialog>
      {dialogs}
    </>
  );
};
