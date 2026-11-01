import { Button } from "@grasp-os/ui/components/button";
import { Kbd } from "@grasp-os/ui/components/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { useLingui } from "@lingui/react/macro";
import { MessagesSquareIcon } from "lucide-react";
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

// The way to the person's chats window (chat-window.tsx) on every page: ⌘K
// anywhere, and the icon a page's header may show. The window itself, with
// its command list, loads the first time it opens.

const ChatWindow = lazy(async () => {
  const { ChatWindow: window } = await import("./chat-window.tsx");
  return { default: window };
});

const applePlatform = /mac|iphone|ipad/iu;

/** ⌘K on a Mac, Ctrl K elsewhere. */
const shortcutLabel = (): string =>
  typeof navigator !== "undefined" && applePlatform.test(navigator.userAgent)
    ? "⌘K"
    : "Ctrl K";

/** Whether `event` is ⌘K or Ctrl K, and nothing else held. */
const isShortcut = (event: KeyboardEvent): boolean =>
  (event.metaKey || event.ctrlKey) &&
  !event.altKey &&
  !event.shiftKey &&
  event.key.toLowerCase() === "k";

/** A quiet icon in the page's header, named by its tooltip. */
export const HeaderIcon = ({
  label,
  shortcut,
  render,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  /** What it is, when it is a link rather than a button. */
  render?: React.ReactElement;
  onClick?: () => void;
  children: ReactNode;
}) => (
  <Tooltip>
    <TooltipTrigger
      render={
        render ?? (
          <Button
            aria-label={label}
            onClick={onClick}
            size="icon-sm"
            variant="ghost"
          />
        )
      }
    >
      {children}
    </TooltipTrigger>
    <TooltipContent>
      {label}
      {shortcut === undefined ? null : <Kbd>{shortcut}</Kbd>}
    </TooltipContent>
  </Tooltip>
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
      if (!isShortcut(event)) {
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
      shortcut={shortcutLabel()}
    >
      <MessagesSquareIcon />
    </HeaderIcon>
  );
};
