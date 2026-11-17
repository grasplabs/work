import {
  DockablePanel,
  DockablePanelHandle,
  DockablePanelHeader,
} from "@grasp-os/ui/components/dockable-panel";
import type { DockablePlacement } from "@grasp-os/ui/components/dockable-panel";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useMatch, useRouteContext, useRouter } from "@tanstack/react-router";
import { Suspense, lazy, useEffect, useEffectEvent, useRef } from "react";
import type { ReactNode } from "react";

import { Alert } from "../grasp/alert/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Empty } from "../grasp/empty/index.ts";
import {
  AppWindow,
  Cross,
  Edit,
  Expand,
  PanelToggle,
  Retry,
} from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import { Spinner } from "../grasp/spinner/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import {
  Tooltip,
  TooltipPanel,
  TooltipShortcut,
  TooltipTrigger,
} from "../grasp/tooltip/index.ts";
import { NotLoaded } from "../load-from-core.tsx";
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
import { ConnectionRequests } from "./connection-requests.tsx";
import { chatKey, useGlobalChat } from "./global-chat.tsx";
import type { ModelsUnavailable } from "./global-chat.tsx";
import { HeldWrites } from "./held-writes.tsx";
import { PackageRequests } from "./package-requests.tsx";
import { reading } from "./reading.stylex.ts";
import { RecentsButton } from "./recents.tsx";
import { ChatSources } from "./sources.tsx";
import { SubjectBarContent, subjectBarOf } from "./subject-bar.tsx";

const panelStyles = stylex.create({
  // The chat in App shell's panel: its head over its body, filling the panel.
  content: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
  },
  head: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    paddingBlock: grasp.space2,
    paddingInline: grasp.space3,
  },
  // The title takes the room the buttons leave, and gives way first: a
  // Button can't cut its words short (asked of Grasp UI), so it is clipped.
  title: {
    display: "flex",
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
  },
  // The head's buttons, at its end.
  actions: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: grasp.space1,
    marginInlineStart: "auto",
  },
  grow: {
    display: "grid",
    flexGrow: 1,
  },
  centre: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    alignItems: "center",
    gap: grasp.space3,
    paddingBlock: grasp.space8,
  },
  stack: {
    display: "grid",
    gap: grasp.space2,
  },
  start: {
    justifySelf: "start",
  },
  // The box at the chat's foot, and what stands with it.
  footer: {
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    gap: grasp.space1,
    paddingInline: grasp.space4,
    paddingBlockStart: grasp.space2,
    paddingBlockEnd: grasp.space4,
  },
  body: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
  },
  column: {
    width: "100%",
    marginInline: "auto",
  },
  // Full screen, the conversation reads as one column in the middle.
  reading: {
    maxWidth: reading.width,
  },
  notice: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    paddingInline: grasp.space1,
  },
});

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
      <Text size="sm" tone="muted" weight="medium">
        <Trans>New chat</Trans>
      </Text>
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
  icon: IconData;
}

/** A button in the chat's head: an icon, named, its name and shortcut in a tooltip. */
const HeaderButton = ({
  icon,
  label,
  shortcut,
  onClick,
}: {
  icon: IconData;
  label: string;
  /** Its keys, as Tooltip names them ("mod+j"). */
  shortcut?: string;
  onClick: () => void;
}) => (
  <Tooltip shortcut={shortcut}>
    <TooltipTrigger
      icon={icon}
      label={label}
      onClick={() => {
        onClick();
      }}
      size="sm"
      variant="ghost"
    />
    <TooltipPanel>
      {label}
      {shortcut === undefined ? null : <TooltipShortcut />}
    </TooltipPanel>
  </Tooltip>
);

/**
 * The floating chat's grip, at its head: it moves the chat, or docks it,
 * dragged to its dock or double-clicked.
 */
const ChatGrip = () => {
  const { t } = useLingui();
  return (
    <DockablePanelHandle label={t`Drag to move, or double-click to dock`} />
  );
};

/**
 * The header's buttons that move the chat from where it is: full screen
 * and back, or dock it; only to where this page allows it
 * (chat-presence.ts).
 */
