import { chatPlanKinds } from "@grasp-os/shared/chat";
import type { ChatPlanKind } from "@grasp-os/shared/chat";
import { canBuild, isMemberAdmin } from "@grasp-os/shared/roles";
import { createFileRoute } from "@tanstack/react-router";

import { opportunityOf } from "../brain/opportunity-drafts.ts";
import { chatPresence } from "../chat/chat-presence.ts";
import { ChatStart, ideasOf } from "../chat/chat-start.tsx";
import { loadFromCore } from "../load-from-core.tsx";

// Chat's own page (chat/chat-start.tsx), and Make something's way in
// (`?make=app` or `?make=workflow`, and `&project=`): the ideas to start
// from are read for who builds, never waited for. The first question
// starts the chat with what to make, which the chat keeps. From an
// opportunity an admin drafts (`&opportunity=`, Brain › Opportunities),
// the box starts with its brief in place of the ideas. `?agent=` (the
// Agents page's "Chat") mentions that agent in the box, so the question
// goes to it. Each chat has its own page (`/chats/$chatId`,
// chat/chat-link.ts); the person's other chats are in the sidebar and one
// ⌘K window away (chat/chat-switcher.tsx).

const Chat = () => {
  const {
    make,
    project,
    agent,
    opportunity: opportunityId,
  } = Route.useSearch();
  const { ideas, opportunity } = Route.useLoaderData();
  return (
    <ChatStart
      agent={agent}
      opportunity={opportunity}
      opportunityId={opportunityId}
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

/** What the address says: what to make, where and with which agent. */
interface ChatSearch {
  agent?: string;
  make?: ChatPlanKind;
  project?: string;
  /** The opportunity whose brief the box starts with (Brain › Opportunities' Draft it). */
  opportunity?: string;
}

/** What to make, as the address names it: an App or a workflow, or nothing. */
const makeOf = (value: unknown): ChatPlanKind | undefined =>
  chatPlanKinds.find((kind) => kind === value);

export const Route = createFileRoute("/_shell/")({
  // Chat's start is where to ask: no docked chat beside it, and no bar.
  staticData: { chat: chatPresence.hidden },
  validateSearch: (search: Record<string, unknown>): ChatSearch => {
    const make = makeOf(search.make);
    return {
      // The agent a new chat starts with, as the Agents page names it.
      ...(typeof search.agent === "string" ? { agent: search.agent } : {}),
      ...(make === undefined ? {} : { make }),
      ...(make !== undefined && typeof search.project === "string"
        ? { project: search.project }
        : {}),
      ...(make !== undefined && typeof search.opportunity === "string"
        ? { opportunity: search.opportunity }
        : {}),
    };
  },
  loaderDeps: ({ search: { make, opportunity } }) => ({ make, opportunity }),
  // Deferred, and only for who builds, who makes: the page never waits.
  // An opportunity only for the organization's admins, who alone read them.
  loader: ({ context: { core, identity }, deps: { make, opportunity } }) => ({
    ideas:
      make === undefined ||
      opportunity !== undefined ||
      !canBuild(identity.role)
        ? undefined
        : loadFromCore(core, async (session) => await ideasOf(session, make)),
    opportunity:
      opportunity === undefined || !isMemberAdmin(identity)
        ? undefined
        : loadFromCore(
            core,
            async (session) => await opportunityOf(session, opportunity)
          ),
  }),
  component: Chat,
});
