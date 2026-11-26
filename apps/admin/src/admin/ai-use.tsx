/**
 * What one company takes in AI, and what that costs Grasp, composed as
 * the organization's Overview is: the figures first (this month against
 * what the contract covers, everything so far, its tokens and minutes),
 * then what it cost over time, split by model or by use, with the line the
 * contract covers, then what each use cost and which model did it, and
 * last what Grasp's own AI features cost on Grasp's keys for it. One month
 * can be looked at alone. Every figure is the model's (`usageOf`,
 * `usageIn`): what core counted as it happened, and what the model works
 * out from what happened before it counted.
 *
 * Not here yet, as the prototype has it: the numbers workflow by
 * workflow, which need the company's live workflows, and core doesn't send
 * those yet.
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
import type { AiStatusReport } from "@grasp-os/shared/ai-status-report";
import { Button } from "@grasp-os/ui/components/button";
import {
  ChartBar,
  ChartContainer,
  ChartGrid,
  ChartLegend,
  ChartReferenceLine,
  ChartTooltip,
  ChartXAxis,
  ChartYAxis,
} from "@grasp-os/ui/components/chart";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  Section as Part,
  SectionHeader,
} from "@grasp-os/ui/components/section-header";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Stat, StatGroup } from "@grasp-os/ui/components/stat";
import { Text } from "@grasp-os/ui/components/text";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { colors, font, radius, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { useOrganization } from "./organization.tsx";
import { OrganizationPlatformSpend } from "./platform-spend.tsx";
import { sectionTo, sectionWords } from "./sections.ts";
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

/**
 * The most parts a bar is split into: Damsko's chart has five tones, the
 * value colour and then four, and a sixth part would repeat the fifth.
 */
const mostParts = 5;

/** The chart's tones in its order, so a model's swatch is its colour in the bars. */
const tones = stylex.create({
  0: { fill: colors.chartPlain, backgroundColor: colors.chartPlain },
  1: { fill: colors.chart2, backgroundColor: colors.chart2 },
  2: { fill: colors.chart3, backgroundColor: colors.chart3 },
  3: { fill: colors.chart4, backgroundColor: colors.chart4 },
  4: { fill: colors.chart5, backgroundColor: colors.chart5 },
});

/** A tone by its place among the parts: past the fifth, the fifth's. */
const toneAt = (index: number) =>
  [tones[0], tones[1], tones[2], tones[3], tones[4]][
    Math.min(index, mostParts - 1)
  ];

