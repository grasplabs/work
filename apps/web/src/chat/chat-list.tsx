import type { ChatSummary } from "@grasp-os/shared/chat";
import { chatTitleSchema } from "@grasp-os/shared/chat";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { Input } from "@grasp-os/ui/components/input";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import {
  EllipsisIcon,
  MessageSquareIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";

import { ErrorText } from "../error-text.tsx";
import {
  PageSidebar,
  PageSidebarTop,
  RailButton,
  RailDivider,
  RailExpand,
  usePageSidebarFold,
} from "../frame/page-sidebar.tsx";
import { useCoreAction } from "../use-core-action.ts";

// The person's chats beside the open one, in the page sidebar
// (grasplabs/prototype `components/chat/chat-list.tsx`): a new chat with
// the fold beside it, then the past ones by when they were started;
// folded, a rail of icons. Each chat's menu renames or deletes it. Read
// from core alone: nothing about them is kept in the browser.

type Period = "today" | "week" | "earlier";

const periodLabel: Record<Period, MessageDescriptor> = {
  today: msg({ message: "Today", context: "chats from today" }),
  week: msg({ message: "Last 7 days", context: "chats from the past week" }),
  earlier: msg({ message: "Earlier", context: "older chats" }),
};

/** How many recent chats the folded rail shows as icons. */
const onRail = 6;

const aDay = 24 * 60 * 60 * 1000;

/** When the day `date` falls on began, here. */
const startOfDay = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** Whole days between the day `iso` fell on and today, here. */
const daysAgo = (iso: string, now: Date): number =>
  Math.round((startOfDay(now) - startOfDay(new Date(iso))) / aDay);

const periodOf = (days: number): Period => {
  if (days <= 0) {
    return "today";
  }
  return days < 7 ? "week" : "earlier";
};

/** The chats by period, each newest first, in the order core lists them. */
const groupChats = (
  chats: readonly ChatSummary[],
  now: Date
): { period: Period; chats: ChatSummary[] }[] => {
  const groups = new Map<Period, ChatSummary[]>();
  for (const chat of chats) {
    const period = periodOf(daysAgo(chat.createdAt, now));
    groups.set(period, [...(groups.get(period) ?? []), chat]);
  }
  return (["today", "week", "earlier"] as const).flatMap((period) => {
    const inPeriod = groups.get(period);
    return inPeriod === undefined ? [] : [{ period, chats: inPeriod }];
  });
};

/**
 * A chat's name being changed in place: Enter or leaving the field keeps
 * it, Escape keeps the old one. `onDone` gets the new name, or `null` when
 * nothing should change, and whether a key ended it, so the focus can go
 * back to the row (leaving the field put it somewhere else already).
 */
const RenameField = ({
  value,
  label,
  onDone,
}: {
  value: string;
  label: string;
  onDone: (name: string | null, byKey: boolean) => void;
}) => {
  const [text, setText] = useState(value);
  // Enter and Escape end it before the field loses focus; leaving it must
  // not end it a second time.
  const done = useRef(false);
  const finish = (name: string | null, byKey: boolean): void => {
    if (done.current) {
      return;
    }
    done.current = true;
    onDone(name, byKey);
  };
  return (
    <Input
      aria-label={label}
      // It opens to be typed in.
      autoFocus
      onBlur={() => {
        finish(text, false);
      }}
      onChange={(event) => {
        setText(event.target.value);
      }}
      onFocus={(event) => {
        event.currentTarget.select();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(text, true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(null, true);
        }
      }}
      value={text}
    />
  );
};

/** How long a first click waits for a second one before it counts as one. */
const doubleClickMs = 250;

/**
 * A click and a double click that do different things on a link: the
 * click waits a moment, so a double click only renames. A click from the
 * keyboard, or one that opens a new tab, acts at once, as a link does.
 */
const useClickOrDoubleClick = (
  onClick: () => void,
  onDoubleClick: () => void
) => {
  const pending = useRef(0);
  useEffect(
    () => () => {
      window.clearTimeout(pending.current);
    },
    []
  );
  return {
    onClick: (event: MouseEvent) => {
      window.clearTimeout(pending.current);
      const ownTab =
        event.button === 0 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey;
      if (event.detail === 0 || !ownTab) {
        return;
      }
      event.preventDefault();
      if (event.detail === 1) {
        pending.current = window.setTimeout(onClick, doubleClickMs);
      }
    },
    onDoubleClick: () => {
      window.clearTimeout(pending.current);
      onDoubleClick();
    },
  };
};

/** Deletes a chat, once the person confirms. */
const DeleteDialog = ({
  chat,
  active,
  open,
  onOpenChange,
}: {
  chat: ChatSummary;
  /** Whether it is the open chat: then the page leaves it for a new one. */
  active: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const router = useRouter();
  const navigate = useNavigate();
  const { busy, failure, run } = useCoreAction();
  const { title } = chat;
  const remove = async (): Promise<void> => {
    const removed = await run(async (session) => {
      await session.chats.remove(chat.id);
      return true;
    });
    if (removed === true) {
      onOpenChange(false);
      if (active) {
        await navigate({ to: "/", search: {} });
      }
      await router.invalidate();
    }
  };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Delete “{title}”?</Trans>
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm">
          <Trans>
            Its messages are deleted for good, and every change its agent holds
            for you is rejected. What the agent did stays in the audit log.
          </Trans>
        </p>
        <ErrorText>{failure}</ErrorText>
        <DialogFooter showCloseButton>
          <Button
            disabled={busy}
            onClick={() => {
              void remove();
            }}
            variant="destructive"
          >
            <Trans>Delete</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/**
 * One chat in the list: its title alone, one line as high as every other
 * row in a sidebar, so the list holds more of them; the group it is under
 * says when it was started. A double click renames it in place, as does
 * Rename in its menu; Delete asks first.
 */
const ChatItem = ({
  chat,
  active,
  onPick,
}: {
  chat: ChatSummary;
  active: boolean;
  onPick?: () => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const navigate = useNavigate();
  const { failure, run } = useCoreAction();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Choosing Rename leaves the focus in the field that opens, rather than
  // giving it back to the menu's button.
  const renamingFromMenu = useRef(false);
  // Enter or Escape gives the focus back to the row once the field goes.
  const link = useRef<HTMLAnchorElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (renaming || !refocus.current) {
      return;
    }
    refocus.current = false;
    link.current?.focus();
  }, [renaming]);
  const open = (): void => {
    onPick?.();
    void navigate({ to: "/", search: { chat: chat.id } });
  };
  const clicks = useClickOrDoubleClick(open, () => {
    setRenaming(true);
  });
  const rename = async (name: string): Promise<void> => {
    const renamed = await run(async (session) => {
      await session.chats.rename(chat.id, name);
      return true;
    });
    if (renamed === true) {
      await router.invalidate();
    }
  };
  const { title } = chat;
  return (
    <li className="group/row relative">
      {renaming ? (
        <div className="flex items-center px-2 py-0.5">
          <RenameField
            label={t`Chat name`}
            onDone={(name, byKey) => {
              refocus.current = byKey;
              setRenaming(false);
              const trimmed = name?.trim();
              if (
                trimmed !== undefined &&
                trimmed !== title &&
                chatTitleSchema.safeParse(trimmed).success
              ) {
                void rename(trimmed);
              }
            }}
            value={title}
          />
        </div>
      ) : (
        <Link
          aria-current={active ? "page" : undefined}
          className={
            active
              ? "bg-accent focus-visible:ring-ring flex w-full items-center rounded-md py-1.5 pr-9 pl-2 text-left outline-none focus-visible:ring-2"
              : "hover:bg-muted focus-visible:ring-ring flex w-full items-center rounded-md py-1.5 pr-9 pl-2 text-left outline-none focus-visible:ring-2"
          }
          onClick={(event) => {
            clicks.onClick(event);
            if (event.detail === 0) {
              onPick?.();
            }
          }}
          onDoubleClick={() => {
            clicks.onDoubleClick();
          }}
          ref={link}
          search={{ chat: chat.id }}
          to="/"
        >
          <span className="min-w-0 flex-1 truncate">{title}</span>
        </Link>
      )}
      {renaming ? null : (
        <span className="absolute top-1 right-1.5 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 has-data-popup-open:opacity-100 pointer-coarse:opacity-100">
          <DropdownMenu
            onOpenChange={(menuOpen) => {
              if (menuOpen) {
                renamingFromMenu.current = false;
              }
            }}
          >
            <DropdownMenuTrigger
              aria-label={t`More for ${title}`}
              render={<Button size="icon-xs" variant="ghost" />}
            >
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              finalFocus={() => !renamingFromMenu.current}
            >
              <DropdownMenuItem
                onClick={() => {
                  renamingFromMenu.current = true;
                  setRenaming(true);
                }}
              >
                <PencilIcon />
                <Trans>Rename</Trans>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  setDeleting(true);
                }}
                variant="destructive"
              >
                <Trash2Icon />
                <Trans>Delete</Trans>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      )}
      <ErrorText>{failure}</ErrorText>
      {deleting ? (
        <DeleteDialog
          active={active}
          chat={chat}
          onOpenChange={setDeleting}
          open={deleting}
        />
      ) : null}
    </li>
  );
};

