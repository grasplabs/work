import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@grasp-os/ui/components/message-scroller";
import { cn } from "@grasp-os/ui/lib/utils";

// A chat's thread that follows the answer as it grows, in the prototype's
// AI Elements conversation (grasplabs/prototype
// `components/ai-elements/conversation.tsx`, ddd235d), on the kit's
// message scroller (`@shadcn/react`) in place of `use-stick-to-bottom`:
// it starts at the end and keeps to it while the person is there; scrolled
// up to read, it stays where they are, and a button brings them back. The
// prototype's empty state and download aren't here: the chat page has its
// own, and the export menu its own Markdown.

/** The thread: it opens at its end and follows it. */
export const Conversation = ({
  className,
  children,
  ...props
}: React.ComponentProps<typeof MessageScroller>) => (
  <MessageScrollerProvider autoScroll defaultScrollPosition="end">
    <MessageScroller className={cn("min-h-0 flex-1", className)} {...props}>
      {children}
    </MessageScroller>
  </MessageScrollerProvider>
);

/** What the thread scrolls through, named for assistive technology. */
export const ConversationContent = ({
  label,
  className,
  children,
}: {
  /** The thread's name: the scrolling region is a landmark. */
  label: string;
  className?: string;
  children: React.ReactNode;
}) => (
  <MessageScrollerViewport aria-label={label}>
    <MessageScrollerContent className={className}>
      {children}
    </MessageScrollerContent>
  </MessageScrollerViewport>
);

/** Back to the newest message, shown while the person has scrolled up. */
export const ConversationScrollButton = ({ label }: { label: string }) => (
  <MessageScrollerButton aria-label={label} size="icon" variant="outline" />
);