const styles = stylex.create({
  // The page's parts, a step further apart than the lines within each, as the Overview's.
  parts: { display: "flex", flexDirection: "column", gap: space["10"] },
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
  // A use's models, as one bar of their shares, and each named with its share.
  shares: {
    display: "flex",
    flexDirection: "column",
    gap: space["2"],
    minWidth: 0,
    marginBlockStart: space["1"],
  },
  bar: { display: "block", width: "100%", height: "0.5rem" },
  part: { stroke: colors.background },
  models: {
    display: "flex",
    flexWrap: "wrap",
    columnGap: space["3"],
    rowGap: space["1"],
    color: colors.mutedForeground,
    fontFamily: font.sans,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
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
  figure: { fontVariantNumeric: "tabular-nums" },
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

/** What `each` of `items` comes to, together. */
const sumOf = <Each,>(items: readonly Each[], each: (item: Each) => number) =>
  items.reduce((sum, item) => sum + each(item), 0);

type Split = "model" | "purpose";

/** One part of a bar: its key in the chart's rows, its words, and what it gathers. */
interface BarPart<Key extends string> {
  key: string;
  label: string;
  members: readonly Key[];
}

/**
 * What the bars are split into, the costliest at the foot: each on its own
 * while there are five or fewer, else the four costliest and the rest
 * together, as the chart tells five apart.
 */
const partsOf = <Key extends string>(
  keys: readonly Key[],
  spent: (key: Key) => number,
  words: Record<Key, string>,
  rest: string
): BarPart<Key>[] => {
  const ranked = keys
    .filter((key) => spent(key) > 0)
    .toSorted((one, other) => spent(other) - spent(one));
  const own =
    ranked.length <= mostParts ? ranked : ranked.slice(0, mostParts - 1);
  const parts: BarPart<Key>[] = own.map((key) => ({
    key,
    label: words[key],
    members: [key],
  }));
  return own.length === ranked.length
    ? parts
    : [
        ...parts,
        { key: "rest", label: rest, members: ranked.slice(own.length) },
      ];
};

/** The models' parts of what was spent in `period`. */
const modelPartsOf = (period: UsePeriod): BarPart<Model>[] =>
  partsOf(
    MODELS,
    (model) => period.models[model].spend,
    modelWords,
    "Other models"
  );

/** The uses' parts of what was spent in `period`. */
const purposePartsOf = (period: UsePeriod): BarPart<Purpose>[] =>
  partsOf(
    PURPOSES,
    (purpose) => period.purposes[purpose].spend,
    purposeWords,
    "Other uses"
  );

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

/** What the bars are split by, as the choice beside them says it. */
const SplitToggle = ({
  value,
  onChange,
}: {
  value: Split;
  onChange: (value: Split) => void;
}) => (
  <ToggleGroup
    aria-label="What the bars are split by"
    onValueChange={(next) => {
      // A press on the pressed one keeps it: one of the two is always shown.
      if (next[0] === "model" || next[0] === "purpose") {
        onChange(next[0]);
      }
    }}
    size="sm"
    value={[value]}
  >
    <ToggleGroupItem value="model">By model</ToggleGroupItem>
    <ToggleGroupItem value="purpose">By use</ToggleGroupItem>
  </ToggleGroup>
);

/** One part of the bars, with what one month's or one day's use of it cost. */
interface Series {
  key: string;
  label: string;
  inMonth: (each: Usage["months"][number]) => number;
  onDay: (each: Usage["days"][number]) => number;
}

/** The bars' parts, split by model or by use, as `period` ranks them. */
const seriesOf = (split: Split, period: UsePeriod): Series[] =>
  split === "model"
    ? modelPartsOf(period).map(({ key, label, members }) => ({
        key,
        label,
        inMonth: (each) => sumOf(members, (model) => each.models[model].spend),
        onDay: (each) => sumOf(members, (model) => each.models[model]),
      }))
    : purposePartsOf(period).map(({ key, label, members }) => ({
        key,
        label,
        inMonth: (each) =>
          sumOf(members, (purpose) => each.purposes[purpose].spend),
        onDay: (each) => sumOf(members, (purpose) => each.purposes[purpose]),
      }));

/**
 * What was spent over time, as bars split by model or by use: month by
 * month over everything so far, with the line the contract covers; day by
 * day inside one month, or while there is only one. Each point is named
 * as people read it ("Oct 2026", "2 Nov"), so the tooltip and the table a
 * screen reader reads say it whole.
 */
const OverTime = ({
  month,
  split,
  covered,
  period,
}: {
  month: string | null;
  split: Split;
  covered: number | null;
  period: UsePeriod;
}) => {
  const { view } = useOrganization();
  const { usage } = view;
  const monthly = month === null && usage.months.length > 1;
  const series = seriesOf(split, period);
  // One row a bar: when it is, and what each part cost then.
  const data: Record<string, string | number>[] = monthly
    ? usage.months.map((each) => ({
        at: formatMonth(each.month),
        ...Object.fromEntries(
          series.map((one) => [one.key, one.inMonth(each)])
        ),
      }))
    : usage.days
        .filter((each) => month === null || each.day.startsWith(month))
        .map((each) => ({
          at: formatDay(each.day),
          ...Object.fromEntries(
            series.map((one) => [one.key, one.onDay(each)])
          ),
        }));
  const spentAt = data.map((row) => ({
    at: String(row.at),
    spend: sumOf(series, (one) => Number(row[one.key] ?? 0)),
  }));
  let most: (typeof spentAt)[number] | undefined;
  for (const row of spentAt) {
    if (most === undefined || row.spend > most.spend) {
      most = row;
    }
  }
  const line = monthly ? covered : null;
  return (
    <ChartContainer
      aria-label={
        monthly ? "What it cost, month by month" : "What it cost, day by day"
      }
      config={Object.fromEntries(
        series.map(({ key, label }) => [key, { label }])
      )}
      data={data}
      summary={
        most === undefined || most.spend === 0
          ? "Nothing spent."
          : `The most, ${euro(most.spend)}, ${monthly ? "in" : "on"} ${most.at}.`
      }
      xKey="at"
      xLabel={monthly ? "Month" : "Day"}
    >
      <ChartGrid />
      <ChartXAxis />
      <ChartYAxis valueFormatter={(value) => euros(Number(value))} width={56} />
      {series.map(({ key }) => (
        <ChartBar dataKey={key} key={key} stackId="spend" />
      ))}
      {line === null ? null : (
        <ChartReferenceLine y={line}>Contract</ChartReferenceLine>
      )}
      <ChartTooltip valueFormatter={euro} />
      <ChartLegend />
    </ChartContainer>
  );
};

/** A use's tokens and minutes by voice, in a line; empty where it took neither. */
const takenLine = (use: Use): string => {
  const minutes = use.spoken + use.heard;
  return [
    use.tokensIn + use.tokensOut > 0
      ? `${tokens(use.tokensIn)} read, ${tokens(use.tokensOut)} written`
      : "",
    minutes > 0 ? `${whole(minutes)} min by voice` : "",
  ]
    .filter((line) => line !== "")
    .join(" · ");
};

/**
 * Parts of one whole side by side, as one bar: each as wide as its share,
 * in its tone. An SVG, so the widths need no inline style.
 */
const ShareBar = ({
  parts,
}: {
  parts: { key: string; share: number; tone: number }[];
}) => {
  const at = parts.map((_, index) =>
    sumOf(parts.slice(0, index), (part) => part.share)
  );
  return (
    <svg aria-hidden {...stylex.props(styles.bar)}>
      {parts.map((part, index) => (
        <rect
          {...stylex.props(toneAt(part.tone), styles.part)}
          height="100%"
          key={part.key}
          rx="2"
          strokeWidth="2"
          width={`${part.share * 100}%`}
          x={`${(at[index] ?? 0) * 100}%`}
        />
      ))}
    </svg>
  );
};

/**
 * Each use of AI that took something, a row each: what it cost, which
 * models did it and their shares, in the tones the bars split by model
 * draw them, and the tokens and minutes by voice it took. A use on a model
 * without a price cost nothing, and still shows what it took.
 */
const WhichModel = ({ period }: { period: UsePeriod }) => {
  const modelParts = modelPartsOf(period);
  const toneOf = (model: Model): number =>
    Math.max(
      0,
      modelParts.findIndex((part) => part.members.includes(model))
    );
  const purposes = PURPOSES.filter((purpose) =>
    taken(period.purposes[purpose])
  );
  return (
    <ItemGroup aria-labelledby="which-model" separated>
      {purposes.map((purpose) => {
        const use = period.purposes[purpose];
        const of = use.spend;
        const models = MODELS.filter(
          (model) => period.matrix[purpose][model].spend > 0
        );
        const line = takenLine(use);
        return (
          <Item key={purpose}>
            <ItemContent>
              <ItemTitle>{purposeWords[purpose]}</ItemTitle>
              {line === "" ? null : <ItemDescription>{line}</ItemDescription>}
              {models.length === 0 ? null : (
                <span {...stylex.props(styles.shares)}>
                  <ShareBar
                    parts={models.map((model) => ({
                      key: model,
                      share: period.matrix[purpose][model].spend / of,
                      tone: toneOf(model),
                    }))}
                  />
                  <span {...stylex.props(styles.models)}>
                    {models.map((model) => (
                      <span key={model} {...stylex.props(styles.model)}>
                        <span
                          aria-hidden
                          {...stylex.props(
                            styles.swatch,
                            toneAt(toneOf(model))
                          )}
                        />
                        {`${modelWords[model]} ${formatPercent(period.matrix[purpose][model].spend / of)}`}
                      </span>
                    ))}
                  </span>
                </span>
              )}
            </ItemContent>
            <ItemActions>
              <Text as="span" color={of === 0 ? "muted" : "default"}>
                <span {...stylex.props(styles.figure)}>
                  {of > 0 ? euro(of) : "No cost"}
                </span>
              </Text>
            </ItemActions>
          </Item>
        );
      })}
    </ItemGroup>
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
    <Empty>
      <EmptyHeader>
        <EmptyMedia icon={sectionWords.usage.icon} />
        <EmptyTitle level={2}>Nothing used yet</EmptyTitle>
        <EmptyDescription>
          It starts when Stephen reads the first conversation, and grows with
          every interview.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild variant="outline">
          <Link params={{ clientId: admin.client.id }} to={sectionTo.steps}>
            To the first conversation
          </Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
};

/** What it took, what that cost and what did it, once anything is used. */
const Used = () => {
  const { view } = useOrganization();
  const { usage, contract } = view;
  const [period, setPeriod] = useState(allMonths);
  const [split, setSplit] = useState<Split>("model");

  const month = period === allMonths ? null : period;
  const now = usageIn(usage, month);
  const covered =
    contract.status === "signed" && contract.aiIncluded > 0
      ? contract.aiIncluded
      : null;
  // The month the figure on the contract is about: the one picked, or the
  // one the view is counted to, which `thisMonth` is, used in or not.
  const shown = month ?? view.asOf.slice(0, 7);
  const inMonth = month === null ? usage.thisMonth : now.total;
  const over = covered !== null && inMonth.spend > covered;
  const first = usage.months[0]?.month;

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

      <StatGroup aria-label="AI use in short" columns={4}>
        <Stat
          change={coveredLineOf(inMonth.spend, covered, view.unknown.contract)}
          label={formatMonth(shown)}
          value={euro(inMonth.spend)}
          variant={over ? "warning" : "default"}
        />
        <Stat
          change={
            first === undefined ? undefined : `since ${formatMonth(first)}`
          }
          label="In all, so far"
          value={euro(usage.total.spend)}
        />
        <Stat
          change={`${tokens(now.total.tokensIn)} read, ${tokens(now.total.tokensOut)} written`}
          label="Tokens"
          value={tokens(now.total.tokensIn + now.total.tokensOut)}
        />
        <Stat
          change={`${whole(now.total.spoken)} spoken, ${whole(now.total.heard)} heard`}
          label="Minutes by voice"
          value={whole(now.total.spoken + now.total.heard)}
        />
      </StatGroup>

      <Part aria-labelledby="over-time">
        <SectionHeader
          actions={<SplitToggle onChange={setSplit} value={split} />}
          description={
            covered !== null && month === null
              ? `Against the ${euros(covered)} of AI use a month the contract covers`
              : undefined
          }
          id="over-time"
          size="sm"
          title="What it cost, over time"
          variant="group"
        />
        <OverTime covered={covered} month={month} period={now} split={split} />
      </Part>

      {taken(now.total) ? (
        <Part aria-labelledby="which-model">
          <SectionHeader
            description="What each use cost, and the models that did it"
            id="which-model"
            size="sm"
            title="Which model does what"
            variant="group"
          />
          <WhichModel period={now} />
        </Part>
      ) : null}
    </>
  );
};

/**
 * An organization's AI use: what it took, what that cost, and what did it;
 * then what Grasp's own AI features cost on Grasp's keys for it, from its
 * core's AI status (`aiStatus`, not awaited).
 */
export const AiUse = ({
  aiStatus,
}: {
  aiStatus: Promise<AiStatusReport | null>;
}) => {
  const { view } = useOrganization();
  return (
    <div {...stylex.props(styles.parts)}>
      {/* Nothing used is nothing counted: a model without a price adds tokens but no spend, and its use still shows. */}
      {taken(view.usage.total) ? <Used /> : <NothingUsed />}
      <OrganizationPlatformSpend status={aiStatus} />
    </div>
  );
};
