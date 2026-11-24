import type {
  ModelBindingSpend,
  ModelDaySpend,
  ModelMonthSpend,
  ModelSettings,
  SpendingWorkflow,
  WorkflowMonthSpend,
} from "@grasp-os/shared/models";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
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
import { msg, ph, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { formatDollars } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { monthEnd } from "./money.ts";
import { SettingsGroup } from "./section.tsx";

// Settings › AI and spend, its last card: what the models cost this month
// on the organization's keys (core's `models.spend()` and the Apps' model
// bindings from `models.settings()`), as Damsko's spend card draws it. The month's total as the key figure,
// with where it ends at this pace; the month so far as one area, day by
// day; then where it went, chat, each workflow with its runs and each
// App's model binding with its alias and model, as a list of bars; under
// them, which month is counted (the UTC month, which the company's days
// are cut to). Read-only: nothing in Grasp limits what an organization
// spends on its own keys.

const styles = stylex.create({
  body: {
    display: "grid",
    gap: space[4],
  },
});

/**
 * The value axis's width: room for its longest label, "$0.075" (Grasp UI's
 * spend card), and under a cent for one of five decimals, "0,00075 $".
 */
const axisWidth = (top: number): number => (top < 0.01 ? 80 : 56);

/**
 * `amount` in dollars with as many decimals as its first `significant`
 * digits need, two at least: "$0.0004", "$0.012", "$0.125". A model call
 * costs fractions of a cent, so a month's first calls would read "$0.00".
 */
const exactDollars = (amount: number, significant: number): string =>
  new Intl.NumberFormat(active.locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 20,
  }).format(Number(amount.toPrecision(significant)));

/** What was spent: to the cent, and under ten cents to its first two digits, so a small amount never reads as nothing. */
const spentDollars = (amount: number): string =>
  amount >= 0.1 ? formatDollars(amount) : exactDollars(amount, 2);

/**
 * Dollars short enough for the chart's value axis: under a dollar to
 * their first three digits, so no two levels read alike ("$0.0005",
 * "$0.001", "$0.0015"), then compact.
 */
