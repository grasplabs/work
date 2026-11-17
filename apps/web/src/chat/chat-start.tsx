import type { Blueprint } from "@grasp-os/shared/apps";
import type { ChatMake } from "@grasp-os/shared/chat";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Await, useLocation, useRouteContext } from "@tanstack/react-router";

import type { Session } from "../core.ts";
import { Button } from "../grasp/button/index.ts";
import { ChatStart as StartScreen } from "../grasp/chat-start/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import type { Loaded } from "../load-from-core.tsx";
import { examplesFor } from "../make/examples.ts";
import type { MakeExample } from "../make/examples.ts";
import { BlueprintIdeas, WorkflowIdeas } from "../make/make-ideas.tsx";
import { tourOffer } from "../tour/tour-script.ts";
import {
  endTour,
  startTour,
  tourOffered,
  useTour,
} from "../tour/tour-state.ts";
import { startingAgent } from "./agent-choice.tsx";
import { useLook } from "./backdrop-look.ts";
import { ChatComposer } from "./chat-composer.tsx";
import { useGoToChat } from "./chat-link.ts";
import { useGlobalChat } from "./global-chat.tsx";
import { useAsk } from "./use-ask.ts";

// Chat's own page (routes/_shell.index.tsx): where to start, as Grasp
// UI's Chat start: the question over the person's background (their look,
// chat/backdrop-look.ts, chosen in Settings, Appearance), the box to ask in
// as glass under it. The first time, Stephen's offer of his tour is the
// question, its two buttons under the box (tour/tour-state.ts). Make
// something comes here too (`make`, from `?make=app` or `?make=workflow`
// and `&project=`): what to get done, and ideas to start from under the box
// (make/make-ideas.tsx), the blueprints for an App, a few starting
// sentences for a workflow; the first question starts the chat with what
// to make (`ChatMake`), which the chat keeps. Asking makes the chat and
// goes to its own page (chat/chat-link.ts), the question already in it.

const styles = stylex.create({
  // App shell's page area: the screen fills it.
  screen: { minHeight: "100%" },
  below: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: grasp.space4,
  },
  choices: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: grasp.space2,
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

/** The tour's offer, under the box: take it, or not now (then the box has the cursor). */
const TourChoices = ({ userId }: { userId: string }) => {
  const { i18n } = useLingui();
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <div {...stylex.props(styles.choices)}>
      <Button
        onClick={() => {
          startTour(userId, pathname);
        }}
      >
        {i18n._(tourOffer.start)}
      </Button>
      <Button
        onClick={() => {
          tourOffered(userId);
          endTour();
          document
            .querySelector<HTMLElement>('[data-slot="chat-start"] textarea')
            ?.focus();
        }}
        variant="ghost"
      >
        {i18n._(tourOffer.later)}
      </Button>
    </div>
  );
};

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

/** Under the box: the tour's offer, or Make something's hint and ideas. */
const Below = ({
  tourFor,
  making,
  ideas,
  onPick,
}: {
  /** Who is offered the tour, while they are. */
  tourFor: string | undefined;
  making: boolean;
  ideas: Promise<Loaded<MakeIdeas>> | undefined;
  onPick: (text: string) => void;
}) => {
  if (tourFor !== undefined) {
    return <TourChoices userId={tourFor} />;
  }
  if (!making) {
    return null;
  }
  return (
    <div {...stylex.props(styles.below)}>
      <Text size="sm" tone="muted">
        <Trans>
          Say it like you&apos;d tell a colleague. Grasp works out what to make.
        </Trans>
      </Text>
      {ideas === undefined ? null : <Ideas ideas={ideas} onPick={onPick} />}
    </div>
  );
};

/**
 * Asks in a new chat, which opens on its own page; from Make
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
  const { offered } = useGlobalChat();
  const { identity } = useRouteContext({ from: "/_shell" });
  const { t, i18n } = useLingui();
  const look = useLook(identity.userId);
  const agents = offered?.agents ?? [];
  // The agent the address names (the Agents page's "Chat"), else the
  // company's first. The box has no agent picker until Grasp UI's lands.
  const agentId = startingAgent(agents, agent)?.id;
  const goToChat = useGoToChat();
  const { composer } = useAsk(
    undefined,
    offered?.models,
    offered?.efforts,
    undefined,
    {
      // The chat's own page (chat/chat-link.ts), the question already in it.
      onAsked: (chatId) => {
        goToChat(chatId);
      },
      ...(make === undefined ? {} : { make }),
      ...(agentId === undefined ? {} : { agentId }),
    }
  );
  // Offered the tour, his question is the page's, and nothing to start
  // from under the box until it is answered. Never to who came to make
  // something: they came for that, not a tour.
  const invited = useTour().phase === "invited";
  const offeredTour = invited && make === undefined;
  const question =
    make === undefined
      ? t`What should we look at today?`
      : t`What do you want to get done?`;
  return (
    <StartScreen
      below={
        <Below
          ideas={offeredTour ? undefined : ideas}
          making={make !== undefined}
          onPick={(text) => {
            composer.onText(text);
          }}
          tourFor={offeredTour ? identity.userId : undefined}
        />
      }
      layout={styles.screen}
      title={offeredTour ? i18n._(tourOffer.say) : question}
      variant={look}
    >
      <ChatComposer
        {...composer}
        models={offered?.models}
        running={false}
        surface="glass"
      />
    </StartScreen>
  );
};