/**
 * The list itself: a new chat with the fold beside it, then the chats by
 * when they were started. In the sheet on a narrow screen there is no
 * fold, and a pick closes the sheet.
 */
export const ChatList = ({
  chats,
  activeId,
  fold,
  onPick,
}: {
  chats: readonly ChatSummary[];
  activeId: string | undefined;
  fold?: { label: string; onFold: () => void };
  onPick?: () => void;
}) => {
  const { t, i18n } = useLingui();
  const groups = groupChats(chats, new Date());
  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      <PageSidebarTop fold={fold}>
        <Link
          className={buttonVariants({ variant: "outline" })}
          onClick={onPick}
          search={{}}
          to="/"
        >
          <PlusIcon data-icon="inline-start" />
          <Trans>New chat</Trans>
        </Link>
      </PageSidebarTop>
      <nav
        aria-label={t`Recent chats`}
        className="min-h-0 flex-1 overflow-auto p-3"
      >
        {groups.length === 0 ? (
          <p className="text-muted-foreground px-1 py-2">
            <Trans>Your chats show up here.</Trans>
          </p>
        ) : (
          groups.map((group) => (
            <section
              aria-label={i18n._(periodLabel[group.period])}
              className="flex flex-col gap-0.5 pt-3 first:pt-0"
              key={group.period}
            >
              <h3 className="text-muted-foreground px-2 pb-1 text-xs">
                {i18n._(periodLabel[group.period])}
              </h3>
              <ul className="flex flex-col gap-0.5">
                {group.chats.map((chat) => (
                  <ChatItem
                    active={chat.id === activeId}
                    chat={chat}
                    key={chat.id}
                    onPick={onPick}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </nav>
    </div>
  );
};

/** The chats in the page sidebar, open or folded to its rail. */
export const ChatSidebar = ({
  chats,
  activeId,
}: {
  chats: readonly ChatSummary[];
  activeId: string | undefined;
}) => {
  const { t } = useLingui();
  const [folded, setFolded] = usePageSidebarFold("chat");
  if (folded) {
    return (
      <PageSidebar folded label={t`Chats`}>
        <RailExpand
          label={t`Expand the chats`}
          onExpand={() => {
            setFolded(false);
          }}
        />
        <RailButton label={t`New chat`} render={<Link search={{}} to="/" />}>
          <PlusIcon />
        </RailButton>
        <RailDivider />
        {chats.slice(0, onRail).map((chat) => (
          <RailButton
            active={chat.id === activeId}
            key={chat.id}
            label={chat.title}
            render={<Link search={{ chat: chat.id }} to="/" />}
          >
            <MessageSquareIcon />
          </RailButton>
        ))}
      </PageSidebar>
    );
  }
  return (
    <PageSidebar folded={false} label={t`Chats`}>
      <ChatList
        activeId={activeId}
        chats={chats}
        fold={{
          label: t`Fold the chats`,
          onFold: () => {
            setFolded(true);
          },
        }}
      />
    </PageSidebar>
  );
};
