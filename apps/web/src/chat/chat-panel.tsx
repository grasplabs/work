import type { ChatSummary } from "@grasp-os/shared/chat";
import type { DropdownMenuMoreItem } from "@grasp-os/ui/components/dropdown-menu";
import { PencilIcon } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import {
  Link,
  useMatch,
  useRouteContext,
  useRouter,
} from "@tanstack/react-router";
import { bindLayer } from "@ui-sdk/core";
import { useEffect, useEffectEvent, useRef } from "react";
import type { ReactNode } from "react";

import type { PanelPlacement } from "../frame/panels/float-window.tsx";
import type { PanelPosition } from "../frame/panels/floating.ts";
import { PanelBody, PanelHead, PanelTitle } from "../frame/panels/head.tsx";
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
import { useChatMenu, useRenameChat } from "./chat-more.tsx";
import { allows, useOpenChat } from "./chat-presence.ts";
import { useGlobalChat } from "./global-chat.tsx";
import { reading } from "./reading.stylex.ts";

// Grasp's chat open (global-chat.tsx), in the frame's panels
// (frame/panels): docked beside the page or floating over it as a window,
// full screen over the page, and back, as #2503 has it. The panels move it,
// size it and dock it (drag it to the end edge, or pull the docked head out
// to float it); where it is is kept (chat-layout.ts). Its head: the chat's
// name, renamed where it stands, full screen, and "…" with the switch, the
// chat's own page, a new chat and the chat's own menu; then Close. Then the
// thread, and the box to ask in, which takes the cursor as the chat opens.
// Escape closes it to its idle bar, which takes the cursor back
// (chat-bar.tsx).

const panelStyles = stylex.create({
  // The chat in the panels: its head, its thread, its box.
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
  // The conversation at the body's whole height, so the thread keeps its
  // own scroll.
  whole: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
  },
  // Full screen, the conversation and the box in the middle, at one
  // reading width.
  column: {
    width: "100%",
    maxWidth: reading.width,
    marginInline: "auto",
  },
});

