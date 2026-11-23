import type { BoardReport, SignalCount } from "@grasp-os/shared/board-report";
import type { Programme } from "@grasp-os/shared/onboarding";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import {
  ChartBar,
  ChartBarList,
  ChartContainer,
  ChartGrid,
  ChartTooltip,
  ChartXAxis,
  ChartYAxis,
} from "@grasp-os/ui/components/chart";
import { Heading } from "@grasp-os/ui/components/heading";
import { StatGroup } from "@grasp-os/ui/components/stat";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode, Ref } from "react";

import { formatDate, formatPercent } from "../format.ts";

// The weekly report as a page of its own, made only of Damsko's parts: a
// StatGroup for its figures, a Chart for the runs per day, ChartBarList
// for the workflows and what could be better, Card, Heading and Text for
// the rest. What it shows comes from `boardReport.read()`; a part core
// couldn't read says so in its place, never as nothing that ran. It
// downloads, and prints, as a snapshot of exactly this page
// (report-row.tsx).

const styles = stylex.create({
  page: {
    display: "flex",
    flexDirection: "column",
    gap: space["6"],
    width: "100%",
    maxWidth: "48rem",
    marginInline: "auto",
    paddingBlock: space["8"],
    paddingInline: space["6"],
  },
  head: {
    display: "flex",
    flexDirection: "column",
    gap: space["3"],
  },
});

const readOf = <T,>(
  part: { state: "read"; data: T } | { state: "unread"; code: string }
): T | undefined => (part.state === "read" ? part.data : undefined);

const share = (part: number, whole: number): number =>
  whole === 0 ? 0 : Math.round((part / whole) * 100);

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

/** What each kind of signal is called. */
const signalKindNames: Record<SignalCount["kind"], MessageDescriptor> = {
  failing_step: msg`Keeps failing`,
  waiting_for_person: msg`Waiting for a person`,
  correction: msg`Often corrected`,
  cost_per_run: msg`Model cost`,
};

/** The order kinds with as many signals come in: what a run waits or fails on first. */
const kindOrder: readonly SignalCount["kind"][] = [
  "failing_step",
  "waiting_for_person",
  "correction",
  "cost_per_run",
];

/** What ran in the week, worked out once from what core read. */
interface Ran {
  from: string;
  to: string;
  total: number;
  completed: number;
  failed: number;
  percentAlone: number;
  days: { day: string; runs: number }[];
  workflows: { name: string; started: number }[];
}

/**
 * What the report says. A part core couldn't read is undefined, and says
 * so in its place; `better` is null for someone who reads no signals, and
 * the report leaves it out.
 */
interface Week {
  company: string;
  week: number;
  weeks: number;
  ran: Ran | undefined;
  better: { kind: string; count: number }[] | null | undefined;
}

const weekOf = (
  report: BoardReport,
  programme: Programme,
  company: string,
  {
    locale,
    name,
  }: { locale: string; name: (kind: MessageDescriptor) => string }
): Week => {
  const runs = readOf(report.runs);
  const better = readOf(report.better);
  const weekday = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    timeZone: "UTC",
  });
  let ran: Ran | undefined;
  if (runs !== undefined) {
    const { days } = runs;
    ran = {
      from: formatDate(runs.from),
      to: formatDate(runs.to),
      total: runs.runs.total,
      completed: sum(days.map((day) => day.completed)),
      failed: sum(days.map((day) => day.failed)),
      percentAlone: share(runs.runs.withoutPerson, runs.runs.total),
      days: days.map((day) => ({
        day: weekday.format(new Date(`${day.day}T12:00:00Z`)),
        runs: day.completed + day.failed + day.waiting + day.other,
      })),
      workflows: runs.workflows.map((each) => ({
        name: each.name,
        started: each.started,
      })),
    };
  }
  const counts = new Map(
    (better ?? []).map(({ kind, count }) => [kind, count])
  );
  return {
    company,
    week: programme.week,
    weeks: programme.weeks,
    ran,
    better:
      better === null || better === undefined
        ? better
        : kindOrder
            .flatMap((kind) => {
              const count = counts.get(kind);
              return count === undefined
                ? []
                : [{ kind: name(signalKindNames[kind]), count }];
            })
            .toSorted((a, b) => b.count - a.count),
  };
};

