/**
 * An organization being set up, on its Setup (src/hosting/progress.ts):
 * one calm row per thing that happens, its state, and how long it has
 * taken. Once live its Setup says so in one fact, its steps and who is
 * invited under it (src/admin/setup-status.tsx). Codes and the technical
 * part only under each row's Details.
 */
import { Badge } from "@grasp-os/ui/components/badge";
import type { BadgeVariant } from "@grasp-os/ui/components/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Text } from "@grasp-os/ui/components/text";
import { font, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Group } from "../admin/setup-parts.tsx";
import type {
  LineState,
  ProgressLine,
  ProvisioningProgress,
} from "./progress.ts";

const styles = stylex.create({
  details: {
    margin: 0,
    paddingInlineStart: space["5"],
    display: "grid",
    rowGap: space["1"],
  },
  code: { fontFamily: font.mono, fontSize: font.textSm },
  steps: { display: "flex", flexDirection: "column", gap: space["3"] },
});

const stateWords: Readonly<Record<LineState, string>> = {
  waiting: "Waiting",
  doing: "Doing",
  done: "Done",
  retrying: "Trying again",
  failed: "Failed",
  needs_attention: "Needs attention",
};

/** How long from `from` to `to`, in minutes and seconds. */
const durationOf = (from: Date, to: Date): string => {
  const seconds = Math.max(
    0,
    Math.round((to.getTime() - from.getTime()) / 1000)
  );
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds % 60}s`;
};

const badgeVariants: Readonly<Record<LineState, BadgeVariant>> = {
  waiting: "outline",
  doing: "outline",
  done: "success",
  retrying: "outline",
  failed: "destructive",
  needs_attention: "destructive",
};

/** Where a step stands: a spinner while it goes (its state in words for a screen reader), else its Badge. */
const StateMark = ({ state }: { state: LineState }) =>
  state === "doing" || state === "retrying" ? (
    <Spinner aria-label={stateWords[state]} />
  ) : (
    <Badge variant={badgeVariants[state]}>{stateWords[state]}</Badge>
  );

/** What a step or the whole run recorded, under its Details. */
const Details = ({ children }: { children: ReactNode }) => (
  <Collapsible fitContent>
    <CollapsibleTrigger>Details</CollapsibleTrigger>
    <CollapsibleContent>{children}</CollapsibleContent>
  </Collapsible>
);

/** One step on one row: where it stands, what it is, and its details under it. */
const Line = ({ line }: { line: ProgressLine }) => (
  <Item size="sm">
    <ItemMedia>
      <StateMark state={line.state} />
    </ItemMedia>
    <ItemContent>
      <ItemTitle>{line.label}</ItemTitle>
      {line.details.length === 0 ? null : (
        <ItemDescription>
          <Details>
            <ul {...stylex.props(styles.details)}>
              {line.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          </Details>
        </ItemDescription>
      )}
    </ItemContent>
  </Item>
);

/** What it all comes to while it isn't ready, in a sentence. */
const headline = (progress: ProvisioningProgress, now: Date): string => {
  if (progress.state === "needs_attention") {
    return "Stopped: it needs a look";
  }
  if (progress.state === "waiting") {
    return progress.hosting === "on_prem"
      ? "Waiting for its own install"
      : "Waiting to start";
  }
  return `Setting up ${progress.hostname ?? "its address"} (${durationOf(progress.startedAt, now)} so far)`;
};

const Steps = ({ progress }: { progress: ProvisioningProgress }) => (
  <ItemGroup aria-label="Steps" separated>
    {progress.lines.map((line) => (
      <Line key={line.id} line={line} />
    ))}
  </ItemGroup>
);

/** Its steps once every one is done, and who is invited: under its Setup's "Set up" fact. */
export const ReadySteps = ({
  progress,
}: {
  progress: ProvisioningProgress;
}) => (
  <div {...stylex.props(styles.steps)}>
    {progress.admins.length === 0 ? null : (
      <Text color="muted" size="sm">
        {`Invited: ${progress.admins.join(", ")}. They become admins when they first sign in.`}
      </Text>
    )}
    <Steps progress={progress} />
  </div>
);

/**
 * Its progress while it isn't ready; `children`, what staff do about it
 * once it stopped (its Retry), shown beside why.
 */
export const ProvisioningProgressView = ({
  progress,
  children,
}: {
  progress: ProvisioningProgress;
  children?: ReactNode;
}) => (
  <Group
    description={progress.notice ?? undefined}
    id="progress"
    title={headline(progress, new Date())}
  >
    {progress.state === "needs_attention" ? children : null}
    <Steps progress={progress} />
    {progress.code === null ? null : (
      <Details>
        <p {...stylex.props(styles.code)}>{progress.code}</p>
      </Details>
    )}
  </Group>
);
