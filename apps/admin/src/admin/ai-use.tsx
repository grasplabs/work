/**
 * What one company takes in AI, and what that costs Grasp, ported from the
 * prototype (grasplabs/prototype `components/admin/org-usage.tsx`). At a
 * glance: this month against what the contract covers, and everything so
 * far. Then how it went over time, and what each use cost, split by which
 * model did it, with its tokens and minutes. One month can be looked at
 * alone. Every figure is the model's (`usageOf`, `usageIn`): what core
 * counted as it happened, and what the model works out from what happened
 * before it counted.
 *
 * Not here yet, as the prototype has it: the numbers workflow by
 * workflow, which need the company's live workflows, and core doesn't send
 * those yet. Nor, since Damsko's chart draws one series to a bar and no
 * line across it, the spend over time split by model or use, or the line
 * of what the contract covers: the bars are the whole spend, and the split
 * is the period's, under them.
 */

import {
  MODEL_NAMES,
  MODELS,
  PURPOSES,
  usageIn,
} from "@grasp-os/shared/admin/admin-usage";
import type {
  Model,
  Purpose,
  Usage,
  Use,
  UsePeriod,
} from "@grasp-os/shared/admin/admin-usage";
import { Button } from "@grasp-os/ui/components/button";
import { CardContent } from "@grasp-os/ui/components/card";
import {
  ChartBar,
  ChartContainer,
  ChartGrid,
  ChartTooltip,
  ChartXAxis,
  ChartYAxis,
} from "@grasp-os/ui/components/chart";
import type { ChartConfig } from "@grasp-os/ui/components/chart";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { StatGroup } from "@grasp-os/ui/components/stat";
import { Text } from "@grasp-os/ui/components/text";
import { colors, font, radius, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { useOrganization } from "./organization.tsx";
import { Panel } from "./panel.tsx";
import { sectionTo } from "./sections.ts";
import {
  euro,
  euros,
  formatDay,
  formatMonth,
  formatPercent,
  tokens,
  whole,
} from "./words.ts";

/** Every month together, as the choice of month says it. */
const allMonths = "all";

/** A chart colour of Damsko's, by its place among the shades. */
type Shade =
  | "chart1"
  | "chart2"
  | "chart3"
  | "chart4"
  | "chart5"
  | "chartMuted";

const shades = stylex.create({
  chart1: { fill: colors.chart1, backgroundColor: colors.chart1 },
  chart2: { fill: colors.chart2, backgroundColor: colors.chart2 },
  chart3: { fill: colors.chart3, backgroundColor: colors.chart3 },
  chart4: { fill: colors.chart4, backgroundColor: colors.chart4 },
  chart5: { fill: colors.chart5, backgroundColor: colors.chart5 },
  chartMuted: { fill: colors.chartMuted, backgroundColor: colors.chartMuted },
});

/** Each model in a shade of its own, the careful one the darkest. */
const modelShade: Record<Model, Shade> = {
  opus: "chart1",
  sonnet: "chart5",
  haiku: "chart3",
  voice: "chart4",
  ears: "chart2",
  conversation: "chartMuted",
  // Never in a bar: it has no price, so no share of what was spent.
  other: "chart2",
};

const styles = stylex.create({
  // The line on how the figures were found, and the choice of month, in one row.
  top: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["3"],
  },
  note: { minWidth: 0, flexGrow: 1, flexBasis: "16rem" },
  month: { width: "12rem", maxWidth: "100%" },
  uses: {
    display: "flex",
    flexDirection: "column",
    gap: space["4"],
    minWidth: 0,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  use: {
    display: "flex",
    flexDirection: "column",
    gap: space["2"],
    minWidth: 0,
  },
  head: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space["3"],
  },
  figure: { fontVariantNumeric: "tabular-nums" },
  bar: { display: "block", width: "100%", height: "0.625rem" },
  part: { stroke: colors.card },
  parts: {
    display: "flex",
    flexWrap: "wrap",
    columnGap: space["3"],
    rowGap: space["1"],
    color: colors.mutedForeground,
    fontFamily: font.sans,
    fontSize: font.textXs,
  },
  model: {
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    whiteSpace: "nowrap",
  },
  swatch: {
    width: "0.5rem",
    height: "0.5rem",
    flexShrink: 0,
    borderRadius: radius.xs,
  },
  taken: {
    fontVariantNumeric: "tabular-nums",
    marginInlineStart: { default: null, "@media (min-width: 40rem)": "auto" },
  },
});

/** What AI is used for, in a word. */
const purposeWords: Record<Purpose, string> = {
  reading: "Reading",
  interviews: "Interviews",
  drawing: "Drawing the work",
  chat: "Chat",
  runs: "Workflows",
  opinions: "Company opinions",
};

