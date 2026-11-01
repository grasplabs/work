import type { ChatProject, ChatSummary } from "@grasp-os/shared/chat";
import type { ModelEfforts } from "@grasp-os/shared/models";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import { Sheet, SheetContent, SheetTitle } from "@grasp-os/ui/components/sheet";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { PanelRightIcon, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { GraspBuddy } from "../buddy/grasp-buddy.tsx";
import { activeChat, setActiveChat } from "../chat/active-chat.ts";
import { AskOrCompose } from "../chat/asked-questions.tsx";
import { BuildsFailure, draftsOf, useChatBuilds } from "../chat/builds.tsx";
import { ChatMore } from "../chat/chat-more.tsx";
import { ChatSwitcherButton, HeaderIcon } from "../chat/chat-switcher.tsx";
import { useFollowedChat } from "../chat/chat-watch.ts";
import { ComposerNote } from "../chat/composer-note.tsx";
import { Composer } from "../chat/composer.tsx";
import { ConnectionRequests } from "../chat/connection-requests.tsx";
import { HeldWrites } from "../chat/held-writes.tsx";
import { ProjectShelf } from "../chat/project-shelf.tsx";
import { SidePanel } from "../chat/side-panel.tsx";
import { ChatSources } from "../chat/sources.tsx";
import type { SourceName } from "../chat/sources.tsx";
import { ChatStudio } from "../chat/studio.tsx";
import { StartingQuestions } from "../chat/suggestions.tsx";
import { ChatThread } from "../chat/thread.tsx";
import { useAsk } from "../chat/use-ask.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { PageNotLoaded, PageLoading } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { useWide } from "../frame/wide.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { usePageSidePanel } from "../screens/app-panel-context.tsx";
import { TourOffer } from "../tour/tour-layer.tsx";
import { useTour } from "../tour/tour-state.ts";

// Chat with the organization's agent, in the prototype's layout
// (grasplabs/prototype `routes/index.tsx`): the open chat has the page's
// whole width, its answers streaming in as the agent writes them, the
// changes it holds for the person to confirm, and a side panel with the
// versions it built up for review. The person's other chats and their
// projects are one ⌘K window away (chat/chat-switcher.tsx), behind the
// first of the quiet icons top right; the others start a new chat and
// hold what can be done with this one. A new chat starts on Grasp's buddy
// and the question "What should we look at today?", centred in the middle
// of the page, with questions to start from and the person's projects as
// quiet rows under the box (the first time, Stephen's offer of his tour
// stands in the question's place, tour/tour-layer.tsx); once its agent
// writes a draft of an App, the
// chat moves left and the App's preview stands on the right
// (chat/studio.tsx).

interface ChatPage {
  chats: ChatSummary[];
  /** The open chat, when it is past the end of `chats`. */
  beyond?: ChatSummary;
  /** The person's projects, newest first. */
  projects: ChatProject[];
  /** The models a question may name, the default first. */
  models: string[];
  /** The efforts each of them takes (`chats.efforts()`). */
  efforts: Record<string, ModelEfforts>;
  /** The collections' and connections' names, by ID, for provenance. */
  sourceNames: ReadonlyMap<string, SourceName>;
  /** The organization's name, when it has one and core could say it. */
  organizationName: string | undefined;
}

/** The organization's name; none when it has none or core couldn't say. */
const readOrganizationName = async (
  session: Session
): Promise<string | undefined> => {
  const [organization] = await Promise.allSettled([session.organization.get()]);
  const name =
    organization.status === "fulfilled" ? organization.value.name.trim() : "";
  return name === "" ? undefined : name;
};

/**
 * The names of the collections and connections the person can see, by
 * ID: a list refused only leaves those IDs unnamed.
 */
const readSourceNames = async (
  session: Session
): Promise<ReadonlyMap<string, SourceName>> => {
  const [collections, connections] = await Promise.allSettled([
    session.knowledge.listCollections(),
    session.connections.list(),
  ]);
  const names = new Map<string, SourceName>();
  if (collections.status === "fulfilled") {
    for (const { id, name } of collections.value) {
      names.set(id, { name, kind: "collection" });
    }
  }
  if (connections.status === "fulfilled") {
    for (const { id, provider, accountName } of connections.value) {
      names.set(id, {
        name: accountName === null ? provider : `${provider} (${accountName})`,
        kind: "connection",
      });
    }
  }
  return names;
};

/**
 * A new chat: Grasp's buddy, the question, and the box to ask in, with
 * questions to start from and the person's projects under it; started
 * from a project, it is made in that project.
 */
const NewChat = ({
  models,
  efforts,
  project,
  chats,
  projects,
}: {
  models: string[];
  efforts: Record<string, ModelEfforts>;
  project: ChatProject | undefined;
  chats: readonly ChatSummary[];
  projects: readonly ChatProject[];
}) => {
  const { composer, ask } = useAsk(
    undefined,
    models,
    efforts,
    "page",
    project?.id
  );
  const projectName = project?.name;
  const { identity } = Route.useRouteContext();
  // Offered the tour, his question stands in the greeting's place, and
  // nothing to start from under the box until it is answered.
  const offered = useTour().phase === "invited";
  // Where focus goes once the offer is turned down: the box to ask in.
  const page = useRef<HTMLDivElement>(null);
  return (
    <section
      aria-labelledby="new-chat"
      className="flex min-w-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="flex min-h-full items-center justify-center px-6 py-12">
        <div className="flex w-full max-w-3xl flex-col gap-8 pb-10" ref={page}>
          <div className="flex flex-col items-center gap-6 text-center">
            <GraspBuddy />
            {offered ? (
              <TourOffer
                headingId="new-chat"
                onDeclined={() => {
                  page.current?.querySelector("textarea")?.focus();
                }}
                userId={identity.userId}
              />
            ) : (
              <h1 className="type-display" id="new-chat">
                <Trans>What should we look at today?</Trans>
              </h1>
            )}
          </div>
          {projectName === undefined ? null : (
            <p className="text-muted-foreground text-center">
              <Trans>New chat in the project {projectName}</Trans>
            </p>
          )}
          <Composer running={false} {...composer} />
          {project === undefined && !offered ? (
            <div className="flex flex-col gap-6">
              <StartingQuestions
                disabled={composer.busy || models.length === 0}
                onPick={(question) => {
                  void ask(question);
                }}
              />
              <ProjectShelf chats={chats} projects={projects} />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
};

/** The page's crumbs: Chat, the open chat's project if it is in one, the chat. */
const crumbsOf = (
  chatLabel: string,
  chat: ChatSummary | undefined,
  projects: readonly ChatProject[]
) => {
  if (chat === undefined) {
    return [{ label: chatLabel }];
  }
  const project = projects.find(({ id }) => id === chat.projectId);
  return [
    { label: chatLabel, to: "/" as const },
    ...(project === undefined
      ? []
      : [
          {
            label: project.name,
            to: "/projects/$projectId" as const,
            params: { projectId: project.id },
          },
        ]),
    { label: chat.title },
  ];
};

/**
 * One chat, followed as it streams, in the studio with the App its agent
 * builds, and with the side panel beside it.
 */
const OpenChat = ({
  chat,
  models,
  efforts,
  sourceNames,
  organizationName,
  panel,
  onPanel,
}: {
  chat: ChatSummary;
  models: string[];
  efforts: Record<string, ModelEfforts>;
  sourceNames: ReadonlyMap<string, SourceName>;
  organizationName: string | undefined;
  panel: boolean;
  onPanel: (open: boolean) => void;
}) => {
  const { view, failure } = useFollowedChat(chat.id);
  const { t } = useLingui();
  const { composer, ask } = useAsk(chat.id, models, efforts);
  const lastQuestion = view.messages.findLast(({ role }) => role === "user");
  const wide = useWide();
  const builds = useChatBuilds(chat.id, view.running, view.drafts);
  const drafts = draftsOf(builds);
  const building = drafts.length > 0;
  // Where the panel opened, beside the chat or in a sheet, holds until it
  // closes: an App running in it is never moved, which would load it anew,
  // when the first draft of an App comes. Only a window narrowing past lg
  // moves it into the sheet, and then the App open in it (`openedApp`)
  // opens again.
  const [placed, setPlaced] = useState<"aside" | "sheet">();
  if (panel && placed === undefined) {
    setPlaced(wide && !building ? "aside" : "sheet");
  } else if (!panel && placed !== undefined) {
    setPlaced(undefined);
  }
  const aside = wide && (panel ? placed === "aside" : !building);
  const sidePanel = <SidePanel builds={builds} />;
  // An App open in the shell's panel slot stands where this panel stood:
  // one panel at a time beside the chat.
  const showPanel = usePageSidePanel(panel);
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <ChatStudio chatId={chat.id} drafts={drafts} wide={wide}>
        <section
          aria-label={chat.title}
          className="relative flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <h1 className="sr-only">{chat.title}</h1>
          <ChatThread
            chatId={chat.id}
            loaded={view.loaded}
            messages={view.messages}
            onRetry={() => {
              if (lastQuestion?.role === "user") {
                void ask(lastQuestion.text);
              }
            }}
            output={view.output}
            partial={view.partial}
            running={view.running}
            tools={view.tools}
          >
            {failure === undefined && view.stopped === null ? null : (
              <div className="flex flex-col gap-2">
                <ErrorText>{failure}</ErrorText>
                <ErrorText>{view.stopped ?? undefined}</ErrorText>
                {/* A question stopped before the agent answered (a deploy, say)
                  is asked again from here: it may be the chat's first. */}
                {view.stopped !== null &&
                !view.running &&
                lastQuestion?.role === "user" ? (
                  <Button
                    className="self-start"
                    onClick={() => {
                      void ask(lastQuestion.text);
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <Trans>Try again</Trans>
                  </Button>
                ) : null}
              </div>
            )}
            <HeldWrites chatId={chat.id} version={view.held} />
            <ConnectionRequests chatId={chat.id} version={view.held} />
          </ChatThread>
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pb-4 md:px-6">
            <BuildsFailure read={builds} />
            <ChatSources names={sourceNames} provenance={view.provenance} />
            <AskOrCompose
              messages={view.messages}
              onAnswer={(answers) => {
                void ask(answers);
              }}
              running={view.running}
              {...composer}
            />
            <ComposerNote organizationName={organizationName} />
          </div>
        </section>
      </ChatStudio>
      {/* Beside the chat on a wide window, as wide as a page sidebar; over it,
          in a sheet, on a narrower one, and beside an App being built,
          which takes the room, unless it was already open beside the chat. */}
      {showPanel && aside ? (
        <aside
          aria-label={t`Side panel`}
          className="bg-background flex w-72 flex-none flex-col overflow-y-auto border-l p-4"
        >
          {sidePanel}
        </aside>
      ) : null}
      {aside ? null : (
        <Sheet onOpenChange={onPanel} open={showPanel}>
          <SheetContent closeLabel={t`Close`} side="right">
            <SheetTitle className="sr-only">
              <Trans>Side panel</Trans>
            </SheetTitle>
            <div className="flex flex-1 flex-col overflow-y-auto p-4">
              {sidePanel}
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
};

const Chat = () => {
  const page = Route.useLoaderData();
  const { chat: open, project: startIn } = Route.useSearch();
  const { t } = useLingui();
  // Open from the start where the dock's "Open in chat" asked for it.
  const [panel, setPanel] = useState(Route.useSearch().panel === true);
  // One past the list's newest opens too, as core keeps it (`beyond`,
  // whose App it is for included), or, where core can't find it, to say
  // why not.
  const chat =
    page.state !== "ready" || open === undefined
      ? undefined
      : (page.data.chats.find(({ id }) => id === open) ??
        (page.data.beyond?.id === open ? page.data.beyond : undefined) ?? {
          id: open,
          title: t`Chat`,
          createdAt: "",
          lastAt: "",
          running: false,
          projectId: null,
          appId: null,
          via: "web",
        });
  // The open chat: the chat dock carries it on on every other page. An
  // App's own chat stays the App's, in the dock on its page, and leaves
  // the person's open chat as it was.
  const forApp = chat !== undefined && chat.appId !== null;
  useEffect(() => {
    if (open !== undefined && !forApp) {
      setActiveChat(open);
    }
  }, [open, forApp]);
  if (page.state !== "ready") {
    return <PageNotLoaded crumbs={[{ label: t`Chat` }]} page={page} />;
  }
  const { chats, projects, models, efforts, sourceNames, organizationName } =
    page.data;
  return (
    <>
      <SiteHeader
        actions={
          // Quiet icons, named when pointed at: the other chats, a new one,
          // the side panel and more for this one.
          <div className="flex items-center gap-0.5">
            <ChatSwitcherButton />
            {chat === undefined ? null : (
              <>
                <HeaderIcon
                  label={t`New chat`}
                  render={
                    <Link
                      aria-label={t`New chat`}
                      className={buttonVariants({
                        size: "icon-sm",
                        variant: "ghost",
                      })}
                      onClick={() => {
                        setActiveChat(undefined);
                      }}
                      search={{}}
                      to="/"
                    />
                  }
                >
                  <PlusIcon />
                </HeaderIcon>
                <HeaderIcon
                  label={t`Side panel`}
                  render={
                    <Button
                      aria-label={t`Side panel`}
                      aria-pressed={panel}
                      onClick={() => {
                        setPanel(!panel);
                      }}
                      size="icon-sm"
                      variant="ghost"
                    />
                  }
                >
                  <PanelRightIcon />
                </HeaderIcon>
                <ChatMore
                  chat={chat}
                  // Its own: copied, a dialog open, for this chat alone.
                  key={chat.id}
                  projects={projects}
                  sourceNames={sourceNames}
                />
              </>
            )}
          </div>
        }
        crumbs={crumbsOf(t`Chat`, chat, projects)}
        // On a phone, Chat alone beside the chat's four icons, as in the
        // prototype; the project and the chat from sm up.
        phoneCrumbs="first"
      />
      {/* Held to the window, so a tall box at the bottom makes the thread shorter, never the page longer. */}
      <div className="flex min-h-0 flex-1 text-sm">
        {chat === undefined ? (
          <NewChat
            chats={chats}
            efforts={efforts}
            models={models}
            project={projects.find(({ id }) => id === startIn)}
            projects={projects}
          />
        ) : (
          <OpenChat
            chat={chat}
            efforts={efforts}
            key={chat.id}
            models={models}
            onPanel={setPanel}
            organizationName={organizationName}
            panel={panel}
            sourceNames={sourceNames}
          />
        )}
      </div>
    </>
  );
};

/**
 * Chat `chatId`, past the end of the list, as core keeps it; none where
 * core can't find it, and the chat opens to say why.
 */
const chatPastTheList = async (
  session: Session,
  chatId: string
): Promise<ChatSummary | undefined> => {
  try {
    return await session.chats.summary(chatId);
  } catch {
    return undefined;
  }
};

export const Route = createFileRoute("/_shell/")({
  pendingComponent: PageLoading,
  validateSearch: (
    search: Record<string, unknown>
  ): { chat?: string; panel?: true; project?: string } => ({
    ...(typeof search.chat === "string" ? { chat: search.chat } : {}),
    ...(search.panel === true ? { panel: true } : {}),
    // A new chat started from a project.
    ...(typeof search.project === "string" ? { project: search.project } : {}),
  }),
  // Chat opens on the open chat, the one the dock carries on, whatever led
  // here (the sidebar, the logo); only "New chat" lets go of it first.
  // Staff who reach the onboarding alone have no chat: home is the area.
  beforeLoad: ({ search, context: { identity } }) => {
    if (identity.onboardingOnly === true) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: "/onboarding", replace: true });
    }
    const active = activeChat();
    if (
      search.chat === undefined &&
      search.project === undefined &&
      active !== undefined
    ) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: "/", search: { chat: active }, replace: true });
    }
  },
  loaderDeps: ({ search }) => ({ chat: search.chat }),
  loader: async ({ context: { core }, deps: { chat } }) =>
    await loadFromCore(core, async (session): Promise<ChatPage> => {
      const [chats, projects, models, efforts, sourceNames, organizationName] =
        await Promise.all([
          session.chats.list(),
          session.chats.projects(),
          session.chats.models(),
          session.chats.efforts(),
          readSourceNames(session),
          readOrganizationName(session),
        ]);
      // A chat past the list's end, as core keeps it, so whose it is (an
      // App's) is known; one core can't find opens to say why.
      const beyond =
        chat === undefined || chats.some(({ id }) => id === chat)
          ? undefined
          : await chatPastTheList(session, chat);
      return {
        chats,
        ...(beyond === undefined ? {} : { beyond }),
        projects,
        models,
        efforts,
        sourceNames,
        organizationName,
      };
    }),
  component: Chat,
});
