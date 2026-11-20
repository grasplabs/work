// Page skeleton, agents: the Agents overview before its agents arrive, a grid of portrait cards.
// A route's first paint, as the product's Agents page draws it: columns of at least 16rem that fill
// the row, each AgentCard's own boxes round a portrait at least 20rem tall, its name and job at the
// top and its audience pill pinned to its foot. Built on the card's own boxes (`agentCardStyles`
// from agent-card) so nothing moves when the agents arrive: the card's ground stands still (no glow
// and no figure while it waits), on the page's own paper, the ground the card's aura lays when the
// agents arrive, so the colour holds. The name, the job and the pill are quiet shapes in their own
// boxes. PageHeader's own `loading` heads it, with the page's actions in their place, and the
// page's `toolbar` (its tabs) stands between the header and the grid, as on the loaded page.
//
//   <PageSkeletonAgents cards={8} actions={<Button variant="ink" icon={Plus}>New agent</Button>} />
//   <PageSkeletonAgents toolbar={<Tabs …><TabsList>…</TabsList></Tabs>} />   the tab row in its place
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { agentCardStyles } from "../../agent-card";
import { Card } from "../../card";
import { PageHeader } from "../../page-header";
import { Skeleton } from "../../skeleton";
import { grasp } from "../../tokens/tokens.stylex";

/** The portrait card's boxes, shared by the loaded card and its placeholder (now AgentCard's own). */
export { agentCardStyles } from "../../agent-card";

const waits = stylex.create({
  // The name's line at a medium heading's own height.
  name: { width: "8rem", height: grasp.titleMdLine },
  job: { width: "12rem", maxWidth: "100%" },
  // The audience pill's box, at a small badge's own height.
  fact: { width: "5rem", height: grasp.badgeHeightSm },
});

export interface PageSkeletonAgentsProps {
  /** How many cards the grid holds at first. @default 8 */
  cards?: number;
  /** The page's actions, as the loaded page has them (they need no data): drawn in their place. */
  actions?: ReactNode;
  /**
   * What stands between the header and the cards on the loaded page, such as its tabs (My agents,
   * Organization). Drawn in its place, so the cards do not drop when the page arrives.
   */
  toolbar?: ReactNode;
}

/** The Agents overview before it arrives: the header's placeholder, its toolbar, then still portrait cards. */
export const PageSkeletonAgents = ({
  cards = 8,
  actions,
  toolbar,
}: PageSkeletonAgentsProps) => (
  <div data-slot="page-skeleton-agents" {...stylex.props(agentCardStyles.page)}>
    <PageHeader title="" actions={actions} loading />
    {toolbar}
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
