import type {
  RunActivity,
  RunActivityDay,
  RunActivityWorkflow,
} from "@grasp-os/shared/workflows";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useId } from "react";

import { RouterLink } from "../frame/router-link.tsx";
import { Heading } from "../grasp/heading/index.ts";
import { visuallyHidden } from "../grasp/hidden/hidden.ts";
import { StatsGrid, Stat } from "../grasp/stats/index.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../grasp/table/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import {
  columnsOf,
  fullDays,
  isLabelled,
  lastDays,
  runOutcomes,
  weekDays,
  withoutPerson,
} from "./runs.ts";
import type { RunOutcome } from "./runs.ts";
import { WidgetBlock } from "./widget-block.tsx";

// The Runs widget of the dashboard's board: how many runs started each
// day of the week, as columns of how they stand now, and how many of them
// needed nobody, the headline. In full, the last month the same way, the
// decisions those runs asked people for, and each workflow's runs. The
// columns are drawn for the eye; a table that says the same is there for
// screen readers.

/** Each outcome's name. */
const outcomeNames: Record<RunOutcome, MessageDescriptor> = {
  completed: msg`Completed`,
  failed: msg`Failed`,
  waiting: msg`Waiting on a person`,
  other: msg`Running or cancelled`,
};

/** Each outcome's part of a column: green once done, orange where it failed, pale while it waits. */
const outcomeFills = stylex.create({
  completed: { fill: grasp.success },
  failed: { fill: grasp.attention },
  waiting: { fill: grasp.attention, fillOpacity: 0.4 },
  other: { fill: grasp.chartQuietFill },
});

/** Each outcome's mark in the key, as its part of a column. */
const outcomeSwatches = stylex.create({
  completed: { backgroundColor: grasp.success },
  failed: { backgroundColor: grasp.attention },
  waiting: { backgroundColor: grasp.attention, opacity: 0.4 },
  other: { backgroundColor: grasp.chartQuietFill },
});

