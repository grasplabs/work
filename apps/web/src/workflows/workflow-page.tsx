import type { DecisionView } from "@grasp-os/shared/decisions";
import { workflowRunsListed } from "@grasp-os/shared/workflow-resources";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Container } from "@grasp-os/ui/components/container";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
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
import { PageHeader } from "@grasp-os/ui/components/page-header";
import { Text } from "@grasp-os/ui/components/text";
import { Icon, MessageCircleIcon } from "@grasp-os/ui/lib/icons";
import { font, space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { formatSince } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { DecisionCard } from "../inbox/decision-card.tsx";
import type { Loaded } from "../load-from-core.tsx";
import type { Names } from "./activity-words.ts";
import { ListedCount } from "./listed-count.tsx";
import { useStartedBy } from "./run-detail.tsx";
import { useRunTitle } from "./run-page.tsx";
import { runStatusLabels, runToneOf } from "./run-status.ts";
import type { WorkflowSettingsSection } from "./settings-sections.ts";

// An independent workflow's own page as direction C (Track) has it: its
// name and where it stands, what waits on the reader in the one approval
// shape (inbox/decision-card.tsx), then its runs, newest first, each opening its
// own page (run-page.tsx). For its builders, their workshop under it: a
// row for each of the tools that change it, each opening its view. What C
// draws beyond that needs core: a one-line description (GRA-2272), the
// stage board and each run's pips (GRA-2283), and a run titled by what it
// handled (GRA-2278); none of it is shown until core has it.

const styles = stylex.create({
  // The room round it the reference's shell gives a page (28px above,
  // 32px below, 24px at its sides): the item shell here gives none. The
  // room below stands outside what scrolls, as the reference's shell keeps
  // it, so the runs stop short of the card's foot.
  room: {
    // The text the reference's shell gives a page, which what isn't sized
    // itself inherits (the item shell here sets a smaller one).
    fontSize: font.textBase,
    lineHeight: font.textBaseLine,
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    paddingBlockEnd: space["8"],
  },
  scroll: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
    paddingBlockStart: space["7"],
    paddingInline: space["6"],
  },
  page: {
    display: "flex",
    flexDirection: "column",
    gap: space["8"],
    paddingBlockEnd: space["8"],
  },
  section: { display: "flex", flexDirection: "column", gap: space["3"] },
  head: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: space["3"],
  },
  headWords: { display: "flex", flexDirection: "column", gap: space["1"] },
});

/** Where a workshop row leads: one of the workflow's builder views. */
export type WorkshopView =
  | { view: "flow" }
  | { view: "runs" }
  | { view: "settings"; section: WorkflowSettingsSection };

/** One tool of the workshop: what it is, in a line, and where it opens. */
export interface WorkshopRow {
  id: string;
  title: string;
  description: string;
  to: WorkshopView;
}

/** How many of its runs show before the rest are asked for. */
const firstRuns = 10;

/** A run as a row: when it started, who started it, and how it stands. */
const RunRow = ({
  workflow,
  run,
  names,
}: {
  workflow: string;
  run: WorkflowResourceRun;
  names: Names;
}) => {
  const { t, i18n } = useLingui();
  const title = useRunTitle()(run);
  const startedBy = useStartedBy(names);
  const who = startedBy(run.principal);
  const ended = run.endedAt === null ? "" : formatSince(run.endedAt);
  return (
    <Item asChild size="sm">
      <Link
        params={{ workflow, run: run.id }}
        to="/workflows/$workflow/runs/$run"
      >
        <ItemContent>
          <ItemTitle>{title}</ItemTitle>
          <ItemDescription>
            {run.endedAt === null
              ? t({
                  message: `By ${who}`,
                  context: "who started a workflow run",
                })
              : t({
                  message: `By ${who} · ended ${ended}`,
                  context: "who started a workflow run, and when it ended",
                })}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Badge dot variant={runToneOf(run.status)}>
            {i18n._(runStatusLabels[run.status])}
          </Badge>
        </ItemActions>
      </Link>
    </Item>
  );
};

