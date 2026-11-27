import { createFileRoute } from "@tanstack/react-router";

import { LoadedChatPage } from "../chat/chat-page.tsx";
import { chatPresence } from "../chat/chat-presence.ts";
import { startOf } from "../chat/chat-starts.ts";
import { loadFromCore } from "../load-from-core.tsx";

// A chat's own page (chat/chat-page.tsx), at its own address, as #2503 has
// it: linked, reloaded, reached with Back. The page shows at once, as the
// chat's watch starts: the read here is never waited for, and says only
// whether core has the chat for the person. The page, once it shows,
// makes the chat it names the person's open chat (active-chat.ts), so the
// chat beside another page goes on with it; the read selects nothing, so
// one answered after the person moved to another chat changes nothing. A
// chat core has none of for the person (deleted, or someone else's) is
// not found; a read that failed otherwise says why, with Try again. A chat
// the tab is starting (chat-starts.ts) is read not at all: its question,
// on its way, makes it.

const Chat = () => {
  const { chatId } = Route.useParams();
  const { page } = Route.useLoaderData();
  return <LoadedChatPage chatId={chatId} page={page} />;
};

export const Route = createFileRoute("/_shell/chats/$chatId")({
  // The chat is the page: no docked chat or idle bar beside it.
  staticData: { chat: chatPresence.hidden },
  // Deferred: the page never waits for it.
  loader: ({ context: { core }, params: { chatId } }) => ({
    page:
      startOf(chatId) === undefined
        ? loadFromCore(
            core,
            async (session) => await session.chats.summary(chatId)
          )
        : undefined,
  }),
  component: () => <Chat />,
});
