import type { ChatSummary } from "@grasp-os/shared/chat";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import {
  Link,
  useMatch,
  useRouteContext,
  useRouter,
} from "@tanstack/react-router";
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
import type { DropdownMenuAction } from "../grasp/dropdown-menu/index.ts";
import { Edit } from "../grasp/icons/index.ts";
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
import { chatLink } from "./chat-link.ts";
import { ChatPanelTitle, useChatMenu } from "./chat-more.tsx";
import { allows, useOpenChat } from "./chat-presence.ts";
import { useGlobalChat } from "./global-chat.tsx";
import { reading } from "./reading.stylex.ts";

// Grasp's chat open (global-chat.tsx), in App shell's panels: docked beside
// the page or floating over it as a window, full screen over the page, and
// back. The shell moves it, sizes it and docks it (drag it to the end edge,
// or pull the docked head out to float it); work keeps where it is
// (chat-layout.ts). Its head: the chat's name, renamed where it stands, the
// shell's switch, full screen and the chat's own page, then a new chat, its
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

/** "New chat" as an item of the head's menu, once a chat is open. */
const useFreshItem = (): DropdownMenuAction[] => {
  const { t } = useLingui();
  const { chatId, slot } = useGlobalChat();
  return chatId === undefined
    ? []
    : [
        {
          label: t`New chat`,
          icon: Edit,
          onSelect: () => {
            // A subject's slot would find the chat that last worked on it
            // again: it starts afresh instead.
            if (slot === "chat") {
              setActiveChat(undefined);
            } else {
              startAfresh(slot);
            }
          },
        },
      ];
};

/** What every head of the chat's panel takes, whatever is open in it. */
interface HeadProps {
  expanded: boolean;
  menu: readonly DropdownMenuAction[];
}

/**
 * The library's window head: the chat's name (renamed where it stands),
 * full screen, the "…" with the head's own items and ours, and close.
 */
const Head = ({ expanded, menu }: HeadProps) => {
  const { chatId } = useGlobalChat();
  return (
    <AppShellPanelHead
      expanded={expanded}
      menu={menu}
      onExpandedChange={expandChat}
      onClose={closeChat}
      // A chat not made yet has no page until its first question. The
      // router's link, so opening it doesn't load the app anew.
      {...(chatId === undefined
        ? {}
        : {
            pageHref: `/chats/${chatId}`,
            pageRender: <Link {...chatLink(chatId)} />,
          })}
      title={<ChatTitle />}
    />
  );
};

/** The head of an open chat: its own menu after "New chat", and the delete's dialog. */
const OpenChatHead = ({
  chat,
  expanded,
  fresh,
}: {
  chat: ChatSummary;
  expanded: boolean;
  fresh: readonly DropdownMenuAction[];
}) => {
  const { sourceNames } = useGlobalChat();
  const { actions, dialog } = useChatMenu({ chat, sourceNames });
  return (
    <>
      <Head expanded={expanded} menu={[...fresh, ...actions]} />
      {dialog}
    </>
  );
};

/** The panel's head, for a chat not made yet or the open one. */
const PanelHead = ({ expanded }: { expanded: boolean }) => {
  const { summary } = useGlobalChat();
  const fresh = useFreshItem();
  return summary === undefined ? (
    <Head expanded={expanded} menu={fresh} />
  ) : (
    // Its own for each chat: a delete opened for one is never another's.
    <OpenChatHead
      chat={summary}
      expanded={expanded}
      fresh={fresh}
      key={summary.id}
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

/**
 * The open chat's body: its thread, the brain's questions on its pages,
 * and the box, which takes the cursor as the chat opens or moves.
 */
const Body = ({ open, expanded }: { open: boolean; expanded: boolean }) => {
  const body = useRef<HTMLDivElement>(null);
  const chat = useGlobalChat();
  const { summary, words } = chat;
  // Escape closes it.
  const onEscape = useEffectEvent(() => {
    closeChat();
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
      <PanelHead expanded={expanded} />
      <Body expanded={expanded} open={stage.card} />
    </div>
  );
};

/** What App shell needs of Grasp's chat for its panels. */
export interface ChatPanels {
  /** The chat, wherever it may show on this page, open or not; null where it may not. */
  panels: ReactNode;
  /** Whether it is open beside or over the page. */
  open: boolean;
  /**
   * Opens and closes it from App shell's own button, at the bar's end at
   * every width; none where it stays open (about the page's subject), where
   * a button that can't close it would do nothing.
   */
  onOpenChange: ((open: boolean) => void) | undefined;
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
  const { stage, presence, roomBeside, available } = useGlobalChat();
  const layout = useChatLayout();
  const openHere = useOpenChat();
  // Where the page allows both, and there is room beside it (not a phone).
  const movable =
    roomBeside && allows(presence, "docked") && allows(presence, "floating");
  return {
    // Given wherever it may show, so the shell's own button stands there
    // open or closed, a way back to a closed chat at every width.
    panels: available ? <ChatPanel /> : null,
    open: stage.card,
    onOpenChange: (open) => {
      if (open) {
        openHere();
      } else {
        closeChat();
      }
    },
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
    onClose: closeChat,
  };
};
