import {
  createContext,
  lazy,
  Suspense,
  use,
  useEffect,
  useEffectEvent,
  useState,
} from "react";
import type { ReactNode } from "react";

import { isShortcut } from "../shortcuts.ts";

// The way to the person's chats window (chat-window.tsx) on every page: ⌘K
// anywhere but rich text, and the sidebar's search. The window itself, with
// its command list, loads the first time it opens. The keys are the
// product's, not the sidebar's (AppShellSidebar's `listenToSearchShortcut`):
// they close the window again, where Damsko's, as every page shortcut,
// pause while a modal is open (registry gap of 27 Nov 2026).

const ChatWindow = lazy(async () => {
  const { ChatWindow: window } = await import("./chat-window.tsx");
  return { default: window };
});

/** The chats window's key: ⌘K, or Ctrl K off a Mac. */
export const chatsKey = "k";

/** Opens (or closes) the frame's chats window. */
const OpenChats = createContext<(open: boolean) => void>(() => {
  // Outside the frame there is no window to open.
});

/**
 * The frame's chats window, on every page: ⌘K or Ctrl K opens it (and
 * closes it again), as does the sidebar's search. Not in rich text, where
 * the same keys shape the text, as the sidebar's own keys do.
 */
export const ChatSwitcherProvider = ({ children }: { children: ReactNode }) => {
  const [open, setOpen] = useState(false);
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
      const active = document.activeElement;
      if (
        !isShortcut(event, chatsKey) ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) {
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
      {children}
      {opened ? (
        <Suspense fallback={null}>
          <ChatWindow onOpenChange={setOpen} open={open} />
        </Suspense>
      ) : null}
    </OpenChats>
  );
};

/** Opens (or closes) the frame's chats window, as ⌘K does. */
export const useChatsWindow = (): ((open: boolean) => void) => use(OpenChats);
