import type {
  ModelDaySpend,
  ModelMonthSpend,
  ModelSettings,
  SpendingWorkflow,
} from "@grasp-os/shared/models";
import {
  ChartArea,
  ChartBarList,
  ChartContainer,
  ChartGrid,
  ChartTooltip,
  ChartXAxis,
  ChartYAxis,
} from "@grasp-os/ui/components/chart";
import { Stat } from "@grasp-os/ui/components/stat";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { i18n as active } from "@lingui/core";
import type { I18n } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { formatDollars } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { monthEnd } from "./money.ts";
import { RowAlert, SettingsGroup } from "./section.tsx";

// Settings › AI and spend, its last card: what the models cost this month
// on the organization's keys (core's `models.spend()` and the Apps' model
// bindings from `models.settings()`), as Grasp UI's spend card draws it
// (examples/chart/spend-card.tsx). The month's total as the key figure,
// with where it ends at this pace; the month so far as one area, day by
// day; then where it went, chat, each workflow and each App, as a list of bars. Read-only:
// nothing in Grasp limits what an organization spends on its own keys.

const styles = stylex.create({
  body: {
    display: "grid",
    gap: space["4"],
  },
  chart: { width: "100%" },
});

/** The value axis's width: room for its longest label, "$0.075" (Grasp UI's spend card). */
const axisWidth = 56;

/** Dollars short enough for the chart's value axis: cents under a dollar, then compact. */
const axisDollars = (value: string | number): string => {
  const amount = Number(value);
  return new Intl.NumberFormat(active.locale, {
    style: "currency",
    currency: "USD",
    notation: amount < 1 ? "standard" : "compact",
    // Under a dollar a quarter step keeps its third decimal ($0.025): the
    // axis is wide enough for it (`axisWidth`).
    minimumFractionDigits: amount < 1 ? 2 : 0,
    maximumFractionDigits: amount < 1 ? 3 : 1,
  }).format(amount);
};

/** A workflow's name, with its App's for an App's workflow. */
const workflowName = (of: SpendingWorkflow, i18n: I18n): string => {
  const workflow = of.name ?? of.workflowId;
  if (of.appId === null) {
    return workflow;
  }
  const app = of.appName ?? of.appId;
  return i18n._(msg`${workflow} in ${ph({ app })}`);
};

/** Less than this many dollars is nothing left over: sums of floats round. */
const leftOverMin = 0.0001;

/**
 * Where the month's spend went: chat, each workflow, each App, and, where
 * those lists are whole, the rest under `names.other` (the Brain, whatever
 * else calls a model on the organization's key); none that spent nothing.
 */
const whereItWent = (
  spend: ModelMonthSpend,
  settings: ModelSettings | undefined,
  i18n: I18n,
  names: { chat: string; other: string }
): { name: string; spend: number }[] => {
  const rows = [
    { name: names.chat, spend: spend.chat },
    ...spend.workflows.map((workflow) => ({
      name: workflowName(workflow, i18n),
      spend: workflow.amount,
    })),
    ...(settings?.bindings.listed ?? []).map((binding) => ({
      name: binding.appName,
      spend: binding.thisMonth,
    })),
  ];
  // Only from whole lists: with some left out, the rest isn't known.
  const whole =
    settings !== undefined && !spend.more && !settings.bindings.more;
  const left = spend.total - rows.reduce((sum, row) => sum + row.spend, 0);
  // One bar per name: the chart keys its bars by it, so an App with two
  // model bindings, or two workflows of one name, add up on one bar.
  const bars = new Map<string, number>();
  for (const row of [
    ...rows,
    ...(whole && left > leftOverMin
      ? [{ name: names.other, spend: left }]
      : []),
  ]) {
    bars.set(row.name, (bars.get(row.name) ?? 0) + row.spend);
  }
  return [...bars]
    .map(([name, spent]) => ({ name, spend: spent }))
    .filter((row) => row.spend > 0)
    .toSorted((a, b) => b.spend - a.spend);
};

/**
 * The month so far as a running total, day by day: one calm line that
 * ends at the key figure above it, never a spike for a busy day. Each day
 * is named by its number; a company's day in the month before or after
 * (its time zone's month is cut at the UTC month's edges) by its month and
 * day, so no two days read alike.
 */
