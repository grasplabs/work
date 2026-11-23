import type { TriggerKind } from "@grasp-os/shared/workflow-triggers";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";

import { formatDayMonth, formatNumber, formatSince } from "../format.ts";
import { Badge } from "../grasp/badge/index.ts";
import { BrandIconGroup } from "../grasp/brand-icon/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../grasp/empty/index.ts";
import {
  Clock,
  Globe,
  Link as LinkIcon,
  Mail,
  Workflow,
} from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { phases, stateOf } from "./overview.ts";
import type {
  OverviewRow,
  Phase,
  RowTrigger,
  Tool,
  ToolsByWorkflow,
  TriggersByWorkflow,
  WorkflowState,
} from "./overview.ts";
import { WorkflowStateIcon } from "./state-icon.tsx";
import { triggerBlockText } from "./trigger-block.ts";

// The Workflows page's rows (Ruben's pick of 21 November, the study's
// direction E, "Route"): one row a workflow, gathered by the phase it
// stands in, what needs the reader first. A row begins with the mark of
// how it stands and its name; then its route, what starts it and the tools
// it works in; then how its week went. The route never draws a workflow's
// steps, only where the work goes, so a workflow of fifty steps reads as
// calmly as one of two: its tools stand four at most, then how many more.
// Each row opens its workflow.

const phaseNames: Readonly<Record<Phase, MessageDescriptor>> = {
  needsYou: msg({ message: "Needs you", context: "workflow phase" }),
  running: msg({ message: "Running", context: "workflow phase" }),
  building: msg({ message: "Not running", context: "workflow phase" }),
};

const stateNames: Readonly<Record<WorkflowState, MessageDescriptor>> = {
  failing: msg({ message: "Failing", context: "how a workflow stands" }),
  waiting: msg({ message: "Waiting on you", context: "how a workflow stands" }),
  paused: msg({ message: "Paused", context: "a workflow someone paused" }),
  blocked: msg({
    message: "Not starting",
    context: "how a workflow stands: nothing can start it yet",
  }),
  live: msg({ message: "Live", context: "how a workflow stands" }),
  building: msg({ message: "Not live yet", context: "how a workflow stands" }),
};

/** What starts a workflow, short enough for its route's first mark. */
const triggerNames: Readonly<Record<TriggerKind, MessageDescriptor>> = {
  schedule: msg({
    message: "On a schedule",
    context: "what starts a workflow",
  }),
  connector: msg({
    message: "On an event",
    context: "what starts a workflow",
  }),
  email: msg({ message: "On an email", context: "what starts a workflow" }),
  webhook: msg({ message: "On a webhook", context: "what starts a workflow" }),
};

const triggerIcons: Readonly<Record<TriggerKind, IconData>> = {
  schedule: Clock,
  connector: Globe,
  email: Mail,
  webhook: LinkIcon,
};

/**
 * What starts a workflow, in the few words its route has room for: the
 * address an email trigger receives mail at, when it was given a name
 * ("Mail to invoices"), and when a schedule next starts a run ("Next Mon
 * 07:00"); otherwise only its kind (`kind`, in words).
 */
const startWords = (trigger: RowTrigger, kind: string, i18n: I18n): string => {
  const { address, nextAt } = trigger;
  // One core made up (`trigger-` and random bits) says nothing to a reader.
  if (address !== null && !address.startsWith("trigger-")) {
    return i18n._(msg`Mail to ${address}`);
  }
  if (nextAt !== null) {
    const when = new Intl.DateTimeFormat(i18n.locale, {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(nextAt));
    return i18n._(msg`Next ${when}`);
  }
  return kind;
};

/** The tools a route shows before it says how many more. */
const toolsShown = 4;

const PHONE = "@media (width < 40rem)";

const styles = stylex.create({
  groups: { display: "grid", rowGap: grasp.sectionGap, minWidth: 0 },
  // The route: at one line down the page in every row, as wide as its
  // marks need and no wider, so no hairline is stretched across a wide
  // screen. On a phone it leaves the row to the name and the week.
  route: {
    display: { default: "flex", [PHONE]: "none" },
    flexShrink: 0,
    alignItems: "center",
    width: "19rem",
    minWidth: 0,
  },
  join: {
    flexShrink: 0,
    width: grasp.space4,
    height: grasp.hairline,
    backgroundColor: grasp.line,
  },
  // How the week went, at the row's end: the figure over the last run.
  end: {
    display: "grid",
    flexShrink: 0,
    justifyItems: "end",
    rowGap: grasp.space1,
    width: { default: "13rem", [PHONE]: "auto" },
    marginInlineStart: "auto",
    textAlign: "end",
  },
  figure: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    color: grasp.ink,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    whiteSpace: "nowrap",
  },
  wide: { display: { default: "inline", [PHONE]: "none" } },
  last: {
    display: { default: "block", [PHONE]: "none" },
    color: grasp.muted,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    whiteSpace: "nowrap",
  },
});

const noTools: readonly Tool[] = [];
const noTriggers: readonly RowTrigger[] = [];

/** Where a workflow's work goes: what starts it, then the tools it works in. */
const Route = ({
  triggers,
  tools,
}: {
  /** Undefined until their read answers: the route then begins at its tools. */
  triggers: readonly RowTrigger[] | undefined;
  tools: readonly Tool[];
}) => {
  const { t, i18n } = useLingui();
  const [first] = triggers ?? noTriggers;
  const more = (triggers?.length ?? 0) - 1;
  const start =
    first === undefined
      ? t({ message: "By hand", context: "what starts a workflow" })
      : startWords(first, i18n._(triggerNames[first.kind]), i18n);
  return (
    <span {...stylex.props(styles.route)}>
      {triggers === undefined ? null : (
        <Badge
          icon={first === undefined ? undefined : triggerIcons[first.kind]}
          size="sm"
        >
          {more > 0 ? t`${start}, and ${more} more` : start}
        </Badge>
      )}
      {triggers === undefined || tools.length === 0 ? null : (
        <span aria-hidden="true" {...stylex.props(styles.join)} />
      )}
      {tools.length === 0 ? null : (
        <BrandIconGroup
          brands={tools.map(({ name, brand }) => brand ?? { name })}
          max={toolsShown}
        />
      )}
    </span>
  );
};

