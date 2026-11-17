import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useMatch, useRouteContext, useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";
import type { ReactNode } from "react";

import {
  AppShellPanelBody,
  AppShellPanelHead,
  AppShellPanelTitle,
} from "../grasp/app-shell/index.ts";
import type {
  AppShellPanelPlacement,
  AppShellPanelPosition,
} from "../grasp/app-shell/index.ts";
import { Cross, Edit, External } from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipShortcut,
  TooltipTrigger,
} from "../grasp/tooltip/index.ts";
import { setActiveChat, startAfresh } from "./active-chat.ts";
import { BrainQuestions } from "./brain-questions.tsx";
import { boxOf, ChatConversation, ChatFooter } from "./chat-body.tsx";
import {
  chatWidth,
  closeChat,
  expandChat,
  heightenChat,
  moveChat,
  openChat,
  resizeChat,
  useChatLayout,
} from "./chat-layout.ts";
import { useGoToChat } from "./chat-link.ts";
import { ChatMoreMenu, ChatPanelTitle } from "./chat-more.tsx";
import { allows } from "./chat-presence.ts";
import { chatKey, useGlobalChat } from "./global-chat.tsx";
import { reading } from "./reading.stylex.ts";

// Grasp's chat open (global-chat.tsx), in App shell's panels: docked beside
// the page or floating over it as a window, full screen over the page, and
// back. The shell moves it, sizes it and docks it (drag it to the end edge,
// or pull the docked head out to float it); work keeps where it is
// (chat-layout.ts). Its head: the chat's name, renamed where it stands, the
// shell's switch and full screen, then a new chat, the chat's own page, its
// menu and Close. Then the thread, and the box to ask in, which takes the
// cursor as the chat opens. Escape closes it to its idle bar, which takes
// the cursor back (chat-bar.tsx).

const panelStyles = stylex.create({
  // The chat in App shell's panels: its head, its thread, its box.
  content: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
  },
  body: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
  },
  // The conversation at the body's whole height, so the Thread keeps its
  // own scroll.
  whole: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
  },
  // Full screen, the conversation and the box in the middle, at one reading
  // width: the library's Thread runs the whole width there for now.
  column: {
    width: "100%",
    maxWidth: reading.width,
    marginInline: "auto",
  },
});

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

/** The open chat's name; a chat not made yet is a new chat. */
const ChatTitle = () => {
  const { t } = useLingui();
  const { summary, retitle } = useGlobalChat();
  return summary === undefined ? (
    <AppShellPanelTitle>{t`New chat`}</AppShellPanelTitle>
  ) : (
    // Its own for each chat: one being renamed is never another.
    <ChatPanelTitle chat={summary} key={summary.id} onRenamed={retitle} />
  );
};

/**
 * The head's own buttons, after the shell's switch and full screen: start
 * afresh, open the chat as its own page (chat-page.tsx), its menu, close.
 */
const HeaderActions = () => {
  const { t } = useLingui();
  const { chatId, slot, keptOpen, summary, sourceNames } = useGlobalChat();
  const goToChat = useGoToChat();
  return (
    <>
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
      {/* A chat not made yet has no page until its first question. The
          router's way there, not the head's own link, which loads the app
          anew. */}
      {chatId === undefined ? null : (
        <HeaderButton
          icon={External}
          label={t`Open as a page`}
          onClick={() => {
            goToChat(chatId);
          }}
        />
      )}
      {summary === undefined ? null : (
        <ChatMoreMenu
          chat={summary}
          key={summary.id}
          sourceNames={sourceNames}
        />
      )}
      {/* About the page's subject it stays open (chat-subject.ts). */}
      {keptOpen ? null : (
        <HeaderButton
          icon={Cross}
          label={t`Close`}
          onClick={closeChat}
          shortcut={`mod+${chatKey}`}
        />
      )}
    </>
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
const Body = ({ open, expanded }: { open: boolean; expanded: boolean }) => {
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
        <AppShellPanelBody fill>
          {/* Full screen, the conversation in the middle at its reading width. */}
          <div
            {...stylex.props(panelStyles.whole, expanded && panelStyles.column)}
          >
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
        {/* Full screen, the box stands under the thread's reading column. */}
        <div {...stylex.props(expanded && panelStyles.column)}>
          <ChatFooter chat={chat} />
        </div>
      </section>
    </div>
  );
};

/** The open chat as App shell's panels hold it: its head, its thread and its box. */
export const ChatPanel = () => {
  const { stage } = useGlobalChat();
  const { expanded } = useChatLayout();
  return (
    <div {...stylex.props(panelStyles.content)}>
      <AppShellPanelHead
        actions={<HeaderActions />}
        expanded={expanded}
        onExpandedChange={expandChat}
        title={<ChatTitle />}
      />
      <Body expanded={expanded} open={stage.card} />
    </div>
  );
};

/** What App shell needs of Grasp's chat for its panels. */
export interface ChatPanels {
  /** The chat, while it is open; null otherwise. */
  panels: ReactNode;
  /** How wide the chat is, in pixels. */
  width: number;
  onWidthChange: (width: number) => void;
  minWidth: number;
  maxWidth: number;
  /** Docked beside the page, or floating over it. */
  placement: AppShellPanelPlacement;
  /** Moves it between the two; undefined where this page allows only one. */
  onPlacementChange: ((placement: AppShellPanelPlacement) => void) | undefined;
  /** Where the floating chat was moved; undefined until it was. */
  position: AppShellPanelPosition | undefined;
  onPositionChange: (position: AppShellPanelPosition) => void;
  /** How tall the floating chat was made; undefined until it was. */
  height: number | undefined;
  onHeightChange: (height: number) => void;
  /** Whether it covers the page, full screen. */
  covered: boolean;
  /** Closes the chat to its idle bar; undefined where it stays open (about the page's subject). */
  onClose: (() => void) | undefined;
}

/** Grasp's chat for App shell's panels: where it is, how large, and how to move, size and close it. */
export const useChatPanels = (): ChatPanels => {
  const { stage, keptOpen, presence, roomBeside } = useGlobalChat();
  const layout = useChatLayout();
  // Where the page allows both, and there is room beside it (not a phone).
  const movable =
    roomBeside && allows(presence, "docked") && allows(presence, "floating");
  return {
    panels: stage.card ? <ChatPanel /> : null,
    width: layout.width,
    onWidthChange: resizeChat,
    minWidth: chatWidth.min,
    maxWidth: chatWidth.max,
    placement: stage.placement,
    onPlacementChange: movable
      ? (placement) => {
          openChat(placement);
        }
      : undefined,
    position: layout.position ?? undefined,
    onPositionChange: moveChat,
    height: layout.height ?? undefined,
    onHeightChange: heightenChat,
    covered: stage.card && layout.expanded,
    onClose: keptOpen ? undefined : closeChat,
  };
};
