import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { AgentFigure, AgentFigureAura } from "../grasp/agent-figure/index.ts";
import {
  CardDescription,
  CardLink,
  CardMedia,
  CardTitle,
} from "../grasp/card/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { PenFigure } from "./figure/pen-figure.tsx";
import type { NewAgentWay } from "./new-agent-way.ts";

// How a new agent is made (Ruben, 19 Nov 2026): it starts with one
// question, set it up yourself or in a chat, two cards in the page's
// middle. In a chat is Grasp asking, one question at a time
// (new-agent.tsx); setting it up yourself is the agent's own words in one
// form, Make agent, then its page. Which way is in the address (`?way=`),
// so Back leads to the question again.

const styles = stylex.create({
  // The question in the card's middle: the frame's page is a column at
  // least as tall as the card, which this grows to fill.
  middle: {
    display: "grid",
    flexGrow: 1,
    placeContent: "center",
    justifyItems: "center",
    gap: grasp.space4,
    textAlign: "center",
  },
  heading: { display: "grid", gap: grasp.space2 },
  // Two cards of one width, side by side; one above the other when narrow.
  ways: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(2, minmax(0, 18rem))",
      "@media (width < 40rem)": "minmax(0, 18rem)",
    },
    gap: grasp.space4,
    marginBlockStart: grasp.space4,
    textAlign: "start",
  },
  // A way's picture: its own night, the same size on both cards.
  stage: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    aspectRatio: "4 / 3",
    isolation: "isolate",
    overflow: "hidden",
  },
  // The dither fills the stage it stands on.
  wayWords: {
    display: "grid",
    gap: grasp.space1,
    marginBlockStart: grasp.space3,
  },
});

/** A way's picture, on the card's media: its stage, the words under it. */
const Way = ({
  way,
  title,
  description,
  children,
}: {
  way: NewAgentWay;
  title: string;
  description: string;
  children: ReactNode;
}) => (
  <CardLink
    render={<Link preload="intent" search={{ way }} to="/agents/new" />}
  >
    <CardMedia>
      <span {...stylex.props(styles.stage)}>{children}</span>
    </CardMedia>
    <span {...stylex.props(styles.wayWords)}>
      <CardTitle>{title}</CardTitle>
      <CardDescription>{description}</CardDescription>
    </span>
  </CardLink>
);

/** The figure the chat's card shows: Grasp, listening. */
const listener = { shape: "orb", palette: "evergreen" } as const;

/**
 * The first question: which way it is made, two cards in the card's
 * middle, each a picture of its way on the page's own ground: a dithered
 * pencil writing for setting it up yourself, the agent's figure listening
 * for a chat. Two
 * paintings side by side, never the same one (AGENTS.md › Design).
 */
export const NewAgentStart = () => {
  const { t } = useLingui();
  return (
    // The question is the page's title, in the middle of the card; the
    // crumbs above say New agent already.
    <div {...stylex.props(styles.middle)}>
      <span {...stylex.props(styles.heading)}>
        <Heading level={1} size="lg">
          {t`How do you want to make it?`}
        </Heading>
        <Text tone="muted">{t`You can change everything later.`}</Text>
      </span>
      <div {...stylex.props(styles.ways)}>
        <Way
          description={t`Write its name, its job and what it should know.`}
          title={t`Set it up yourself`}
          way="manual"
        >
          <AgentFigureAura ground="page" look={listener} />
          <PenFigure />
        </Way>
        <Way
          description={t`Grasp asks what it should do, one question at a time.`}
          title={t`In a chat`}
          way="chat"
        >
          <AgentFigureAura ground="page" look={listener} />
          <AgentFigure look={listener} size="lg" state="listening" />
        </Way>
      </div>
    </div>
  );
};