const axisDollars = (value: string | number): string => {
  const amount = Number(value);
  if (amount < 1) {
    return exactDollars(amount, 3);
  }
  return new Intl.NumberFormat(active.locale, {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
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

/** A workflow's row: its name, and how often it ran this month. */
const workflowRow = (of: WorkflowMonthSpend, i18n: I18n): string => {
  const name = workflowName(of, i18n);
  const { runs } = of;
  return i18n._(
    msg`${name} (${plural(runs, { one: "# run", other: "# runs" })})`
  );
};

/** An App's model binding's row: the App, the alias its code calls, and the model it is bound to. */
const bindingRow = (of: ModelBindingSpend, i18n: I18n): string => {
  const { appName: app, alias, model } = of;
  return model === null
    ? i18n._(msg`${app} (${alias})`)
    : i18n._(msg`${app} (${alias}, ${model})`);
};

/** Less than this many dollars is nothing left over: sums of floats round. */
const leftOverMin = 0.0001;

/** One row of where it went, and what tells it from a row of the same name. */
interface Spender {
  name: string;
  spend: number;
  /** For a workflow its App's ID, or its own for one of no App; for a binding its App's ID. */
  id?: string;
}

/**
 * Where the month's spend went: chat, each workflow, each App's model
 * binding, and, where those lists are whole, the rest under `names.other`
 * (the Brain, whatever else calls a model on the organization's key); none
 * that spent nothing. Each row's name is its own, as the list is keyed by
 * it: two that would read alike (two Apps or workflows of one name) are
 * told apart by their ID.
 */
const whereItWent = (
  spend: ModelMonthSpend,
  settings: ModelSettings | undefined,
  i18n: I18n,
  names: { chat: string; other: string }
): { name: string; spend: number }[] => {
  const rows: Spender[] = [
    { name: names.chat, spend: spend.chat },
    ...spend.workflows.map((workflow) => ({
      name: workflowRow(workflow, i18n),
      spend: workflow.amount,
      id: workflow.appId ?? workflow.workflowId,
    })),
    ...(settings?.bindings.listed ?? []).map((binding) => ({
      name: bindingRow(binding, i18n),
      spend: binding.thisMonth,
      id: binding.appId,
    })),
  ];
  // Only from whole lists: with some left out, the rest isn't known.
  const whole =
    settings !== undefined && !spend.more && !settings.bindings.more;
  const left = spend.total - rows.reduce((sum, row) => sum + row.spend, 0);
  const shown = [
    ...rows,
    ...(whole && left > leftOverMin
      ? [{ name: names.other, spend: left }]
      : []),
  ].filter((row) => row.spend > 0);
  const named = new Map<string, number>();
  for (const { name } of shown) {
    named.set(name, (named.get(name) ?? 0) + 1);
  }
  return shown
    .map(({ name, spend: spent, id }) => ({
      name:
        id !== undefined && (named.get(name) ?? 0) > 1
          ? i18n._(msg`${name}, ID ${id}`)
          : name,
      spend: spent,
    }))
    .toSorted((a, b) => b.spend - a.spend);
};

/**
 * A company's day (`2026-10-31`) as its day and month, "Oct 31": the month
 * too, as the first day can be the last of the month before (a company
 * behind UTC) and the last the 1st of the month after (one ahead of it).
 * Never two days alike among the at most 32 a month has, so the chart's
 * table, which keys each row by it, keys it by its date. Written in UTC:
 * the date is the company's already, and the reader's own zone must not
 * move it to the day before.
 */
const dayAndMonth = (date: string): string =>
  new Intl.DateTimeFormat(active.locale, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));

/** A UTC month (`2026-11`) by its name and year, "November 2026". */
const monthName = (month: string): string =>
  new Intl.DateTimeFormat(active.locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${month}-01T00:00:00Z`));

/**
 * The month so far as a running total, day by day: one calm line that
 * ends at the key figure above it, never a spike for a busy day.
 */
const runningTotal = (
  days: readonly ModelDaySpend[]
): { day: string; spend: number }[] => {
  const points: { day: string; spend: number }[] = [];
  let sofar = 0;
  for (const { date, amount } of days) {
    sofar += amount;
    points.push({ day: dayAndMonth(date), spend: sofar });
  }
  return points;
};

/**
 * The month's spend at a glance: the total, where it ends at this pace,
 * and the month so far as one area, day by day; one line when nothing was
 * spent. The Spend card shows it over where it went.
 */
const SpendSummary = ({ spend }: { spend: ModelMonthSpend }) => {
  const { t } = useLingui();
  const end = monthEnd(spend.total, spend.month, new Date());
  const ending = end === null ? null : spentDollars(end);
  const total = spentDollars(spend.total);
  return (
    <>
      {/* Bare: the figure at the card's start edge, as Grasp UI's spend card. */}
      {/* Nothing spent yet: the figure says it, with no pace to tell. */}
      <Stat
        {...(ending === null || spend.total === 0
          ? {}
          : { change: t`About ${ending} by the end of the month` })}
        label={t`Spent this month`}
        unstyled
        value={total}
      />
      {spend.total === 0 ? null : (
        <ChartContainer
          aria-label={t`Spend so far this month, day by day`}
          config={{ spend: { label: t`Spend` } }}
          data={runningTotal(spend.days)}
          summary={t`${total} so far this month.`}
          xKey="day"
          xLabel={t`Day`}
        >
          <ChartGrid />
          <ChartXAxis />
          <ChartYAxis
            valueFormatter={axisDollars}
            width={axisWidth(spend.total)}
          />
          <ChartArea dataKey="spend" />
          <ChartTooltip valueFormatter={spentDollars} />
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
      <SettingsGroup flush={false} title={t`Spend`}>
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
  const counted = monthName(month.month);
  // An App's binding whose target can't be read serves nothing: worth a look.
  const unreadable = (bound?.bindings.listed ?? []).filter(
    ({ model }) => model === null
  );
  return (
    <SettingsGroup flush={false} title={t`Spend`}>
      <div {...stylex.props(styles.body)}>
        <SpendSummary spend={month} />
        {month.total === 0 ? null : (
          <>
            <ChartBarList
              aria-label={t`Where it went this month`}
              config={{ spend: { label: t`This month` } }}
              data={rows}
              nameKey="name"
              summary={t`${top} spent the most this month.`}
              valueFormatter={spentDollars}
            />
            {month.more ? (
              <Text color="muted" size="xs">
                {t`More workflows spent less.`}
              </Text>
            ) : null}
            {bound?.bindings.more === true ? (
              <Text color="muted" size="xs">
                {t`More Apps have models of their own.`}
              </Text>
            ) : null}
          </>
        )}
        <Text color="muted" size="xs">
          {t`Counted over ${counted} in UTC, in US dollars, as the models are priced.`}
        </Text>
        {unreadable.map((binding) => {
          const app = binding.appName;
          return (
            <Alert
              appearance="subtle"
              key={`${binding.appId}/${binding.alias}`}
              variant="warning"
            >
              <AlertDescription>
                {t`${app}'s model can't be read, so its calls get no answer.`}
              </AlertDescription>
            </Alert>
          );
        })}
      </div>
    </SettingsGroup>
  );
};
