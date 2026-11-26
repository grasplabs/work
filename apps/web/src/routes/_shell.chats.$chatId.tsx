import { createFileRoute } from "@tanstack/react-router";

import { LoadedChatPage } from "../chat/chat-page.tsx";
import { chatPresence } from "../chat/chat-presence.ts";
import { takeMade } from "../chat/pending-question.ts";
import { loadFromCore } from "../load-from-core.tsx";

// A chat's own page (chat/chat-page.tsx), at its own address, as #2503 has
// it: linked, reloaded, reached with Back. The page, once it shows, makes
// the chat it names the person's open chat (active-chat.ts), so the chat
// beside another page goes on with it; the read here selects nothing, so
// one answered after the person moved to another chat changes nothing. A
// chat core has none of for the person (deleted, or someone else's) is
// not found; a read that failed otherwise says why, with Try again.

const Chat = () => {
  const { chatId } = Route.useParams();
  const page = Route.useLoaderData();
  return <LoadedChatPage chatId={chatId} page={page} />;
};

export const Route = createFileRoute("/_shell/chats/$chatId")({
  // The chat is the page: no docked chat or idle bar beside it.
  staticData: { chat: chatPresence.hidden },
  // A chat a question just made opens with what core said as it made it:
  // the question shows at once, with no read between.
  loader: async ({ context: { core }, params: { chatId } }) => {
    const made = takeMade(chatId);
    return made === undefined
      ? await loadFromCore(
          core,
          async (session) => await session.chats.summary(chatId)
        )
      : { state: "ready" as const, data: made };
  },
  component: () => <Chat />,
});
