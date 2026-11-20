// Page skeleton, agents: the Agents overview before its agents arrive, a grid of portrait cards.
// A route's first paint, as the product's Agents page draws it (its agents-overview.tsx): columns
// of at least 16rem that fill the row, each a Card with no padding round a portrait at least 20rem
// tall, its name and job at the top and one fact pinned to its foot. Built on the card's own boxes
// so nothing moves when the agents arrive: the card's ground stands still (no glow and no figure
// while it waits), on the page's own paper, the ground `AgentFigureAura ground="page"` lays when
// the agents arrive, so the colour holds. The name, the job and the fact are quiet lines in their
// own boxes. PageHeader's own `loading` heads it, with the page's actions in their place.
//
//   <PageSkeletonAgents cards={8} actions={<Button variant="ink" icon={Plus}>New agent</Button>} />
//
// The portrait's measures are exported (`agentCardStyles`) so the loaded card stands on the same
// boxes: the grid, the portrait, its words and its foot.
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Card } from "../../card";
import { PageHeader } from "../../page-header";
import { Skeleton } from "../../skeleton";
import { grasp } from "../../tokens/tokens.stylex";

/** The portrait card's boxes, shared by the loaded card and its placeholder. */
export const agentCardStyles = stylex.create({
  // The page: its header, then the grid, as the product's Page lays them.
  page: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space6,
    width: "100%",
  },
  // Columns of at least 16rem (the whole width when narrower), sharing what is left.
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 16rem), 1fr))",
    gap: grasp.space4,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  // The portrait inside a Card with no padding: at least 20rem tall, its words from the top, on the
  // page's paper (the page-ground aura's own ground, laid over it once the agents arrive).
  portrait: {
    backgroundColor: grasp.paper,
    position: "relative",
    display: "grid",
    alignContent: "start",
    minHeight: "20rem",
    padding: grasp.space5,
    overflow: "hidden",
    borderRadius: "inherit",
    cornerShape: grasp.cornerShape,
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
    gap: grasp.space2,
    maxWidth: "75%",
  },
  // The one fact, pinned to the card's start corner at its foot, clear of the figure.
  foot: {
    position: "absolute",
    insetBlockEnd: grasp.space5,
    insetInlineStart: grasp.space5,
    zIndex: 1,
    display: "grid",
    justifyItems: "start",
    gap: grasp.space1,
    maxWidth: "40%",
  },
});

const waits = stylex.create({
  // The name's line at a medium heading's own height.
  name: { width: "8rem", height: grasp.titleMdLine },
  job: { width: "12rem", maxWidth: "100%" },
  // The fact's line at its small text's own height.
  fact: { width: "6rem", height: grasp.textXsLine },
});

export interface PageSkeletonAgentsProps {
  /** How many cards the grid holds at first. @default 8 */
  cards?: number;
  /** The page's actions, as the loaded page has them (they need no data): drawn in their place. */
  actions?: ReactNode;
}

/** The Agents overview before it arrives: the header's placeholder, then still portrait cards. */
export const PageSkeletonAgents = ({
  cards = 8,
  actions,
}: PageSkeletonAgentsProps) => (
  <div data-slot="page-skeleton-agents" {...stylex.props(agentCardStyles.page)}>
    <PageHeader title="" actions={actions} loading />
    <ul aria-hidden="true" {...stylex.props(agentCardStyles.grid)}>
      {Array.from({ length: cards }, (_, index) => (
        <li key={index} data-slot="agent-card">
          <Card padding="none">
            <span {...stylex.props(agentCardStyles.portrait)}>
              <span
                data-slot="agent-card-words"
                {...stylex.props(agentCardStyles.words)}
              >
                <Skeleton layout={waits.name} />
                <Skeleton layout={waits.job} />
              </span>
              <span
                data-slot="agent-card-foot"
                {...stylex.props(agentCardStyles.foot)}
              >
                <Skeleton layout={waits.fact} />
              </span>
            </span>
          </Card>
        </li>
      ))}
    </ul>
  </div>
);
