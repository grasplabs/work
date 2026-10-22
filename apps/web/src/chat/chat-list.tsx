import type { ChatProject, ChatSummary } from "@grasp-os/shared/chat";
import {
  chatTitleSchema,
  projectNameMaxLength,
  projectNameSchema,
} from "@grasp-os/shared/chat";
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
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { Input } from "@grasp-os/ui/components/input";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import {
  CheckIcon,
  EllipsisIcon,
  FolderIcon,
  FolderInputIcon,
  FolderMinusIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  PencilIcon,
  PlusIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DragEvent, MouseEvent, ReactNode } from "react";

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
import { activeChat, setActiveChat } from "./active-chat.ts";
import { chatsByProject } from "./chat-projects.ts";
import { ProjectDialog } from "./project-dialog.tsx";

// The person's chats beside the open one, in the page sidebar
// (grasplabs/prototype `components/chat/chat-list.tsx`): a new chat with
// the fold beside it, the person's projects with their chats, then the
// other chats by when they were last active, so one just continued is
// under Today (`lib/chat-history.ts`); folded, a rail of icons. Each
// chat's menu renames it, moves it into a project or out of one, or
// deletes it; a chat dragged onto a project goes into it, and onto the
// chats by date out of it. Read from core alone: nothing about them is
// kept in the browser.

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

/**
 * The chats by the period they were last active in, each the most recent
 * first, in the order core lists them.
 */
const groupChats = (
  chats: readonly ChatSummary[],
  now: Date
): { period: Period; chats: ChatSummary[] }[] => {
  const groups = new Map<Period, ChatSummary[]>();
  for (const chat of chats) {
    const period = periodOf(daysAgo(chat.lastAt, now));
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
  maxLength,
  onDone,
}: {
  value: string;
  label: string;
  maxLength: number;
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
      maxLength={maxLength}
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

/** The longest name a chat takes, as core checks it. */
const chatTitleMaxLength = 200;

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
      // A deleted chat is nobody's open chat any more.
      if (activeChat() === chat.id) {
        setActiveChat(undefined);
      }
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
 * A click and a double click that do different things on a button: the
 * click waits a moment, so a double click only does its own thing. A
 * click from the keyboard acts at once.
 */
const useButtonClicks = (onClick: () => void, onDoubleClick: () => void) => {
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
      if (event.detail === 0) {
        onClick();
      } else if (event.detail === 1) {
        pending.current = window.setTimeout(onClick, doubleClickMs);
      }
    },
    onDoubleClick: () => {
      window.clearTimeout(pending.current);
      onDoubleClick();
    },
  };
};

/** The data type a dragged chat carries: its ID. */
const chatDragType = "application/x-grasp-chat";

/** What a chat's row needs of the list around it, for its menu and a drag. */
interface ChatMoves {
  projects: readonly ChatProject[];
  /** Makes a project for the chat, from its menu. */
  onNewProject: (chatId: string) => void;
  /** The chat is picked up to drag, or let go (none). */
  onDrag: (chat?: ChatSummary) => void;
}

/**
 * One chat in the list: its title alone, one line as high as every other
 * row in a sidebar, so the list holds more of them; the group it is under
 * says when it was started, or which project it is in. A double click
 * renames it in place, as does Rename in its menu; the menu moves it into
 * a project or out of one, as a drag does; Delete asks first.
 */
