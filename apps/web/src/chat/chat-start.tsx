import type { Blueprint } from "@grasp-os/shared/apps";
import type { ChatMake } from "@grasp-os/shared/chat";
import { canBuild } from "@grasp-os/shared/roles";
import { Trans, useLingui } from "@lingui/react/macro";
import { Await, useRouteContext } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { GraspBuddy } from "../buddy/grasp-buddy.tsx";
import type { Session } from "../core.ts";
import { SiteHeader } from "../frame/site-header.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { examplesFor } from "../make/examples.ts";
import type { MakeExample } from "../make/examples.ts";
import { BlueprintIdeas, WorkflowIdeas } from "../make/make-ideas.tsx";
import { MakeSomethingLink } from "../make/make-link.tsx";
import { TourOffer } from "../tour/tour-layer.tsx";
import { useTour } from "../tour/tour-state.ts";
import { AgentPicker, agentModelOf, startingAgent } from "./agent-choice.tsx";
import { openChat } from "./chat-layout.ts";
import { ChatSwitcherButton } from "./chat-switcher.tsx";
import { Composer } from "./composer.tsx";
import { useGlobalChat } from "./global-chat.tsx";
import { RecentsButton } from "./recents.tsx";
import { StartingQuestions } from "./suggestions.tsx";
import { useAsk } from "./use-ask.ts";

// Chat's own page (routes/_shell.index.tsx): where to start. Grasp's buddy
// and the question "What should we look at today?", centred, with the box
// to ask in and questions to start from under it (the first time,
// Stephen's offer of his tour stands in the question's place,
// tour/tour-layer.tsx), and Make something for who builds. Make something
// comes here too (`make`, from `?make=app` or `?make=workflow` and
// `&project=`): what to get done, and ideas to start from in place of the
// questions (make/make-ideas.tsx), the blueprints for an App, a few
// starting sentences for a workflow; the first question starts the chat
// with what to make (`ChatMake`), which the chat keeps. Asking starts a new
// chat in Grasp's one chat (global-chat.tsx), which opens full screen over
// the page with the answer coming in, as on every other page.

/** What Make something offers to start from: an App's blueprints, or a workflow's starting sentences. */
export type MakeIdeas =
  | { kind: "app"; blueprints: Blueprint[] }
  | { kind: "workflow"; examples: MakeExample[] };

/** The ideas, under the box, once they come: the question never waits for them. */
const Ideas = ({
  ideas,
  onPick,
}: {
  ideas: Promise<Loaded<MakeIdeas>>;
  onPick: (text: string) => void;
}) => (
  <Await fallback={null} promise={ideas}>
    {(read) => {
      if (read.state !== "ready") {
        return null;
      }
      return read.data.kind === "app" ? (
        <BlueprintIdeas blueprints={read.data.blueprints} onPick={onPick} />
      ) : (
        <WorkflowIdeas examples={read.data.examples} onPick={onPick} />
      );
    }}
  </Await>
);

/** The page's question: what to look at, or, making something, what to get done. */
const Greeting = ({ making }: { making: boolean }) =>
  making ? (
    <div className="flex flex-col gap-2">
      <h1 className="type-display" id="new-chat">
        <Trans>What do you want to get done?</Trans>
      </h1>
      <p className="text-muted-foreground">
        <Trans>
          Say it like you&apos;d tell a colleague. Grasp works out what to make.
        </Trans>
      </p>
    </div>
  ) : (
    <h1 className="type-display" id="new-chat">
      <Trans>What should we look at today?</Trans>
    </h1>
  );

/** What Make something offers for `make`, read for the person. */
export const ideasOf = async (
  session: Session,
  make: ChatMake["kind"]
): Promise<MakeIdeas> => {
  if (make === "app") {
    return { kind: make, blueprints: await session.apps.blueprints.list() };
  }
  const workflows = await session.workflowResources.list();
  return {
    kind: make,
    examples: examplesFor(workflows.map(({ process }) => process)),
  };
};

/**
 * Asks in a new chat, which opens full screen over the page; from Make
 * something (`make`), with `ideas` to start from, the chat made with what
 * to make. The chat is with the agent `agent` names (the Agents page's
 * "Chat"), else the company's first, until the person picks another.
 */
export const ChatStart = ({
  make,
  ideas,
  agent,
}: {
  make: ChatMake | undefined;
  ideas: Promise<Loaded<MakeIdeas>> | undefined;
  agent?: string | undefined;
}) => {
  const { t } = useLingui();
  const { offered } = useGlobalChat();
  const { identity } = useRouteContext({ from: "/_shell" });
  const agents = offered?.agents ?? [];
  const [picked, setPicked] = useState<string | undefined>(agent);
  const agentId = startingAgent(agents, picked)?.id;
  const { composer, ask } = useAsk(
    undefined,
    offered?.models,
    offered?.efforts,
    undefined,
    {
      onAsked: () => {
        openChat("fullscreen");
      },
      ...(make === undefined ? {} : { make }),
      ...(agentId === undefined ? {} : { agentId }),
    }
  );
  // Offered the tour, his question stands in the greeting's place, and
  // nothing to start from under the box until it is answered. Never to
  // who came to make something: they came for that, not a tour.
  const invited = useTour().phase === "invited";
  const offeredTour = invited && make === undefined;
  // Where focus goes once the offer is turned down: the box to ask in.
  const page = useRef<HTMLDivElement>(null);
  return (
    <>
      <SiteHeader
        actions={
          <>
            {canBuild(identity.role) ? (
              <MakeSomethingLink kind="app" size="sm" />
            ) : null}
            <ChatSwitcherButton />
          </>
        }
        crumbs={[{ label: t`Chat` }]}
      />
      <section
        aria-labelledby="new-chat"
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto text-sm"
      >
        <div className="flex min-h-full items-center justify-center px-6 py-12">
          <div
            className="flex w-full max-w-3xl flex-col gap-8 pb-10"
            ref={page}
          >
            <div className="flex flex-col items-center gap-6 text-center">
              <GraspBuddy />
              {offeredTour ? (
                <TourOffer
                  headingId="new-chat"
                  onDeclined={() => {
                    page.current
                      ?.querySelector<HTMLElement>('[role="textbox"]')
                      ?.focus();
                  }}
                  userId={identity.userId}
                />
              ) : (
                <Greeting making={make !== undefined} />
              )}
            </div>
            <Composer
              actions={<RecentsButton />}
              agent={
                <AgentPicker
                  agentId={agentId}
                  agents={agents}
                  onAgent={setPicked}
                />
              }
              agentModel={agentModelOf(agents, agentId)}
              running={false}
              {...composer}
            />
            {offeredTour || ideas === undefined ? null : (
              <Ideas
                ideas={ideas}
                onPick={(text) => {
                  composer.onText(text);
                }}
              />
            )}
            {offeredTour || make !== undefined ? null : (
              <StartingQuestions
                disabled={composer.busy || (composer.models?.length ?? 0) === 0}
                onPick={(question) => {
                  void ask(question);
                }}
              />
            )}
          </div>
        </div>
      </section>
    </>
  );
};