/** Its runs, newest first; for a reader who sees only their own (`own`), said so when there are none. */
const Runs = ({
  workflow,
  runs,
  names,
  own,
}: {
  workflow: string;
  runs: Loaded<WorkflowResourceRun[]>;
  names: Names;
  own: boolean;
}) => {
  const { t } = useLingui();
  const [all, setAll] = useState(false);
  const label = t({ message: "Runs", context: "a workflow's runs" });
  if (runs.state !== "ready") {
    return <NotLoadedState page={runs} />;
  }
  if (runs.data.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyDescription>
            {own
              ? t`You haven't run it yet. Only your own runs show here.`
              : t`No runs yet.`}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const newest = workflowRunsListed;
  const shown = all ? runs.data : runs.data.slice(0, firstRuns);
  const more = runs.data.length - shown.length;
  return (
    <>
      <ItemGroup separated aria-label={label}>
        {shown.map((run) => (
          <RunRow key={run.id} names={names} run={run} workflow={workflow} />
        ))}
      </ItemGroup>
      {more > 0 ? (
        <span>
          <Button
            onClick={() => {
              setAll(true);
            }}
            size="sm"
            variant="ghost"
          >
            {t`${plural(more, { one: "Show # more run", other: "Show # more runs" })}`}
          </Button>
        </span>
      ) : null}
      {/* Core lists the newest runs only. */}
      {all && runs.data.length >= newest ? (
        <Text color="muted" size="sm">
          {t`Only the newest ${newest} runs show here.`}
        </Text>
      ) : null}
    </>
  );
};

/** Its builders' tools, each a row with the way to it, and its chat. */
const Workshop = ({
  rows,
  open,
}: {
  rows: readonly WorkshopRow[];
  open: (to: WorkshopView) => void;
}) => {
  const { t } = useLingui();
  const label = t({
    message: "Workshop",
    context: "a workflow's builder tools",
  });
  return (
    <section {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.head)}>
        <div {...stylex.props(styles.headWords)}>
          <Heading level={2} size="xs">
            {label}
          </Heading>
          <Text color="muted" size="sm">
            {t`Only builders see this.`}
          </Text>
        </div>
        <Button
          onClick={() => {
            open({ view: "flow" });
          }}
          size="sm"
          variant="ghost"
        >
          <Icon icon={MessageCircleIcon} />
          {t`Change it in chat`}
        </Button>
      </div>
      <ItemGroup aria-label={label}>
        {rows.map((row) => {
          const tool = row.title;
          return (
            <Item key={row.id} size="sm" variant="outline">
              <ItemContent>
                <ItemTitle>{row.title}</ItemTitle>
                <ItemDescription>{row.description}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  aria-label={t({
                    message: `Open ${tool}`,
                    context: "open a workflow's builder tool",
                  })}
                  onClick={() => {
                    open(row.to);
                  }}
                  size="sm"
                  variant="ghost"
                >
                  {t({
                    message: "Open",
                    context: "open a workflow's builder tool",
                  })}
                </Button>
              </ItemActions>
            </Item>
          );
        })}
      </ItemGroup>
    </section>
  );
};

export const WorkflowHome = ({
  workflow,
  name,
  status,
  decisions,
  runs,
  names,
  builder,
  workshop,
  onOpen,
}: {
  workflow: string;
  /** Its name, as people see it. */
  name: string;
  /** Where it stands, in words (workflow-status.tsx). */
  status: ReactNode;
  /** The answers its runs wait for that the reader may give. */
  decisions: readonly DecisionView[];
  runs: Loaded<WorkflowResourceRun[]>;
  names: Names;
  builder: boolean;
  workshop: readonly WorkshopRow[];
  onOpen: (to: WorkshopView) => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const count = runs.state === "ready" ? runs.data.length : undefined;
  return (
    <div {...stylex.props(styles.room)}>
      <div {...stylex.props(styles.scroll)}>
        <Container size="lg">
          <div {...stylex.props(styles.page)}>
            <PageHeader description={status} title={name} />
            {decisions.map((decision) => (
              <DecisionCard
                decision={decision}
                key={decision.id}
                onAnswered={() => {
                  void router.invalidate();
                }}
              />
            ))}
            <section {...stylex.props(styles.section)}>
              <Heading level={2} size="xs">
                {t({ message: "Runs", context: "a workflow's runs" })}{" "}
                <ListedCount count={count} of="runs" />
              </Heading>
              <Runs
                names={names}
                own={!builder}
                runs={runs}
                workflow={workflow}
              />
            </section>
            {builder ? <Workshop open={onOpen} rows={workshop} /> : null}
          </div>
        </Container>
      </div>
    </div>
  );
};
