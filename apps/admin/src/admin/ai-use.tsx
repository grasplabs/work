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
import { Button } from "@grasp-os/ui/components/button";
import { CardContent } from "@grasp-os/ui/components/card";
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
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { StatGroup } from "@grasp-os/ui/components/stat";
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
  parts: { key: string; share: number; tone: number }[];
}) => {
  const at = parts.map((_, index) =>
    parts.slice(0, index).reduce((sum, part) => sum + part.share, 0)
  );
  return (
    <svg aria-hidden {...stylex.props(styles.bar)}>
      {parts.map((part, index) => (
        <rect
          {...stylex.props(toneAt(part.tone), styles.part)}
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

/** What `each` of `items` comes to, together. */
const sumOf = <Item,>(items: readonly Item[], each: (item: Item) => number) => {
  let sum = 0;
  for (const item of items) {
    sum += each(item);
  }
  return sum;
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

type Split = "model" | "purpose";

/** One part of a bar: its key in the chart's rows, its words, and what it gathers. */
interface Part<Key extends string> {
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
): Part<Key>[] => {
  const ranked = keys
    .filter((key) => spent(key) > 0)
    .toSorted((a, b) => spent(b) - spent(a));
  const own =
    ranked.length <= mostParts ? ranked : ranked.slice(0, mostParts - 1);
  const parts: Part<Key>[] = own.map((key) => ({
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
const modelPartsOf = (period: UsePeriod): Part<Model>[] =>
  partsOf(
    MODELS,
    (model) => period.models[model].spend,
    modelWords,
    "Other models"
  );

/** Each model's tone, as the bars split by model draw it. */
const toneOfModel = (period: UsePeriod) => {
  const parts = modelPartsOf(period);
  return (model: Model): number =>
    Math.max(
      0,
      parts.findIndex((part) => part.members.includes(model))
    );
};

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

/**
 * What was spent over time, as bars split by model or by use: month by
 * month over everything so far, with the line the contract covers; day by
 * day inside one month, or while there is only one.
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
  // Each part's key, with what one month's or one day's use of it cost.
  const parts: {
    key: string;
    label: string;
    inMonth: (each: Usage["months"][number]) => number;
    onDay: (each: Usage["days"][number]) => number;
  }[] =
    split === "model"
      ? modelPartsOf(period).map(({ key, label, members }) => ({
          key,
          label,
          inMonth: (each) =>
            sumOf(members, (model) => each.models[model].spend),
          onDay: (each) => sumOf(members, (model) => each.models[model]),
        }))
      : partsOf(
          PURPOSES,
          (purpose) => period.purposes[purpose].spend,
          purposeWords,
          "Other uses"
        ).map(({ key, label, members }) => ({
          key,
          label,
          inMonth: (each) =>
            sumOf(members, (purpose) => each.purposes[purpose].spend),
          onDay: (each) => sumOf(members, (purpose) => each.purposes[purpose]),
        }));
  // One row a bar: when it is, as it is read, and what each part cost then.
  const data: Record<string, string | number>[] = monthly
    ? usage.months.map((each) => ({
        at: formatMonth(each.month),
        ...Object.fromEntries(
          parts.map((part) => [part.key, part.inMonth(each)])
        ),
      }))
    : usage.days
        .filter((each) => month === null || each.day.startsWith(month))
        .map((each) => ({
          at: formatDay(each.day),
          ...Object.fromEntries(
            parts.map((part) => [part.key, part.onDay(each)])
          ),
        }));
  const most = mostOf(
    data.map((row) => ({
      at: row.at,
      spend: sumOf(parts, (part) => Number(row[part.key] ?? 0)),
    }))
  );
  const line = monthly ? covered : null;
  return (
    <ChartContainer
      aria-label={
        monthly ? "What it cost, month by month" : "What it cost, day by day"
      }
      config={Object.fromEntries(
        parts.map(({ key, label }) => [key, { label }])
      )}
      data={data}
      height={208}
      summary={
        most === undefined
          ? "Nothing spent."
          : `The most, ${euro(most.spend)}, ${monthly ? "in" : "on"} ${most.at}.`
      }
      xKey="at"
    >
      <ChartGrid />
      <ChartXAxis />
      <ChartYAxis valueFormatter={(value) => euros(Number(value))} width={56} />
      {parts.map(({ key }) => (
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

/**
 * Each use of AI that took something: what it cost, split by what did it,
 * and under it the tokens and the minutes by voice it took. A use on a
 * model without a price cost nothing, and still shows what it took.
 */
const WhichModel = ({ period }: { period: UsePeriod }) => {
  const toneOf = toneOfModel(period);
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
                  tone: toneOf(model),
                }))}
              />
            ) : null}
            <span {...stylex.props(styles.parts)}>
              {parts.map((model) => (
                <span key={model} {...stylex.props(styles.model)}>
                  <span
                    aria-hidden
                    {...stylex.props(styles.swatch, toneAt(toneOf(model)))}
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
  const [split, setSplit] = useState<Split>("model");

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
        action={<SplitToggle onChange={setSplit} value={split} />}
        description={
          covered !== null && month === null
            ? `Against the ${euros(covered)} of AI use a month the contract covers.`
            : undefined
        }
        title="What it cost, over time"
      >
        <CardContent>
          <OverTime
            covered={covered}
            month={month}
            period={now}
            split={split}
          />
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
