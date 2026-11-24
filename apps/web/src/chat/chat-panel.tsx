import {
  DockablePanel,
  DockablePanelHandle,
  DockablePanelHeader,
  useDockablePanel,
} from "@grasp-os/app-kit/components/dockable-panel";
import type { DockablePlacement } from "@grasp-os/app-kit/components/dockable-panel";
import { Panel } from "@grasp-os/app-kit/components/panel";
import { Text } from "@grasp-os/ui/components/text";
import { Icon, Maximize2Icon, PencilIcon, XIcon } from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
// Damsko's icon module has no "exit full screen": Hugeicons' own drawing,
// Expand's pair (Maximize2Icon is ArrowExpand01Icon), through Damsko's Icon.
import { ArrowShrink01Icon } from "@hugeicons/core-free-icons";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useMatch, useRouteContext, useRouter } from "@tanstack/react-router";
import { bindLayer } from "@ui-sdk/core";
import { useEffect, useEffectEvent, useRef } from "react";

import { shortcutLabel } from "../shortcuts.ts";
import { setActiveChat, startAfresh } from "./active-chat.ts";
import { AgentName, agentModelOf } from "./agent-choice.tsx";
import { AskOrCompose } from "./asked-questions.tsx";
import { BrainQuestions } from "./brain-questions.tsx";
import { BuildsFailure, workOf } from "./builds.tsx";
import { ChatConversation } from "./chat-body.tsx";
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
import { chatKey, useGlobalChat } from "./global-chat.tsx";
import { pendingCard } from "./make-card.tsx";
import {
  ModelsUnavailableNotice,
  unavailableText,
} from "./models-unavailable.tsx";
import { ChatSources } from "./sources.tsx";
import { SubjectBarContent, subjectBarOf } from "./subject-bar.tsx";

// Grasp's chat open (global-chat.tsx): one panel, docked beside the page or
// floating over it as a window the person moves by its header. A header with
// the person's recent chats and the ways to start afresh, move the chat or
// close it; the thread; and the box to ask in, which takes the cursor as the
// chat opens. Escape closes it to its idle bar, which takes the cursor back
// (chat-bar.tsx).

const styles = stylex.create({
  newChat: { minWidth: 0, paddingInline: space["2"] },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: space["1"],
    marginInlineStart: "auto",
  },
  footer: {
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    gap: space["1"],
    paddingInline: space["4"],
    paddingBlockStart: space["2"],
    paddingBlockEnd: space["4"],
  },
  body: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
  },
  column: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    width: "100%",
    minHeight: 0,
    marginInline: "auto",
  },
  // Full screen, the conversation and the box read as one column in the middle.
  fullscreen: { maxWidth: "48rem" },
  // There the box is as far in as the thread's words, and as wide (#2503).
  footerFullscreen: { paddingInline: space["8"] },
  boxFullscreen: { maxWidth: "100%" },
});

/**
 * The open chat's title at the head of the chat, renamed where it stands,
 * with its menu; a chat not made yet is a new chat.
 */
const ChatTitle = () => {
  const { summary, sourceNames, retitle } = useGlobalChat();
  if (summary === undefined) {
    return (
      <span {...stylex.props(styles.newChat)}>
        <Text as="span" color="muted" size="sm" truncate weight="medium">
          <Trans>New chat</Trans>
        </Text>
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
  icon: IconData;
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
    docked: [{ to: "fullscreen", label: t`Full screen`, icon: Maximize2Icon }],
    fullscreen: [
      { to: "docked", label: t`Exit full screen`, icon: ArrowShrink01Icon },
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
        <Icon icon={icon} />
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
    <div {...stylex.props(styles.actions)}>
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
          <Icon icon={PencilIcon} />
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
          <Icon icon={XIcon} />
        </HeaderIcon>
      )}
    </div>
  );
};

/** The conversation, or what to ask before there is one; `focusBox` takes the person to the box. */
const Thread = ({ focusBox }: { focusBox: () => void }) => {
  const chat = useGlobalChat();
  const { placement } = useDockablePanel();
  return (
    <ChatConversation
      chat={chat}
      compact={placement !== "fullscreen"}
      focusBox={focusBox}
    />
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

/** The box to ask in, or the agent's questions in its place; dictating only while the chat is open. */
const Footer = ({ open }: { open: boolean }) => {
  const { t } = useLingui();
  const fullscreen = useDockablePanel().placement === "fullscreen";
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
  const unavailable = unavailableText(modelsUnavailable);
  // Which of the company's agents answers here, where there are several.
  const agents = offered?.agents ?? [];
  // Under a card that waits for the person, the box is where to change it.
  const waiting = pendingCard(view.messages, view.running)?.kind;
  const changeWords = {
    planned: t`Change something about the plan`,
    agentDraft: t`Change something about the agent`,
    agentChange: t`Change something about the change`,
  };
  const placeholder =
    waiting === undefined ? words.placeholder : changeWords[waiting];
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
    <div
      {...stylex.props(styles.footer, fullscreen && styles.footerFullscreen)}
    >
      <BuildsFailure read={builds} />
      <ChatSources names={sourceNames} provenance={view.provenance} />
      <AskOrCompose
        {...composer}
        {...(unavailable === undefined ? {} : { unavailable })}
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
        // The panel stays while it is closed: nothing listens from it then.
        dictates={open}
        style={fullscreen ? styles.boxFullscreen : undefined}
        label={words.title}
        onAnswer={async (text) => await ask(text)}
        // The box's editor takes its placeholder as it starts: another
        // starts it afresh, with the text it holds.
        key={placeholder}
        placeholder={placeholder}
        running={view.running}
      />
      <ModelsUnavailableNotice onRetry={retry} why={modelsUnavailable} />
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
  // While open, the whole chat is a layer in UI SDK's stack, as Damsko's
  // menus, pickers, popovers and dialogs are: Escape goes to the topmost
  // layer alone, so whatever was opened in the chat closes first, and the
  // chat only once nothing of its own is open on top. An Escape pressed
  // outside it is not its own.
  useEffect(() => {
    const chat =
      body.current?.closest<HTMLElement>('[data-slot="dockable-panel-card"]') ??
      null;
    if (!open || chat === null) {
      return () => {
        // Nothing was bound.
      };
    }
    return bindLayer(chat, {
      onDismiss: (reason, event) => {
        if (
          reason === "escape-key" &&
          event.target instanceof Node &&
          chat.contains(event.target)
        ) {
          onEscape();
        }
      },
    });
  }, [open]);
  return (
    <div ref={body} {...stylex.props(styles.body)}>
      {/* Full screen, the conversation reads as a column in the middle,
        named by its chat. */}
      <section
        aria-label={summary?.title ?? words.title}
        {...stylex.props(
          styles.column,
          placement === "fullscreen" && styles.fullscreen
        )}
      >
        <Thread
          focusBox={() => {
            body.current
              ?.querySelector<HTMLElement>('[role="textbox"]')
              ?.focus();
          }}
        />
        <BrainGaps />
        <Footer open={open} />
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
