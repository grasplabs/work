import type { Blueprint } from "@grasp-os/shared/apps";
import type { ChatMake } from "@grasp-os/shared/chat";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Await, useRouteContext } from "@tanstack/react-router";
import { useRef, useState } from "react";

import type { Session } from "../core.ts";
import { BackdropField } from "../grasp/field/backdrop.tsx";
import { schemeOf, useLook } from "../grasp/field/look.ts";
import { SidebarButton } from "../grasp/frame/page-bar.tsx";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import type { Loaded } from "../load-from-core.tsx";
import { examplesFor } from "../make/examples.ts";
import type { MakeExample } from "../make/examples.ts";
import { BlueprintIdeas, WorkflowIdeas } from "../make/make-ideas.tsx";
import { TourOffer } from "../tour/tour-layer.tsx";
import { useTour } from "../tour/tour-state.ts";
import { AgentPicker, startingAgent } from "./agent-choice.tsx";
import { openChat } from "./chat-layout.ts";
import { useGlobalChat } from "./global-chat.tsx";
import { RecentsButton } from "./recents.tsx";
import { StartComposer } from "./start-composer.tsx";
import { useAsk } from "./use-ask.ts";

// Chat's own page (routes/_shell.index.tsx): where to start. The question
// "What should we look at today?", centred over the backdrop the person
// chose in Settings (grasp/field/look.ts), with the box to ask in under it (the
// first time, Stephen's offer of his tour stands in the question's place,
// tour/tour-layer.tsx), and Make something for who builds. Make something
// comes here too (`make`, from `?make=app` or `?make=workflow` and
// `&project=`): what to get done, and ideas to start from under the box
// (make/make-ideas.tsx), the blueprints for an App, a few
// starting sentences for a workflow; the first question starts the chat
// with what to make (`ChatMake`), which the chat keeps. Asking starts a new
// chat in Grasp's one chat (global-chat.tsx), which opens full screen over
// the page with the answer coming in, as on every other page.

// The page's look, from Grasp UI's tokens (grasp/tokens), in StyleX.
const styles = stylex.create({
  page: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "0%",
    minHeight: 0,
    minWidth: 0,
    overflowY: "auto",
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.text,
  },
  // The backdrop's box, with the page's words above it.
  centre: {
    position: "relative",
    isolation: "isolate",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100%",
    paddingInline: grasp.space6,
    paddingBlock: grasp.space12,
  },
  // On a scene, which is night, what stands on it turns light.
  // The text colour is set again here: inherited, it would stay the one
  // worked out for the page's own scheme, and what is typed would be dark
  // on the night.
  onNight: {
    colorScheme: "dark",
    color: grasp.text,
  },
  column: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: grasp.space8,
    width: "100%",
    maxWidth: "48rem",
    paddingBottom: grasp.space10,
  },
  head: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: grasp.space6,
    textAlign: "center",
  },
  greeting: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
  },
  title: {
    fontFamily: grasp.fontSerif,
    fontSize: grasp.titleLg,
    lineHeight: grasp.titleLgLine,
    fontWeight: grasp.weightRegular,
    letterSpacing: grasp.trackingTitle,
    color: grasp.ink,
  },
  hint: {
    color: grasp.muted,
  },
});

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
    <div {...stylex.props(styles.greeting)}>
      <h1 id="new-chat" {...stylex.props(styles.title)}>
        <Trans>What do you want to get done?</Trans>
      </h1>
      <p {...stylex.props(styles.hint)}>
        <Trans>
          Say it like you&apos;d tell a colleague. Grasp works out what to make.
        </Trans>
      </p>
    </div>
  ) : (
    <h1 id="new-chat" {...stylex.props(styles.title)}>
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
  const look = useLook(identity.userId);
  const scheme = schemeOf(look);
  const agents = offered?.agents ?? [];
  const [picked, setPicked] = useState<string | undefined>(agent);
  const agentId = startingAgent(agents, picked)?.id;
  const { composer } = useAsk(
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
    <section aria-labelledby="new-chat" {...stylex.props(styles.page)}>
      <div
        // On a scene the kit's parts turn dark too (the box to ask in, the
        // tour's offer, the ideas), whatever the person's theme, so what
        // is typed reads on the night.
        data-theme={scheme}
        {...stylex.props(styles.centre, scheme === "dark" && styles.onNight)}
      >
        <BackdropField clear={page} look={look} />
        {/* Chat has no bar above it: the sidebar's way back floats here. */}
        <SidebarButton floating label={t`Show or hide the sidebar`} />
        <div ref={page} {...stylex.props(styles.column)}>
          <div {...stylex.props(styles.head)}>
            {offeredTour ? (
              <TourOffer
                headingId="new-chat"
                onDeclined={() => {
                  page.current
                    ?.querySelector<HTMLElement>('textarea, [role="textbox"]')
                    ?.focus();
                }}
                userId={identity.userId}
              />
            ) : (
              <Greeting making={make !== undefined} />
            )}
          </div>
          <StartComposer
            ask={{ ...composer, models: offered?.models }}
            end={<RecentsButton />}
            start={
              <AgentPicker
                agentId={agentId}
                agents={agents}
                onAgent={setPicked}
              />
            }
          />
          {offeredTour || ideas === undefined ? null : (
            <Ideas
              ideas={ideas}
              onPick={(text) => {
                composer.onText(text);
              }}
            />
          )}
        </div>
      </div>
    </section>
  );
};
