import type { ChatProject, ChatSummary } from "@grasp-os/shared/chat";
import {
  projectDocumentMaxBytes,
  projectDocumentMaxKb,
  projectDocumentsMax,
  projectGoalMaxLength,
  projectGoalSchema,
} from "@grasp-os/shared/chat";
import type { ModelEfforts } from "@grasp-os/shared/models";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { FieldError } from "@grasp-os/ui/components/field";
import { Progress } from "@grasp-os/ui/components/progress";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import {
  EllipsisIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderIcon,
  PencilIcon,
  PlusIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useRef, useState } from "react";

import {
  ChatMenu,
  chatTitleMaxLength,
  DeleteProjectDialog,
  RenameField,
  useChatChanges,
  useRenameFocus,
} from "../chat/chat-menus.tsx";
import { documentAccept, documentProblem } from "../chat/chat-projects.ts";
import type { DocumentProblem } from "../chat/chat-projects.ts";
import { ChatSwitcherButton } from "../chat/chat-switcher.tsx";
import { Composer } from "../chat/composer.tsx";
import { DeleteChatDialog } from "../chat/delete-chat-dialog.tsx";
import { ProjectDialog } from "../chat/project-dialog.tsx";
import { useAsk } from "../chat/use-ask.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDaysAgo } from "../format.ts";
import { PageLoading, PageNotLoaded } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";

// One project's page under Chat (grasplabs/prototype
// `routes/projects/$projectId.tsx`): its name and goal, a box that starts a
// chat in it, and its chats under that; beside them what Grasp reads in
// every one of them, its instructions (the project's goal) and its
// documents, each changed in place, with how much of the project's room
// the documents take. Its crumbs say Chat, and Chat stays lit in the
// sidebar; the corner chat keeps off it, as the box here starts the
// project's chats (chat/chat-dock.tsx).

interface ProjectPage {
  chats: ChatSummary[];
  projects: ChatProject[];
  models: string[];
  efforts: Record<string, ModelEfforts>;
}

/** All a project's documents may hold together, in bytes: its room. */
const projectRoomBytes = projectDocumentsMax * projectDocumentMaxBytes;

/**
 * The files of `files` a project holding `count` documents can take, in
 * the order picked, and why the first one it can't take isn't added.
 */
const takenFiles = (
  files: readonly File[],
  count: number
): { taken: File[]; first: DocumentProblem | undefined } => {
  const taken: File[] = [];
  let first: DocumentProblem | undefined;
  for (const file of files) {
    const reason = documentProblem(file, count + taken.length);
    if (reason === null) {
      taken.push(file);
    } else {
      first ??= reason;
    }
  }
  return { taken, first };
};

/** Why a picked file wasn't added, as the person reads it. */
const useProblemText = (): Record<DocumentProblem | "unreadable", string> => {
  const { t } = useLingui();
  const most = projectDocumentsMax;
  const maxKb = projectDocumentMaxKb;
  return {
    type: t`A project takes Markdown, text, CSV and JSON files.`,
    size: t`Each document holds up to ${maxKb} KB.`,
    unreadable: t`A picked file couldn't be read. Pick it again.`,
    count: t`${plural(most, {
      one: "A project holds up to # document.",
      other: "A project holds up to # documents.",
    })}`,
  };
};

