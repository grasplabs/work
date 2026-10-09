import type { ChatSummary } from "@grasp-os/shared/chat";
import type { ModelEfforts } from "@grasp-os/shared/models";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import { Sheet, SheetContent, SheetTitle } from "@grasp-os/ui/components/sheet";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { PanelLeftIcon, PanelRightIcon, PlusIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { GraspBuddy } from "../buddy/grasp-buddy.tsx";
import { activeChat, setActiveChat } from "../chat/active-chat.ts";
import { BuildsFailure, draftsOf, useChatBuilds } from "../chat/builds.tsx";
import { ChatList, ChatSidebar } from "../chat/chat-list.tsx";
import { chatMarkdown } from "../chat/chat-markdown.ts";
import { useFollowedChat } from "../chat/chat-watch.ts";
import { Composer } from "../chat/composer.tsx";
import { ConnectionRequests } from "../chat/connection-requests.tsx";
import { HeldWrites } from "../chat/held-writes.tsx";
import { SidePanel } from "../chat/side-panel.tsx";
import { ChatSources } from "../chat/sources.tsx";
import type { SourceName } from "../chat/sources.tsx";
import { ChatStudio } from "../chat/studio.tsx";
import { ChatThread } from "../chat/thread.tsx";
import { useAsk } from "../chat/use-ask.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { ExportMenu } from "../export/export-menu.tsx";
import { PageNotLoaded, PageLoading } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";

// Chat with the organization's agent, in the prototype's layout
// (grasplabs/prototype `routes/index.tsx`): the person's chats in the page
// sidebar, and the open one beside them, its answers streaming in as the
// agent writes them, the changes it holds for the person to confirm, and a
// side panel with the versions it built up for review. A new chat starts on
// Grasp's buddy and the question "What should we look at today?", in the
// middle of the page; once its agent writes a draft of an App, the chat
// moves left and the App's preview stands on the right (chat/studio.tsx),
// and the chats' sidebar folds to its rail to give it the room.

interface ChatPage {
  chats: ChatSummary[];
  /** The models a question may name, the default first. */
  models: string[];
  /** The efforts each of them takes (`chats.efforts()`). */
  efforts: Record<string, ModelEfforts>;
  /** The collections' and connections' names, by ID, for provenance. */
  sourceNames: ReadonlyMap<string, SourceName>;
}

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

/** A new chat: Grasp's buddy, the question, and the box to ask in. */
const NewChat = ({
  models,
  efforts,
}: {
  models: string[];
  efforts: Record<string, ModelEfforts>;
}) => {
  const { composer } = useAsk(undefined, models, efforts);
  return (
    <section
      aria-labelledby="new-chat"
      className="flex min-w-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="flex min-h-full items-center justify-center px-6 py-12">
        <div className="flex w-full max-w-3xl flex-col gap-8 pb-10">
          <div className="flex flex-col gap-6">
            <GraspBuddy aligned />
            <h1 className="text-2xl font-medium tracking-tight" id="new-chat">
              <Trans>What should we look at today?</Trans>
            </h1>
          </div>
          <Composer running={false} {...composer} />
          <p className="text-muted-foreground text-sm">
            <Trans>
              Describe what you want. The agent answers from what it can read,
              and holds every change to an outside system until you confirm it.
            </Trans>
          </p>
        </div>
      </div>
    </section>
  );
};

/** From this width (Tailwind's lg) the side panel sits beside the chat. */
const wideQuery = "(min-width: 64rem)";

const onWide = (onChange: () => void): (() => void) => {
  const query = matchMedia(wideQuery);
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
};

const isWide = (): boolean => matchMedia(wideQuery).matches;

/** Characters a file name can't hold on some system, and runs of space. */
const unsafeInFileName = /[\s"*/:<>?\\|]+/gu;

/** The name a chat exports under: its title, made safe for a file. */
const fileNameOf = (title: string): string =>
  title
    .replaceAll(unsafeInFileName, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 80) || "grasp-chat";

/**
 * The one element the side panel draws itself in, and what puts it in a
 * container: beside the chat or in a sheet over it. Moving the element
 * rather than drawing the panel anew in the other keeps what it holds (an
 * App open, an approval under way) when the first draft of an App, or a
 * narrower window, moves it.
 */
const usePanelNode = (): [
  HTMLDivElement | undefined,
  (container: HTMLElement | null) => void,
] => {
  // Made the first time a container is there for it, then kept.
  const [node, setNode] = useState<HTMLDivElement>();
  return [
    node,
    (container) => {
      if (container === null) {
        return;
      }
      if (node !== undefined) {
        container.append(node);
        return;
      }
      const element = document.createElement("div");
      element.className = "flex flex-1 flex-col";
      container.append(element);
      setNode(element);
    },
  ];
};

/**
 * One chat, followed as it streams, in the studio with the App its agent
 * builds (`onBuilding` says whether one stands beside it), and with the
 * side panel beside it.
 */
const OpenChat = ({
  chat,
  models,
  efforts,
  sourceNames,
  panel,
  onPanel,
  onBuilding,
}: {
  chat: ChatSummary;
  models: string[];
  efforts: Record<string, ModelEfforts>;
  sourceNames: ReadonlyMap<string, SourceName>;
  panel: boolean;
  onPanel: (open: boolean) => void;
  onBuilding: (building: boolean) => void;
}) => {
  const { view, failure } = useFollowedChat(chat.id);
  const { i18n, t } = useLingui();
  const { composer, ask } = useAsk(chat.id, models, efforts);
  const lastQuestion = view.messages.findLast(({ role }) => role === "user");
  const wide = useSyncExternalStore(onWide, isWide);
  const builds = useChatBuilds(chat.id, view.running, view.drafts);
  const drafts = draftsOf(builds);
  const building = drafts.length > 0;
  useEffect(() => {
    onBuilding(building);
    return () => {
      onBuilding(false);
    };
  }, [building, onBuilding]);
  const [panelNode, holdPanel] = usePanelNode();
  // Drawn from the first time it opens on, so it keeps its state while
  // closed too, and a sheet that closes still shows it on its way out.
  const [panelUsed, setPanelUsed] = useState(panel);
  if (panel && !panelUsed) {
    setPanelUsed(true);
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <ChatStudio chatId={chat.id} drafts={drafts} wide={wide}>
        <section
          aria-label={chat.title}
          className="relative flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <h1 className="sr-only">{chat.title}</h1>
          {/* In a row of its own above the thread, so no message scrolls under it. */}
          {view.messages.length === 0 ? null : (
            <div className="flex flex-none justify-end px-4 pt-2">
              <ExportMenu
                file={{
                  name: fileNameOf(chat.title),
                  title: chat.title,
                  markdown: () =>
                    chatMarkdown({
                      title: chat.title,
                      messages: view.messages,
                      partial: view.partial,
                      provenance: view.provenance,
                      names: sourceNames,
                      i18n,
                    }),
                }}
                label={t`Export this chat`}
              />
            </div>
          )}
          <ChatThread
            loaded={view.loaded}
            messages={view.messages}
            onRetry={() => {
              if (lastQuestion?.role === "user") {
                void ask(lastQuestion.text);
              }
            }}
            partial={view.partial}
            running={view.running}
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
            <Composer running={view.running} {...composer} />
            <p className="text-muted-foreground text-center text-xs">
              <Trans>
                Grasp holds every change to an outside system until you confirm
                it.
              </Trans>
            </p>
          </div>
        </section>
      </ChatStudio>
      {/* Beside the chat on a wide window, as wide as a page sidebar; over it,
          in a sheet, on a narrower one, and beside an App being built,
          which takes the room. */}
      {wide && panel && !building ? (
        <aside
          aria-label={t`Side panel`}
          className="bg-background flex w-72 flex-none flex-col overflow-y-auto border-l p-4"
          ref={holdPanel}
        />
      ) : null}
      {wide && !building ? null : (
        <Sheet onOpenChange={onPanel} open={panel}>
          <SheetContent closeLabel={t`Close`} side="right">
            <SheetTitle className="sr-only">
              <Trans>Side panel</Trans>
            </SheetTitle>
            <div
              className="flex flex-1 flex-col overflow-y-auto p-4"
              ref={holdPanel}
            />
          </SheetContent>
        </Sheet>
      )}
      {panelUsed && panelNode !== undefined
        ? createPortal(<SidePanel builds={builds} />, panelNode)
        : null}
    </div>
  );
};

const Chat = () => {
  const page = Route.useLoaderData();
  const { chat: open } = Route.useSearch();
  const { t } = useLingui();
  const [listOpen, setListOpen] = useState(false);
  // Open from the start where the dock's "Open in chat" asked for it.
  const [panel, setPanel] = useState(Route.useSearch().panel === true);
  // Whether the open chat's agent has an App to show beside it.
  const [building, setBuilding] = useState(false);
  // The open chat: the chat dock carries it on on every other page.
  useEffect(() => {
    if (open !== undefined) {
      setActiveChat(open);
    }
  }, [open]);
  if (page.state !== "ready") {
    return <PageNotLoaded crumbs={[{ label: t`Chat` }]} page={page} />;
  }
  const { chats, models, efforts, sourceNames } = page.data;
  // One past the list's newest opens too, as core finds it (or says why not).
  const chat =
    chats.find(({ id }) => id === open) ??
    (open === undefined
      ? undefined
      : { id: open, title: t`Chat`, createdAt: "", running: false });
  return (
    <>
      <SiteHeader
        actions={
          <>
            <Button
              className="md:hidden"
              onClick={() => {
                setListOpen(true);
              }}
              size="sm"
              variant="outline"
            >
              <PanelLeftIcon data-icon="inline-start" />
              <Trans>Chats</Trans>
            </Button>
            {chat === undefined ? null : (
              <>
                <Button
                  aria-pressed={panel}
                  onClick={() => {
                    setPanel(!panel);
                  }}
                  size="sm"
                  variant="outline"
                >
                  <PanelRightIcon data-icon="inline-start" />
                  {/* On a phone the icon alone, so where the chat is stays in view. */}
                  <span className="max-sm:sr-only">
                    <Trans>Side panel</Trans>
                  </span>
                </Button>
                <Link
                  className={buttonVariants({ size: "sm", variant: "outline" })}
                  onClick={() => {
                    setActiveChat(undefined);
                  }}
                  search={{}}
                  to="/"
                >
                  <PlusIcon data-icon="inline-start" />
                  {/* On a phone the icon alone, so where the chat is stays in view. */}
                  <span className="max-sm:sr-only">
                    <Trans>New chat</Trans>
                  </span>
                </Link>
              </>
            )}
          </>
        }
        crumbs={
          chat === undefined
            ? [{ label: t`Chat` }]
            : [{ label: t`Chat`, to: "/" }, { label: chat.title }]
        }
      />
      {/* Held to the window, so a tall box at the bottom makes the thread shorter, never the page longer. */}
      <div className="flex min-h-0 flex-1 text-sm">
        <ChatSidebar
          activeId={chat?.id}
          building={chat !== undefined && building}
          chats={chats}
        />
        {chat === undefined ? (
          <NewChat efforts={efforts} models={models} />
        ) : (
          <OpenChat
            chat={chat}
            efforts={efforts}
            key={chat.id}
            models={models}
            onBuilding={setBuilding}
            onPanel={setPanel}
            panel={panel}
            sourceNames={sourceNames}
          />
        )}
      </div>
      <Sheet onOpenChange={setListOpen} open={listOpen}>
        <SheetContent closeLabel={t`Close`} side="left">
          <SheetTitle className="sr-only">
            <Trans>Recent chats</Trans>
          </SheetTitle>
          <ChatList
            activeId={chat?.id}
            chats={chats}
            onPick={() => {
              setListOpen(false);
            }}
          />
        </SheetContent>
      </Sheet>
    </>
  );
};

export const Route = createFileRoute("/_shell/")({
  pendingComponent: PageLoading,
  validateSearch: (
    search: Record<string, unknown>
  ): { chat?: string; panel?: true } => ({
    ...(typeof search.chat === "string" ? { chat: search.chat } : {}),
    ...(search.panel === true ? { panel: true } : {}),
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
    if (search.chat === undefined && active !== undefined) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: "/", search: { chat: active }, replace: true });
    }
  },
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, async (session): Promise<ChatPage> => {
      const [chats, models, efforts, sourceNames] = await Promise.all([
        session.chats.list(),
        session.chats.models(),
        session.chats.efforts(),
        readSourceNames(session),
      ]);
      return { chats, models, efforts, sourceNames };
    }),
  component: Chat,
});