const MoveButtons = () => {
  const { t } = useLingui();
  const {
    presence,
    roomBeside,
    stage: { placement },
  } = useGlobalChat();
  const moves: Record<DockablePlacement, Move[]> = {
    // In App shell's panel there is no grip to drag it out by: a button floats it.
    docked: [
      { to: "floating", label: t`Float over the page`, icon: AppWindow },
      { to: "fullscreen", label: t`Full screen`, icon: Expand },
    ],
    fullscreen: [
      // Grasp UI has no exit-full-screen icon yet (asked of the library):
      // the panel toggle, the closest in its set, stands in.
      { to: "docked", label: t`Exit full screen`, icon: PanelToggle },
    ],
    // Docking is the grip's: pushed into the dock, or double-clicked.
    floating: [],
  };
  return (
    moves[placement]
      // On a phone there is no page beside it to float over, and full
      // screen looks as docked does: neither is offered there.
      .filter(
        ({ to }) => allows(presence, to) && (roomBeside || to === "docked")
      )
      .map(({ to, label, icon }) => (
        <HeaderButton
          icon={icon}
          key={to}
          label={label}
          onClick={() => {
            openChat(to);
          }}
        />
      ))
  );
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
    <div {...stylex.props(panelStyles.actions)}>
      {chatId === undefined ? null : (
        <HeaderButton
          icon={Edit}
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
        />
      )}
      <MoveButtons />
      {/* About the page's subject it stays open (chat-subject.ts). */}
      {keptOpen ? null : (
        <HeaderButton
          icon={Cross}
          label={t`Close`}
          onClick={closeChat}
          shortcut={`mod+${chatKey}`}
        />
      )}
    </div>
  );
};

/** What the chat says before anything is asked in it. */
const Welcome = ({ text }: { text: string }) => (
  <div {...stylex.props(panelStyles.grow)}>
    <Empty shape="thread">{text}</Empty>
  </div>
);

/** The chat loading, in the thread's place. */
const Loading = () => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(panelStyles.centre)}>
      <Spinner label={t`Loading…`} />
    </div>
  );
};

