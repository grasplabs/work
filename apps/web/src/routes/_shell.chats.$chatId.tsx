import { createFileRoute, notFound } from "@tanstack/react-router";

import { setActiveChat } from "../chat/active-chat.ts";
import { ChatPage } from "../chat/chat-page.tsx";
import { chatPresence } from "../chat/chat-presence.ts";
import { NotFound } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";

// A chat's own page (chat/chat-page.tsx), at its own address, as #2503 has
// it: linked, reloaded, reached with Back. The chat it names becomes the
// person's open chat before the page draws (active-chat.ts), so the page
// shows it from the first frame and the chat beside another page goes on
// with it. A chat core has none of for the person (deleted, or someone
// else's) is not found.

/** The chat the address names. */
const Chat = () => {
  const { chatId } = Route.useParams();
  const { title } = Route.useLoaderData();
  // Another chat is another page: nothing typed in one stays for the next.
  return <ChatPage chatId={chatId} key={chatId} title={title} />;
};

export const Route = createFileRoute("/_shell/chats/$chatId")({
  // The chat is the page: no docked chat or idle bar beside it.
  staticData: { chat: chatPresence.hidden },
  loader: async ({ context: { core }, params: { chatId }, preload }) => {
    const summary = await loadFromCore(
      core,
      async (session) => await session.chats.summary(chatId)
    );
    if (summary.state === "missing") {
      throw notFound();
    }
    // Only for the page itself, never for a link merely read ahead.
    if (!preload) {
      setActiveChat(chatId, "chat");
    }
    return {
      title: summary.state === "ready" ? summary.data.title : undefined,
    };
  },
  notFoundComponent: () => <NotFound />,
  component: () => <Chat />,
});
