import type { RunActivity, RunActivityDay } from "@grasp-os/shared/workflows";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { cn } from "@grasp-os/ui/lib/utils";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { useId } from "react";

import { formatDate } from "../format.ts";
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
const outcomeFills: Record<RunOutcome, string> = {
  completed: "fill-status-agreed",
  failed: "fill-destructive",
  waiting: "fill-status-attention/40",
  other: "fill-muted-foreground/30",
};

/** Each outcome's mark in the key, as its part of a column. */
const outcomeSwatches: Record<RunOutcome, string> = {
  completed: "bg-status-agreed",
  failed: "bg-destructive",
  waiting: "bg-status-attention/40",
  other: "bg-muted-foreground/30",
};

/** A UTC day, `YYYY-MM-DD`, as a moment inside it wherever the page is. */
const middayOf = (day: string): string => `${day}T12:00:00Z`;

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
    <ul aria-hidden="true" className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
      {runOutcomes.map((outcome) => (
        <li className="flex items-center gap-1.5" key={outcome}>
          <span
            className={cn(
              "size-2 flex-none rounded-full",
              outcomeSwatches[outcome]
            )}
          />
          <span className="text-muted-foreground">
            {i18n._(outcomeNames[outcome])}
          </span>
        </li>
      ))}
    </ul>
  );
};

/** The days' runs as a table, for screen readers: what the columns show. */
const DaysTable = ({ days }: { days: readonly RunActivityDay[] }) => {
  const { i18n } = useLingui();
  return (
    <div className="sr-only">
      <Table>
        <TableCaption>
          <Trans>Runs by the day they started</Trans>
        </TableCaption>
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
              <TableCell>{formatDate(middayOf(day.day))}</TableCell>
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
    <figure className={cn("flex flex-col gap-1.5", !tall && "min-h-0 flex-1")}>
      <div className={tall ? "h-48" : "min-h-0 flex-1"}>
        <svg
          aria-hidden="true"
          className="size-full"
          preserveAspectRatio="none"
          viewBox={`0 0 ${columns.length} 1`}
        >
          {columns.map(({ day, runs, parts }, index) => {
            const date = formatDate(middayOf(day.day));
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
                  className="fill-transparent"
                  height={1}
                  width={1}
                  x={index}
                  y={0}
                />
                {parts.map((part) => (
                  <rect
                    className={outcomeFills[part.outcome]}
                    height={part.height}
                    key={part.outcome}
                    width={0.7}
                    x={index + 0.15}
                    y={1 - part.from - part.height}
                  />
                ))}
              </g>
            );
          })}
        </svg>
      </div>
      {/* A name wider than its column spills over the unnamed ones beside it. */}
      <div aria-hidden="true" className="flex border-t pt-1">
        {columns.map(({ day }, index) => (
          <span
            className="text-muted-foreground flex min-w-0 flex-1 justify-center text-xs whitespace-nowrap"
            key={day.day}
          >
            {isLabelled(index, columns.length)
              ? columnName(day.day, columns.length, i18n.locale)
              : ""}
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
    <p className="flex flex-wrap items-baseline gap-x-2">
      <span>
        <Trans>
          <span className="text-2xl font-medium tabular-nums">{without}</span>{" "}
          without a person
        </Trans>
      </span>
      <span className="text-muted-foreground text-xs">
        <Plural one="of # run" other="of # runs" value={runs} />
      </span>
    </p>
  );
};

/** The decisions the runs asked people for, by how they ended. */
const Decisions = ({ activity }: { activity: RunActivity }) => {
  const { i18n } = useLingui();
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
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h3 className="font-medium" id={id}>
        <Trans>Decisions</Trans>
      </h3>
      <p className="text-muted-foreground">
        <Plural
          one={`${withPerson} of # run asked a person for a decision.`}
          other={`${withPerson} of # runs asked a person for a decision.`}
          value={total}
        />
      </p>
      <dl className="grid grid-cols-2 gap-4 @md:grid-cols-4">
        {counts.map(({ key, name, count }) => (
          <div className="flex flex-col" key={key}>
            <dt className="text-muted-foreground text-xs">{i18n._(name)}</dt>
            <dd className="text-2xl font-medium tabular-nums">{count}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
};

/** Each workflow's runs over the window: how many started, completed and failed. */
const Workflows = ({ activity }: { activity: RunActivity }) => {
  const id = useId();
  if (activity.workflows.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h3 className="font-medium" id={id}>
        <Trans>By workflow</Trans>
      </h3>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <Trans>Workflow</Trans>
            </TableHead>
            <TableHead>
              <Trans>Engine</Trans>
            </TableHead>
            <TableHead className="text-right">
              <Trans>Started</Trans>
            </TableHead>
            <TableHead className="text-right">
              <Trans>Completed</Trans>
            </TableHead>
            <TableHead className="text-right">
              <Trans>Failed</Trans>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {activity.workflows.map((row) => (
            <TableRow key={`${row.app}/${row.workflow}`}>
              <TableCell>
                <Link
                  className="hover:underline"
                  params={{ app: row.app, workflow: row.workflow }}
                  to="/workflows/$app/$workflow"
                >
                  {row.workflow}
                </Link>
              </TableCell>
              <TableCell>{row.appName}</TableCell>
              <TableCell className="text-right">{row.started}</TableCell>
              <TableCell className="text-right">{row.completed}</TableCell>
              <TableCell className="text-right">{row.failed}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
};

/** In full: the month's columns and headline, the decisions, and each workflow. */
const RunsInFull = ({ activity }: { activity: RunActivity }) => (
  <div className="flex flex-col gap-8">
    <section className="flex flex-col gap-3">
      <Headline days={activity.days} />
      <DayColumns days={activity.days} tall />
    </section>
    <Decisions activity={activity} />
    <Workflows activity={activity} />
  </div>
);

/**
 * The runs of the engines the person can open, this week: the share
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
        <p className="text-muted-foreground flex h-full items-center">
          <Trans>No runs this week.</Trans>
        </p>
      )}
    </WidgetBlock>
  );
};
