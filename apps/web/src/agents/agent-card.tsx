import { Badge } from "@grasp-os/ui/components/badge";
import { Card, CardLink } from "@grasp-os/ui/components/card";
import { Heading } from "@grasp-os/ui/components/heading";
import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { motionVars } from "@grasp-os/ui/lib/vars.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { agentCardMarker } from "./agent-card.stylex.ts";
import { AgentFigure, AgentFigureAura } from "./figure/agent-figure.tsx";
import type { FigureState as AgentFigureState } from "./figure/body.ts";
import type { AgentFigureLook } from "./figure/palettes.ts";

// One agent as a portrait card, as #2503's library drew it (its
// AgentCard, which the rename map moves to the product): the agent's own
// light on the page's ground, its name with its job under it, its figure
// large and cropped by the card's corner, whom it answers as a pill at its
// foot, and a few facts that grow up inside it while it is rested on or
// focused. The whole card is one link.

/** The portrait card's boxes, shared by the card and PageSkeletonAgents' placeholder. */
export const agentCardStyles = stylex.create({
  // The page: its header, then the grid, as the product's Page lays them.
  page: {
    display: "flex",
    flexDirection: "column",
    gap: space["6"],
    width: "100%",
  },
  // Columns of at least 16rem (the whole width when narrower), sharing what is left.
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 16rem), 1fr))",
    gap: space["4"],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  // The portrait inside a Card with no padding: at least 20rem tall, its words from the top, on the
  // page's paper (the page-ground aura's own ground, laid over it once the agents arrive).
  portrait: {
    backgroundColor: colors.background,
    position: "relative",
    display: "grid",
    alignContent: "start",
    minHeight: "20rem",
    padding: space["5"],
    overflow: "hidden",
    borderRadius: "inherit",
    cornerShape: radius.shape,
    isolation: "isolate",
  },
  // The figure: large, cropped by the card's end corner.
  figure: {
    position: "absolute",
    insetBlockEnd: "-3.5rem",
    insetInlineEnd: "-3.5rem",
    zIndex: 0,
  },
  // The name and the job, over the ground.
  words: {
    position: "relative",
    zIndex: 1,
    display: "grid",
    gap: space["2"],
    maxWidth: "75%",
  },
  // The foot, pinned to the card's start corner: its pills side by side on one line, wrapping only
  // when they do not fit; over the figure's edge if they must, each on its own fill.
  foot: {
    position: "absolute",
    insetBlockEnd: space["5"],
    insetInlineStart: space["5"],
    zIndex: 1,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["1"],
    maxWidth: `calc(100% - 2 * ${space["5"]})`,
  },
});

const styles = stylex.create({
  // The marker's box: the card's own, so its hover is the card's.
  host: { display: "grid", minWidth: 0 },
  // The details: a raised panel inside the card's foot, its corner concentric with the card's. At
  // rest it is not there; rested on or focused by the keys it grows up from the card's foot.
  details: {
    position: "absolute",
    insetInline: space["3"],
    insetBlockEnd: space["3"],
    zIndex: 2,
    display: "grid",
    gap: space["2"],
    margin: 0,
    padding: space["4"],
    borderRadius: `max(${radius.sm}, calc(${radius.base} - ${space["3"]}))`,
    cornerShape: radius.shape,
    backgroundColor: colors.card,
    boxShadow: shadow.sm,
    borderWidth: { default: 0, [media.forcedColors]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    transformOrigin: "50% 100%",
    opacity: {
      default: 0,
      [stylex.when.ancestor(":hover", agentCardMarker)]: {
        default: 0,
        [media.hover]: 1,
      },
      [stylex.when.ancestor(":has(:focus-visible)", agentCardMarker)]: 1,
    },
    transform: {
      default: `translateY(${space["2"]}) scale(0.96)`,
      [stylex.when.ancestor(":hover", agentCardMarker)]: {
        default: `translateY(${space["2"]}) scale(0.96)`,
        [media.hover]: "none",
      },
      [stylex.when.ancestor(":has(:focus-visible)", agentCardMarker)]: "none",
      [media.reducedMotion]: "none",
    },
    visibility: {
      default: "hidden",
      [stylex.when.ancestor(":hover", agentCardMarker)]: {
        default: "hidden",
        [media.hover]: "visible",
      },
      [stylex.when.ancestor(":has(:focus-visible)", agentCardMarker)]:
        "visible",
    },
    transitionProperty: "opacity, transform, visibility",
    transitionDuration: motionVars.ui,
    transitionTimingFunction: duration.ease,
    pointerEvents: "none",
  },
  // One fact: its name quiet at the start, its value in the ink at the end, on one line each.
  fact: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    alignItems: "baseline",
    columnGap: space["3"],
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    letterSpacing: font.trackingUi,
  },
  key: { margin: 0, color: colors.mutedForeground },
  // The job, as CardDescription draws a card's sentence: its own element,
  // as CardDescription takes no id and the card's link is described by it
  // (registry gap of 25 Nov 2026).
  job: {
    display: "block",
    margin: 0,
    fontSize: font.textBase,
    lineHeight: font.textBaseTightLine,
    letterSpacing: font.trackingUi,
    color: colors.mutedForeground,
  },
  value: {
    margin: 0,
    color: colors.foreground,
    textAlign: "end",
    overflowWrap: "anywhere",
  },
});

/** One of the facts a card's details show. */
export interface AgentCardFact {
  /** What it is, in a word or two ("On its own", "Model", "This month"). */
  key: string;
  /** What it says of this agent ("Only when asked", "Claude Sonnet 5.5", "$4.20"). */
  value: ReactNode;
}

