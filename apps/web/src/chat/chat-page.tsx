import type { ChatSummary } from "@grasp-os/shared/chat";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useLayoutEffect, useRef, useState } from "react";

import { LoadingLines, PageNotLoaded } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { setActiveChat } from "./active-chat.ts";
import { boxOf, ChatConversation, ChatFooter } from "./chat-body.tsx";
import { ChatMoreMenu, useRenameChat } from "./chat-more.tsx";
import { useGlobalChat } from "./global-chat.tsx";
import { reading } from "./reading.stylex.ts";

// A chat as its own page (routes/_shell.chats.$chatId.tsx), as #2503 has
// it: its title in the page's bar, renamed where it stands or from the
// chat's menu beside it, the conversation in one reading column down the
// card, and the box to ask in at its foot. The chat is the address's,
// which the page makes the person's open chat (active-chat.ts), so it is
// Grasp's one chat of the frame (global-chat.tsx): the dock on another
// page, opened there, goes on with it, from the same watch. Only that
// chat shows here, and only it is asked in: whatever selected another one
// meanwhile (a read or a send answered late) is undone before the page
// paints, and until then the page shows no conversation and no box.

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
    paddingBlockStart: space["2"],
    paddingInline: space["4"],
  },
});

/** Chat `chatId`'s page; `title` as core named it when the page loaded. */
export const ChatPage = ({
  chatId,
  title,
}: {
  chatId: string;
  title: string | undefined;
}) => {
  const page = useRef<HTMLDivElement>(null);
  const chat = useGlobalChat();
  const { words, sourceNames, retitle } = chat;
  // Whether the frame's chat is this page's: anything else shows nothing.
  const ours = chat.chatId === chatId;
  useLayoutEffect(() => {
    if (!ours) {
      setActiveChat(chatId, "chat");
    }
  }, [ours, chatId]);
  const summary = ours ? chat.summary : undefined;
  // Renamed since, or named by its agent once a turn ended: the newer name.
  const name = summary?.title ?? title ?? words.title;
  const rename = useRenameChat(chatId, retitle);
  // The rename where the name stands, opened by its own keys or the menu's Rename.
  const [renaming, setRenaming] = useState(false);
  return (
    <div ref={page} {...stylex.props(styles.page)}>
      <SiteHeader
        actions={
          summary === undefined ? undefined : (
            <ChatMoreMenu
              chat={summary}
              key={summary.id}
              onRename={() => {
                setRenaming(true);
              }}
              sourceNames={sourceNames}
            />
          )
        }
        crumbs={[
          {
            label: name,
            onRename: rename,
            renaming,
            onRenamingChange: setRenaming,
          },
        ]}
      />
      <section aria-label={name} {...stylex.props(styles.column)}>
        {ours ? (
          <>
            <ChatConversation
              chat={chat}
              // The page's column is the thread's: no reading column of its
              // own inside it, so its rows stand as far in as the box
              // (#2503's).
              compact
              focusBox={() => {
                boxOf(page.current)?.focus();
              }}
            />
            <ChatFooter chat={chat} inColumn listening />
          </>
        ) : (
          <LoadingLines />
        )}
      </section>
    </div>
  );
};

/**
 * Chat `chatId`'s page as its route read it (`page`, the chat's summary):
 * the chat, or, where core has none of it for the person, not found, and
 * where the read failed otherwise, why, with Try again; never a chat to
 * ask in that core didn't give.
 */
export const LoadedChatPage = ({
  chatId,
  page,
}: {
  chatId: string;
  page: Loaded<ChatSummary>;
}) => {
  const { t } = useLingui();
  if (page.state !== "ready") {
    return <PageNotLoaded crumbs={[{ label: t`Chat` }]} page={page} />;
  }
  // Another chat is another page: nothing typed in one stays for the next.
  return <ChatPage chatId={chatId} key={chatId} title={page.data.title} />;
};
