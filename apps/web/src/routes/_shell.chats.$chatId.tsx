import * as stylex from "@stylexjs/stylex";
import { createFileRoute, notFound } from "@tanstack/react-router";

import { loadThread } from "../chat/chat-body.tsx";
import { ChatPage } from "../chat/chat-page.tsx";
import { chatPresence } from "../chat/chat-presence.ts";
import { loadChat } from "../chat/chat-watch.ts";
import { useGlobalChat } from "../chat/global-chat.tsx";
import { Fill, LoadingBar } from "../frame/page-skeletons-b.tsx";
import { NotFound } from "../frame/page-states.tsx";
import { PageSkeletonChat } from "../grasp/blocks/page-skeleton-chat/page-skeleton-chat.tsx";
import { Composer, ComposerAdd } from "../grasp/composer/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
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

const styles = stylex.create({
  // The box at the chat's width, as the block's column has it.
  composer: { maxWidth: grasp.chatWidth },
});

/** Does nothing: the box takes nothing until the chat is there. */
const wait = (): void => undefined;

/**
 * The chat before its first update: the bar, its name to come, the
 * thread's waiting pairs, and the chat's box still, with its add and
 * dictate, in the box it will have (chat/chat-composer.tsx): the library's
 * chat block, its column and box at the chat's width (48rem).
 */
const ChatPending = () => {
  const { words } = useGlobalChat();
  return (
    <>
      <LoadingBar />
      <Fill>
        <PageSkeletonChat
          aria-label={words.title}
          composer={
            <Composer
              aria-label={words.title}
              layout={styles.composer}
              loading
              onDictate={wait}
              onSend={wait}
              placeholder={words.placeholder}
              start={<ComposerAdd onAttach={wait} />}
            />
          }
        />
      </Fill>
    </>
  );
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
  pendingComponent: ChatPending,
  notFoundComponent: () => <NotFound />,
  component: () => <Chat />,
});