const ChatItem = ({
  chat,
  active,
  moves,
  onPick,
}: {
  chat: ChatSummary;
  active: boolean;
  moves: ChatMoves;
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
  const move = async (projectId: string | null): Promise<void> => {
    const moved = await run(async (session) => {
      await session.chats.moveChat(chat.id, projectId);
      return true;
    });
    if (moved === true) {
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
            maxLength={chatTitleMaxLength}
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
          // The open chat as the chat switcher marks it: in weight, on the
          // muted fill a row takes where it is pointed at.
          className={
            active
              ? "bg-muted focus-visible:ring-ring/50 flex w-full items-center rounded-md py-1.5 pr-9 pl-2 text-left font-medium outline-none focus-visible:ring-3"
              : "hover:bg-muted focus-visible:ring-ring/50 flex w-full items-center rounded-md py-1.5 pr-9 pl-2 text-left transition-colors duration-150 outline-none focus-visible:ring-3"
          }
          draggable
          onClick={(event) => {
            clicks.onClick(event);
            if (event.detail === 0) {
              onPick?.();
            }
          }}
          onDoubleClick={() => {
            clicks.onDoubleClick();
          }}
          onDragEnd={() => {
            moves.onDrag();
          }}
          onDragStart={(event) => {
            event.dataTransfer.setData(chatDragType, chat.id);
            event.dataTransfer.effectAllowed = "move";
            moves.onDrag(chat);
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
              className="w-60"
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
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <FolderInputIcon />
                  <Trans>Move to project</Trans>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-52">
                  {moves.projects.map((project) => (
                    <DropdownMenuItem
                      disabled={project.id === chat.projectId}
                      key={project.id}
                      onClick={() => {
                        void move(project.id);
                      }}
                    >
                      <FolderIcon />
                      <span className="min-w-0 flex-1 truncate">
                        {project.name}
                      </span>
                      {project.id === chat.projectId ? <CheckIcon /> : null}
                    </DropdownMenuItem>
                  ))}
                  {moves.projects.length === 0 ? null : (
                    <DropdownMenuSeparator />
                  )}
                  <DropdownMenuItem
                    onClick={() => {
                      moves.onNewProject(chat.id);
                    }}
                  >
                    <FolderPlusIcon />
                    <Trans>New project…</Trans>
                  </DropdownMenuItem>
                  {chat.projectId === null ? null : (
                    <DropdownMenuItem
                      onClick={() => {
                        void move(null);
                      }}
                    >
                      <FolderMinusIcon />
                      <Trans>Take out of the project</Trans>
                    </DropdownMenuItem>
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
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

/** Deletes a project, once the person confirms; its chats stay. */
const DeleteProjectDialog = ({
  project,
  open,
  onOpenChange,
}: {
  project: ChatProject;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const { name } = project;
  const remove = async (): Promise<void> => {
    const removed = await run(async (session) => {
      await session.chats.removeProject(project.id);
      return true;
    });
    if (removed === true) {
      onOpenChange(false);
      await router.invalidate();
    }
  };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Delete the project “{name}”?</Trans>
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm">
          <Trans>
            Its goal and documents are deleted. Its chats stay, back among the
            chats by date.
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
            <Trans>Delete project</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/**
 * Where a dragged chat can land: a project it isn't in (`projectId`), or
 * the chats by date (`null`) when it is in one. `over` marks the place it
 * would land while it is over it.
 */
const useDropZone = (
  dragging: ChatSummary | undefined,
  projectId: string | null,
  onDrop: (chat: ChatSummary) => void
) => {
  const [over, setOver] = useState(false);
  const lands = dragging !== undefined && dragging.projectId !== projectId;
  return {
    over: lands && over,
    zone: {
      onDragOver: (event: DragEvent) => {
        if (!lands || !event.dataTransfer.types.includes(chatDragType)) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setOver(true);
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        ) {
          return;
        }
        setOver(false);
      },
      onDrop: (event: DragEvent) => {
        event.preventDefault();
        setOver(false);
        if (lands) {
          onDrop(dragging);
        }
      },
    },
  };
};

/**
 * A project in the list: its name, folding its chats away or opening
 * them, and its chats under it along a thin guide line. A double click
 * renames it in place; its menu starts a chat in it, edits its goal and
 * documents, or deletes it. A chat dragged onto it goes into it.
 */
const ProjectGroup = ({
  project,
  chats,
  activeId,
  moves,
  dragging,
  onMove,
  onEdit,
  onPick,
}: {
  project: ChatProject;
  chats: readonly ChatSummary[];
  activeId: string | undefined;
  moves: ChatMoves;
  dragging: ChatSummary | undefined;
  onMove: (chat: ChatSummary, projectId: string | null) => void;
  onEdit: (project: ChatProject) => void;
  onPick?: () => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { failure, run } = useCoreAction();
  const [open, setOpen] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const renamingFromMenu = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (renaming || !refocus.current) {
      return;
    }
    refocus.current = false;
    button.current?.focus();
  }, [renaming]);
  const { over, zone } = useDropZone(dragging, project.id, (chat) => {
    // A folded project opens, so the chat is seen arriving.
    setOpen(true);
    onMove(chat, project.id);
  });
  const clicks = useButtonClicks(
    () => {
      setOpen(!open);
    },
    () => {
      setRenaming(true);
    }
  );
  const rename = async (name: string): Promise<void> => {
    const renamed = await run(async (session) => {
      await session.chats.renameProject(project.id, name);
      return true;
    });
    if (renamed === true) {
      await router.invalidate();
    }
  };
  const { name } = project;
  const Icon = open ? FolderOpenIcon : FolderIcon;
  return (
    <li
      aria-label={name}
      className={
        over
          ? "ring-ring flex flex-col gap-0.5 rounded-lg ring-2"
          : "flex flex-col gap-0.5 rounded-lg"
      }
      {...zone}
    >
      <div className="group/row relative">
        {renaming ? (
          <div className="flex items-center gap-2.5 px-2 py-0.5">
            <Icon
              aria-hidden="true"
              className="text-muted-foreground size-4 flex-none"
            />
            <RenameField
              label={t`Project name`}
              maxLength={projectNameMaxLength}
              onDone={(next, byKey) => {
                refocus.current = byKey;
                setRenaming(false);
                const trimmed = next?.trim();
                if (
                  trimmed !== undefined &&
                  trimmed !== name &&
                  projectNameSchema.safeParse(trimmed).success
                ) {
                  void rename(trimmed);
                }
              }}
              value={name}
            />
          </div>
        ) : (
          <button
            aria-expanded={open}
            className="hover:bg-muted focus-visible:ring-ring/50 flex w-full items-center gap-2.5 rounded-md py-1.5 pr-3 pl-2 text-left transition-colors duration-150 outline-none focus-visible:ring-3"
            onClick={(event) => {
              clicks.onClick(event);
            }}
            onDoubleClick={() => {
              clicks.onDoubleClick();
            }}
            ref={button}
            type="button"
          >
            <Icon
              aria-hidden="true"
              className="text-muted-foreground size-4 flex-none"
            />
            <span className="min-w-0 flex-1 truncate">{name}</span>
            {/* How many chats it holds, as the chat switcher and the project
                cards say it; its menu takes the place where it is pointed at,
                so it keeps that room. Seen only, so the project is still named
                by its name alone. */}
            <span
              aria-hidden="true"
              className="text-muted-foreground min-w-5 flex-none text-right text-xs tabular-nums group-focus-within/row:invisible group-hover/row:invisible group-has-data-popup-open/row:invisible pointer-coarse:invisible"
            >
              {chats.length}
            </span>
          </button>
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
                aria-label={t`More for the project ${name}`}
                render={<Button size="icon-xs" variant="ghost" />}
              >
                <EllipsisIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-60"
                finalFocus={() => !renamingFromMenu.current}
              >
                <DropdownMenuItem
                  render={
                    <Link
                      onClick={() => {
                        setActiveChat(undefined);
                        onPick?.();
                      }}
                      search={{ project: project.id }}
                      to="/"
                    />
                  }
                >
                  <MessageSquarePlusIcon />
                  <Trans>New chat in this project</Trans>
                </DropdownMenuItem>
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
                    onEdit(project);
                  }}
                >
                  <SlidersHorizontalIcon />
                  <Trans>Goal and documents</Trans>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => {
                    setDeleting(true);
                  }}
                  variant="destructive"
                >
                  <Trash2Icon />
                  <Trans>Delete project</Trans>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        )}
      </div>
      <ErrorText>{failure}</ErrorText>
      {open ? (
        <ul className="ml-4 flex flex-col gap-0.5 border-l pl-1.5">
          {chats.length === 0 ? (
            <li className="text-muted-foreground px-2 py-1.5 text-xs">
              <Trans>
                No chats yet. Drag one here, or move it from its menu.
              </Trans>
            </li>
          ) : (
            chats.map((chat) => (
              <ChatItem
                active={chat.id === activeId}
                chat={chat}
                key={chat.id}
                moves={moves}
                onPick={onPick}
              />
            ))
          )}
        </ul>
      ) : null}
      {deleting ? (
        <DeleteProjectDialog
          onOpenChange={setDeleting}
          open={deleting}
          project={project}
        />
      ) : null}
    </li>
  );
};

/**
 * The chats by when they were last active: a chat dragged anywhere here
 * comes out of its project.
 */
const DatedChats = ({
  chats,
  activeId,
  moves,
  dragging,
  onMove,
  onPick,
  children,
}: {
  chats: readonly ChatSummary[];
  activeId: string | undefined;
  moves: ChatMoves;
  dragging: ChatSummary | undefined;
  onMove: (chat: ChatSummary, projectId: string | null) => void;
  onPick?: () => void;
  children?: ReactNode;
}) => {
  const { t, i18n } = useLingui();
  const groups = groupChats(chats, new Date());
  const { over, zone } = useDropZone(dragging, null, (chat) => {
    onMove(chat, null);
  });
  return (
    <section
      aria-label={t`Chats by date`}
      className={
        over
          ? "ring-ring flex min-h-16 flex-1 flex-col gap-3 rounded-lg ring-2"
          : "flex min-h-16 flex-1 flex-col gap-3 rounded-lg"
      }
      {...zone}
    >
      {groups.length === 0
        ? children
        : groups.map((group) => (
            <section
              aria-label={i18n._(periodLabel[group.period])}
              className="flex flex-col gap-0.5"
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
                    moves={moves}
                    onPick={onPick}
                  />
                ))}
              </ul>
            </section>
          ))}
    </section>
  );
};

/**
 * The list itself: a new chat with the fold beside it, the person's
 * projects with their chats, then the other chats by when they were
 * last active. In the sheet on a narrow screen there is no fold, and a pick
 * closes the sheet.
 */
export const ChatList = ({
  chats,
  projects,
  activeId,
  fold,
  onPick,
}: {
  chats: readonly ChatSummary[];
  projects: readonly ChatProject[];
  activeId: string | undefined;
  fold?: { label: string; onFold: () => void };
  onPick?: () => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { failure, run } = useCoreAction();
  // A project being made (for the chat that asked for it, if one did), or
  // the one whose goal and documents are being changed.
  const [editing, setEditing] = useState<
    { chatId?: string } | { project: ChatProject }
  >();
  // The chat being dragged.
  const [dragging, setDragging] = useState<ChatSummary>();
  const { inProject, outside } = chatsByProject(chats, projects);
  const move = async (
    chatId: string,
    projectId: string | null
  ): Promise<void> => {
    const moved = await run(async (session) => {
      await session.chats.moveChat(chatId, projectId);
      return true;
    });
    if (moved === true) {
      await router.invalidate();
    }
  };
  const onMove = (chat: ChatSummary, projectId: string | null): void => {
    setDragging(undefined);
    void move(chat.id, projectId);
  };
  const moves: ChatMoves = {
    projects,
    onNewProject: (chatId) => {
      setEditing({ chatId });
    },
    onDrag: setDragging,
  };
  const edited =
    editing !== undefined && "project" in editing ? editing.project : undefined;
  const forChat =
    editing !== undefined && "chatId" in editing ? editing.chatId : undefined;
  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      <PageSidebarTop fold={fold}>
        <Link
          className={buttonVariants({ variant: "outline" })}
          onClick={() => {
            setActiveChat(undefined);
            onPick?.();
          }}
          search={{}}
          to="/"
        >
          <PlusIcon data-icon="inline-start" />
          <Trans>New chat</Trans>
        </Link>
      </PageSidebarTop>
      <nav
        aria-label={t`Recent chats`}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3"
      >
        <section aria-label={t`Projects`} className="flex flex-col gap-0.5">
          <div className="flex items-center justify-between pr-1.5 pl-2">
            <h3 className="text-muted-foreground text-xs">
              <Trans>Projects</Trans>
            </h3>
            <Button
              aria-label={t`New project`}
              onClick={() => {
                setEditing({});
              }}
              size="icon-xs"
              title={t`New project`}
              variant="ghost"
            >
              <PlusIcon />
            </Button>
          </div>
          {projects.length === 0 ? null : (
            <ul className="flex flex-col gap-0.5">
              {projects.map((project) => (
                <ProjectGroup
                  activeId={activeId}
                  chats={inProject.get(project.id) ?? []}
                  dragging={dragging}
                  key={project.id}
                  moves={moves}
                  onEdit={(edit) => {
                    setEditing({ project: edit });
                  }}
                  onMove={onMove}
                  onPick={onPick}
                  project={project}
                />
              ))}
            </ul>
          )}
          <ErrorText>{failure}</ErrorText>
        </section>
        <DatedChats
          activeId={activeId}
          chats={outside}
          dragging={dragging}
          moves={moves}
          onMove={onMove}
          onPick={onPick}
        >
          <p className="text-muted-foreground px-2 py-2">
            {chats.length === 0 ? (
              <Trans>Your chats show up here.</Trans>
            ) : (
              <Trans>Every chat is in a project.</Trans>
            )}
          </p>
        </DatedChats>
      </nav>
      <ProjectDialog
        onOpenChange={(dialogOpen) => {
          if (!dialogOpen) {
            setEditing(undefined);
          }
        }}
        onSaved={(projectId) => {
          if (forChat !== undefined) {
            void move(forChat, projectId);
          }
        }}
        open={editing !== undefined}
        project={edited}
      />
    </div>
  );
};

/**
 * The chats in the page sidebar, open or folded to its rail, kept as the
 * person left it: folded, a new chat, each project, then the most recent
 * chats, as icons. While an App being built stands beside the chat
 * (`building`) it is the rail, to give the App the room, as the
 * prototype's studio has it: opened there, it stays open for that chat
 * only, and folding it again keeps nothing.
 */
export const ChatSidebar = ({
  chats,
  projects,
  activeId,
  building = false,
}: {
  chats: readonly ChatSummary[];
  projects: readonly ChatProject[];
  activeId: string | undefined;
  building?: boolean;
}) => {
  const { t } = useLingui();
  const [browsingFolded, setBrowsingFolded] = usePageSidebarFold("chat");
  // The chat beside whose App the person opened the sidebar.
  const [openedBeside, setOpenedBeside] = useState<string>();
  const folded = building
    ? openedBeside === undefined || openedBeside !== activeId
    : browsingFolded;
  const setFolded = (next: boolean): void => {
    if (building) {
      setOpenedBeside(next ? undefined : activeId);
    } else {
      setBrowsingFolded(next);
    }
  };
  if (folded) {
    const activeProject = chats.find(({ id }) => id === activeId)?.projectId;
    return (
      <PageSidebar folded label={t`Chats`}>
        <RailExpand
          label={t`Expand the chats`}
          onExpand={() => {
            setFolded(false);
          }}
        />
        <RailButton
          label={t`New chat`}
          render={
            <Link
              onClick={() => {
                setActiveChat(undefined);
              }}
              search={{}}
              to="/"
            />
          }
        >
          <PlusIcon />
        </RailButton>
        {projects.length === 0 ? null : <RailDivider />}
        {projects.map((project) => (
          <RailButton
            active={project.id === activeProject}
            key={project.id}
            label={project.name}
            onClick={() => {
              setFolded(false);
            }}
          >
            <FolderIcon />
          </RailButton>
        ))}
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
        projects={projects}
      />
    </PageSidebar>
  );
};
