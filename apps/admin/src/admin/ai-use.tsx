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
import { buttonVariants } from "@grasp-os/ui/components/button";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  chartColor,
  ReferenceLine,
  XAxis,
  YAxis,
} from "@grasp-os/ui/components/chart";
import type { ChartColor, ChartConfig } from "@grasp-os/ui/components/chart";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { cn } from "@grasp-os/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { useOrganization } from "./organization.tsx";
import { Figure } from "./parts.tsx";
import { Section } from "./section.tsx";
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

/** Each model in a shade of its own, the careful one the darkest. */
const modelShade: Record<Model, ChartColor> = {
  opus: "chart-1",
  sonnet: "chart-5",
  haiku: "chart-3",
  voice: "chart-4",
  ears: "chart-2",
  // Never in a chart: it has no price, so no share of what was spent.
  other: "chart-2",
};
const purposeShade: Record<Purpose, ChartColor> = {
  interviews: "chart-1",
  drawing: "chart-5",
  runs: "chart-3",
  chat: "chart-4",
  reading: "chart-2",
};

/** A shade as a swatch's class, and as an SVG mark's fill. */
const swatch: Record<ChartColor, string> = {
  "chart-1": "bg-chart-1",
  "chart-2": "bg-chart-2",
  "chart-3": "bg-chart-3",
  "chart-4": "bg-chart-4",
  "chart-5": "bg-chart-5",
};
const fill: Record<ChartColor, string> = {
  "chart-1": "fill-chart-1",
  "chart-2": "fill-chart-2",
  "chart-3": "fill-chart-3",
  "chart-4": "fill-chart-4",
  "chart-5": "fill-chart-5",
};

/** What AI is used for, in a word. */
const purposeWords: Record<Purpose, string> = {
  reading: "Reading",
  interviews: "Interviews",
  drawing: "Drawing the work",
  chat: "Chat",
  runs: "Workflows",
};

/** What does the work: a model by its own name, Stephen's voice and ears by what they are. */
const modelWords: Record<Model, string> = {
  opus: MODEL_NAMES.opus,
  sonnet: MODEL_NAMES.sonnet,
  haiku: MODEL_NAMES.haiku,
  voice: "Stephen’s voice",
  ears: "Stephen’s ears",
  other: MODEL_NAMES.other,
};

/** Whether a use took anything at all: tokens, minutes or money. */
const taken = (use: Use): boolean =>
  use.tokensIn + use.tokensOut + use.spoken + use.heard + use.spend > 0;

type Split = "model" | "purpose";

const splitOf = (value: unknown): Split =>
  value === "purpose" ? "purpose" : "model";

/** Use split both ways: by what did it, and by what it was for. */
type SplitUse = Pick<UsePeriod, "models" | "purposes">;

/** One part of a split: its key, its words, its shade, and what it took of some use. */
interface SplitKey {
  key: Model | Purpose;
  label: string;
  shade: ChartColor;
  takenIn: (split: SplitUse) => Use;
  /** What it cost on one day. */
  spentOn: (day: Usage["days"][number]) => number;
}

/** What the bars are split by: each model, or each use. */
const keysOf = (split: Split): SplitKey[] =>
  split === "model"
    ? MODELS.map((key) => ({
        key,
        label: modelWords[key],
        shade: modelShade[key],
        takenIn: (each) => each.models[key],
        spentOn: (day) => day.models[key],
      }))
    : PURPOSES.map((key) => ({
        key,
        label: purposeWords[key],
        shade: purposeShade[key],
        takenIn: (each) => each.purposes[key],
        spentOn: (day) => day.purposes[key],
      }));

/** A share as an SVG length. */
const svgShare = (share: number): string => `${share * 100}%`;

/**
 * Parts of one whole side by side, as one bar: each as wide as its share,
 * in its shade. An SVG, so the widths need no inline style.
 */
