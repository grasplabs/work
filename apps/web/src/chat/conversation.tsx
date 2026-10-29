import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@grasp-os/ui/components/message-scroller";
import { cn } from "@grasp-os/ui/lib/utils";
import { useEffect, useRef } from "react";
import type { RefObject } from "react";

// A chat's thread that follows the answer as it grows, in the prototype's
// AI Elements conversation (grasplabs/prototype
// `components/ai-elements/conversation.tsx`, ddd235d), on the kit's
// message scroller (`@shadcn/react`) in place of `use-stick-to-bottom`:
// it starts at the end and keeps to it while the person is there; scrolled
// up to read, it stays where they are, and a button brings them back. The
// prototype's empty state and download aren't here: the chat page has its
// own, and the export menu its own Markdown.

/** How long a thread keeps to its end while what is around it settles, in milliseconds. */
const settlesWithinMs = 500;

/**
 * A thread opens at its end, and stays there while what is around it
 * settles: the chat dock's frame rises into place and its box is measured
 * a moment later, so the view gets smaller after the scroller went to the
 * end, and the newest words would slip under the box. For the first half
 * second only, and not once the person scrolls.
 */
const SettleAtEnd = ({
  scroller,
}: {
  scroller: RefObject<HTMLDivElement | null>;
}) => {
  const { scrollToEnd } = useMessageScroller();
  useEffect(() => {
    const element = scroller.current;
    const observer = new ResizeObserver(() => {
      scrollToEnd({ behavior: "auto" });
    });
    const stop = (): void => {
      observer.disconnect();
    };
    const timer = setTimeout(stop, settlesWithinMs);
    if (element !== null) {
      observer.observe(element);
      element.addEventListener("wheel", stop, { once: true, passive: true });
      element.addEventListener("touchmove", stop, {
        once: true,
        passive: true,
      });
    }
    return () => {
      clearTimeout(timer);
      stop();
      element?.removeEventListener("wheel", stop);
      element?.removeEventListener("touchmove", stop);
    };
  }, [scroller, scrollToEnd]);
  return null;
};

/** The thread: it opens at its end and follows it. */
export const Conversation = ({
  className,
  children,
  ...props
}: React.ComponentProps<typeof MessageScroller>) => {
  const scroller = useRef<HTMLDivElement>(null);
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller
        className={cn("min-h-0 flex-1", className)}
        ref={scroller}
        {...props}
      >
        <SettleAtEnd scroller={scroller} />
        {children}
      </MessageScroller>
    </MessageScrollerProvider>
  );
};

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