/** Every prop an AgentCard takes. */
export interface AgentCardProps {
  /** The agent's name, the card's heading. */
  name: string;
  /** What it is for, in one line under the name. */
  job?: string;
  /** Its shape and palette: `agentFigureOf(agent.id)`, or `stephensLook` for the main agent. */
  look: AgentFigureLook;
  /**
   * Whom it answers, as a pill at the card's foot: "Just for me", "Everyone", or a team's name.
   * Left out, no pill.
   */
  audience?: string;
  /** Paused: the figure asleep and its light dimmed. Say so in words too (a `status` badge). */
  paused?: boolean;
  /** How it stands, above the audience pill: the host's own Badge ("Paused", "Last run failed"). */
  status?: ReactNode;
  /**
   * Two or three facts that grow up inside the card while it is rested on or focused by the keys,
   * and are said with it to a screen reader. Left out, the card shows nothing more on hover.
   */
  details?: readonly AgentCardFact[];
  /** Where the whole card leads: a chat with the agent, or its page. */
  opens?: { chat: string } | { page: string };
  /** The link's name, when the agent's name does not say where it goes ("Chat with Stephen"). @default `name` */
  "aria-label"?: string;
  /** The name's level in the page's outline. @default 2 */
  headingLevel?: 2 | 3 | 4;
}

/** The figure's pose: asleep while paused, listening while the card is rested on or focused. */
const usePose = (paused: boolean) => {
  const [near, setNear] = useState(false);
  let state: AgentFigureState = "idle";
  if (paused) {
    state = "asleep";
  } else if (near) {
    state = "listening";
  }
  const come = () => {
    setNear(true);
  };
  const go = () => {
    setNear(false);
  };
  return {
    state,
    near: {
      onPointerEnter: come,
      onPointerLeave: go,
      onFocus: come,
      onBlur: go,
    },
  };
};

/** The details, grown in place: a list of facts, said with the card. */
const Details = ({
  id,
  facts,
}: {
  id: string;
  facts: readonly AgentCardFact[];
}) => (
  <dl id={id} data-slot="agent-card-details" {...stylex.props(styles.details)}>
    {facts.map((fact) => (
      <div key={fact.key} {...stylex.props(styles.fact)}>
        <dt {...stylex.props(styles.key)}>{fact.key}</dt>
        <dd {...stylex.props(styles.value)}>{fact.value}</dd>
      </div>
    ))}
  </dl>
);

/** Whether a line was given: undefined and empty both say nothing. */
const said = (line: string | undefined): line is string =>
  line !== undefined && line !== "";

/** The card's foot: its status, then whom it answers as a pill. */
const Foot = ({
  id,
  status,
  audience,
}: {
  id: string;
  status: ReactNode;
  audience: string | undefined;
}) => (
  <span
    data-slot="agent-card-foot"
    id={id}
    {...stylex.props(agentCardStyles.foot)}
  >
    {status}
    {audience === undefined ? null : <Badge size="sm">{audience}</Badge>}
  </span>
);

/** One agent as a portrait card: its name, job and audience at rest, its details on hover and focus. */
export const AgentCard = ({
  name,
  job,
  look,
  audience,
  paused = false,
  status,
  details,
  opens,
  "aria-label": label,
  headingLevel = 2,
}: AgentCardProps) => {
  const id = useId();
  const { state, near } = usePose(paused);
  const facts = details ?? [];
  const hasFoot = status !== undefined || audience !== undefined;
  const ids = {
    job: `${id}-job`,
    foot: `${id}-foot`,
    details: `${id}-details`,
  };
  const described = [
    said(job) ? ids.job : "",
    hasFoot ? ids.foot : "",
    facts.length > 0 ? ids.details : "",
  ]
    .filter((each) => each !== "")
    .join(" ");
  const portrait = (
    <span {...stylex.props(agentCardStyles.portrait)}>
      {/* Mounted anew when it pauses or wakes: its light is drawn for one or the other. */}
      <AgentFigureAura
        key={paused ? "asleep" : "awake"}
        ground="page"
        look={look}
        bright={paused ? 0.45 : 1}
      />
      <span {...stylex.props(agentCardStyles.figure)}>
        <AgentFigure look={look} size="xl" state={state} />
      </span>
      <span
        data-slot="agent-card-words"
        {...stylex.props(agentCardStyles.words)}
      >
        <Heading level={headingLevel} size="default">
          {name}
        </Heading>
        {said(job) ? (
          <span id={ids.job} {...stylex.props(styles.job)}>
            {job}
          </span>
        ) : null}
      </span>
      {hasFoot ? (
        <Foot id={ids.foot} status={status} audience={audience} />
      ) : null}
      {facts.length > 0 ? <Details id={ids.details} facts={facts} /> : null}
    </span>
  );
  return (
    <span
      data-slot="agent-card"
      data-paused={paused ? "" : undefined}
      {...near}
      {...stylex.props(agentCardMarker, styles.host)}
    >
      {opens === undefined ? (
        <Card padding="none">{portrait}</Card>
      ) : (
        <CardLink
          asChild
          padding="none"
          aria-label={label ?? name}
          {...(described === "" ? {} : { "aria-describedby": described })}
        >
          {"chat" in opens ? (
            <Link search={{ agent: opens.chat }} to="/">
              {portrait}
            </Link>
          ) : (
            <Link params={{ agent: opens.page }} to="/agents/$agent">
              {portrait}
            </Link>
          )}
        </CardLink>
      )}
    </span>
  );
};
