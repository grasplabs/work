import { Card, CardContent } from "@grasp-os/ui/components/card";
import { Container } from "@grasp-os/ui/components/container";
import { PageHeader } from "@grasp-os/ui/components/page-header";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { size, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { agentCardStyles } from "./agent-card.tsx";

// The agents pages before what they show arrives: the page's header in
// its place, then the shapes of what loads, so nothing drops when it
// comes. Each is hidden from a screen reader but its region, which says
// it is busy.

// Each placeholder is as wide as the box it stands in.
const waits = stylex.create({
  name: { width: "8rem" },
  job: { width: "12rem", maxWidth: "100%" },
  fact: { width: "5rem" },
  // New agent's place in the header, as large as its small button.
  action: { display: "grid", width: "7.5rem", height: size.controlSm },
  // A settings card's rows, as an agent's page has them.
  column: { display: "grid", gap: space["8"], width: "100%" },
  group: { display: "grid", rowGap: space["2"] },
  title: {
    display: "block",
    width: "7rem",
    marginInline: space.tableCellInline,
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["6"],
    minHeight: space.fieldRow,
    paddingInline: space.tableCellInline,
  },
  label: { width: "9rem" },
  value: { width: "6rem" },
});

/** The Agents page before its agents arrive: its header, its tabs, then still portrait cards. */
export const AgentsSkeleton = ({
  cards = 8,
  action = false,
  toolbar,
}: {
  cards?: number;
  /** Whether the loaded page has New agent in its header: its place, still, never a live button. */
  action?: boolean;
  /** What stands between the header and the cards, such as the tabs. */
  toolbar?: ReactNode;
}) => (
  <div aria-busy="true" {...stylex.props(agentCardStyles.page)}>
    <PageHeader
      actions={
        action ? (
          <span {...stylex.props(waits.action)}>
            <Skeleton variant="rectangular" />
          </span>
        ) : undefined
      }
      loading
      title=""
    />
    {toolbar}
    <ul aria-hidden="true" {...stylex.props(agentCardStyles.grid)}>
      {Array.from({ length: cards }, (_, index) => (
        <li key={index}>
          <Card padding="none">
            <span {...stylex.props(agentCardStyles.portrait)}>
              <span {...stylex.props(agentCardStyles.words)}>
                <span {...stylex.props(waits.name)}>
                  <Skeleton size="lg" />
                </span>
                <span {...stylex.props(waits.job)}>
                  <Skeleton />
                </span>
              </span>
              <span {...stylex.props(agentCardStyles.foot)}>
                <span {...stylex.props(waits.fact)}>
                  <Skeleton size="sm" />
                </span>
              </span>
            </span>
          </Card>
        </li>
      ))}
    </ul>
  </div>
);

/** An agent's Overview: its Details card's seven rows and Recent activity's one. */
const overviewRows = [7, 1] as const;

/** An agent's page before it arrives: its header, then a settings card per number of rows. */
export const AgentSkeleton = ({
  sections = overviewRows,
}: {
  sections?: readonly number[];
}) => (
  <Container align="center" size="sm">
    <div aria-busy="true" {...stylex.props(waits.column)}>
      <PageHeader loading size="sm" title="" />
      {sections.map((rows, section) => (
        <div aria-hidden="true" key={section} {...stylex.props(waits.group)}>
          <span {...stylex.props(waits.title)}>
            <Skeleton />
          </span>
          <Card size="sm">
            <CardContent flush>
              {Array.from({ length: rows }, (_, row) => (
                <div key={row} {...stylex.props(waits.row)}>
                  <span {...stylex.props(waits.label)}>
                    <Skeleton size="sm" />
                  </span>
                  <span {...stylex.props(waits.value)}>
                    <Skeleton size="sm" />
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      ))}
    </div>
  </Container>
);
