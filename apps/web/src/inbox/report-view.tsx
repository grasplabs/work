import type { BoardReport } from "@grasp-os/shared/board-report";
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
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode, Ref } from "react";

import { formatDate, formatPercent } from "../format.ts";

// The weekly report as a page of its own, made only of Damsko's parts: a
// StatGroup for its figures, a Chart for the runs per day, ChartBarList
// for the workflows and what could be better, Card, Heading and Text for
// the rest. What it shows comes from `boardReport.read()`. It downloads,
// and prints, as a snapshot of exactly this page (report-row.tsx).

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

/** What the report says, worked out once from what core read. */
interface Week {
  company: string;
  week: number;
  weeks: number;
  from: string;
  to: string;
  total: number;
  completed: number;
  failed: number;
  percentAlone: number;
  days: { day: string; runs: number }[];
  workflows: { name: string; started: number }[];
  better: { kind: string; count: number }[];
}

const weekOf = (
  report: BoardReport,
  programme: Programme,
  company: string,
  locale: string
): Week => {
  const runs = readOf(report.runs);
  const days = runs?.days ?? [];
  const total = runs?.runs.total ?? 0;
  const alone = runs?.runs.withoutPerson ?? 0;
  const weekday = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    timeZone: "UTC",
  });
  return {
    company,
    week: programme.week,
    weeks: programme.weeks,
    from: runs === undefined ? "" : formatDate(runs.from),
    to: runs === undefined ? "" : formatDate(runs.to),
    total,
    completed: sum(days.map((day) => day.completed)),
    failed: sum(days.map((day) => day.failed)),
    percentAlone: share(alone, total),
    days: days.map((day) => ({
      day: weekday.format(new Date(`${day.day}T12:00:00Z`)),
      runs: day.completed + day.failed + day.waiting + day.other,
    })),
    workflows: (runs?.workflows ?? []).map((each) => ({
      name: each.name,
      started: each.started,
    })),
    better: (readOf(report.better) ?? []).map((each) => ({
      kind: each.kind.replaceAll("_", " "),
      count: each.count,
    })),
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

/** The report: one sentence leads, then the figures and the charts that say it. */
const Report = ({ week }: { week: Week }) => {
  const { t } = useLingui();
  const { company, from, to, weeks, total, completed, failed } = week;
  const number = week.week;
  const percent = formatPercent(week.percentAlone / 100);
  return (
    <>
      <div {...stylex.props(styles.head)}>
        <Text color="muted" size="sm">
          {t`${company} · Week ${number} of ${weeks} · ${from} to ${to}`}
        </Text>
        <Heading level={1} size="xl">
          {t`${plural(total, { one: `${percent} of this week's # run needed nobody.`, other: `${percent} of this week's # runs needed nobody.` })}`}
        </Heading>
      </div>
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
          data={week.days}
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
      {week.workflows.length === 0 ? null : (
        <Part title={t`Workflows`}>
          <ChartBarList
            aria-label={t`Runs by workflow`}
            config={{ started: { label: t`Runs` } }}
            data={week.workflows}
            nameKey="name"
            pattern="dither-dots"
            summary={t`${plural(total, { one: "Where this week's # run went.", other: "Where this week's # runs went." })}`}
          />
        </Part>
      )}
      {week.better.length === 0 ? null : (
        <Part title={t`What could be better`}>
          <ChartBarList
            aria-label={t`What could be better`}
            config={{ count: { label: t`Signals` } }}
            data={week.better}
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
  const week = weekOf(report, programme, company, i18n.locale);
  return (
    <div ref={ref} {...stylex.props(styles.page)}>
      <Report week={week} />
    </div>
  );
};
