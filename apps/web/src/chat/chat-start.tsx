import type { Blueprint } from "@grasp-os/shared/apps";
import type { ChatMake } from "@grasp-os/shared/chat";
import type { Opportunity } from "@grasp-os/shared/opportunities";
import { canBuild } from "@grasp-os/shared/roles";
import { Heading } from "@grasp-os/ui/components/heading";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Await, useRouteContext } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { briefOf, useStartFrom } from "../brain/opportunity-drafts.ts";
import type { Session } from "../core.ts";
import { SiteHeader } from "../frame/site-header.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { examplesFor } from "../make/examples.ts";
import type { MakeExample } from "../make/examples.ts";
import { BlueprintIdeas, WorkflowIdeas } from "../make/make-ideas.tsx";
import { MakeSomethingLink } from "../make/make-link.tsx";
import { agentModelOf } from "./agent-choice.tsx";
import { openChat } from "./chat-layout.ts";
import { ChatSwitcherButton } from "./chat-switcher.tsx";
import { Composer } from "./composer.tsx";
import { useGlobalChat } from "./global-chat.tsx";
import {
  ModelsUnavailableNotice,
  unavailableText,
} from "./models-unavailable.tsx";
import { useAsk } from "./use-ask.ts";

// Chat's own page (routes/_shell.index.tsx): where to start. The question
// "What should we look at today?", centred, with the box to ask in, and
// Make something for who builds (as on #2503, without Grasp's buddy).
// Make something comes here too (`make`, from `?make=app` or
// `?make=workflow` and `&project=`): what to get done, how to say it and
// ideas to start from under the box (make/make-ideas.tsx), the blueprints for
// an App, a few starting sentences for a workflow; the first question
// starts the chat with what to make (`ChatMake`), which the chat keeps.
// From an opportunity an admin drafts (`opportunity`, GRA-1751), the box
// starts with its brief (brain/opportunity-drafts.ts) for them to change
// and send: nothing is asked until they do. Asking starts a new chat in
// Grasp's one chat (global-chat.tsx), which opens full screen over the
// page with the answer coming in, as on every other page.

const styles = stylex.create({
  page: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minWidth: 0,
    minHeight: 0,
    overflowY: "auto",
  },
  centre: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100%",
    paddingInline: space["6"],
    paddingBlock: space["12"],
  },
  column: {
    display: "flex",
    flexDirection: "column",
    gap: space["8"],
    width: "100%",
    maxWidth: "48rem",
    paddingBlockEnd: space["10"],
  },
  greeting: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space["6"],
    textAlign: "center",
  },
  words: { display: "grid", gap: space["4"] },
  // The box takes the column's whole width, wider than its own at most, as
  // on #2503: 48rem at most.
  box: { maxWidth: "100%" },
  // The box and, under it, why nothing can be asked yet.
  ask: { display: "grid", gap: space["2"] },
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
const Greeting = ({ making }: { making: boolean }) => (
  <Heading id="new-chat" level={1} size="lg">
    {making ? (
      <Trans>What do you want to get done?</Trans>
    ) : (
      <Trans>What should we look at today?</Trans>
    )}
  </Heading>
);

/** Under the box, making something: how to say it, then the ideas to start from. */
const Making = ({
  ideas,
  onPick,
}: {
  ideas: Promise<Loaded<MakeIdeas>> | undefined;
  onPick: (text: string) => void;
}) => (
  <div {...stylex.props(styles.words)}>
    <Text as="p" color="muted" size="sm">
      <Trans>
        Say it like you&apos;d tell a colleague. Grasp works out what to make.
      </Trans>
    </Text>
    {ideas === undefined ? null : <Ideas ideas={ideas} onPick={onPick} />}
  </div>
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
  const { t, i18n } = useLingui();
  const { offered, modelsUnavailable, retry } = useGlobalChat();
  const unavailable = unavailableText(modelsUnavailable);
  const { identity } = useRouteContext({ from: "/_shell" });
  const agents = offered?.agents ?? [];
  const named = agents.find(({ id }) => id === agent);
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
    }
  );
  // The agent the address names, mentioned in the box once the person's
  // agents are read: only one they may ask, and only into an empty box.
  const mentioned = useRef(false);
  const { text: typed, onText, onMentions, mentions } = composer;
  // The agents the box mentions now: who a starting question goes to, and
  // whose model the box shows (the first one's, else the first agent's).
  const agentsMentioned = mentions.filter(({ kind }) => kind === "agent");
  const answering = agentsMentioned.at(0)?.id ?? agents.at(0)?.id;
  useEffect(() => {
    if (named === undefined || mentioned.current || typed !== "") {
      return;
    }
    mentioned.current = true;
    onText(`@${named.name} `);
    onMentions([
      { kind: "agent", id: named.id, label: named.name, trigger: "@" },
    ]);
  }, [named, typed, onText, onMentions]);
  // The opportunity's brief, once read, fills the box.
  const kind = make?.kind;
  useStartFrom(opportunity, (read) => {
    if (kind !== undefined) {
      onText(briefOf(read, kind, i18n));
    }
  });
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
      <section aria-labelledby="new-chat" {...stylex.props(styles.page)}>
        <div {...stylex.props(styles.centre)}>
          <div {...stylex.props(styles.column)}>
            <div {...stylex.props(styles.greeting)}>
              <Greeting making={make !== undefined} />
            </div>
            <div {...stylex.props(styles.ask)}>
              <Composer
                placeholder={t`Ask anything, or describe a process`}
                agentModel={agentModelOf(agents, answering)}
                running={false}
                style={styles.box}
                {...(unavailable === undefined ? {} : { unavailable })}
                {...composer}
              />
              <ModelsUnavailableNotice
                onRetry={retry}
                why={modelsUnavailable}
              />
            </div>
            {make === undefined ? null : (
              <Making
                ideas={ideas}
                onPick={(text) => {
                  composer.onText(text);
                }}
              />
            )}
          </div>
        </div>
      </section>
    </>
  );
};
