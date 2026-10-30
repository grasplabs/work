import type {
  ChatProject,
  ChatSearchHit,
  ChatSummary,
} from "@grasp-os/shared/chat";
import { chatPlatformName } from "@grasp-os/shared/chat";
import { hasEvery } from "@grasp-os/shared/chat-search";
import { failureText } from "@grasp-os/shared/errors";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@grasp-os/ui/components/command";
import { Kbd } from "@grasp-os/ui/components/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { cn } from "@grasp-os/ui/lib/utils";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  FolderIcon,
  FolderPlusIcon,
  MessagesSquareIcon,
  PlusIcon,
} from "lucide-react";
import {
  createContext,
  use,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

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
import { DeleteChatDialog } from "./delete-chat-dialog.tsx";
import { ProjectDialog } from "./project-dialog.tsx";

// The person's chats and projects in one window, one quiet icon and ⌘K
// away, in place of a list beside the chat (grasplabs/prototype
// `components/chat/chat-switcher.tsx`). The window is the frame's, on
// every page (`ChatSwitcherProvider`, mounted in the shell): ⌘K opens it
// anywhere, and a page's header may show the icon that does too
// (`ChatSwitcherButton`). It reads the chats and projects as it opens, and
// again after a change made in it. On the left, a new chat, all chats and
// each project with how many chats it holds, and a new project at its
// foot (on a phone, one row that scrolls sideways); on the right, the
// chats of what is chosen there by when they were last used, each with
// when that was and, in all chats, its project. A search on top narrows
// them to the chats with every word in their title, their project's name
// or what was said in them: by title at once, then by what was said as
// core finds it (`chats.search`, in the project chosen), a chat found that
// way showing where. The keys move through the chats and Enter opens one;
// a row's three dots, where it is pointed at, rename it, move it or
// delete it.

const periodLabel: Record<ChatPeriod, MessageDescriptor> = {
  today: msg({ message: "Today", context: "chats from today" }),
  week: msg({ message: "Last 7 days", context: "chats from the past week" }),
  earlier: msg({ message: "Earlier", context: "older chats" }),
};

/** How long typing rests before core is asked what was said. */
const searchRestMs = 200;

const applePlatform = /mac|iphone|ipad/iu;

/** ⌘K on a Mac, Ctrl K elsewhere. */
const shortcutLabel = (): string =>
  typeof navigator !== "undefined" && applePlatform.test(navigator.userAgent)
    ? "⌘K"
    : "Ctrl K";

/** Whether `event` is ⌘K or Ctrl K, and nothing else held. */
const isShortcut = (event: KeyboardEvent): boolean =>
  (event.metaKey || event.ctrlKey) &&
  !event.altKey &&
  !event.shiftKey &&
  event.key.toLowerCase() === "k";

/** A quiet icon in the page's header, named by its tooltip. */
export const HeaderIcon = ({
  label,
  shortcut,
  render,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  /** What it is, when it is a link rather than a button. */
  render?: React.ReactElement;
  onClick?: () => void;
  children: ReactNode;
}) => (
  <Tooltip>
    <TooltipTrigger
      render={
        render ?? (
          <Button
            aria-label={label}
            onClick={onClick}
            size="icon-sm"
            variant="ghost"
          />
        )
      }
    >
      {children}
    </TooltipTrigger>
    <TooltipContent>
      {label}
      {shortcut === undefined ? null : <Kbd>{shortcut}</Kbd>}
    </TooltipContent>
  </Tooltip>
);

/** All chats or one project, in the column on the left, lit while it shows. */
const Scope = ({
  label,
  count,
  chosen,
  onChoose,
  icon,
}: {
  label: string;
  count: number;
  chosen: boolean;
  onChoose: () => void;
  icon: ReactNode;
}) => (
  <button
    aria-pressed={chosen}
    className={cn(
      "focus-visible:ring-ring/50 [&_svg]:text-muted-foreground flex flex-none items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors duration-150 outline-none focus-visible:ring-3 [&_svg]:size-4 [&_svg]:flex-none",
      chosen
        ? "bg-background ring-foreground/10 font-medium shadow-xs ring-1"
        : "text-muted-foreground hover:bg-background/60 hover:text-foreground"
    )}
    onClick={onChoose}
    type="button"
  >
    {icon}
    <span className="min-w-0 flex-1 truncate">{label}</span>
    <span className="text-muted-foreground text-xs tabular-nums">{count}</span>
  </button>
);

/** The chat platform a chat came through, before its time. */
const ChannelName = ({ via }: { via: string }) => {
  const { t } = useLingui();
  const app = chatPlatformName(via);
  return <>{t`via ${app}`} · </>;
};

/**
 * One chat: its title, and on the right when it was last used, with its
 * project where all chats show; found by what was said in it, where it
 * was said under the title. Its three dots take the time's place where
 * it is pointed at.
 */
const ChatRow = ({
  chat,
  hit,
  active,
  projects,
  projectName,
  now,
  onOpen,
  onChanged,
  onNewProject,
  onDelete,
}: {
  chat: ChatSummary;
  hit: ChatSearchHit | undefined;
  active: boolean;
  projects: readonly ChatProject[];
  projectName: string | undefined;
  now: Date;
  onOpen: () => void;
  /** It was renamed or moved: the window reads the chats again. */
  onChanged: () => void;
  onNewProject: () => void;
  onDelete: () => void;
}) => {
  const { t, i18n } = useLingui();
  const [renaming, setRenaming] = useState(false);
  const { failure, rename, move } = useChatChanges(chat);
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
              {projectName === undefined ? null : `${projectName} · `}
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
        onMove={(projectId) => {
          void (async () => {
            await move(projectId);
            onChanged();
          })();
        }}
        onNewProject={onNewProject}
        onRename={() => {
          setRenaming(true);
        }}
        projects={projects}
      />
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

/**
 * What core found for a search: the query it was asked, in which project
 * (none for all chats), and the chats.
 */
interface Found {
  query: string;
  projectId: string | undefined;
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
  const search = (text: string, projectId: string | undefined): void => {
    const query = text.trim();
    const asked = `${projectId ?? ""}\n${query}`;
    latest.current = asked;
    window.clearTimeout(timer.current);
    setFailure(undefined);
    if (query === "") {
      return;
    }
    timer.current = window.setTimeout(() => {
      void (async () => {
        try {
          const hits = await core.withSession(
            async (session) =>
              await session.chats.search(query, projectId ?? null)
          );
          if (latest.current === asked) {
            setFound({ query, projectId, hits });
          }
        } catch (error) {
          if (latest.current === asked) {
            setFailure(failureText(error));
          }
        }
      })();
    }, searchRestMs);
  };
  return { found, failure, search };
};

/** The person's chats and projects, read as the window opens. */
interface Listed {
  chats: ChatSummary[];
  projects: ChatProject[];
}

/** Reads the person's chats and projects from core, again on each `read`. */
const useListed = () => {
  const core = useCore();
  const [listed, setListed] = useState<Listed>();
  const [failure, setFailure] = useState<string>();
  const read = (): void => {
    void (async () => {
      try {
        const [chats, projects] = await core.withSession(
          async (session) =>
            await Promise.all([session.chats.list(), session.chats.projects()])
        );
        setListed({ chats, projects });
        setFailure(undefined);
      } catch (error) {
        setFailure(failureText(error));
      }
    })();
  };
  return { listed, failure, read };
};

/** A new project, for the chat that asked for it (moved into it) or none. */
const NewProject = ({
  open,
  chatId,
  onDone,
}: {
  open: boolean;
  chatId: string | undefined;
  onDone: (projectId?: string) => void;
}) => {
  const core = useCore();
  const router = useRouter();
  const [failure, setFailure] = useState<string>();
  return (
    <>
      <ProjectDialog
        onOpenChange={(next) => {
          if (!next) {
            onDone();
          }
        }}
        onSaved={(projectId) => {
          if (chatId === undefined) {
            onDone(projectId);
            return;
          }
          void (async () => {
            try {
              await core.withSession(async (session) => {
                await session.chats.moveChat(chatId, projectId);
              });
              await router.invalidate();
            } catch (error) {
              setFailure(failureText(error));
            }
            onDone(projectId);
          })();
        }}
        open={open}
      />
      <ErrorText>{failure}</ErrorText>
    </>
  );
};

/** Opens (or closes) the frame's chats window. */
const OpenChats = createContext<(open: boolean) => void>(() => {
  // Outside the frame there is no window to open.
});

/**
 * The chats the window lists: those of all chats or of `project`, and
 * with a search, those whose title or project holds every word until
 * core has answered it; then what core `found`, each chat as `chats`
 * has it, so a rename or a move made since shows.
 */
const shownChats = ({
  chats,
  projects,
  project,
  query,
  found,
}: {
  chats: readonly ChatSummary[];
  projects: readonly ChatProject[];
  project: ChatProject | undefined;
  query: string;
  found: Found | undefined;
}): ChatSummary[] => {
  const inScope = (chat: ChatSummary): boolean =>
    project === undefined || chat.projectId === project.id;
  if (query === "") {
    return chats.filter(inScope);
  }
  if (found === undefined) {
    return chats
      .filter(inScope)
      .filter((chat) =>
        hasEvery(
          query,
          chat.title,
          projects.find(({ id }) => id === chat.projectId)?.name ?? ""
        )
      );
  }
  const byId = new Map(chats.map((chat) => [chat.id, chat]));
  return found.hits
    .flatMap(({ chat }) => byId.get(chat.id) ?? [])
    .filter(inScope);
};

/**
 * The column on the left: a new chat (in the project chosen), all chats,
 * each project with how many chats it holds, and a new project.
 */
const ScopeColumn = ({
  chats,
  projects,
  project,
  onChoose,
  onNewChat,
  onNewProject,
}: {
  chats: readonly ChatSummary[];
  projects: readonly ChatProject[];
  project: ChatProject | undefined;
  onChoose: (projectId?: string) => void;
  onNewChat: () => void;
  onNewProject: () => void;
}) => {
  const { t } = useLingui();
  const projectName = project?.name;
  const projectsLabel = t`Projects`;
  return (
    <nav
      aria-label={projectsLabel}
      className="bg-muted/40 flex flex-none gap-1 overflow-x-auto border-b p-2 md:w-56 md:flex-col md:overflow-x-visible md:overflow-y-auto md:border-r md:border-b-0 md:p-3"
    >
      <Button
        className="flex-none md:mb-3 md:justify-start"
        onClick={onNewChat}
        size="sm"
        variant="outline"
      >
        <PlusIcon data-icon="inline-start" />
        {projectName === undefined ? (
          <Trans>New chat</Trans>
        ) : (
          <Trans>New chat in {projectName}</Trans>
        )}
      </Button>
      <Scope
        chosen={project === undefined}
        count={chats.length}
        icon={<MessagesSquareIcon />}
        label={t`All chats`}
        onChoose={() => {
          onChoose();
        }}
      />
      <span className="text-muted-foreground hidden px-2 pt-3 pb-1 text-xs md:block">
        {projectsLabel}
      </span>
      {projects.map((each) => (
        <Scope
          chosen={each.id === project?.id}
          count={chats.filter(({ projectId }) => projectId === each.id).length}
          icon={<FolderIcon />}
          key={each.id}
          label={each.name}
          onChoose={() => {
            onChoose(each.id);
          }}
        />
      ))}
      <Button
        className="flex-none md:mt-auto md:justify-start"
        onClick={onNewProject}
        size="sm"
        variant="ghost"
      >
        <FolderPlusIcon data-icon="inline-start" />
        <Trans>New project</Trans>
      </Button>
    </nav>
  );
};

/** The window and what it shows, while it is open. */
const ChatWindow = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const { t, i18n } = useLingui();
  const navigate = useNavigate();
  const activeId = useActiveChat();
  const [search, setSearch] = useState("");
  // All chats (`undefined`), or one project's, by its ID.
  const [scope, setScope] = useState<string>();
  // A new project, and the chat that asked for it, if one did.
  const [creating, setCreating] = useState<{ chatId?: string }>();
  const [deleting, setDeleting] = useState<ChatSummary>();
  const said = useSaidSearch();
  const listing = useListed();
  const [readOnOpen, setReadOnOpen] = useState(false);
  // Read again each time it opens, so it shows what changed elsewhere.
  if (open !== readOnOpen) {
    setReadOnOpen(open);
    if (open) {
      setSearch("");
      setScope(undefined);
    }
  }
  const read = useEffectEvent(() => {
    listing.read();
  });
  useEffect(() => {
    if (open) {
      read();
    }
  }, [open]);

  const chats = listing.listed?.chats ?? [];
  const projects = listing.listed?.projects ?? [];
  const project = projects.find(({ id }) => id === scope);
  const nameOf = (chat: ChatSummary): string | undefined =>
    projects.find(({ id }) => id === chat.projectId)?.name;
  const query = search.trim();
  const searching = query !== "";
  const answered =
    said.found?.query === query && said.found.projectId === project?.id
      ? said.found
      : undefined;
  const hits = new Map((answered?.hits ?? []).map((hit) => [hit.chat.id, hit]));
  const now = new Date();
  const groups = groupChats(
    shownChats({ chats, projects, project, query, found: answered }),
    now
  );
  const choose = (projectId?: string): void => {
    setScope(projectId);
    said.search(search, projectId);
  };
  const openChat = (chatId: string): void => {
    onOpenChange(false);
    void navigate({ to: "/", search: { chat: chatId } });
  };
  const newChat = (): void => {
    onOpenChange(false);
    setActiveChat(undefined);
    void navigate({
      to: "/",
      search: project === undefined ? {} : { project: project.id },
    });
  };
  return (
    <>
      <CommandDialog
        className="top-1/8 sm:max-w-3xl"
        description={t`Search your chats and projects, and open one.`}
        onOpenChange={onOpenChange}
        open={open}
        title={t`Chats`}
      >
        <Command
          flush
          // cmdk names its search by a label of its own: this one.
          label={t`Search chats and projects`}
          loop
          shouldFilter={false}
        >
          <CommandInput
            aria-label={t`Search chats and projects`}
            onValueChange={(value) => {
              setSearch(value);
              said.search(value, scope);
            }}
            placeholder={t`Search chats and projects`}
            size="lg"
            value={search}
          />
          <div className="flex h-112 min-h-0 flex-col md:flex-row">
            <ScopeColumn
              chats={chats}
              onChoose={choose}
              onNewChat={newChat}
              onNewProject={() => {
                setCreating({});
              }}
              project={project}
              projects={projects}
            />
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {project === undefined ? null : (
                <div className="flex items-center gap-2 border-b py-2 pr-2 pl-5">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {project.name}
                  </span>
                  <Link
                    className={buttonVariants({ size: "sm", variant: "ghost" })}
                    onClick={() => {
                      onOpenChange(false);
                    }}
                    params={{ projectId: project.id }}
                    to="/projects/$projectId"
                  >
                    <Trans>Instructions and files</Trans>
                    <ArrowRightIcon data-icon="inline-end" />
                  </Link>
                </div>
              )}
              <ErrorText>{listing.failure ?? said.failure}</ErrorText>
              <CommandList fill>
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
                        onNewProject={() => {
                          setCreating({ chatId: chat.id });
                        }}
                        onOpen={() => {
                          openChat(chat.id);
                        }}
                        projectName={
                          project === undefined ? nameOf(chat) : undefined
                        }
                        projects={projects}
                      />
                    ))}
                  </CommandGroup>
                ))}
              </CommandList>
            </div>
          </div>
        </Command>
      </CommandDialog>
      <NewProject
        chatId={creating?.chatId}
        onDone={(projectId) => {
          setCreating(undefined);
          listing.read();
          if (projectId !== undefined) {
            choose(projectId);
          }
        }}
        open={creating !== undefined}
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

/**
 * The frame's chats window, on every page: ⌘K or Ctrl K opens it (and
 * closes it again), as does a page's {@link ChatSwitcherButton}.
 */
export const ChatSwitcherProvider = ({ children }: { children: ReactNode }) => {
  const [open, setOpen] = useState(false);
  const toggle = useEffectEvent(() => {
    setOpen(!open);
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!isShortcut(event)) {
        return;
      }
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  return (
    <OpenChats value={setOpen}>
      {children}
      <ChatWindow onOpenChange={setOpen} open={open} />
    </OpenChats>
  );
};

/** The quiet icon in a page's header that opens the chats window. */
export const ChatSwitcherButton = () => {
  const { t } = useLingui();
  const setOpen = use(OpenChats);
  return (
    <HeaderIcon
      label={t`Chats`}
      onClick={() => {
        setOpen(true);
      }}
      shortcut={shortcutLabel()}
    >
      <MessagesSquareIcon />
    </HeaderIcon>
  );
};
