import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";

import { SiteHeader } from "../frame/site-header.tsx";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { setActiveChat } from "./active-chat.ts";
import { boxOf, ChatConversation, ChatFooter } from "./chat-body.tsx";
import type { ChatBodyValues } from "./chat-body.tsx";
import { useChatSession, useGlobalChat } from "./global-chat.tsx";
import { reading } from "./reading.stylex.ts";

// A chat as its own page (routes/_shell.chats.$chatId.tsx): its title in
// the page's bar, the conversation in one reading column down the card,
// and the box to ask in at its foot. The chat is the address's; what the
// shell knows of asking (the models, the sources' names, Grasp's words)
// is the one chat's of the frame (global-chat.tsx). The layout is kept
// thin, to take the library's chat page pattern once it lands.

const styles = stylex.create({
  // The page down the card: the column takes what the bar leaves.
  page: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
  },
  // One reading column in the middle: the thread over the box.
  column: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    width: "100%",
    maxWidth: reading.width,
    marginInline: "auto",
    paddingBlockStart: grasp.space2,
    paddingInline: grasp.space4,
  },
});

/** A page's chat is never about a subject, nor found for one. */
const noFinding: ChatBodyValues["finding"] = {
  searching: false,
  failure: undefined,
  retry: () => {
    // Nothing is found for a chat the address names.
  },
};

const noSubject: ChatBodyValues["subject"] = {
  about: undefined,
  name: undefined,
};

/** Chat `chatId`'s page; `title` as core named it when the page loaded. */
export const ChatPage = ({
  chatId,
  title,
}: {
  chatId: string;
  title: string | undefined;
}) => {
  const page = useRef<HTMLDivElement>(null);
  const { offered, words, modelsUnavailable, retry, sourceNames } =
    useGlobalChat();
  const session = useChatSession(chatId, offered);
  // The person's open chat is this one: the dock on another page, opened
  // there, goes on with it. It doesn't open itself as they leave.
  useEffect(() => {
    setActiveChat(chatId, "chat");
  }, [chatId]);
  const chat: ChatBodyValues = {
    ...session,
    finding: noFinding,
    subject: noSubject,
    words,
    modelsUnavailable,
    retry,
    sourceNames,
    offered,
  };
  // Renamed since, or named by its agent once a turn ended: the newer name.
  const name = session.summary?.title ?? title ?? words.title;
  return (
    <div ref={page} {...stylex.props(styles.page)}>
      <SiteHeader crumbs={[{ label: name }]} />
      <section aria-label={name} {...stylex.props(styles.column)}>
        <ChatConversation
          chat={chat}
          compact={false}
          focusBox={() => {
            boxOf(page.current)?.focus();
          }}
        />
        <ChatFooter chat={chat} />
      </section>
    </div>
  );
};