/** What does the work: a model by its own name, Stephen's voice and ears by what they are. */
const modelWords: Record<Model, string> = {
  opus: MODEL_NAMES.opus,
  sonnet: MODEL_NAMES.sonnet,
  haiku: MODEL_NAMES.haiku,
  voice: "Stephen’s voice",
  ears: "Stephen’s ears",
  conversation: "Stephen’s live interviews",
  other: MODEL_NAMES.other,
};

/** Whether a use took anything at all: tokens, minutes or money. */
const taken = (use: Use): boolean =>
  use.tokensIn + use.tokensOut + use.spoken + use.heard + use.spend > 0;

/** A share as an SVG length. */
const svgShare = (share: number): string => `${share * 100}%`;

/**
 * Parts of one whole side by side, as one bar: each as wide as its share,
 * in its shade. An SVG, so the widths need no inline style.
 */
const ShareBar = ({
  parts,
}: {
  parts: { key: string; share: number; shade: Shade }[];
}) => {
  const at = parts.map((_, index) =>
    parts.slice(0, index).reduce((sum, part) => sum + part.share, 0)
  );
  return (
    <svg aria-hidden {...stylex.props(styles.bar)}>
      {parts.map((part, index) => (
        <rect
          {...stylex.props(shades[part.shade], styles.part)}
          height="100%"
          key={part.key}
          rx="3"
          strokeWidth="2"
          width={svgShare(part.share)}
          x={svgShare(at[index] ?? 0)}
        />
      ))}
    </svg>
  );
};

/** The choice of month: every month together, or one of them, the latest first. */
const MonthSelect = ({
  months,
  value,
  onChange,
}: {
  months: string[];
  value: string;
  onChange: (value: string) => void;
}) => (
  <Select
    items={[
      { value: allMonths, label: "Everything so far" },
      ...months.toReversed().map((month) => ({
        value: month,
        label: formatMonth(month),
      })),
    ]}
    onValueChange={(next) => {
      onChange(next ?? allMonths);
    }}
    value={value}
  >
    <SelectTrigger
      aria-label="Which month to show"
      size="sm"
      style={styles.month}
    >
      <SelectValue />
    </SelectTrigger>
    <SelectContent />
  </Select>
);

/** What one day cost, every model together. */
const spentOn = (day: Usage["days"][number]): number => {
  let spend = 0;
  for (const model of MODELS) {
    spend += day.models[model];
  }
  return spend;
};

/** The row that cost the most, if any. */
const mostOf = <Row extends { spend: number }>(
  rows: Row[]
): Row | undefined => {
  let most: Row | undefined;
  for (const row of rows) {
    if (most === undefined || row.spend > most.spend) {
      most = row;
    }
  }
  return most;
};

const spentConfig: ChartConfig = { spend: { label: "Spent" } };

/**
 * What was spent over time, as bars: month by month over everything so
 * far; day by day inside one month, or while there is only one.
 */
const OverTime = ({ month }: { month: string | null }) => {
  const { view } = useOrganization();
  const { usage } = view;
  const monthly = month === null && usage.months.length > 1;
  // One row a bar: when it is, and what it cost then.
  const data = monthly
    ? usage.months.map((each) => ({ at: each.month, spend: each.use.spend }))
    : usage.days
        .filter((each) => month === null || each.day.startsWith(month))
        .map((each) => ({ at: each.day, spend: spentOn(each) }));
  const said = (value: string | number) =>
    monthly ? formatMonth(String(value)) : formatDay(String(value));
  const most = mostOf(data);
  return (
    <ChartContainer
      aria-label={
        monthly ? "What it cost, month by month" : "What it cost, day by day"
      }
      config={spentConfig}
      data={data}
      height={208}
      summary={
        most === undefined
          ? "Nothing spent."
          : `The most, ${euro(most.spend)}, ${monthly ? "in" : "on"} ${said(most.at)}.`
      }
      xKey="at"
    >
      <ChartGrid />
      <ChartXAxis valueFormatter={said} />
      <ChartYAxis valueFormatter={(value) => euros(Number(value))} width={44} />
      <ChartBar dataKey="spend" />
      <ChartTooltip valueFormatter={euro} />
    </ChartContainer>
  );
};

/**
 * Each use of AI that took something: what it cost, split by what did it,
 * and under it the tokens and the minutes by voice it took. A use on a
 * model without a price cost nothing, and still shows what it took.
 */