/** One part of the report on a card of its own, under its title. */
const Part = ({ title, children }: { title: string; children: ReactNode }) => (
  <Card asChild>
    <section>
      <CardHeader>
        <CardTitle level={2}>{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </section>
  </Card>
);

/** What a part says when core couldn't read it. */
const Unread = () => {
  const { t } = useLingui();
  return (
    <Text color="muted" size="sm">
      {t`This couldn't be read when the report was made.`}
    </Text>
  );
};

/** What ran: the figures and the charts that say it. */
const WhatRan = ({ ran }: { ran: Ran }) => {
  const { t } = useLingui();
  const { from, to, total, completed, failed } = ran;
  const percent = formatPercent(ran.percentAlone / 100);
  return (
    <>
      <StatGroup
        aria-label={t`The week's figures`}
        columns={4}
        items={[
          { label: t`Runs`, value: String(total) },
          { label: t`Completed`, value: String(completed) },
          {
            label: t`Failed`,
            value: String(failed),
            ...(failed > 0 ? { variant: "destructive" as const } : {}),
          },
          { label: t`Without a person`, value: percent },
        ]}
      />
      <Part title={t`Runs per day`}>
        <ChartContainer
          aria-label={t`Runs per day`}
          config={{ runs: { label: t`Runs` } }}
          data={ran.days}
          summary={t`${plural(total, { one: `# run from ${from} to ${to}.`, other: `# runs from ${from} to ${to}.` })}`}
          xKey="day"
        >
          <ChartGrid />
          <ChartXAxis />
          <ChartYAxis />
          <ChartBar dataKey="runs" pattern="dither-pixels" />
          <ChartTooltip />
        </ChartContainer>
      </Part>
      {ran.workflows.length === 0 ? null : (
        <Part title={t`Workflows`}>
          <ChartBarList
            aria-label={t`Runs by workflow`}
            config={{ started: { label: t`Runs` } }}
            data={ran.workflows}
            nameKey="name"
            pattern="dither-dots"
            summary={t`${plural(total, { one: "Where this week's # run went.", other: "Where this week's # runs went." })}`}
          />
        </Part>
      )}
    </>
  );
};

/** The week's one sentence: how much of what ran needed nobody. */
const Lead = ({ ran }: { ran: Ran }) => {
  const { t } = useLingui();
  const { total } = ran;
  const percent = formatPercent(ran.percentAlone / 100);
  return t`${plural(total, { one: `${percent} of this week's # run needed nobody.`, other: `${percent} of this week's # runs needed nobody.` })}`;
};

/**
 * The report: who and which week, one sentence, what ran, and what could
 * be better. With what ran unread, the week leads instead of the sentence.
 */
const Report = ({ week }: { week: Week }) => {
  const { t } = useLingui();
  const { company, weeks, ran, better } = week;
  const number = week.week;
  // Over the sentence: who, which week and its days; with what ran
  // unread, only who, as the week itself leads.
  let over: string = company;
  if (ran !== undefined) {
    const { from, to } = ran;
    over = t`${company} · Week ${number} of ${weeks} · ${from} to ${to}`;
  }
  return (
    <>
      <div {...stylex.props(styles.head)}>
        {over === "" ? null : (
          <Text color="muted" size="sm">
            {over}
          </Text>
        )}
        <Heading level={1} size="xl">
          {ran === undefined ? (
            t`Week ${number} of ${weeks}`
          ) : (
            <Lead ran={ran} />
          )}
        </Heading>
      </div>
      {ran === undefined ? (
        <Part title={t`What ran`}>
          <Unread />
        </Part>
      ) : (
        <WhatRan ran={ran} />
      )}
      {better === undefined ? (
        <Part title={t`What could be better`}>
          <Unread />
        </Part>
      ) : null}
      {better === null || better === undefined || better.length === 0 ? null : (
        <Part title={t`What could be better`}>
          <ChartBarList
            aria-label={t`What could be better`}
            config={{ count: { label: t`Signals` } }}
            data={better}
            nameKey="kind"
            summary={t`What Grasp noticed could be better, by kind.`}
          />
        </Part>
      )}
    </>
  );
};

export const ReportView = ({
  report,
  programme,
  company,
  ref,
}: {
  report: BoardReport;
  programme: Programme;
  company: string;
  /** The page itself, for its snapshot. */
  ref?: Ref<HTMLDivElement>;
}) => {
  const { i18n } = useLingui();
  const week = weekOf(report, programme, company, {
    locale: i18n.locale,
    name: (kind) => i18n._(kind),
  });
  return (
    <div ref={ref} {...stylex.props(styles.page)}>
      <Report week={week} />
    </div>
  );
};