const runningTotal = (
  days: readonly ModelDaySpend[],
  month: string,
  locale: string
): { day: string; spend: number }[] => {
  const outside = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const points: { day: string; spend: number }[] = [];
  let sofar = 0;
  for (const { date, amount } of days) {
    sofar += amount;
    points.push({
      day: date.startsWith(month)
        ? String(Number(date.slice(8)))
        : outside.format(new Date(`${date}T00:00:00Z`)),
      spend: sofar,
    });
  }
  return points;
};

/**
 * The month's spend at a glance: the total, where it ends at this pace,
 * and the month so far as one area, day by day; one line when nothing was
 * spent. The Spend card shows it over where it went.
 */
const SpendSummary = ({ spend }: { spend: ModelMonthSpend }) => {
  const { t, i18n } = useLingui();
  const end = monthEnd(spend.total, spend.month, new Date());
  const ending = end === null ? null : formatDollars(end);
  const total = formatDollars(spend.total);
  return (
    <>
      {/* Bare: the figure at the card's start edge, as Grasp UI's spend card. */}
      {/* Nothing spent yet: the figure says it, with no pace to tell. */}
      <Stat
        change={
          ending === null || spend.total === 0
            ? ""
            : t`About ${ending} by the end of the month`
        }
        label={t`Spent this month`}
        unstyled
        value={total}
      />
      {spend.total === 0 ? null : (
        <ChartContainer
          aria-label={t`Spend so far this month, day by day`}
          config={{ spend: { label: t`Spend` } }}
          data={runningTotal(spend.days, spend.month, i18n.locale)}
          style={styles.chart}
          summary={t`${total} so far this month.`}
          xKey="day"
          xLabel={t`Day`}
        >
          <ChartGrid />
          <ChartXAxis />
          <ChartYAxis valueFormatter={axisDollars} width={axisWidth} />
          <ChartArea dataKey="spend" />
          <ChartTooltip valueFormatter={formatDollars} />
        </ChartContainer>
      )}
    </>
  );
};

/** The month's spend: the total, each day's, and where it went. */
export const SpendCard = ({
  spend,
  settings,
}: {
  spend: Loaded<ModelMonthSpend>;
  settings: Loaded<ModelSettings>;
}) => {
  const { t, i18n } = useLingui();
  if (spend.state !== "ready") {
    return (
      <SettingsGroup title={t`Spend`}>
        <NotLoadedState heading="h3" page={spend} />
      </SettingsGroup>
    );
  }
  const month = spend.data;
  const bound = settings.state === "ready" ? settings.data : undefined;
  const rows = whereItWent(month, bound, i18n, {
    chat: t`Chat`,
    other: t`Other`,
  });
  const top = rows[0]?.name ?? "";
  // An App's binding whose target can't be read serves nothing: worth a look.
  const unreadable = (bound?.bindings.listed ?? []).filter(
    ({ model }) => model === null
  );
  return (
    <SettingsGroup title={t`Spend`}>
      <div {...stylex.props(styles.body)}>
        <SpendSummary spend={month} />
        {month.total === 0 ? null : (
          <>
            <ChartBarList
              aria-label={t`Where it went this month`}
              config={{ spend: { label: t`This month` } }}
              data={rows}
              nameKey="name"
              valueFormatter={formatDollars}
              summary={t`${top} spent the most this month.`}
            />
            {month.more ? (
              <Text size="xs" color="muted">
                {t`More workflows spent less.`}
              </Text>
            ) : null}
            {bound?.bindings.more === true ? (
              <Text size="xs" color="muted">
                {t`More Apps have models of their own.`}
              </Text>
            ) : null}
          </>
        )}
        {unreadable.map((binding) => {
          const app = binding.appName;
          return (
            <RowAlert
              key={`${binding.appId}/${binding.alias}`}
              variant="warning"
            >
              {t`${app}'s model can't be read, so its calls get no answer.`}
            </RowAlert>
          );
        })}
      </div>
    </SettingsGroup>
  );
};
