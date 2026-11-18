import type { ChatSummary } from "@grasp-os/shared/chat";
import { useMatchRoute } from "@tanstack/react-router";
import { createContext, use, useEffect, useEffectEvent, useState } from "react";
import type { ReactNode } from "react";

import { isShortcut } from "../shortcuts.ts";
import { chatLink } from "./chat-link.ts";
import { ChatWindow } from "./chat-window.tsx";
import { DeleteChatDialog } from "./delete-chat-dialog.tsx";

// The way to the person's chats window (chat-window.tsx) on every page: ⌘K
// anywhere, and the sidebar's "All chats"; and the one delete
// dialog the sidebar's chat rows ask in. The window comes with the page,
// not as a chunk of its own: fetched on the first press, it opened a
// second late. It opens at once and fills in as core answers.

/** The chats window's key: ⌘K, or Ctrl K off a Mac. */
export const chatsKey = "k";

/** Asks to delete a chat, behind the frame's one delete dialog (the sidebar's row menu). */
const AskDelete = createContext<(chat: ChatSummary) => void>(() => {
  // Outside the frame there is no dialog to ask in.
});

/**
 * The frame's delete dialog, for a chat asked of it: the same question as
 * the chats window and the chat's own menu ask. A chat deleted while its
 * page is open leaves it for a new chat.
 */
const DeleteAsked = ({
  chat,
  onDone,
}: {
  chat: ChatSummary;
  onDone: () => void;
}) => {
  const onItsPage = useMatchRoute()(chatLink(chat.id)) !== false;
  return (
    <DeleteChatDialog
      active={onItsPage}
      chat={chat}
      onOpenChange={(next) => {
        if (!next) {
          onDone();
        }
      }}
      open
    />
  );
};

/** Asks to delete a chat, behind the frame's delete dialog. */
export const useAskDeleteChat = (): ((chat: ChatSummary) => void) =>
  use(AskDelete);

/** Opens (or closes) the frame's chats window. */
const OpenChats = createContext<(open: boolean) => void>(() => {
  // Outside the frame there is no window to open.
});

/**
 * The frame's chats window, on every page: ⌘K or Ctrl K opens it (and
 * closes it again), as does the sidebar's "All chats" ({@link useChatsWindow}).
 */
export const ChatSwitcherProvider = ({ children }: { children: ReactNode }) => {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<ChatSummary>();
  // Kept once opened, so it closes as a dialog does, not all at once.
  const [opened, setOpened] = useState(false);
  if (open && !opened) {
    setOpened(true);
  }
  const toggle = useEffectEvent(() => {
    setOpen(!open);
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!isShortcut(event, chatsKey)) {
        return;
      }
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  return (
    <OpenChats value={setOpen}>
      <AskDelete value={setDeleting}>{children}</AskDelete>
      {deleting === undefined ? null : (
        <DeleteAsked
          chat={deleting}
          onDone={() => {
            setDeleting(undefined);
          }}
        />
      )}
      {opened ? <ChatWindow onOpenChange={setOpen} open={open} /> : null}
    </OpenChats>
  );
};

/** Opens (or closes) the frame's chats window, as ⌘K does. */
export const useChatsWindow = (): ((open: boolean) => void) => use(OpenChats);
