import type {
  ModelMonthSpend,
  ModelSettings,
  SpendingWorkflow,
} from "@grasp-os/shared/models";
import type { I18n } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import {
  Chart,
  ChartArea,
  ChartAxis,
  ChartGrid,
  ChartTooltip,
} from "../grasp/chart/index.ts";
import { Progress } from "../grasp/progress/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { RowAlert } from "../grasp/setting-row/index.ts";
import { Stat } from "../grasp/stats/index.ts";
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
import type { Loaded } from "../load-from-core.tsx";
import { dollars, monthEnd } from "./money.ts";
import { SectionNotLoaded } from "./section.tsx";

// Settings › AI and spend, its last card: what the models cost this month
// on the organization's keys (core's `models.spend()` and the Apps' model
// bindings from `models.settings()`). The month's total as the key figure,
// with where it ends at this pace; the month so far as one area, day by
// day; then where it went, chat, each workflow and each App, as a list of bars. Read-only:
// nothing in Grasp limits what an organization spends on its own keys.

const styles = stylex.create({
  body: {
    display: "grid",
    gap: grasp.space4,
  },
  chart: { width: "100%" },
  share: { width: "100%", minWidth: "6rem" },
  // The bar, then its percentage, on one line.
  shareCell: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space3,
  },
});

/** Dollars short enough for the chart's value axis: cents under a dollar, then compact. */
const axisDollars = (value: string | number): string => {
  const amount = Number(value);
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    notation: amount < 1 ? "standard" : "compact",
    // Quarter steps under a dollar keep their third decimal ($0.025), so
    // the axis never reads 0.03 for 0.025.
    minimumFractionDigits: amount < 1 ? 2 : 0,
    maximumFractionDigits: amount < 1 ? 3 : 1,
  }).format(amount);
};

/** A share as a percentage in the page's language: "84%". */
const percent = (share: number): string =>
  new Intl.NumberFormat(undefined, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(share);

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
 * those lists are whole, the rest under `names.other` (the Brain, the
 * dashboard's widgets, whatever else calls a model on the organization's
 * key); none that spent nothing.
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
  return [
    ...rows,
    ...(whole && left > leftOverMin
      ? [{ name: names.other, spend: left }]
      : []),
  ]
    .filter((row) => row.spend > 0)
    .toSorted((a, b) => b.spend - a.spend);
};

/**
 * The month so far as a running total, day by day: one calm line that
 * ends at the key figure above it, never a spike for a busy day.
 */
const runningTotal = (
  days: readonly number[]
): { day: string; spend: number }[] => {
  const points: { day: string; spend: number }[] = [];
  let sofar = 0;
  for (const [at, amount] of days.entries()) {
    sofar += amount;
    points.push({ day: String(at + 1), spend: sofar });
  }
  return points;
};

/**
 * The month's spend at a glance: the total, where it ends at this pace,
 * and the month so far as one area, day by day; one line when nothing was
 * spent. The Spend card shows it over where it went, Billing on its own.
 */
export const SpendSummary = ({ spend }: { spend: ModelMonthSpend }) => {
  const { t } = useLingui();
  const end = monthEnd(spend.total, spend.month, new Date());
  const ending = end === null ? null : dollars(end);
  const total = dollars(spend.total);
  return (
    <>
      <Stat
        change={
          ending === null ? "" : t`About ${ending} by the end of the month`
        }
        title={t`Spent this month`}
        tone="neutral"
        value={total}
      />
      {spend.total === 0 ? (
        <Text size="sm" tone="muted">
          {t`Nothing spent on AI this month yet.`}
        </Text>
      ) : (
        <Chart
          aria-label={t`Spend so far this month, day by day`}
          config={{ spend: { label: t`Spend` } }}
          data={runningTotal(spend.days)}
          height={220}
          layout={styles.chart}
          summary={t`${total} so far this month.`}
          xKey="day"
        >
          <ChartGrid />
          <ChartAxis side="x" />
          <ChartAxis format={axisDollars} side="y" />
          <ChartArea fill="plain" series="spend" />
          <ChartTooltip format={dollars} />
        </Chart>
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
      <SectionCard density="compact" title={t`Spend`}>
        <SectionNotLoaded page={spend} />
      </SectionCard>
    );
  }
  const month = spend.data;
  const bound = settings.state === "ready" ? settings.data : undefined;
  const rows = whereItWent(month, bound, i18n, {
    chat: t`Chat`,
    other: t`Other`,
  });
  // An App's binding whose target can't be read serves nothing: worth a look.
  const unreadable = (bound?.bindings.listed ?? []).filter(
    ({ model }) => model === null
  );
  return (
    <SectionCard density="compact" title={t`Spend`}>
      <div {...stylex.props(styles.body)}>
        <SpendSummary spend={month} />
        {month.total === 0 ? null : (
          <>
            <Table aria-label={t`Where it went this month`} density="compact">
              <TableHeader>
                <TableRow>
                  <TableHead>{t`Where it went`}</TableHead>
                  <TableHead>{t`Share`}</TableHead>
                  <TableHead align="end">{t`This month`}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ name, spend: amount }) => (
                  <TableRow key={name}>
                    <TableCell lead>{name}</TableCell>
                    <TableCell>
                      <span {...stylex.props(styles.shareCell)}>
                        {/* The column's head names it: the bar says only its row, to a screen reader. */}
                        <Progress
                          label={t`${name}: share of this month`}
                          layout={styles.share}
                          showLabel={false}
                          size="sm"
                          value={Math.round((amount / month.total) * 100)}
                        />
                        <Text element="span" size="sm" tone="muted">
                          {percent(amount / month.total)}
                        </Text>
                      </span>
                    </TableCell>
                    <TableCell align="end">{dollars(amount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {month.more ? (
              <Text size="xs" tone="muted">
                {t`More workflows spent less.`}
              </Text>
            ) : null}
            {bound?.bindings.more === true ? (
              <Text size="xs" tone="muted">
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
              variant="attention"
            >
              {t`${app}'s model can't be read, so its calls get no answer.`}
            </RowAlert>
          );
        })}
      </div>
    </SectionCard>
  );
};