/** The project's instructions, changed in a dialog of its own. */
const InstructionsForm = ({
  project,
  onSaved,
}: {
  project: ChatProject;
  onSaved: () => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [text, setText] = useState(project.goal);
  const { name } = project;
  const save = async (): Promise<void> => {
    const parsed = projectGoalSchema.safeParse(text);
    if (!parsed.success) {
      return;
    }
    const saved = await run(async (session) => {
      await session.chats.setProjectGoal(project.id, parsed.data);
      return true;
    });
    if (saved === true) {
      await router.invalidate();
      onSaved();
    }
  };
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <DialogHeader>
        <DialogTitle>
          <Trans>Instructions for {name}</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>Grasp reads these in every chat of the project.</Trans>
        </DialogDescription>
      </DialogHeader>
      <Textarea
        aria-label={t`Instructions`}
        maxLength={projectGoalMaxLength}
        onChange={(event) => {
          setText(event.target.value);
        }}
        placeholder={t`What are you trying to achieve, and how should Grasp answer?`}
        rows={8}
        value={text}
      />
      <ErrorText>{failure}</ErrorText>
      <DialogFooter>
        <DialogClose
          disabled={busy}
          render={<Button type="button" variant="outline" />}
        >
          <Trans>Cancel</Trans>
        </DialogClose>
        <Button disabled={busy} type="submit">
          <Trans>Save instructions</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
};

/** What Grasp is told in every chat of the project: its goal. */
const Instructions = ({ project }: { project: ChatProject }) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const has = project.goal.trim() !== "";
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <Trans>Instructions</Trans>
        </CardTitle>
        <CardAction>
          <Button
            aria-label={has ? t`Edit the instructions` : t`Set instructions`}
            onClick={() => {
              setOpen(true);
            }}
            size="icon-sm"
            title={has ? t`Edit the instructions` : t`Set instructions`}
            variant="ghost"
          >
            {has ? <PencilIcon /> : <PlusIcon />}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {has ? (
          <p className="line-clamp-6 text-sm whitespace-pre-line">
            {project.goal}
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">
            <Trans>
              What the project is for, and how Grasp should answer in it.
            </Trans>
          </p>
        )}
      </CardContent>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          {open ? (
            <InstructionsForm
              onSaved={() => {
                setOpen(false);
              }}
              project={project}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
};

/**
 * The documents Grasp reads in every chat of the project, how much of its
 * room they take, and adding or removing one in place.
 */
const Files = ({ project }: { project: ChatProject }) => {
  const { t } = useLingui();
  const router = useRouter();
  const picker = useRef<HTMLInputElement>(null);
  const { busy, failure, run } = useCoreAction();
  const [problem, setProblem] = useState<DocumentProblem | "unreadable">();
  const problemText = useProblemText();
  let used = 0;
  for (const { bytes } of project.documents) {
    used += bytes;
  }
  const percent = Math.min(100, Math.round((used / projectRoomBytes) * 100));
  const add = async (files: readonly File[]): Promise<void> => {
    const { taken, first } = takenFiles(files, project.documents.length);
    setProblem(first);
    let read: { name: string; content: string }[];
    try {
      read = await Promise.all(
        taken.map(async (file) => ({
          name: file.name,
          content: await file.text(),
        }))
      );
    } catch {
      setProblem("unreadable");
      return;
    }
    await run(async (session) => {
      for (const document of read) {
        // oxlint-disable-next-line no-await-in-loop -- in order, so a failure leaves the rest unsent
        await session.chats.addProjectDocument(project.id, document);
      }
    });
    // Whatever went through shows, a refusal included.
    await router.invalidate();
  };
  const remove = async (documentId: string): Promise<void> => {
    setProblem(undefined);
    await run(async (session) => {
      await session.chats.removeProjectDocument(project.id, documentId);
    });
    await router.invalidate();
  };
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <Trans>Files</Trans>
        </CardTitle>
        <CardAction>
          <Button
            aria-label={t`Add documents`}
            disabled={busy}
            onClick={() => {
              picker.current?.click();
            }}
            size="icon-sm"
            title={t`Add documents`}
            variant="ghost"
          >
            <FilePlusIcon />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          <input
            accept={documentAccept}
            aria-label={t`Add documents`}
            className="sr-only"
            disabled={busy}
            multiple
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              // Empty again, so the same file can be chosen once more.
              event.target.value = "";
              void add(files);
            }}
            ref={picker}
            tabIndex={-1}
            type="file"
          />
          {project.documents.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              <Trans>
                Documents Grasp reads in every chat of this project. Markdown,
                text, CSV or JSON, up to {projectDocumentMaxKb} KB each.
              </Trans>
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <Progress aria-label={t`Room used`} value={percent} />
                <span className="text-muted-foreground text-xs">
                  <Trans>{percent}% of the project’s room used</Trans>
                </span>
              </div>
              <ul
                aria-label={t`Documents in this project`}
                className="flex flex-col gap-1"
              >
                {project.documents.map((document) => {
                  const documentName = document.name;
                  return (
                    <li
                      className="flex items-center gap-2.5 rounded-md border py-1.5 pr-1.5 pl-2.5"
                      key={document.id}
                    >
                      <FileTextIcon
                        aria-hidden="true"
                        className="text-muted-foreground size-4 flex-none"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {documentName}
                      </span>
                      <Button
                        aria-label={t`Remove ${documentName}`}
                        disabled={busy}
                        onClick={() => {
                          void remove(document.id);
                        }}
                        size="icon-xs"
                        variant="ghost"
                      >
                        <XIcon />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {problem === undefined ? null : (
            <FieldError>{problemText[problem]}</FieldError>
          )}
          <ErrorText>{failure}</ErrorText>
        </div>
      </CardContent>
    </Card>
  );
};

/**
 * A chat of the project: its title and when it was last used, opening it
 * in Chat; its three dots as everywhere.
 */
const ProjectChat = ({
  chat,
  projects,
  onNewProject,
  onDelete,
}: {
  chat: ChatSummary;
  projects: readonly ChatProject[];
  onNewProject: () => void;
  onDelete: () => void;
}) => {
  const { t, i18n } = useLingui();
  // As the prototype says it: "Updated yesterday", "Updated 4 days ago".
  const when = formatDaysAgo(chat.lastAt, new Date(), i18n.locale);
  const [renaming, setRenaming] = useState(false);
  const { row, ended } = useRenameFocus<HTMLAnchorElement>(renaming);
  const { failure, rename, move } = useChatChanges(chat);
  if (renaming) {
    return (
      <li className="px-3 py-2">
        <RenameField
          label={t`Chat name`}
          maxLength={chatTitleMaxLength}
          onDone={(name, byKey) => {
            ended(byKey);
            setRenaming(false);
            void rename(name);
          }}
          value={chat.title}
        />
      </li>
    );
  }
  return (
    <li className="group/row relative">
      <Link
        className="hover:bg-muted/50 focus-visible:ring-ring/50 flex w-full flex-col gap-0.5 py-3 pr-12 pl-4 text-left transition-colors duration-150 outline-none focus-visible:ring-3 focus-visible:ring-inset"
        ref={row}
        search={{ chat: chat.id }}
        to="/"
      >
        <span className="truncate text-sm font-medium">{chat.title}</span>
        <span className="text-muted-foreground text-xs">
          <Trans>Updated {when}</Trans>
        </span>
      </Link>
      <ChatMenu
        chat={chat}
        onDelete={onDelete}
        onMove={(projectId) => {
          void move(projectId);
        }}
        onNewProject={onNewProject}
        onRename={() => {
          setRenaming(true);
        }}
        projects={projects}
      />
      <ErrorText>{failure}</ErrorText>
    </li>
  );
};

/** The box that starts a chat in the project, which opens in Chat. */
const ProjectBox = ({
  project,
  models,
  efforts,
}: {
  project: ChatProject;
  models: string[];
  efforts: Record<string, ModelEfforts>;
}) => {
  const { t } = useLingui();
  const { composer } = useAsk(undefined, models, efforts, "page", project.id);
  const { name } = project;
  return (
    <Composer
      {...composer}
      label={t`Start a chat in ${name}`}
      placeholder={t`Start a chat in ${name}`}
      running={false}
    />
  );
};

const Project = () => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const router = useRouter();
  const { projectId } = Route.useParams();
  const page = Route.useLoaderData();
  const [editing, setEditing] = useState(false);
  const [deletingProject, setDeletingProject] = useState(false);
  const [deletingChat, setDeletingChat] = useState<ChatSummary>();
  // A chat whose three dots asked for a new project to go into.
  const [newFor, setNewFor] = useState<string>();
  const { failure, run } = useCoreAction();
  if (page.state !== "ready") {
    return (
      <PageNotLoaded
        crumbs={[{ label: t`Chat`, to: "/" }, { label: t`Project` }]}
        icon={FolderIcon}
        page={page}
      />
    );
  }
  const { chats, projects, models, efforts } = page.data;
  const project = projects.find(({ id }) => id === projectId);
  if (project === undefined) {
    return (
      <PageNotLoaded
        crumbs={[{ label: t`Chat`, to: "/" }, { label: t`Project` }]}
        icon={FolderIcon}
        notFound={t`This project isn't here any more.`}
        page={{ state: "missing" }}
      />
    );
  }
  const inside = chats
    .filter((chat) => chat.projectId === project.id)
    .toSorted((a, b) => b.lastAt.localeCompare(a.lastAt));
  const { name, goal } = project;
  return (
    <>
      <SiteHeader
        actions={<ChatSwitcherButton />}
        crumbs={[{ label: t`Chat`, to: "/" }, { label: name }]}
      />
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-4 text-sm md:p-6 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-6">
          <div className="flex items-start gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <h1 className="text-2xl font-medium tracking-tight">{name}</h1>
              {goal === "" ? null : (
                <p className="text-muted-foreground line-clamp-2 text-pretty">
                  {goal}
                </p>
              )}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={t`More for the project ${name}`}
                render={<Button size="icon-sm" variant="ghost" />}
              >
                <EllipsisIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem
                  onClick={() => {
                    setEditing(true);
                  }}
                >
                  <SlidersHorizontalIcon />
                  <Trans>Edit project</Trans>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => {
                    setDeletingProject(true);
                  }}
                  variant="destructive"
                >
                  <Trash2Icon />
                  <Trans>Delete project</Trans>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <ProjectBox efforts={efforts} models={models} project={project} />
          <section
            aria-labelledby="project-chats"
            className="flex flex-col gap-1"
          >
            <h2 className="pb-1 font-medium" id="project-chats">
              <Trans>Chats</Trans>
            </h2>
            {inside.length === 0 ? (
              <p className="text-muted-foreground rounded-xl border border-dashed px-4 py-6 text-center">
                <Trans>
                  No chats yet. What is asked above starts one, and it stays in
                  this project.
                </Trans>
              </p>
            ) : (
              <ul className="flex flex-col divide-y rounded-xl border">
                {inside.map((chat) => (
                  <ProjectChat
                    chat={chat}
                    key={chat.id}
                    onDelete={() => {
                      setDeletingChat(chat);
                    }}
                    onNewProject={() => {
                      setNewFor(chat.id);
                    }}
                    projects={projects}
                  />
                ))}
              </ul>
            )}
            <ErrorText>{failure}</ErrorText>
          </section>
        </div>
        <aside
          aria-label={t`What Grasp reads in this project`}
          className="flex flex-col gap-4 lg:sticky lg:top-20 lg:w-80 lg:flex-none"
        >
          <Instructions project={project} />
          <Files project={project} />
        </aside>
      </div>
      <ProjectDialog
        onOpenChange={setEditing}
        open={editing}
        project={project}
      />
      <ProjectDialog
        onOpenChange={(open) => {
          if (!open) {
            setNewFor(undefined);
          }
        }}
        onSaved={(created) => {
          const chatId = newFor;
          if (chatId === undefined) {
            return;
          }
          void (async () => {
            await run(async (session) => {
              await session.chats.moveChat(chatId, created);
            });
            await router.invalidate();
          })();
        }}
        open={newFor !== undefined}
      />
      <DeleteProjectDialog
        onDeleted={async () => {
          await navigate({ to: "/", search: {} });
        }}
        onOpenChange={setDeletingProject}
        open={deletingProject}
        project={project}
      />
      {deletingChat === undefined ? null : (
        <DeleteChatDialog
          active={false}
          chat={deletingChat}
          onOpenChange={(open) => {
            if (!open) {
              setDeletingChat(undefined);
            }
          }}
          open
        />
      )}
    </>
  );
};

export const Route = createFileRoute("/_shell/projects/$projectId")({
  pendingComponent: PageLoading,
  component: Project,
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, async (session): Promise<ProjectPage> => {
      const [chats, projects, models, efforts] = await Promise.all([
        session.chats.list(),
        session.chats.projects(),
        session.chats.models(),
        session.chats.efforts(),
      ]);
      return { chats, projects, models, efforts };
    }),
});