const WhichModel = ({ period }: { period: UsePeriod }) => {
  const purposes = PURPOSES.filter((purpose) =>
    taken(period.purposes[purpose])
  );
  return (
    <ul {...stylex.props(styles.uses)}>
      {purposes.map((purpose) => {
        const use = period.purposes[purpose];
        const of = use.spend;
        const minutes = use.spoken + use.heard;
        const parts = MODELS.filter(
          (model) => period.matrix[purpose][model].spend > 0
        );
        return (
          <li key={purpose} {...stylex.props(styles.use)}>
            <div {...stylex.props(styles.head)}>
              <Text as="span">{purposeWords[purpose]}</Text>
              <Text as="span" color={of === 0 ? "muted" : "default"}>
                <span {...stylex.props(styles.figure)}>
                  {of > 0 ? euro(of) : "–"}
                </span>
              </Text>
            </div>
            {parts.length > 0 ? (
              <ShareBar
                parts={parts.map((model) => ({
                  key: model,
                  share: period.matrix[purpose][model].spend / of,
                  shade: modelShade[model],
                }))}
              />
            ) : null}
            <span {...stylex.props(styles.parts)}>
              {parts.map((model) => (
                <span key={model} {...stylex.props(styles.model)}>
                  <span
                    aria-hidden
                    {...stylex.props(styles.swatch, shades[modelShade[model]])}
                  />
                  {modelWords[model]}{" "}
                  {formatPercent(period.matrix[purpose][model].spend / of)}
                </span>
              ))}
              <span {...stylex.props(styles.taken)}>
                {[
                  use.tokensIn + use.tokensOut > 0
                    ? `${tokens(use.tokensIn)} read, ${tokens(use.tokensOut)} written`
                    : "",
                  minutes > 0 ? `${whole(minutes)} min by voice` : "",
                ]
                  .filter((line) => line !== "")
                  .join(" · ")}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
};

/**
 * What the month's spend is against what the contract covers, under its
 * figure: nothing to measure it against while the contract isn't known,
 * or isn't signed.
 */
const coveredLineOf = (
  spend: number,
  covered: number | null,
  unknown: boolean
): string => {
  if (unknown) {
    return "the contract isn’t known yet";
  }
  if (covered === null) {
    return "no signed contract yet";
  }
  return spend > covered
    ? `${euros(spend - covered)} above the ${euros(covered)} covered`
    : `of ${euros(covered)} the contract covers`;
};

/** Nothing used yet: what starts it, and the way to it. */
const NothingUsed = () => {
  const { admin } = useOrganization();
  return (
    <Panel
      description="It starts when Stephen reads the first conversation, and grows with every interview."
      title="Nothing used yet"
    >
      <CardContent>
        <Button asChild size="sm" variant="outline">
          <Link params={{ clientId: admin.client.id }} to={sectionTo.steps}>
            To the first conversation
          </Link>
        </Button>
      </CardContent>
    </Panel>
  );
};

/** An organization's AI use: what it took, what that cost, and what did it. */
export const AiUse = () => {
  const { view } = useOrganization();
  const { usage, contract } = view;
  const [period, setPeriod] = useState(allMonths);

  // Nothing used is nothing counted: a model without a price adds tokens
  // but no spend, and its use still shows.
  if (!taken(usage.total)) {
    return <NothingUsed />;
  }

  const month = period === allMonths ? null : period;
  const now = usageIn(usage, month);
  const covered =
    contract.status === "signed" && contract.aiIncluded > 0
      ? contract.aiIncluded
      : null;
  // The month the tile on the contract is about: the one picked, or the one
  // the view is counted to, which `thisMonth` is, used in or not.
  const shown = month ?? view.asOf.slice(0, 7);
  const inMonth = month === null ? usage.thisMonth : now.total;
  const over = covered !== null && inMonth.spend > covered;
  const first = usage.months[0]?.month;
  const coveredLine = coveredLineOf(
    inMonth.spend,
    covered,
    view.unknown.contract
  );

  return (
    <>
      <div {...stylex.props(styles.top)}>
        {/* Said only of figures that aren't counted: what they are instead. */}
        <Text color="muted" style={styles.note}>
          {usage.counted
            ? ""
            : "Worked out from what happened: every interview, who is in, and each workflow that runs."}
        </Text>
        <MonthSelect
          months={usage.months.map((each) => each.month)}
          onChange={setPeriod}
          value={period}
        />
      </div>

      <StatGroup
        aria-label="AI use in short"
        items={[
          {
            label: formatMonth(shown),
            value: euro(inMonth.spend),
            change: coveredLine,
            variant: over ? "warning" : "default",
          },
          {
            label: "In all, so far",
            value: euro(usage.total.spend),
            ...(first === undefined
              ? {}
              : { change: `since ${formatMonth(first)}` }),
          },
          {
            label: "Tokens",
            value: tokens(now.total.tokensIn + now.total.tokensOut),
            change: `${tokens(now.total.tokensIn)} read, ${tokens(now.total.tokensOut)} written`,
          },
          {
            label: "Minutes by voice",
            value: whole(now.total.spoken + now.total.heard),
            change: `${whole(now.total.spoken)} spoken, ${whole(now.total.heard)} heard`,
          },
        ]}
      />

      <Panel
        description={
          covered !== null && month === null
            ? `Against the ${euros(covered)} of AI use a month the contract covers.`
            : undefined
        }
        title="What it cost, over time"
      >
        <CardContent>
          <OverTime month={month} />
        </CardContent>
      </Panel>

      {taken(now.total) ? (
        <Panel title="Which model does what">
          <CardContent>
            <WhichModel period={now} />
          </CardContent>
        </Panel>
      ) : null}
    </>
  );
};
