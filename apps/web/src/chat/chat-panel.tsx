import {
  DockablePanel,
  DockablePanelHandle,
  DockablePanelHeader,
} from "@grasp-os/ui/components/dockable-panel";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useMatch, useRouteContext, useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";
import type { ReactNode } from "react";

import { AppShellPanelBody } from "../grasp/app-shell/index.ts";
import { AppWindow, Cross, Edit, Expand } from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipShortcut,
  TooltipTrigger,
} from "../grasp/tooltip/index.ts";
import { setActiveChat, startAfresh } from "./active-chat.ts";
import { BrainQuestions } from "./brain-questions.tsx";
import { boxOf, ChatConversation, ChatFooter } from "./chat-body.tsx";
import type { ChatPlacement } from "./chat-layout.ts";
import {
  chatWidth,
  closeChat,
  moveChat,
  openChat,
  resizeChat,
  useChatLayout,
} from "./chat-layout.ts";
import { useGoToChat } from "./chat-link.ts";
import { ChatTitleMenu } from "./chat-more.tsx";
import { allows } from "./chat-presence.ts";
import { chatKey, useGlobalChat } from "./global-chat.tsx";

const panelStyles = stylex.create({
  // The chat in App shell's panel: its head over its body, filling the panel.
  content: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
  },
  // One bar tall, at the page's room from the card's sides, as App shell's
  // docked panel has it: the line under it meets the line under the page's bar.
  head: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    boxSizing: "border-box",
    minHeight: grasp.shellBar,
    paddingInline: grasp.shellPageInline,
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
  // The thread's box in App shell's panel body: the body's whole height,
  // so the library's Thread keeps its own scroll (it is as tall as its box).
  fill: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
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
  to: ChatPlacement;
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
      aria-label={label}
      onClick={() => {
        onClick();
      }}
      size="sm"
      variant="ghost"
    />
    <TooltipContent>
      {label}
      {shortcut === undefined ? null : <TooltipShortcut />}
    </TooltipContent>
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
 * The header's buttons that move the chat from where it is: floating it
 * over the page, where this page allows that (chat-presence.ts); docking
 * it again is the floating chat's grip.
 */
const MoveButtons = () => {
  const { t } = useLingui();
  const {
    presence,
    roomBeside,
    stage: { placement },
  } = useGlobalChat();
  const moves: Record<ChatPlacement, Move[]> = {
    // In App shell's panel there is no grip to drag it out by: a button floats it.
    docked: [
      { to: "floating", label: t`Float over the page`, icon: AppWindow },
    ],
    // Docking is the grip's: pushed into the dock, or double-clicked.
    floating: [],
  };
  return (
    moves[placement]
      // On a phone there is no page beside it to float over.
      .filter(({ to }) => allows(presence, to) && roomBeside)
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
 * The header's buttons on its right: start afresh, open the chat as its own
 * page (chat-page.tsx), move the chat, close it.
 * They follow where the panel shows, so they don't change while it fades out
 * of one place for the other.
 */
const HeaderActions = () => {
  const { t } = useLingui();
  const { chatId, slot, keptOpen } = useGlobalChat();
  const goToChat = useGoToChat();
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
      {/* A chat not made yet has no page until its first question. */}
      {chatId === undefined ? null : (
        <HeaderButton
          icon={Expand}
          label={t`Open as a page`}
          onClick={() => {
            goToChat(chatId);
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

/**
 * The open chat's body: its thread, the brain's questions on its pages,
 * and the box, which takes the cursor as the chat opens or moves.
 */
const Body = ({ open }: { open: boolean }) => {
  const body = useRef<HTMLDivElement>(null);
  const chat = useGlobalChat();
  const { summary, words, keptOpen } = chat;
  // Escape closes it, where it doesn't stay open (about the page's subject).
  const onEscape = useEffectEvent(() => {
    if (!keptOpen) {
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
      {/* The conversation, named by its chat. */}
      <section
        aria-label={summary?.title ?? words.title}
        {...stylex.props(panelStyles.body)}
      >
        <AppShellPanelBody>
          <div {...stylex.props(panelStyles.fill)}>
            <ChatConversation
              chat={chat}
              compact
              focusBox={() => {
                boxOf(body.current)?.focus();
              }}
            />
          </div>
        </AppShellPanelBody>
        <BrainGaps />
        <ChatFooter chat={chat} />
      </section>
    </div>
  );
};

/**
 * Grasp's chat floating over the page, where the person last moved it.
 * Docked it lives in App shell's panels (`useChatPanels`).
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
  /** The chat's content while it is docked; null otherwise. */
  panels: ReactNode;
  /** How wide the docked chat is, in pixels. */
  width: number;
  onWidthChange: (width: number) => void;
  minWidth: number;
  maxWidth: number;
  /** Closes the chat to its idle bar; undefined where it stays open (about the page's subject). */
  onClose: (() => void) | undefined;
}

/**
 * Grasp's chat for App shell's `panels`: its content while docked, how wide it is and how to resize and close it. Floating stays
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
  };
};
