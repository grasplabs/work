import type { AppShellSidebarProps } from "@grasp-os/ui/blocks/app-shell-01/app-shell-01";
import { createContext, lazy, Suspense, use, useState } from "react";
import type { ReactNode } from "react";

// The way to the person's chats window (chat-window.tsx) on every page: ⌘K
// anywhere, the chat's box too, and the sidebar's search. The window
// itself, with its command list, loads the first time it opens. The keys
// are the sidebar's search keys (AppShellSidebar, `useChatsSearch`): they
// open the window from anywhere, rich text such as the chat's box too
// (no editor of the product's binds them), and close it again from inside.

const ChatWindow = lazy(async () => {
  const { ChatWindow: window } = await import("./chat-window.tsx");
  return { default: window };
});

/** The chats window's key: ⌘K, or Ctrl K off a Mac. */
export const chatsKey = "k";

/** Whether the frame's chats window is open, and what opens or closes it. */
interface ChatsWindowState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const ChatsWindow = createContext<ChatsWindowState>({
  open: false,
  setOpen: () => {
    // Outside the frame there is no window to open.
  },
});

/**
 * The frame's chats window, on every page: the sidebar's search and its
 * keys, ⌘K or Ctrl K, open it, and the keys close it again.
 */
export const ChatSwitcherProvider = ({ children }: { children: ReactNode }) => {
  const [open, setOpen] = useState(false);
  // Kept once opened, so it closes as a dialog does, not all at once.
  const [opened, setOpened] = useState(false);
  if (open && !opened) {
    setOpened(true);
  }
  return (
    // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
    <ChatsWindow value={{ open, setOpen }}>
      {children}
      {opened ? (
        <Suspense fallback={null}>
          <ChatWindow onOpenChange={setOpen} open={open} />
        </Suspense>
      ) : null}
    </ChatsWindow>
  );
};

/** Opens (or closes) the frame's chats window, as ⌘K does. */
export const useChatsWindow = (): ((open: boolean) => void) =>
  use(ChatsWindow).setOpen;

/**
 * The sidebar's search as the chats window: its button and its keys, ⌘K or
 * Ctrl K, open the window, and the keys close it again while it is open.
 */
export const useChatsSearch = (): Pick<
  AppShellSidebarProps,
  "searchOpen" | "onSearchOpenChange" | "searchShortcut"
> => {
  const { open, setOpen } = use(ChatsWindow);
  return {
    searchOpen: open,
    onSearchOpenChange: setOpen,
    searchShortcut: `mod+${chatsKey}`,
  };
};
