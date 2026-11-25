import type { Blueprint } from "@grasp-os/shared/apps";
import type { ChatMake, ChatPlanKind } from "@grasp-os/shared/chat";
import type { Opportunity } from "@grasp-os/shared/opportunities";
import { SidebarTrigger, useSidebar } from "@grasp-os/ui/components/sidebar";
import { Text } from "@grasp-os/ui/components/text";
import {
  colors,
  font,
  media,
  radius,
  shadow,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Await, useRouteContext } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { briefOf, useStartFrom } from "../brain/opportunity-drafts.ts";
import type { Session } from "../core.ts";
import type { Loaded } from "../load-from-core.tsx";
import { examplesFor } from "../make/examples.ts";
import type { MakeExample } from "../make/examples.ts";
import { BlueprintIdeas, WorkflowIdeas } from "../make/make-ideas.tsx";
import { agentModelOf } from "./agent-choice.tsx";
import { useLook } from "./backdrop-look.ts";
import { Backdrop } from "./backdrop/backdrop.tsx";
import { useGoToChat } from "./chat-link.ts";
import { Composer } from "./composer.tsx";
import { useGlobalChat } from "./global-chat.tsx";
import {
  ModelsUnavailableNotice,
  unavailableText,
} from "./models-unavailable.tsx";
import { useAsk } from "./use-ask.ts";

// Chat's own page (routes/_shell.index.tsx): where to start. The question
// "What should we look at today?", centred, with the box to ask in, on
// the person's background (their look, backdrop-look.ts, chosen in
// Settings › Appearance; sand until they choose), with no bar over the
// page, as on #2503.
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

const NARROW = media.maxSm;

const styles = stylex.create({
  // The whole screen: as tall as the page, its column in the middle.
  screen: {
    flexGrow: 1,
    minHeight: "inherit",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    width: "100%",
    paddingInline: { default: space["6"], [NARROW]: space["4"] },
    paddingBlock: space["12"],
  },
  // A little above the middle: room under it, none over it.
  column: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space["8"],
    width: "100%",
    maxWidth: "48rem",
    paddingBottom: space["10"],
    minWidth: 0,
    fontFamily: font.sans,
  },
  // With nothing under the box, #2503 keeps the room of the row under it
  // all the same (one gap): the column stands as high as it does there.
  bare: { paddingBottom: `calc(${space["10"]} + ${space["8"]})` },
  title: {
    margin: 0,
    fontFamily: font.serif,
    fontSize: { default: font.headingLg, [NARROW]: font.headingMd },
    lineHeight: { default: font.headingLgLine, [NARROW]: font.headingMdLine },
    fontWeight: font.weightNormal,
    letterSpacing: font.trackingTitle,
    textAlign: "center",
    textWrap: "balance",
    overflowWrap: "anywhere",
    color: colors.foreground,
  },
  // The box, and under it why nothing can be asked yet, across the column.
  ask: { display: "grid", gap: space["2"], width: "100%", minWidth: 0 },
  box: { maxWidth: "100%" },
  // Making something: how to say it, then the ideas, under the box.
  below: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space["4"],
    width: "100%",
    minWidth: 0,
  },
  // With no bar over the page: the sidebar's way back, floating at its
  // top corner, raised: a control of its own that reads over the sand.
  trigger: {
    position: "absolute",
    insetBlockStart: space["2"],
    insetInlineStart: space["2"],
    zIndex: 1,
    display: "flex",
    borderRadius: `min(${radius.base}, calc(${size.controlXs} / 2))`,
    cornerShape: radius.shape,
    backgroundColor: colors.card,
    boxShadow: shadow.sm,
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
const Greeting = ({ making }: { making: boolean }) => (
  <h1 id="new-chat" {...stylex.props(styles.title)}>
    {making ? (
      <Trans>What do you want to get done?</Trans>
    ) : (
      <Trans>What should we look at today?</Trans>
    )}
  </h1>
);

/** Under the box, making something: how to say it, then the ideas to start from. */
const Making = ({
  ideas,
  onPick,
}: {
  ideas: Promise<Loaded<MakeIdeas>> | undefined;
  onPick: (text: string) => void;
}) => (
  <div {...stylex.props(styles.below)}>
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
  make: ChatPlanKind
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
  /** Only an App or a workflow: Make something starts no agent's setup. */
  make: (ChatMake & { kind: ChatPlanKind }) | undefined;
  ideas: Promise<Loaded<MakeIdeas>> | undefined;
  agent?: string | undefined;
  /** The opportunity whose brief the box starts with, once read. */
  opportunity?: Promise<Loaded<Opportunity | undefined>> | undefined;
}) => {
  const { t, i18n } = useLingui();
  const { offered, modelsUnavailable, retry } = useGlobalChat();
  // What stands behind: the person's look, chosen in Settings › Appearance.
  const { identity } = useRouteContext({ from: "/_shell" });
  const look = useLook(identity.userId);
  // The column the backdrop keeps clear of.
  const column = useRef<HTMLDivElement>(null);
  // With no bar over the page, the sidebar's trigger where the sidebar is away.
  const { state, isMobile } = useSidebar();
  const away = isMobile || state === "collapsed";
  const unavailable = unavailableText(modelsUnavailable);
  const agents = offered?.agents ?? [];
  const named = agents.find(({ id }) => id === agent);
  const goToChat = useGoToChat();
  const { composer } = useAsk(
    undefined,
    offered?.models,
    offered?.efforts,
    undefined,
    {
      // The chat's own page (chat-link.ts), the question already in it.
      onAsked: (chatId) => {
        goToChat(chatId);
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
      {/* The frame's control, outside the backdrop, as #2503's frame draws
          its menu button over the page: in the page's own mode, never
          turned dark with what stands on a scene. */}
      {away ? (
        <span {...stylex.props(styles.trigger)}>
          <SidebarTrigger />
        </span>
      ) : null}
      <Backdrop clear={column} variant={look}>
        <section aria-labelledby="new-chat" {...stylex.props(styles.screen)}>
          <div
            ref={column}
            {...stylex.props(styles.column, make === undefined && styles.bare)}
          >
            <Greeting making={make !== undefined} />
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
        </section>
      </Backdrop>
    </>
  );
};
