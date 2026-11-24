import { Button } from "@grasp-os/ui/components/button";
import { Icon, MessageSquareIcon } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
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

import { isShortcut, shortcutLabel } from "../shortcuts.ts";

// The way to the person's chats window (chat-window.tsx) on every page: ⌘K
// anywhere, and the icon a page's header may show. The window itself, with
// its command list, loads the first time it opens.

const ChatWindow = lazy(async () => {
  const { ChatWindow: window } = await import("./chat-window.tsx");
  return { default: window };
});

/** The chats window's key: ⌘K, or Ctrl K off a Mac. */
export const chatsKey = "k";

/** A quiet icon in the page's header, named by its tooltip, its key beside its name there. */
export const HeaderIcon = ({
  label,
  shortcut,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  onClick?: () => void;
  children: ReactNode;
}) => (
  <Button
    aria-label={label}
    onClick={onClick}
    size="icon-sm"
    tooltip={shortcut === undefined ? label : `${label} (${shortcut})`}
    variant="ghost"
  >
    {children}
  </Button>
);

/** Opens (or closes) the frame's chats window. */
const OpenChats = createContext<(open: boolean) => void>(() => {
  // Outside the frame there is no window to open.
});

/**
 * The frame's chats window, on every page: ⌘K or Ctrl K opens it (and
 * closes it again), as does a page's {@link ChatSwitcherButton}.
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

/** The quiet icon in a page's header that opens the chats window. */
export const ChatSwitcherButton = () => {
  const { t } = useLingui();
  const setOpen = use(OpenChats);
  return (
    <HeaderIcon
      label={t`Chats`}
      onClick={() => {
        setOpen(true);
      }}
      shortcut={shortcutLabel(chatsKey)}
    >
      <Icon icon={MessageSquareIcon} />
    </HeaderIcon>
  );
};
