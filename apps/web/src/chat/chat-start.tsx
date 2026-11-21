import type { Blueprint } from "@grasp-os/shared/apps";
import type { ChatMake } from "@grasp-os/shared/chat";
import type { Opportunity } from "@grasp-os/shared/opportunities";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Await, useRouteContext } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { briefOf, useStartFrom } from "../brain/opportunity-drafts.ts";
import type { Session } from "../core.ts";
import { ChatStart as StartScreen } from "../grasp/chat-start/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import type { Loaded } from "../load-from-core.tsx";
import { examplesFor } from "../make/examples.ts";
import type { MakeExample } from "../make/examples.ts";
import { BlueprintIdeas, WorkflowIdeas } from "../make/make-ideas.tsx";
import { agentModelOf } from "./agent-choice.tsx";
import { useLook } from "./backdrop-look.ts";
import { ChatComposer } from "./chat-composer.tsx";
import { useGoToChat } from "./chat-link.ts";
import { useGlobalChat } from "./global-chat.tsx";
import { useAsk } from "./use-ask.ts";

// Chat's own page (routes/_shell.index.tsx): where to start, as Grasp
// UI's Chat start: the question over the person's background (their look,
// chat/backdrop-look.ts, chosen in Settings, Appearance), the box to ask in
// as glass under it. Make
// something comes here too (`make`, from `?make=app` or `?make=workflow`
// and `&project=`): what to get done, and ideas to start from under the box
// (make/make-ideas.tsx), the blueprints for an App, a few starting
// sentences for a workflow; the first question starts the chat with what
// to make (`ChatMake`), which the chat keeps. From an opportunity an admin
// drafts (`opportunity`, GRA-1751), the box starts with its brief
// (brain/opportunity-drafts.ts) for them to change and send: nothing is
// asked until they do. Asking makes the chat and goes to its own page
// (chat/chat-link.ts), the question already in it.

const styles = stylex.create({
  // App shell's page area: the screen fills it.
  screen: { minHeight: "100%" },
  below: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: grasp.space4,
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

/** Under the box: Make something's hint and ideas. */
const Below = ({
  making,
  ideas,
  onPick,
}: {
  making: boolean;
  ideas: Promise<Loaded<MakeIdeas>> | undefined;
  onPick: (text: string) => void;
}) => {
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
 * to make. The agent `agent` names (the Agents page's "Chat") is mentioned
 * in the box as it opens, so the question goes to it (`@`, mentions.tsx);
 * taken out, the question goes to the company's first agent.
 */
export const ChatStart = ({
  make,
  ideas,
  agent,
  opportunity,
}: {
  make: ChatMake | undefined;
  ideas: Promise<Loaded<MakeIdeas>> | undefined;
  agent?: string | undefined;
  /** The opportunity whose brief the box starts with, once read. */
  opportunity?: Promise<Loaded<Opportunity | undefined>> | undefined;
}) => {
  const { offered } = useGlobalChat();
  const { identity } = useRouteContext({ from: "/_shell" });
  const { t, i18n } = useLingui();
  const look = useLook(identity.userId);
  const agents = offered?.agents ?? [];
  const named = agents.find(({ id }) => id === agent);
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
    }
  );
  const question =
    make === undefined
      ? t`What should we look at today?`
      : t`What do you want to get done?`;
  // The agent the address names, mentioned in the box once the person's
  // agents are read: only one they may ask, and only into an empty box.
  const mentioned = useRef(false);
  const { text: typed, onText, onMentions, mentions } = composer;
  // Whose model the box shows: the first agent it mentions, else the
  // company's first, who answers a question that mentions none.
  const answering =
    mentions.find(({ kind }) => kind === "agent")?.id ?? agents.at(0)?.id;
  useEffect(() => {
    if (named === undefined || mentioned.current || typed !== "") {
      return;
    }
    mentioned.current = true;
    onText(`@${named.name} `);
    onMentions([{ kind: "agent", id: named.id, label: named.name }]);
  }, [named, typed, onText, onMentions]);
  // The opportunity's brief, once read, fills the box.
  const kind = make?.kind;
  useStartFrom(opportunity, (read) => {
    if (kind !== undefined) {
      onText(briefOf(read, kind, i18n));
    }
  });
  return (
    <StartScreen
      below={
        <Below
          ideas={ideas}
          making={make !== undefined}
          onPick={(text) => {
            composer.onText(text);
          }}
        />
      }
      layout={styles.screen}
      title={question}
      variant={look}
    >
      <ChatComposer
        {...composer}
        agentModel={agentModelOf(agents, answering)}
        models={offered?.models}
        running={false}
        surface="glass"
      />
    </StartScreen>
  );
};