/** When a run began, short: the time alone today, the day before that. */
const whenOf = (at: string): string =>
  new Date(at).toDateString() === new Date().toDateString()
    ? formatSince(at)
    : formatDayMonth(at);

/** How a workflow's week went: what it needs, then its runs, over its last run. */
const Week = ({ row, state }: { row: OverviewRow; state: WorkflowState }) => {
  const { t } = useLingui();
  const failed = formatNumber(row.failed);
  const waiting = formatNumber(row.waiting);
  const runs = formatNumber(row.runs ?? 0);
  const since = row.lastRun === null ? "" : whenOf(row.lastRun);
  const needs = state === "failing" || state === "waiting";
  // A user of it sees their own runs alone, so its figures are theirs.
  const own = row.role === "user";
  let last = row.lastRun === null ? t`No runs yet` : t`Last run ${since}`;
  if (own) {
    last =
      row.lastRun === null
        ? t`You haven't run it yet`
        : t`Your last run ${since}`;
  }
  return (
    <span {...stylex.props(styles.end)}>
      <span {...stylex.props(styles.figure)}>
        {state === "failing" ? (
          <Badge size="sm" tone="danger">{t`${failed} failed`}</Badge>
        ) : null}
        {state === "waiting" ? (
          <Badge size="sm" tone="attention">{t`${waiting} waiting`}</Badge>
        ) : null}
        {row.runs === null ? null : (
          // On a phone a row that needs the reader says only that: its
          // name keeps the room.
          <span {...stylex.props(needs && styles.wide)}>
            {own
              ? t`${runs} of yours done this week`
              : t`${runs} done this week`}
          </span>
        )}
      </span>
      <span {...stylex.props(styles.last)}>{last}</span>
    </span>
  );
};

/** One workflow: how it stands, its name, its route and its week. */
const WorkflowRow = ({
  row,
  tools,
  triggers,
}: {
  row: OverviewRow;
  tools: readonly Tool[];
  triggers: readonly RowTrigger[] | undefined;
}) => {
  const { t, i18n } = useLingui();
  const state = stateOf(row);
  const stands = i18n._(stateNames[state]);
  const { version } = row;
  // Whose it is, its version and how it stands, as one quiet line. Where
  // it needs the reader, the row's end says so with its count ("3 failed"),
  // so the line leaves it out: said once.
  const needs = state === "failing" || state === "waiting";
  // Where its triggers can't start it, why, in place of how it stands.
  const standing =
    state === "blocked" && row.blocked !== null
      ? triggerBlockText(row.blocked, i18n)
      : stands;
  const line = [
    row.owner,
    version === null ? null : t`v${version}`,
    needs ? null : standing,
  ].filter((part): part is string => part !== null);
  return (
    <Item
      render={<Link params={{ workflow: row.id }} to="/workflows/$workflow" />}
      size="sm"
    >
      <ItemMedia>
        <WorkflowStateIcon state={state} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{row.name}</ItemTitle>
        <ItemDescription>{line.join(" · ")}</ItemDescription>
      </ItemContent>
      <Route tools={tools} triggers={triggers} />
      <Week row={row} state={state} />
    </Item>
  );
};

/**
 * Every workflow the person can open, gathered by phase. `tools` and
 * `triggers` come after the rows (their own reads): until then a route
 * shows what has arrived.
 */
export const WorkflowRows = ({
  rows,
  tools,
  triggers,
  builds,
}: {
  /** Whether the reader may make a workflow; else they are told who does. */
  builds: boolean;
  /** In the order of their phases (overview.ts). */
  rows: readonly OverviewRow[];
  tools: ToolsByWorkflow | undefined;
  triggers: TriggersByWorkflow | undefined;
}) => {
  const { t, i18n } = useLingui();
  if (rows.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia icon={Workflow} />
          <EmptyTitle>{t`No workflows yet`}</EmptyTitle>
          <EmptyDescription>
            {builds
              ? t`Workflows are made in chat: describe what should run on its own, and Grasp builds it.`
              : t`A workflow does routine work on its own, such as reading the invoices that arrive by email. Your admin or Grasp sets them up; one shared with you shows here.`}
          </EmptyDescription>
        </EmptyHeader>
        {builds ? (
          <EmptyContent>
            <Button render={<Link search={{}} to="/" />}>{t`Open Chat`}</Button>
          </EmptyContent>
        ) : null}
      </Empty>
    );
  }
  return (
    <div {...stylex.props(styles.groups)}>
      {phases.map((phase) => {
        const inPhase = rows.filter((row) => row.phase === phase);
        if (inPhase.length === 0) {
          return null;
        }
        const name = i18n._(phaseNames[phase]);
        return (
          <SectionCard
            aside={formatNumber(inPhase.length)}
            density="compact"
            flush
            key={phase}
            title={name}
            variant="grouped"
          >
            <ItemGroup aria-label={name} separated>
              {inPhase.map((row) => (
                <WorkflowRow
                  key={row.id}
                  row={row}
                  tools={tools?.get(row.id) ?? noTools}
                  triggers={triggers?.get(row.id)}
                />
              ))}
            </ItemGroup>
          </SectionCard>
        );
      })}
    </div>
  );
};
