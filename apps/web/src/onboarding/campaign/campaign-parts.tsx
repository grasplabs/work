// Concepts only: the parts the three concepts share: what the admin must
// do (nothing shows when there is nothing), and every finding, team by
// team, in a sheet the page opens on request, so the page itself keeps to
// a few.
import { AgentIndicator } from "@grasp-os/ui/components/agent-indicator";
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Heading } from "@grasp-os/ui/components/heading";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@grasp-os/ui/components/sheet";
import { Text } from "@grasp-os/ui/components/text";
import { Icon, MonitorIcon } from "@grasp-os/ui/lib/icons";
import { media, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

import { AskAction, askWords, useAsksDone } from "./campaign-asks.tsx";
import { talkedWords, whenWords } from "./campaign-words.ts";
import { findingsOf } from "./fixtures.ts";
import type { Campaign, Finding } from "./fixtures.ts";

const styles = stylex.create({
  teams: { display: "flex", flexDirection: "column", gap: space[6] },
  team: { display: "flex", flexDirection: "column", gap: space[3] },
  head: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space[3],
  },
  lines: {
    display: "flex",
    flexDirection: "column",
    gap: space[3],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  line: { display: "flex", flexDirection: "column", gap: space[1] },
  running: {
    display: "flex",
    alignItems: "center",
    justifyContent: "inherit",
    flexWrap: "wrap",
    gap: space[2],
    margin: 0,
  },
  desktop: {
    display: { default: "none", [media.maxSm]: "flex" },
    margin: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: space[2],
  },
});

/**
 * Left out on a phone: the campaign page is the admin's, and the admin's
 * onboarding is meant for a computer. A phone shows how it goes, and says
 * where the rest is.
 */
export const wide = stylex.create({
  // A wrapper with no box of its own, so what it holds keeps its place in the layout.
  only: { display: { default: "contents", [media.maxSm]: "none" } },
});

/** What a phone shows in place of the rest. */
export const OnYourComputer = () => (
  <p {...stylex.props(styles.desktop)}>
    <Icon icon={MonitorIcon} />
    <Text as="span" size="sm" color="muted">
      Every team and every finding is on your computer.
    </Text>
  </p>
);

/** What the admin must do, as rows with one press each; nothing when there is nothing. */
export const AskList = ({ campaign }: { campaign: Campaign }) => {
  const { isDone, markDone } = useAsksDone();
  if (campaign.asks.length === 0) {
    return null;
  }
  return (
    <ItemGroup aria-label="For you">
      {campaign.asks.map((ask) => {
        const words = askWords(ask, isDone(ask));
        return (
          <Item key={ask.id} size="sm" variant="outline">
            <ItemContent>
              <ItemTitle>{words.title}</ItemTitle>
              <ItemDescription>{words.sentence}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <AskAction
                ask={ask}
                done={isDone(ask)}
                onDone={() => {
                  markDone(ask);
                }}
              />
            </ItemActions>
          </Item>
        );
      })}
    </ItemGroup>
  );
};

/** One finding as a line: a "told two ways" one says so first, quietly. */
export const FindingText = ({ finding }: { finding: Finding }) => (
  <span {...stylex.props(styles.line)}>
    {finding.kind === "difference" ? (
      <Text as="span" size="xs" color="muted">
        Told two ways
      </Text>
    ) : null}
    <Text as="span" size="sm">
      {finding.text}
    </Text>
  </span>
);

/** Every finding, team by team, in a sheet; the button says how many. */
export const AllFindings = ({
  campaign,
  variant = "ghost",
}: {
  campaign: Campaign;
  variant?: "ghost" | "outline";
}) => {
  const count = findingsOf(campaign).length;
  if (count === 0) {
    return null;
  }
  const { teams, grouped } = campaign;
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button size="sm" variant={variant}>
          {count === 1 ? "The one finding" : `All ${count} findings`}
        </Button>
      </SheetTrigger>
      <SheetContent side="end">
        <SheetHeader>
          <SheetTitle>What we learned</SheetTitle>
          <SheetDescription>In our words, never anyone’s own.</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <div {...stylex.props(styles.teams)}>
            {teams
              .filter((each) => each.findings.length > 0)
              .map((each) => (
                <section key={each.id} {...stylex.props(styles.team)}>
                  {grouped ? (
                    <div {...stylex.props(styles.head)}>
                      <Heading level={3} size="2xs">
                        {each.name}
                      </Heading>
                      <Text as="span" size="xs" color="muted">
                        {talkedWords(each, grouped)}
                      </Text>
                    </div>
                  ) : null}
                  <ul {...stylex.props(styles.lines)}>
                    {each.findings.map((finding) => (
                      <li key={finding.id}>
                        <FindingText finding={finding} />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
          </div>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
};

/**
 * How it runs and when it closes, in one quiet line: the Agent indicator
 * with its words while the interviews run, the words alone once they
 * close; who declined, by name, under it.
 */
export const RunningLine = ({
  campaign,
  indicator = true,
}: {
  campaign: Campaign;
  /** False where the page already shows its one indicator. */
  indicator?: boolean;
}) => {
  const running = indicator && campaign.pace !== "enough";
  const words = [
    running ? "Listening" : "",
    whenWords(campaign),
    `${campaign.known}% known`,
  ]
    .filter((part) => part !== "")
    .join(" · ");
  const { declined } = campaign;
  return (
    <>
      <p {...stylex.props(styles.running)}>
        {running ? <AgentIndicator /> : null}
        <Text as="span" size="sm" color="muted">
          {words}
        </Text>
      </p>
      {declined.length === 0 ? null : (
        <Text size="sm" color="muted">
          {`Declined: ${declined.join(", ")}`}
        </Text>
      )}
    </>
  );
};

/** Before the first finding: what will appear here, and when. */
export const NothingYet = () => (
  <Empty size="sm">
    <EmptyHeader>
      <EmptyTitle>Nothing learned yet</EmptyTitle>
      <EmptyDescription>
        What we learn appears here from day two, once the first few have talked.
      </EmptyDescription>
    </EmptyHeader>
  </Empty>
);