/** The conversation, or what to ask before there is one; `focusBox` takes the person to the box. */
const Thread = ({ focusBox }: { focusBox: () => void }) => {
  const { t } = useLingui();
  const {
    chatId,
    finding,
    view,
    failure,
    empty,
    words,
    ask,
    composer,
    stage: { placement },
  } = useGlobalChat();
  // A subject's chat, while core finds it, or why it gave none.
  if (finding.searching || finding.failure !== undefined) {
    return finding.failure === undefined ? (
      <Loading />
    ) : (
      <div {...stylex.props(panelStyles.centre)}>
        <NotLoaded page={finding.failure} />
        <Button
          onClick={() => {
            finding.retry();
          }}
          size="sm"
        >
          {t`Try again`}
        </Button>
      </div>
    );
  }
  if (chatId === undefined || empty) {
    return <Welcome text={words.empty} />;
  }
  const lastQuestion = view.messages.findLast(({ role }) => role === "user");
  return (
    <Suspense fallback={<Loading />}>
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
          <div {...stylex.props(panelStyles.stack)}>
            {failure === undefined ? null : (
              <Alert variant="danger">{failure}</Alert>
            )}
            {view.stopped === null ? null : (
              <Alert variant="danger">{view.stopped}</Alert>
            )}
            {/* A question stopped before the agent answered (a deploy, say)
              is asked again from here: it may be the chat's first. */}
            {view.stopped !== null &&
            !view.running &&
            lastQuestion !== undefined ? (
              <Button
                icon={Retry}
                layout={panelStyles.start}
                onClick={() => {
                  void ask(lastQuestion.text);
                }}
                size="sm"
              >
                {t`Try again`}
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
    <div {...stylex.props(panelStyles.notice)}>
      <Text size="xs" tone="muted">
        {why.text}
      </Text>
      {onRetry === undefined ? null : (
        <Button
          onClick={() => {
            onRetry();
          }}
          size="xs"
          variant="ghost"
        >
          <Trans>Try again</Trans>
        </Button>
      )}
    </div>
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
    <div {...stylex.props(panelStyles.footer)}>
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
 * Where the cursor goes in the chat: its box's text, or, while Grasp's
 * questions stand in its place, the option picked, or the first.
 */
const boxOf = (body: HTMLElement | null): HTMLElement | null | undefined =>
  body?.querySelector<HTMLElement>("textarea") ??
  body?.querySelector<HTMLElement>('[aria-checked="true"]') ??
  body?.querySelector<HTMLElement>('[role="radio"], [role="checkbox"]');

/**
 * The open chat's body: its thread, the brain's questions on its pages,
 * and the box, which takes the cursor as the chat opens or moves.
 */
const Body = ({ open }: { open: boolean }) => {
  const body = useRef<HTMLDivElement>(null);
  const {
    summary,
    words,
    keptOpen,
    stage: { placement },
  } = useGlobalChat();
  // Escape closes it, or, where it stays open, takes it out of full screen.
  const onEscape = useEffectEvent(() => {
    if (keptOpen) {
      exitFullscreen();
    } else {
      closeChat();
    }
  });
  // Each time it opens, or is drawn anew (App shell may mount its panels
  // again as a layer elsewhere closes): never away from a dialog or menu
  // that has the cursor now, such as the chats window just opened.
  useEffect(() => {
    const elsewhere = document.activeElement?.closest(
      '[role="dialog"], [role="alertdialog"], [role="menu"]'
    );
    if (open && (elsewhere === null || elsewhere === undefined)) {
      boxOf(body.current)?.focus();
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
      // Grasp's questions are the Composer's takeover, whose Escape (back
      // to the text) React hears only after this listener: left to it.
      const inQuestions =
        event.target instanceof Element &&
        event.target.closest('[data-slot="composer-takeover-room"]') !== null;
      if (event.key === "Escape" && !event.defaultPrevented && !inQuestions) {
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
    <div ref={body} {...stylex.props(panelStyles.body)}>
      {/* Full screen, the conversation reads as a column in the middle,
        named by its chat. */}
      <section
        aria-label={summary?.title ?? words.title}
        {...stylex.props(
          panelStyles.body,
          panelStyles.column,
          placement === "fullscreen" && panelStyles.reading
        )}
      >
        <Thread
          focusBox={() => {
            boxOf(body.current)?.focus();
          }}
        />
        <BrainGaps />
        <Footer />
      </section>
    </div>
  );
};

/**
 * Grasp's chat floating over the page, where the person last moved it.
 * Docked and full screen it lives in App shell's panels (`useChatPanels`).
 * It stays mounted while closed, so its card comes and goes as the stage
 * says (chat-stage.ts), and says when it has finished moving.
 */
export const ChatPanel = () => {
  const { t } = useLingui();
  const { stage, delays, settled, presence } = useGlobalChat();
  const { offset } = useChatLayout();
  const floating = stage.card && stage.placement === "floating";
  return (
    <DockablePanel
      defaultOffset={offset ?? undefined}
      delayed={delays.card}
      label={t`Chat`}
      onOffsetChange={moveChat}
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
      open={floating}
      placement="floating"
    >
      <DockablePanelHeader>
        <ChatGrip />
        <div {...stylex.props(panelStyles.title)}>
          <ChatTitle />
        </div>
        <HeaderActions />
      </DockablePanelHeader>
      <Body open={floating} />
    </DockablePanel>
  );
};

/** The open chat as App shell's panel holds it: its head and body, with no frame of its own. */
const ChatPanelContent = () => {
  const { stage } = useGlobalChat();
  return (
    <div {...stylex.props(panelStyles.content)}>
      <div {...stylex.props(panelStyles.head)}>
        <div {...stylex.props(panelStyles.title)}>
          <ChatTitle />
        </div>
        <HeaderActions />
      </div>
      <Body open={stage.card} />
    </div>
  );
};

/** What App shell needs of Grasp's chat for its `panels` slot. */
export interface ChatPanels {
  /** The chat's content while it is docked or full screen; null otherwise. */
  panels: ReactNode;
  /** How wide the docked chat is, in pixels. */
  width: number;
  onWidthChange: (width: number) => void;
  minWidth: number;
  maxWidth: number;
  /** Closes the chat to its idle bar; undefined where it stays open (about the page's subject). */
  onClose: (() => void) | undefined;
  /** Full screen: the chat covers the page. */
  covered: boolean;
}

/**
 * Grasp's chat for App shell's `panels`: its content while docked or full
 * screen, how wide it is and how to resize and close it. Floating stays
 * the old ChatPanel's until App shell has a place for it.
 */
export const useChatPanels = (): ChatPanels => {
  const { stage, keptOpen } = useGlobalChat();
  const { width } = useChatLayout();
  const shown = stage.card && stage.placement !== "floating";
  return {
    panels: shown ? <ChatPanelContent /> : null,
    width,
    onWidthChange: resizeChat,
    minWidth: chatWidth.min,
    maxWidth: chatWidth.max,
    onClose: keptOpen ? undefined : closeChat,
    covered: shown && stage.placement === "fullscreen",
  };
};
