import { createFileRoute, notFound } from "@tanstack/react-router";

import { loadThread } from "../chat/chat-body.tsx";
import { ChatPage } from "../chat/chat-page.tsx";
import { chatPresence } from "../chat/chat-presence.ts";
import { loadChat } from "../chat/chat-watch.ts";
import { NotFound, PageLoading } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";

// A chat's own page (chat/chat-page.tsx), at its own address: linked,
// reloaded, reached with Back. It shows once the chat's first update has
// come, so its thread is there whole, a running answer included, and goes
// on following it from the same watch (chat/chat-watch.ts). A chat core
// has none of for the person (deleted, or someone else's) is not found.

/** The chat the address names. */
const Chat = () => {
  const { chatId } = Route.useParams();
  const { title } = Route.useLoaderData();
  // Another chat is another page: nothing typed in one stays for the next.
  return <ChatPage chatId={chatId} key={chatId} title={title} />;
};

export const Route = createFileRoute("/_shell/chats/$chatId")({
  // The chat is the page: no docked chat or idle bar beside it, and the
  // page fills the card, its thread scrolling inside it.
  staticData: { chat: chatPresence.hidden, page: "fill" },
  loader: async ({ context: { core }, params: { chatId } }) => {
    const [followed, summary] = await Promise.all([
      loadChat(core, chatId),
      loadFromCore(
        core,
        async (session) => await session.chats.summary(chatId)
      ),
      // Its thread's code too, so the chat shows whole, never its shapes.
      loadThread(),
    ]);
    if (followed.gone === true) {
      throw notFound();
    }
    return {
      title: summary.state === "ready" ? summary.data.title : undefined,
    };
  },
  pendingComponent: PageLoading,
  notFoundComponent: () => <NotFound />,
  component: () => <Chat />,
});