const styles = stylex.create({
  key: {
    display: "flex",
    flexWrap: "wrap",
    columnGap: grasp.space3,
    rowGap: grasp.space1,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  keyItem: { display: "flex", alignItems: "center", columnGap: grasp.space2 },
  swatch: {
    flexShrink: 0,
    width: grasp.space2,
    height: grasp.space2,
    borderRadius: grasp.cornerCircle,
  },
  figure: {
    display: "flex",
    flexDirection: "column",
    rowGap: grasp.space2,
    margin: 0,
  },
  figureBoard: { flexGrow: 1, minHeight: 0 },
  drawing: { flexGrow: 1, minHeight: 0 },
  drawingTall: { height: "12rem" },
  svg: { display: "block", width: "100%", height: "100%" },
  pointed: { fill: "transparent" },
  days: {
    display: "flex",
    paddingBlockStart: grasp.space1,
    borderTopWidth: grasp.hairline,
    borderTopStyle: "solid",
    borderTopColor: grasp.line,
  },
  dayName: {
    display: "flex",
    flexGrow: 1,
    flexBasis: 0,
    justifyContent: "center",
    minWidth: 0,
    whiteSpace: "nowrap",
  },
  section: { display: "flex", flexDirection: "column", rowGap: grasp.space3 },
  inFull: { display: "flex", flexDirection: "column", rowGap: grasp.space8 },
  quietLine: { display: "flex", alignItems: "center", height: "100%" },
});

/** A UTC day, `YYYY-MM-DD`, as a moment inside it wherever the page is. */
const middayOf = (day: string): string => `${day}T12:00:00Z`;

/**
 * A UTC day's date as the page's language writes it, such as "3 Oct
 * 2026": read in UTC, as the chart's columns are, so a page east of UTC
 * by 12 hours or more names the same day.
 */
const dayDate = (day: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(middayOf(day)));

/** A share from 0 to 1 in whole percent, as the page's language writes it. */
const percent = (share: number, locale: string): string =>
  new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(share);

/** What a column is named under the chart: its weekday in a week, its date in a month. */
const columnName = (day: string, days: number, locale: string): string =>
  new Intl.DateTimeFormat(
    locale,
    days <= weekDays
      ? { weekday: "short", timeZone: "UTC" }
      : { day: "numeric", month: "short", timeZone: "UTC" }
  ).format(new Date(middayOf(day)));

/** The outcomes' key: each one's mark and name. */
const OutcomeKey = () => {
  const { i18n } = useLingui();
  return (
    <ul aria-hidden="true" {...stylex.props(styles.key)}>
      {runOutcomes.map((outcome) => (
        <li key={outcome} {...stylex.props(styles.keyItem)}>
          <span {...stylex.props(styles.swatch, outcomeSwatches[outcome])} />
          <Text element="span" size="xs" tone="muted">
            {i18n._(outcomeNames[outcome])}
          </Text>
        </li>
      ))}
    </ul>
  );
};

/** The days' runs as a table, for screen readers: what the columns show. */
const DaysTable = ({ days }: { days: readonly RunActivityDay[] }) => {
  const { i18n } = useLingui();
  return (
    <div {...stylex.props(visuallyHidden)}>
      <Table caption={<Trans>Runs by the day they started</Trans>}>
        <TableHeader>
          <TableRow>
            <TableHead>
              <Trans>Day</Trans>
            </TableHead>
            {runOutcomes.map((outcome) => (
              <TableHead key={outcome}>
                {i18n._(outcomeNames[outcome])}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {days.map((day) => (
            <TableRow key={day.day}>
              <TableCell>{dayDate(day.day, i18n.locale)}</TableCell>
              {runOutcomes.map((outcome) => (
                <TableCell key={outcome}>{day[outcome]}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};

/**
 * A column for each day, oldest on the left, stacked by outcome from the
 * ground up, with the days named under them and the key; `tall` in full.
 */
const DayColumns = ({
  days,
  tall = false,
}: {
  days: readonly RunActivityDay[];
  tall?: boolean;
}) => {
  const { i18n } = useLingui();
  const columns = columnsOf(days);
  return (
    <figure {...stylex.props(styles.figure, !tall && styles.figureBoard)}>
      <div {...stylex.props(tall ? styles.drawingTall : styles.drawing)}>
        <svg
          aria-hidden="true"
          preserveAspectRatio="none"
          viewBox={`0 0 ${columns.length} 1`}
          {...stylex.props(styles.svg)}
        >
          {columns.map(({ day, runs, parts }, index) => {
            const date = dayDate(day.day, i18n.locale);
            return (
              <g key={day.day}>
                <title>
                  {plural(runs, {
                    one: `${date}: # run`,
                    other: `${date}: # runs`,
                  })}
                </title>
                {/* The whole height, so pointing anywhere over a day names it. */}
                <rect
                  height={1}
                  width={1}
                  x={index}
                  y={0}
                  {...stylex.props(styles.pointed)}
                />
                {parts.map((part) => (
                  <rect
                    height={part.height}
                    key={part.outcome}
                    width={0.7}
                    x={index + 0.15}
                    y={1 - part.from - part.height}
                    {...stylex.props(outcomeFills[part.outcome])}
                  />
                ))}
              </g>
            );
          })}
        </svg>
      </div>
      {/* A name wider than its column spills over the unnamed ones beside it. */}
      <div aria-hidden="true" {...stylex.props(styles.days)}>
        {columns.map(({ day }, index) => (
          <span key={day.day} {...stylex.props(styles.dayName)}>
            <Text element="span" size="xs" tone="muted">
              {isLabelled(index, columns.length)
                ? columnName(day.day, columns.length, i18n.locale)
                : ""}
            </Text>
          </span>
        ))}
      </div>
      <OutcomeKey />
      <DaysTable days={days} />
    </figure>
  );
};

/** How many of `days`' runs needed nobody, as the headline: the share, and of how many. */
const Headline = ({ days }: { days: readonly RunActivityDay[] }) => {
  const { i18n } = useLingui();
  const { runs, share } = withoutPerson(days);
  if (share === null) {
    return null;
  }
  const without = percent(share, i18n.locale);
  return (
    <Stat
      title={plural(runs, {
        one: "Without a person, of # run",
        other: "Without a person, of # runs",
      })}
      value={without}
    />
  );
};

/** The decisions the runs asked people for, by how they ended. */
const Decisions = ({ activity }: { activity: RunActivity }) => {
  const { i18n, t } = useLingui();
  const id = useId();
  const { approved, rejected, timedOut, open } = activity.decisions;
  const { total, withPerson } = activity.runs;
  const counts: { key: string; name: MessageDescriptor; count: number }[] = [
    { key: "approved", name: msg`Approved`, count: approved },
    { key: "rejected", name: msg`Rejected`, count: rejected },
    { key: "timedOut", name: msg`Timed out`, count: timedOut },
    { key: "open", name: msg`Open now`, count: open },
  ];
  return (
    <section aria-labelledby={id} {...stylex.props(styles.section)}>
      <Heading id={id} level={3} size="ui-sm">
        <Trans>Decisions</Trans>
      </Heading>
      <Text tone="muted">
        <Plural
          one={`${withPerson} of # run asked a person for a decision.`}
          other={`${withPerson} of # runs asked a person for a decision.`}
          value={total}
        />
      </Text>
      <StatsGrid
        aria-label={t`Decisions, by how they ended`}
        columns={4}
        items={counts.map(({ name, count }) => ({
          title: i18n._(name),
          value: String(count),
        }))}
      />
    </section>
  );
};

/** A workflow that ran, opening it. */
const ActivityWorkflow = ({ row }: { row: RunActivityWorkflow }) => (
  <RouterLink
    params={{ workflow: row.workflowId }}
    to="/workflows/$workflow"
    variant="standalone"
  >
    {row.name}
  </RouterLink>
);

/** Each workflow's runs over the window: how many started, completed and failed. */
const Workflows = ({ activity }: { activity: RunActivity }) => {
  const { t } = useLingui();
  const id = useId();
  const title = t`By workflow`;
  if (activity.workflows.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby={id} {...stylex.props(styles.section)}>
      <Heading id={id} level={3} size="ui-sm">
        {title}
      </Heading>
      <Table aria-label={title}>
        <TableHeader>
          <TableRow>
            <TableHead>
              <Trans>Workflow</Trans>
            </TableHead>
            <TableHead align="end">
              <Trans>Started</Trans>
            </TableHead>
            <TableHead align="end">
              <Trans>Completed</Trans>
            </TableHead>
            <TableHead align="end">
              <Trans>Failed</Trans>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {activity.workflows.map((row) => (
            <TableRow key={row.workflowId}>
              <TableCell lead>
                <ActivityWorkflow row={row} />
              </TableCell>
              <TableCell align="end">{row.started}</TableCell>
              <TableCell align="end">{row.completed}</TableCell>
              <TableCell align="end">{row.failed}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
};

/** In full: the month's columns and headline, the decisions, and each workflow. */
const RunsInFull = ({ activity }: { activity: RunActivity }) => (
  <div {...stylex.props(styles.inFull)}>
    <section {...stylex.props(styles.section)}>
      <Headline days={activity.days} />
      <DayColumns days={activity.days} tall />
    </section>
    <Decisions activity={activity} />
    <Workflows activity={activity} />
  </div>
);

/**
 * The runs of the Apps the person can open, this week: the share
 * that needed nobody and a column for each day, or a quiet line before
 * any ran. It opens in full once any ran in the month.
 */
export const RunsWidget = ({ activity }: { activity: RunActivity }) => {
  const { t } = useLingui();
  const week = lastDays(activity, weekDays);
  const ranThisWeek = withoutPerson(week).runs > 0;
  return (
    <WidgetBlock
      description={t`Runs over the last ${fullDays} days, by the day they started and how they stand now.`}
      full={
        activity.runs.total === 0 ? undefined : (
          <RunsInFull activity={activity} />
        )
      }
      title={t`Runs this week`}
    >
      {ranThisWeek ? (
        <>
          <Headline days={week} />
          <DayColumns days={week} />
        </>
      ) : (
        <div {...stylex.props(styles.quietLine)}>
          <Text tone="muted">
            <Trans>No runs this week.</Trans>
          </Text>
        </div>
      )}
    </WidgetBlock>
  );
};
