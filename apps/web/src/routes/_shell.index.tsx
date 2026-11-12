import { chatPlanKinds } from "@grasp-os/shared/chat";
import type { ChatMake } from "@grasp-os/shared/chat";
import { canBuild } from "@grasp-os/shared/roles";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

import { setActiveChat } from "../chat/active-chat.ts";
import { openChat } from "../chat/chat-layout.ts";
import { chatPresence } from "../chat/chat-presence.ts";
import { ChatStart, ideasOf } from "../chat/chat-start.tsx";
import { loadFromCore } from "../load-from-core.tsx";

// Chat's own page (chat/chat-start.tsx), and Make something's way in
// (`?make=app` or `?make=workflow`, and `&project=`): the ideas to start
// from are read for who builds, never waited for. The first question
// starts the chat with what to make, which the chat keeps. `?agent=` (the
// Agents page's "Chat") starts it with that agent. The person's other chats are in
// Recents and one ⌘K window away (chat/chat-switcher.tsx), and a link to
// one (`?chat=`) opens it there.

const Chat = () => {
  const { chat } = Route.useSearch();
  const navigate = Route.useNavigate();
  // A link to one chat (an App's workspace's "Open in chat", say) opens it
  // full screen over the page, and the page's address is the page's again.
  useEffect(() => {
    if (chat === undefined) {
      return;
    }
    setActiveChat(chat);
    openChat("fullscreen");
    void navigate({ search: {}, replace: true });
  }, [chat, navigate]);
  const { make, project, agent } = Route.useSearch();
  const { ideas } = Route.useLoaderData();
  return (
    <ChatStart
      agent={agent}
      // Another agent named starts afresh with it.
      key={agent}
      ideas={ideas}
      make={
        make === undefined
          ? undefined
          : { kind: make, ...(project === undefined ? {} : { project }) }
      }
    />
  );
};

/** What the address says: a chat to open, or what to make, where and with which agent. */
interface ChatSearch {
  chat?: string;
  agent?: string;
  make?: ChatMake["kind"];
  project?: string;
}

/** What to make, as the address names it: an App or a workflow, or nothing. */
const makeOf = (value: unknown): ChatMake["kind"] | undefined =>
  chatPlanKinds.find((kind) => kind === value);

export const Route = createFileRoute("/_shell/")({
  // Chat's own page is where to ask: the chat full screen over it, and no bar.
  staticData: { chat: chatPresence.fullscreenOnly },
  validateSearch: (search: Record<string, unknown>): ChatSearch => {
    const make = makeOf(search.make);
    return {
      ...(typeof search.chat === "string" ? { chat: search.chat } : {}),
      // The agent a new chat starts with, as the Agents page names it.
      ...(typeof search.agent === "string" ? { agent: search.agent } : {}),
      ...(make === undefined ? {} : { make }),
      ...(make !== undefined && typeof search.project === "string"
        ? { project: search.project }
        : {}),
    };
  },
  loaderDeps: ({ search: { make } }) => ({ make }),
  // Deferred, and only for who builds, who makes: the page never waits.
  loader: ({ context: { core, identity }, deps: { make } }) => ({
    ideas:
      make === undefined || !canBuild(identity.role)
        ? undefined
        : loadFromCore(core, async (session) => await ideasOf(session, make)),
  }),
  component: Chat,
});
