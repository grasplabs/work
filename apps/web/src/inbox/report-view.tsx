import type { BoardReport } from "@grasp-os/shared/dashboard";
import type { Programme } from "@grasp-os/shared/onboarding";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import type { Ref } from "react";

import { formatDate, formatPercent } from "../format.ts";
import {
  Chart,
  ChartAxis,
  ChartBar,
  ChartBarList,
  ChartGrid,
  ChartTooltip,
} from "../grasp/chart/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import { PanelTexture } from "../grasp/panel/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { StatsGrid } from "../grasp/stats/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// The weekly report as an artifact, made only of the library's parts:
// Stats for its figures, Chart for the runs per day, ChartBarList for the
// workflows and what could be better, SectionCard, Heading and Text for
// the rest, PanelTexture behind the one sentence that leads (Ruben's pick
// of three looks, 18 November). What it shows comes from
// `dashboard.report()`. It downloads as a snapshot of exactly this page
// (report-row.tsx).

const styles = stylex.create({
  page: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space6,
    maxWidth: "48rem",
    marginInline: "auto",
    paddingBlock: grasp.space8,
    paddingInline: grasp.space6,
    backgroundColor: grasp.paper,
  },
  head: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: grasp.space3,
    padding: grasp.space8,
    borderRadius: grasp.corner,
    overflow: "hidden",
  },
  over: { position: "relative" },
  chart: { width: "100%" },
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
  alone: number;
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
    alone,
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

const Eyebrow = ({ week }: { week: Week }) => {
  const { t } = useLingui();
  const { company, from, to, weeks } = week;
  const number = week.week;
  return (
    <Text size="sm" tone="muted">
      {t`${company} · Week ${number} of ${weeks} · ${from} to ${to}`}
    </Text>
  );
};

const Figures = ({ week }: { week: Week }) => {
  const { t } = useLingui();
  const { total, completed, failed, percentAlone } = week;
  return (
    <StatsGrid
      aria-label={t`The week's figures`}
      columns={4}
      items={[
        { title: t`Runs`, value: String(total) },
        { title: t`Completed`, value: String(completed) },
        {
          title: t`Failed`,
          value: String(failed),
          ...(failed > 0 ? { tone: "danger" as const } : {}),
        },
        {
          title: t`Without a person`,
          value: formatPercent(percentAlone / 100),
        },
      ]}
    />
  );
};

const PerDay = ({ week }: { week: Week }) => {
  const { t } = useLingui();
  const { total, from, to } = week;
  return (
    <SectionCard title={t`Runs per day`}>
      <Chart
        aria-label={t`Runs per day`}
        config={{ runs: { label: t`Runs` } }}
        data={week.days}
        layout={styles.chart}
        summary={t`${plural(total, { one: `# run from ${from} to ${to}.`, other: `# runs from ${from} to ${to}.` })}`}
        xKey="day"
      >
        <ChartGrid />
        <ChartAxis side="x" />
        <ChartAxis side="y" />
        <ChartBar fill="dither-pixels" series="runs" />
        <ChartTooltip />
      </Chart>
    </SectionCard>
  );
};

const Workflows = ({ week }: { week: Week }) => {
  const { t } = useLingui();
  const { total } = week;
  return week.workflows.length === 0 ? null : (
    <SectionCard title={t`Workflows`}>
      <ChartBarList
        aria-label={t`Runs by workflow`}
        config={{ started: { label: t`Runs` } }}
        data={week.workflows}
        fill="dither-dots"
        layout={styles.chart}
        nameKey="name"
        summary={t`${plural(total, { one: "Where this week's # run went.", other: "Where this week's # runs went." })}`}
      />
    </SectionCard>
  );
};

const Better = ({ week }: { week: Week }) => {
  const { t } = useLingui();
  return week.better.length === 0 ? null : (
    <SectionCard title={t`What could be better`}>
      <ChartBarList
        aria-label={t`What could be better`}
        config={{ count: { label: t`Signals` } }}
        data={week.better}
        layout={styles.chart}
        nameKey="kind"
        summary={t`What Grasp noticed could be better, by kind.`}
      />
    </SectionCard>
  );
};

/** The report: one sentence leads, on the dither, then the figures and the charts that say it. */
const Report = ({ week }: { week: Week }) => {
  const { t } = useLingui();
  const { percentAlone, total } = week;
  const percent = formatPercent(percentAlone / 100);
  return (
    <>
      <div {...stylex.props(styles.head)}>
        <PanelTexture />
        <div {...stylex.props(styles.over)}>
          <Eyebrow week={week} />
        </div>
        <div {...stylex.props(styles.over)}>
          <Heading level={1} size="xl">
            {t`${plural(total, { one: `${percent} of this week's # run needed nobody.`, other: `${percent} of this week's # runs needed nobody.` })}`}
          </Heading>
        </div>
      </div>
      <Figures week={week} />
      <PerDay week={week} />
      <Workflows week={week} />
      <Better week={week} />
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
