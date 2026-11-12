import { Button } from "@grasp-os/ui/components/button";
import {
  DockablePanel,
  DockablePanelHandle,
  DockablePanelHeader,
  useDockablePanel,
} from "@grasp-os/ui/components/dockable-panel";
import type { DockablePlacement } from "@grasp-os/ui/components/dockable-panel";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { GraspMark } from "@grasp-os/ui/components/grasp-mark";
import { Panel } from "@grasp-os/ui/components/panel";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMatch, useRouteContext, useRouter } from "@tanstack/react-router";
import {
  Maximize2Icon,
  Minimize2Icon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";
import { Suspense, lazy, useEffect, useEffectEvent, useRef } from "react";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { NotLoaded } from "../load-from-core.tsx";
import { shortcutLabel } from "../shortcuts.ts";
import { setActiveChat, startAfresh } from "./active-chat.ts";
import { AgentName, agentModelOf } from "./agent-choice.tsx";
import { AskOrCompose } from "./asked-questions.tsx";
import { BrainQuestions } from "./brain-questions.tsx";
import { pendingPlan } from "./build-progress.tsx";
import { BuildsFailure, workOf } from "./builds.tsx";
import {
  chatWidth,
  closeChat,
  exitFullscreen,
  moveChat,
  openChat,
  resizeChat,
  useChatLayout,
} from "./chat-layout.ts";
import { ChatTitleMenu } from "./chat-more.tsx";
import { allows } from "./chat-presence.ts";
import { HeaderIcon } from "./chat-switcher.tsx";
import { ConnectionRequests } from "./connection-requests.tsx";
import { chatKey, useGlobalChat } from "./global-chat.tsx";
import type { ModelsUnavailable } from "./global-chat.tsx";
import { HeldWrites } from "./held-writes.tsx";
import { PackageRequests } from "./package-requests.tsx";
import { RecentsButton } from "./recents.tsx";
import { ChatSources } from "./sources.tsx";
import { SubjectBarContent, subjectBarOf } from "./subject-bar.tsx";

// Grasp's chat open (global-chat.tsx): one panel, docked beside the page or
// floating over it as a window the person moves by its header. A header with
// the person's recent chats and the ways to start afresh, move the chat or
// close it; the thread; and the box to ask in, which takes the cursor as the
// chat opens. Escape closes it to its idle bar, which takes the cursor back
// (chat-bar.tsx).

// The conversation, with its Markdown and code highlighting, loads once a
// chat is open: most pages show the chat idle.
const ChatThread = lazy(async () => {
  const { ChatThread: thread } = await import("./thread.tsx");
  return { default: thread };
});

/**
 * The open chat's title at the head of the chat, renamed where it stands,
 * with its menu; a chat not made yet is a new chat.
 */
const ChatTitle = () => {
  const { summary, sourceNames, retitle } = useGlobalChat();
  if (summary === undefined) {
    return (
      <span className="text-muted-foreground truncate px-2 text-sm font-medium">
        <Trans>New chat</Trans>
      </span>
    );
  }
  return (
    // Its own: renamed, copied, a dialog open, for this chat alone.
    <ChatTitleMenu
      chat={summary}
      key={summary.id}
      onRenamed={retitle}
      sourceNames={sourceNames}
    />
  );
};

/** A move of the chat from where it is, as its header offers it. */
interface Move {
  to: DockablePlacement;
  label: string;
  icon: ReactNode;
}

/**
 * The chat's grip, at the head of the chat: floating, it moves the chat,
 * or docks it, dragged to its dock or double-clicked; docked, dragged out
 * of its dock or double-clicked, it undocks it.
 */
const ChatGrip = () => {
  const { t } = useLingui();
  const { placement } = useDockablePanel();
  return (
    <DockablePanelHandle
      label={
        placement === "floating"
          ? t`Drag to move, or double-click to dock`
          : t`Drag or double-click to undock`
      }
    />
  );
};

/**
 * The header's buttons that move the chat from where it is: full screen
 * and back, or dock it; only to where this page allows it
 * (chat-presence.ts).
 */
const MoveButtons = () => {
  const { t } = useLingui();
  const { placement } = useDockablePanel();
  const { presence } = useGlobalChat();
  const moves: Record<DockablePlacement, Move[]> = {
    // Undocking is the grip's: dragged out, or double-clicked (ChatGrip).
    docked: [
      { to: "fullscreen", label: t`Full screen`, icon: <Maximize2Icon /> },
    ],
    fullscreen: [
      { to: "docked", label: t`Exit full screen`, icon: <Minimize2Icon /> },
    ],
    // Docking is the grip's: pushed into the dock, or double-clicked.
    floating: [],
  };
  return moves[placement]
    .filter(({ to }) => allows(presence, to))
    .map(({ to, label, icon }) => (
      <HeaderIcon
        key={to}
        label={label}
        onClick={() => {
          openChat(to);
        }}
      >
        {icon}
      </HeaderIcon>
    ));
};

/**
 * The header's buttons on its right: start afresh, move the chat, close it.
 * They follow where the panel shows, so they don't change while it fades out
 * of one place for the other.
 */
const HeaderActions = () => {
  const { t } = useLingui();
  const { chatId, slot, keptOpen } = useGlobalChat();
  return (
    <div className="ml-auto flex items-center gap-0.5">
      {chatId === undefined ? null : (
        <HeaderIcon
          label={t`New chat`}
          onClick={() => {
            // A subject's slot would find the chat that last worked on it
            // again: it starts afresh instead.
            if (slot === "chat") {
              setActiveChat(undefined);
            } else {
              startAfresh(slot);
            }
          }}
        >
          <SquarePenIcon />
        </HeaderIcon>
      )}
      <MoveButtons />
      {/* About the page's subject it stays open (chat-subject.ts). */}
      {keptOpen ? null : (
        <HeaderIcon
          label={t`Close`}
          onClick={closeChat}
          shortcut={shortcutLabel(chatKey)}
        >
          <XIcon />
        </HeaderIcon>
      )}
    </div>
  );
};

/** What the chat says before anything is asked in it. */
const Welcome = ({ text }: { text: string }) => (
  <div className="animate-in fade-in-0 flex flex-1 flex-col motion-reduce:animate-none">
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <GraspMark />
        </EmptyMedia>
        <EmptyTitle>{text}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  </div>
);

/** The conversation, or what to ask before there is one; `focusBox` takes the person to the box. */
const Thread = ({ focusBox }: { focusBox: () => void }) => {
  const { t } = useLingui();
  const { chatId, finding, view, failure, empty, words, ask, composer } =
    useGlobalChat();
  const { placement } = useDockablePanel();
  // A subject's chat, while core finds it, or why it gave none.
  if (finding.searching || finding.failure !== undefined) {
    return finding.failure === undefined ? (
      <div className="flex flex-1 justify-center py-8">
        <Spinner aria-label={t`Loading…`} />
      </div>
    ) : (
      <div className="flex flex-1 flex-col items-center gap-3 py-8">
        <NotLoaded page={finding.failure} />
        <Button
          onClick={() => {
            finding.retry();
          }}
          size="sm"
          variant="outline"
        >
          <Trans>Try again</Trans>
        </Button>
      </div>
    );
  }
  if (chatId === undefined || empty) {
    return <Welcome text={words.empty} />;
  }
  const lastQuestion = view.messages.findLast(({ role }) => role === "user");
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 justify-center py-8">
          <Spinner aria-label={t`Loading…`} />
        </div>
      }
    >
      <ChatThread
        chatId={chatId}
        compact={placement !== "fullscreen"}
        loaded={view.loaded || failure !== undefined}
        messages={view.messages}
        onRetry={() => {
          if (lastQuestion !== undefined) {
            void ask(lastQuestion.text);
          }
        }}
        output={view.output}
        partial={view.partial}
        checking={view.checking}
        running={view.running}
        tools={view.tools}
        build={{
          model: composer.model,
          effort: composer.effort,
          onChangePlan: focusBox,
        }}
      >
        {failure === undefined && view.stopped === null ? null : (
          <div className="flex flex-col gap-2">
            <ErrorText>{failure}</ErrorText>
            <ErrorText>{view.stopped ?? undefined}</ErrorText>
            {/* A question stopped before the agent answered (a deploy, say)
              is asked again from here: it may be the chat's first. */}
            {view.stopped !== null &&
            !view.running &&
            lastQuestion !== undefined ? (
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
        <HeldWrites chatId={chatId} version={view.held} />
        <ConnectionRequests chatId={chatId} version={view.held} />
        <PackageRequests
          chatId={chatId}
          // Approved, the work the agent stopped for goes on, in a turn
          // the person's own message starts: the thread says why it did.
          onApproved={() => {
            if (!view.running) {
              void ask(t`The packages are approved. Carry on.`);
            }
          }}
          version={view.held}
        />
      </ChatThread>
    </Suspense>
  );
};

/**
 * The brain's open questions, on the brain's pages, as the brain page read
 * them (routes/_shell.brain.tsx), to answer or have asked about; the brain
 * is read again when one was.
 */
const BrainGaps = () => {
  const router = useRouter();
  const { identity } = useRouteContext({ from: "/_shell" });
  const brain = useMatch({ from: "/_shell/brain", shouldThrow: false });
  const loaded = brain?.loaderData;
  if (loaded?.state !== "ready") {
    return null;
  }
  return (
    <BrainQuestions
      gaps={loaded.data.workspace.gaps}
      identity={identity}
      onChanged={() => {
        void router.invalidate();
      }}
    />
  );
};

/** Why nothing can be asked yet, under the box, with the way out. */
const ModelsUnavailableNotice = ({
  why,
  onRetry,
}: {
  why: ModelsUnavailable;
  onRetry: (() => void) | undefined;
}) => {
  // No provider is the box's own to say: it is covered (composer.tsx).
  if (why.why === "provider") {
    return null;
  }
  return (
    <p className="text-muted-foreground flex items-center gap-2 px-1 text-xs">
      {why.text}
      {onRetry === undefined ? null : (
        <Button onClick={onRetry} size="xs" variant="link">
          <Trans>Try again</Trans>
        </Button>
      )}
    </p>
  );
};

/** The box to ask in, or the agent's questions in its place. */
const Footer = () => {
  const { t } = useLingui();
  const {
    builds,
    subject,
    chatId,
    composer,
    words,
    view,
    asking,
    ask,
    modelsUnavailable,
    retry,
    sourceNames,
    summary,
    offered,
  } = useGlobalChat();
  const work = workOf(builds);
  // Which of the company's agents answers here, where there are several.
  const agents = offered?.agents ?? [];
  // Under a plan that waits for the person, the box is where to change it.
  const placeholder =
    pendingPlan(view.messages, view.running) === undefined
      ? words.placeholder
      : t`Change something about the plan`;
  // When the running turn began: its question's time.
  const turnSince = view.running
    ? view.messages.findLast(({ role }) => role === "user")?.at
    : undefined;
  // The page's subject, by name once it is known.
  const worked =
    subject.about === undefined || subject.name === undefined
      ? undefined
      : { ...subject.about, name: subject.name };
  return (
    <div className="flex flex-none flex-col gap-1 px-4 pt-2 pb-4">
      <BuildsFailure read={builds} />
      <ChatSources names={sourceNames} provenance={view.provenance} />
      <AskOrCompose
        {...composer}
        actions={<RecentsButton />}
        agent={
          summary === undefined ? undefined : (
            <AgentName agentId={summary.agentId} agents={agents} />
          )
        }
        agentModel={agentModelOf(agents, summary?.agentId)}
        subject={
          subjectBarOf(worked, work) === undefined ? undefined : (
            <SubjectBarContent
              chatId={chatId}
              work={work}
              since={turnSince}
              subject={worked}
            />
          )
        }
        asking={asking}
        label={words.title}
        onAnswer={(text) => {
          void ask(text);
        }}
        // The box's editor takes its placeholder as it starts: another
        // starts it afresh, with the text it holds.
        key={placeholder}
        placeholder={placeholder}
        running={view.running}
      />
      {modelsUnavailable === undefined ? null : (
        <ModelsUnavailableNotice onRetry={retry} why={modelsUnavailable} />
      )}
    </div>
  );
};

/**
 * The open chat's body: its thread, the brain's questions on its pages,
 * and the box, which takes the cursor as the chat opens or moves.
 */
const Body = ({ open }: { open: boolean }) => {
  const body = useRef<HTMLDivElement>(null);
  const { placement } = useDockablePanel();
  const { summary, words, keptOpen } = useGlobalChat();
  // Escape closes it, or, where it stays open, takes it out of full screen.
  const onEscape = useEffectEvent(() => {
    if (keptOpen) {
      exitFullscreen();
    } else {
      closeChat();
    }
  });
  // Each time it opens: the panel's stays mounted while it is closed.
  useEffect(() => {
    if (open) {
      body.current?.querySelector<HTMLElement>('[role="textbox"]')?.focus();
    }
  }, [open]);
  useEffect(() => {
    const element = body.current;
    if (element === null) {
      return () => {
        // Nothing was listened to.
      };
    }
    const onKey = (event: KeyboardEvent) => {
      // What has its own use for Escape (a menu, the questions) keeps it.
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        onEscape();
      }
    };
    element.addEventListener("keydown", onKey);
    return () => {
      element.removeEventListener("keydown", onKey);
    };
  }, []);
  return (
    <div className="flex min-h-0 flex-1 flex-col" ref={body}>
      {/* Full screen, the conversation reads as a column in the middle,
        named by its chat. */}
      <section
        aria-label={summary?.title ?? words.title}
        className="mx-auto flex min-h-0 w-full flex-1 flex-col data-[placement=fullscreen]:max-w-3xl"
        data-placement={placement}
      >
        <Thread
          focusBox={() => {
            body.current
              ?.querySelector<HTMLElement>('[role="textbox"]')
              ?.focus();
          }}
        />
        <BrainGaps />
        <Footer />
      </section>
    </div>
  );
};

/**
 * Grasp's chat, open: one panel, docked beside the page or floating over it,
 * where the person last had it. It stays mounted while closed, so the
 * conversation and the box never render anew as it opens, closes or moves.
 * The shell's right Panel is the room it docks into; each shows as the
 * stage says (chat-stage.ts), and says when it has finished moving.
 */
export const ChatPanel = () => {
  const { t } = useLingui();
  const { stage, delays, settled, presence } = useGlobalChat();
  const { offset, width } = useChatLayout();
  return (
    <Panel
      delayed={delays.room}
      onOpenChangeComplete={() => {
        settled("room");
      }}
      open={stage.room}
      side="right"
      // Resizable docked; full screen, its edge is under the chat.
      {...(stage.placement === "docked"
        ? {
            maxSize: chatWidth.max,
            minSize: chatWidth.min,
            onSizeChange: resizeChat,
            resizeLabel: t`Resize the chat`,
            size: width,
          }
        : { size: width })}
    >
      <DockablePanel
        defaultOffset={offset ?? undefined}
        delayed={delays.card}

        label={t`Chat`}
        onOffsetChange={moveChat}
        // Out of its dock, it floats, where this page allows that.
        onDetach={
          allows(presence, "floating")
            ? () => {
                openChat("floating");
              }
            : undefined
        }
        // Dragged to its dock, it docks, where this page allows that.
        onDock={
          allows(presence, "docked")
            ? () => {
                openChat("docked");
              }
            : undefined
        }
        onOpenChangeComplete={() => {
          settled("card");
        }}
        open={stage.card}
        placement={stage.placement}
      >
        <DockablePanelHeader>
          {/* Only where the chat can leave its dock, or go back to it. */}
          {allows(presence, "floating") ? <ChatGrip /> : null}
          <ChatTitle />
          <HeaderActions />
        </DockablePanelHeader>
        <Body open={stage.card} />
      </DockablePanel>
    </Panel>
  );
};