/** "New chat" as an item of the head's menu, once a chat is open. */
const useFreshItem = (): DropdownMenuMoreItem[] => {
  const { t } = useLingui();
  const { chatId, slot } = useGlobalChat();
  return chatId === undefined
    ? []
    : [
        {
          label: t`New chat`,
          icon: PencilIcon,
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
  menu: readonly DropdownMenuMoreItem[];
  /**
   * The chat's name, a PanelTitle itself, so the head offers Rename in
   * its menu where the title takes `onRename`.
   */
  title: ReactNode;
}

/**
 * The panels' head: the chat's name (renamed where it stands), full
 * screen, the "…" with the head's own items and ours, and close. About the
 * page's subject the chat stays open, so it has no close
 * (chat-subject.ts).
 */
const Head = ({ expanded, menu, title }: HeadProps) => {
  const { chatId, keptOpen } = useGlobalChat();
  return (
    <PanelHead
      expanded={expanded}
      menu={menu}
      onExpandedChange={expandChat}
      {...(keptOpen ? {} : { onClose: closeChat })}
      // A chat not made yet has no page until its first question. The
      // router's link, so opening it doesn't load the app anew.
      {...(chatId === undefined
        ? {}
        : { pageRender: <Link {...chatLink(chatId)} /> })}
      title={title}
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
  fresh: readonly DropdownMenuMoreItem[];
}) => {
  const { sourceNames, retitle } = useGlobalChat();
  const { actions, dialog } = useChatMenu({ chat, sourceNames });
  const {
    onRename: handleRename,
    maxLength,
    errorText,
  } = useRenameChat(chat.id, retitle);
  return (
    <>
      <Head
        expanded={expanded}
        menu={[...fresh, ...actions]}
        title={
          <PanelTitle
            onRename={handleRename}
            renameErrorText={errorText}
            renameMaxLength={maxLength}
          >
            {chat.title}
          </PanelTitle>
        }
      />
      {dialog}
    </>
  );
};

/** The panel's head, for a chat not made yet or the open one. */
const PanelHeadOfChat = ({ expanded }: { expanded: boolean }) => {
  const { t } = useLingui();
  const { summary } = useGlobalChat();
  const fresh = useFreshItem();
  return summary === undefined ? (
    <Head
      expanded={expanded}
      menu={fresh}
      title={<PanelTitle>{t`New chat`}</PanelTitle>}
    />
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
  const { summary, words, keptOpen } = chat;
  // Escape closes it, or, where it stays open, takes it out of full screen.
  const onEscape = useEffectEvent(() => {
    if (keptOpen) {
      expandChat(false);
    } else {
      closeChat();
    }
  });
  // Each time it opens: never away from a dialog or menu that has the
  // cursor now, such as the chats window just opened.
  useEffect(() => {
    const elsewhere = document.activeElement?.closest(
      '[role="dialog"], [role="alertdialog"], [role="menu"]'
    );
    if (open && (elsewhere === null || elsewhere === undefined)) {
      boxOf(body.current)?.focus();
    }
  }, [open]);
  // While open, the whole chat is a layer in UI SDK's stack, as Damsko's
  // menus, pickers, popovers and dialogs are: Escape goes to the topmost
  // layer alone, so whatever was opened in the chat closes first, and the
  // chat only once nothing of its own is open on top. An Escape pressed
  // outside it is not its own.
  useEffect(() => {
    const panels =
      body.current?.closest<HTMLElement>("[data-slot=app-shell-panels]") ??
      null;
    if (!open || panels === null) {
      return () => {
        // Nothing was bound.
      };
    }
    return bindLayer(panels, {
      onDismiss: (reason, event) => {
        if (
          reason === "escape-key" &&
          event.target instanceof Node &&
          panels.contains(event.target)
        ) {
          onEscape();
        }
      },
    });
  }, [open]);
  return (
    <div ref={body} {...stylex.props(panelStyles.body)}>
      {/* The conversation, named by its chat. */}
      <section
        aria-label={summary?.title ?? words.title}
        {...stylex.props(panelStyles.body)}
      >
        <PanelBody fill>
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
              // Each chat opened here opens afresh (unread.ts).
              key={chat.chatId}
              // The panel stays while it is closed: nobody reads it then.
              seen={open}
            />
          </div>
        </PanelBody>
        <BrainGaps />
        {/* Full screen, the box stands under the thread's reading column. */}
        <div {...stylex.props(expanded && panelStyles.column)}>
          {/* The panel stays while it is closed: nothing listens from it then. */}
          <ChatFooter chat={chat} listening={open} />
        </div>
      </section>
    </div>
  );
};

/** The open chat as the panels hold it: its head, its thread and its box. */
export const ChatPanel = () => {
  const { t } = useLingui();
  const { stage } = useGlobalChat();
  const { expanded } = useChatLayout();
  return (
    // A landmark of its own, as the chat beside a page always was: the
    // way to it for a screen reader, whatever its head says.
    <section aria-label={t`Chat`} {...stylex.props(panelStyles.content)}>
      <PanelHeadOfChat expanded={expanded} />
      <Body expanded={expanded} open={stage.card} />
    </section>
  );
};

/** What the frame's panels need of Grasp's chat. */
export interface ChatPanels {
  /** The chat, wherever it may show on this page, open or not; null where it may not. */
  panels: ReactNode;
  /** Whether it is open beside or over the page. */
  open: boolean;
  /**
   * Opens and closes it from the card's own button, at every width; none
   * where it stays open (about the page's subject), where a button that
   * can't close it would do nothing.
   */
  onOpenChange: ((open: boolean) => void) | undefined;
  /** How wide the chat is, in pixels. */
  width: number;
  onWidthChange: (width: number) => void;
  minWidth: number;
  maxWidth: number;
  /** Docked beside the page, or floating over it. */
  placement: PanelPlacement;
  /** Moves it between the two; undefined where this page allows only one. */
  onPlacementChange: ((placement: PanelPlacement) => void) | undefined;
  /** Where the floating chat was moved; undefined until it was. */
  position: PanelPosition | undefined;
  onPositionChange: (position: PanelPosition) => void;
  /** How tall the floating chat was made; undefined until it was. */
  height: number | undefined;
  onHeightChange: (height: number) => void;
  /** Whether it covers the page, full screen. */
  covered: boolean;
  /** Closes the chat to its idle bar; undefined where it stays open (about the page's subject). */
  onClose: (() => void) | undefined;
}

/** Grasp's chat for the frame's panels: where it is, how large, and how to move, size and close it. */
export const useChatPanels = (): ChatPanels => {
  const { stage, keptOpen, presence, roomBeside, available } = useGlobalChat();
  const layout = useChatLayout();
  const openHere = useOpenChat();
  // Where the page allows both, and there is room beside it (not a phone).
  const movable =
    roomBeside && allows(presence, "docked") && allows(presence, "floating");
  return {
    // Given wherever it may show, so the card's own button stands there
    // open or closed, a way back to a closed chat at every width.
    panels: available ? <ChatPanel /> : null,
    open: stage.card,
    onOpenChange: keptOpen
      ? undefined
      : (open) => {
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
    onClose: keptOpen ? undefined : closeChat,
  };
};
