/**
 * What to take into the next conversation with a company, ported from the
 * prototype (grasplabs/prototype `components/admin/org-brief.tsx`): where
 * it stands, what Grasp doesn't know yet, and once it is open where Grasp
 * could do more, from the brief the chat and MCP give (`briefOf`). What
 * to bring up is the list of what needs Grasp, beside it on the overview.
 */

import { briefOf } from "@grasp-os/shared/admin/admin-brief";
import type { AdminView } from "@grasp-os/shared/admin/admin-view";
import { Button } from "@grasp-os/ui/components/button";
import { CardContent } from "@grasp-os/ui/components/card";
import { Heading } from "@grasp-os/ui/components/heading";
import { Link } from "@grasp-os/ui/components/link";
import { Text } from "@grasp-os/ui/components/text";
import { Icon, SparklesIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link as RouterLink } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Panel } from "./panel.tsx";
import { sectionTo } from "./sections.ts";
import { knowledgeWords, stageWords, whole } from "./words.ts";

const styles = stylex.create({
  body: { display: "flex", flexDirection: "column", gap: space["4"] },
  list: { display: "flex", flexDirection: "column", gap: space["2"] },
  // Each line of a list after a bullet, as the brief's lists are read.
  items: {
    display: "flex",
    flexDirection: "column",
    gap: space["1"],
    margin: 0,
    paddingInlineStart: space["4"],
    listStyleType: "disc",
  },
});

/** One of the brief's lists, a bullet before each line. */
const BriefList = ({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) => (
  <div {...stylex.props(styles.list)}>
    <Heading level={3} size="2xs">
      {title}
    </Heading>
    <ul {...stylex.props(styles.items)}>{children}</ul>
  </div>
);

/** A line of a brief's list. */
const BriefItem = ({ children }: { children: ReactNode }) => (
  <li>
    <Text as="span" size="sm">
      {children}
    </Text>
  </li>
);

export const OrgBrief = ({
  view,
  clientId,
}: {
  view: AdminView;
  clientId: string;
}) => {
  const brief = briefOf(view);
  const { questions } = brief;
  const where = view.open ? "Open since the go" : stageWords[brief.stage];
  return (
    <Panel
      action={
        // Opens Ask Grasp, which prepares the call at once.
        <Button asChild size="sm" variant="outline">
          <RouterLink search={{ about: clientId }} to="/ask">
            <Icon icon={SparklesIcon} />
            Prepare the call with Grasp
          </RouterLink>
        </Button>
      }
      description={`${where}.`}
      title="Before the next call"
    >
      <CardContent>
        <div {...stylex.props(styles.body)}>
          {/* Core gives how much is known without its parts: what nobody could answer still stands on its own. */}
          {brief.missing.length > 0 || questions > 0 ? (
            <BriefList title="Not known yet">
              {brief.missing.map((each) => (
                <BriefItem key={each.source}>
                  {knowledgeWords[each.source]}: {Math.round(each.known * 100)}%
                  in
                </BriefItem>
              ))}
              {questions > 0 ? (
                <BriefItem>
                  {questions === 1
                    ? "1 question nobody could answer yet"
                    : `${questions} questions nobody could answer yet`}
                </BriefItem>
              ) : null}
            </BriefList>
          ) : null}
          {brief.opportunities.length > 0 ? (
            <BriefList title="Where Grasp could do more">
              {brief.opportunities.map((each) => (
                <BriefItem key={each.id}>
                  <Link asChild>
                    <RouterLink params={{ clientId }} to={sectionTo.workflows}>
                      {each.name}: {whole(each.hours)} hours a week by hand
                    </RouterLink>
                  </Link>
                </BriefItem>
              ))}
            </BriefList>
          ) : null}
          {brief.missing.length === 0 &&
          questions === 0 &&
          brief.opportunities.length === 0 ? (
            <Text color="muted" size="sm">
              Nothing to bring up.
            </Text>
          ) : null}
        </div>
      </CardContent>
    </Panel>
  );
};
