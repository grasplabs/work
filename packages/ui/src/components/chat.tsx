// Chat: the thread of a conversation with an assistant: each turn a Message
// inside a MessageScroller that follows the reply while the person stays at the end, the person's
// own turn its scroll anchor, so a new question settles near the top and the reply streams in under
// it; an Empty before the first turn; and the PromptInput under the thread. It composes and
// owns no scrolling: that is MessageScroller's.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <Chat>
//     <ChatMessages aria-label="Conversation with the assistant" aria-busy={streaming}>
//       {messages.length === 0 ? (
//         <ChatEmptyState title="No messages yet" description="Ask anything to start." />
//       ) : (
//         messages.map((message) => (
//           <ChatMessage key={message.id} messageId={message.id} align={message.role === "user" ? "end" : "start"}>
//             <MessageContent>…</MessageContent>
//           </ChatMessage>
//         ))
//       )}
//     </ChatMessages>
//     <PromptInput … />
//   </Chat>
//
// Every value is a token. A caller may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import type { IconData } from "../lib/icons";
import { space } from "../lib/tokens.stylex";
import { isBlank } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./empty";
import { Message } from "./message";
import type { MessageStatus } from "./message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "./message-scroller";
import type { MessageScrollerPosition } from "./message-scroller";

/** Every prop a Chat takes. */
export interface ChatProps {
  /** Anything over the thread (its header), its ChatMessages, then its PromptInput. */
  children: ReactNode;
  /**
   * Where the thread opens: at its latest turn, at the last turn the person started with what
   * followed under it, or at its first.
   * @default "end"
   */
  defaultScrollPosition?: MessageScrollerPosition;
  /**
   * The whole chat is loading: the thread is busy and says so once. Draw MessageSkeletons in
   * ChatMessages meanwhile.
   * @default false
   */
  loading?: boolean;
  /** Its size and where it sits. Give it a height: the thread scrolls inside it. */
  style?: LayoutStyle;
}

/** Every prop a ChatMessages takes. */
export interface ChatMessagesProps {
  /** Its ChatMessages, oldest first, each with a `key`; or a ChatEmptyState before the first. */
  children: ReactNode;
  /**
   * The thread's name, as a screen reader and an agent say it ("Conversation with the assistant").
   * @default the catalogue's messageScroller.label ("Messages")
   */
  "aria-label"?: string;
  /** The id of an element whose words name it (the chat's heading), in place of `aria-label`. */
  "aria-labelledby"?: string;
  /** The thread is busy, as while the reply streams. */
  "aria-busy"?: boolean;
  /** Where it sits. It takes the room Chat leaves. */
  style?: LayoutStyle;
}

/** Every prop a ChatMessage takes. */
export interface ChatMessageProps {
  /**
   * Which end of the line it stands at: `end` for the person's own turn, the thread's scroll
   * anchor, its words in a muted Bubble; `start` for the assistant's.
   * @default "start"
   */
  align?: "start" | "end";
  /** Its id, stable: for jumping to it and telling it apart. */
  messageId: string;
  /**
   * Its MessageContent: a muted Bubble for the person's turn; the assistant's MessageResponse (or a
   * Reasoning first), then its MessageActions and MessageFooter.
   */
  children: ReactNode;
  /**
   * The assistant's message: `thinking`, `streaming`, `done`, `stopped` or `error`.
   * @default "done"
   */
  status?: MessageStatus;
  /**
   * Its name for a screen reader.
   * @default the catalogue's message.user ("You") at the end, message.assistant ("Assistant") at the start
   */
  "aria-label"?: string;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop a ChatEmptyState takes. */
export interface ChatEmptyStateProps {
  /** What stands there before the first turn, in a few words ("No messages yet"). */
  title?: ReactNode;
  /** One sentence under it: how to begin ("Ask anything to start."). */
  description?: ReactNode;
  /** A mark over the words. */
  icon?: IconData;
  /** Anything more under the words, such as suggestions to start from. Replaces nothing. */
  children?: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

const styles = stylex.create({
  // The thread takes the room; what stands over and under it takes its own.
  // The corners of the box it stands in, so the thread's focus ring follows them.
  chat: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
    borderRadius: "inherit",
    cornerShape: "inherit",
  },
  messages: {
    flexGrow: 1,
    flexBasis: 0,
    minHeight: 0,
    borderRadius: "inherit",
    cornerShape: "inherit",
  },
  // Before the first turn: an Empty, centred in the room the thread leaves.
  empty: {
    display: "flex",
    flexGrow: 1,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    padding: space["4"],
  },
  // What stands under the words, at its own width: a step under the sentence, inside the room the
  // Empty keeps at its foot.
  more: {
    maxWidth: "100%",
    marginBlockStart: `calc(${space["2"]} - ${space["4"]})`,
  },
});

/** The chat: a MessageScrollerProvider that follows the reply, round the thread and the field under it. */
export const Chat = ({
  children,
  defaultScrollPosition,
  loading,
  style,
}: ChatProps) => (
  <MessageScrollerProvider
    autoScroll
    defaultScrollPosition={defaultScrollPosition}
    loading={loading}
  >
    <div data-slot="chat" {...stylex.props(styles.chat, style)}>
      {children}
    </div>
  </MessageScrollerProvider>
);

/** The thread: a MessageScroller with its log, its turns and the way back to the latest. */
export const ChatMessages = ({
  children,
  "aria-label": label,
  "aria-labelledby": labelledBy,
  "aria-busy": busy,
  style,
}: ChatMessagesProps) => (
  <div data-slot="chat-messages" {...stylex.props(styles.messages, style)}>
    <MessageScroller>
      <MessageScrollerViewport aria-label={label} aria-labelledby={labelledBy}>
        <MessageScrollerContent aria-busy={busy}>
          {children}
        </MessageScrollerContent>
      </MessageScrollerViewport>
      <MessageScrollerButton />
    </MessageScroller>
  </div>
);

/** One turn: a Message in its row of the thread, the person's own the scroll anchor. */
export const ChatMessage = ({
  align = "start",
  messageId,
  children,
  status,
  "aria-label": label,
  style,
}: ChatMessageProps) => (
  <MessageScrollerItem
    messageId={messageId}
    scrollAnchor={align === "end"}
    style={style}
  >
    <Message align={align} status={status} aria-label={label}>
      {children}
    </Message>
  </MessageScrollerItem>
);

/** What stands in the thread before the first turn: an Empty, its mark, title and sentence centred. */
export const ChatEmptyState = ({
  title,
  description,
  icon,
  children,
  style,
}: ChatEmptyStateProps) => (
  <div data-slot="chat-empty-state" {...stylex.props(styles.empty, style)}>
    <Empty size="sm">
      <EmptyHeader>
        <EmptyMedia icon={icon} />
        <EmptyTitle>{title}</EmptyTitle>
        {description !== undefined && (
          <EmptyDescription>{description}</EmptyDescription>
        )}
      </EmptyHeader>
    </Empty>
    {!isBlank(children) && <div {...stylex.props(styles.more)}>{children}</div>}
  </div>
);