const ShareBar = ({
  parts,
  className,
}: {
  parts: { key: string; share: number; shade: ChartColor }[];
  className?: string;
}) => {
  const at = parts.map((_, index) =>
    parts.slice(0, index).reduce((sum, part) => sum + part.share, 0)
  );
  return (
    <svg aria-hidden className={cn("block w-full", className)}>
      {parts.map((part, index) => (
        <rect
          className={cn(fill[part.shade], "stroke-card")}
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
}) => {
  const items = [
    { value: allMonths, label: "Everything so far" },
    ...months.toReversed().map((month) => ({
      value: month,
      label: formatMonth(month),
    })),
  ];
  return (
    <Select
      items={items}
      onValueChange={(next: string | null) => {
        onChange(next ?? allMonths);
      }}
      value={value}
    >
      <SelectTrigger
        aria-label="Which month to show"
        className="w-48 max-w-full"
        size="sm"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
};

/** A choice between splitting by model and by use, named `label`. */
const SplitToggle = ({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Split;
  onChange: (value: Split) => void;
}) => (
  <ToggleGroup
    aria-label={label}
    onValueChange={(next: unknown[]) => {
      onChange(splitOf(next[0] ?? value));
    }}
    size="sm"
    spacing={0}
    value={[value]}
    variant="outline"
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
}: {
  month: string | null;
  split: Split;
  covered: number | null;
}) => {
  const { view } = useOrganization();
  const { usage } = view;
  const monthly = month === null && usage.months.length > 1;
  const keys = keysOf(split);
  // One row a bar: when it is, and what each key cost then.
  const data: Record<string, number | string>[] = monthly
    ? usage.months.map((each) => ({
        at: each.month,
        ...Object.fromEntries(
          keys.map(({ key, takenIn }) => [key, takenIn(each).spend])
        ),
      }))
    : usage.days
        .filter((each) => month === null || each.day.startsWith(month))
        .map((each) => ({
          at: each.day,
          ...Object.fromEntries(
            keys.map(({ key, spentOn }) => [key, spentOn(each)])
          ),
        }));
  const config: ChartConfig = Object.fromEntries(
    keys.map(({ key, label, shade }) => [key, { label, color: shade }])
  );
  const labels = new Map<unknown, string>(
    keys.map(({ key, label }) => [key, label])
  );
  const bars = keys.filter(({ key }) =>
    data.some((each) => Number(each[key] ?? 0) > 0)
  );
  const line = monthly ? covered : null;
  const said = (value: unknown) =>
    monthly ? formatMonth(String(value)) : formatDay(String(value));
  return (
    <>
      <ChartContainer className="aspect-auto h-52 w-full" config={config}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            axisLine={false}
            dataKey="at"
            minTickGap={24}
            tickFormatter={said}
            tickLine={false}
          />
          <YAxis
            axisLine={false}
            tickFormatter={(value: number) => euros(value)}
            tickLine={false}
            width={44}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value, name) =>
                  `${labels.get(name) ?? ""}: ${euro(Number(value))}`
                }
                labelFormatter={said}
              />
            }
          />
          {line === null ? null : (
            <ReferenceLine
              stroke="var(--status-attention)"
              strokeDasharray="4 4"
              y={line}
            />
          )}
          {bars.map(({ key, shade }) => (
            <Bar
              dataKey={key}
              fill={chartColor(shade)}
              isAnimationActive={false}
              key={key}
              maxBarSize={36}
              stackId="spend"
            />
          ))}
        </BarChart>
      </ChartContainer>
      <ul className="text-muted-foreground flex flex-wrap justify-center gap-x-4 gap-y-1 px-2 pt-3 text-xs">
        {bars.map(({ key, label, shade }) => (
          <li className="flex items-center gap-1.5" key={key}>
            <span
              aria-hidden
              className={cn("size-2 flex-none rounded-xs", swatch[shade])}
            />
            {label}
          </li>
        ))}
        {line === null ? null : (
          <li className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="border-status-attention h-px w-3 flex-none border-t border-dashed"
            />
            What the contract covers
          </li>
        )}
      </ul>
    </>
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
    <ul className="flex min-w-0 flex-col gap-4 border-t px-5 py-5">
      {purposes.map((purpose) => {
        const use = period.purposes[purpose];
        const of = use.spend;
        const minutes = use.spoken + use.heard;
        const parts = MODELS.filter(
          (model) => period.matrix[purpose][model].spend > 0
        );
        return (
          <li className="flex min-w-0 flex-col gap-1.5" key={purpose}>
            <span className="flex items-baseline justify-between gap-3">
              <span>{purposeWords[purpose]}</span>
              <span
                className={cn(
                  "tabular-nums",
                  of === 0 && "text-muted-foreground"
                )}
              >
                {of > 0 ? euro(of) : "–"}
              </span>
            </span>
            {parts.length > 0 ? (
              <ShareBar
                className="h-2.5"
                parts={parts.map((model) => ({
                  key: model,
                  share: period.matrix[purpose][model].spend / of,
                  shade: modelShade[model],
                }))}
              />
            ) : null}
            <span className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
              {parts.map((model) => (
                <span
                  className="flex items-center gap-1.5 whitespace-nowrap"
                  key={model}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-2 rounded-xs",
                      swatch[modelShade[model]]
                    )}
                  />
                  {modelWords[model]}{" "}
                  {formatPercent(period.matrix[purpose][model].spend / of)}
                </span>
              ))}
              <span className="tabular-nums sm:ml-auto">
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
    <Section
      description="It starts when Stephen reads the first conversation, and grows with every interview."
      title="Nothing used yet"
    >
      <div className="flex border-t px-5 py-4">
        <Link
          className={buttonVariants({ size: "sm", variant: "outline" })}
          params={{ clientId: admin.client.id }}
          to={sectionTo.steps}
        >
          To the first conversation
        </Link>
      </div>
    </Section>
  );
};

/** An organization's AI use: what it took, what that cost, and what did it. */
export const AiUse = () => {
  const { view } = useOrganization();
  const { usage, contract } = view;
  const [period, setPeriod] = useState(allMonths);
  const [stack, setStack] = useState<Split>("model");

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
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Said only of figures that aren't counted: what they are instead. */}
        <p className="text-muted-foreground min-w-0 flex-1 basis-64">
          {usage.counted
            ? ""
            : "Worked out from what happened: every interview, who is in, and each workflow that runs."}
        </p>
        <MonthSelect
          months={usage.months.map((each) => each.month)}
          onChange={setPeriod}
          value={period}
        />
      </div>

      <section
        aria-label="AI use in short"
        className="@container overflow-hidden rounded-xl border"
      >
        <div className="bg-border grid grid-cols-2 gap-px @3xl:grid-cols-4">
          <Figure
            attention={over}
            label={formatMonth(shown)}
            ring={
              covered === null
                ? undefined
                : { value: Math.min(inMonth.spend, covered), of: covered }
            }
            sub={coveredLine}
            value={euro(inMonth.spend)}
          />
          <Figure
            label="In all, so far"
            sub={
              first === undefined ? undefined : `since ${formatMonth(first)}`
            }
            value={euro(usage.total.spend)}
          />
          <Figure
            label="Tokens"
            sub={`${tokens(now.total.tokensIn)} read, ${tokens(now.total.tokensOut)} written`}
            value={tokens(now.total.tokensIn + now.total.tokensOut)}
          />
          <Figure
            label="Minutes by voice"
            sub={`${whole(now.total.spoken)} spoken, ${whole(now.total.heard)} heard`}
            value={whole(now.total.spoken + now.total.heard)}
          />
        </div>
      </section>

      <Section
        action={
          <SplitToggle
            label="What the bars are split by"
            onChange={setStack}
            value={stack}
          />
        }
        description={
          covered !== null && month === null
            ? `Against the ${euros(covered)} of AI use a month the contract covers.`
            : undefined
        }
        title="What it cost, over time"
      >
        <div className="border-t px-3 pt-4 pb-3">
          <OverTime covered={covered} month={month} split={stack} />
        </div>
      </Section>

      {taken(now.total) ? (
        <Section title="Which model does what">
          <WhichModel period={now} />
        </Section>
      ) : null}
    </>
  );
};
