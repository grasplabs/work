/**
 * What one company takes in AI, and what that costs Grasp, ported from the
 * prototype (grasplabs/prototype `components/admin/org-usage.tsx`). At a
 * glance: this month against what the contract covers, and everything so
 * far. Then how it went over time, which model did what, and the same as
 * numbers, by what it was for and by model. One month can be looked at
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
  PRICES,
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
  Label,
  Pie,
  PieChart,
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
import { Figure, Panel } from "./parts.tsx";
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

/** What AI is used for, in a word, and in a line. */
const purposeWords: Record<Purpose, { label: string; what: string }> = {
  reading: {
    label: "Reading",
    what: "The first conversation, looking the company up, and what the company shared in its own onboarding.",
  },
  interviews: {
    label: "Interviews",
    what: "Every interview Stephen held, by voice or typed.",
  },
  drawing: {
    label: "Drawing the work",
    what: "Each team’s work and each workflow, drawn from what people agreed to.",
  },
  chat: { label: "Chat", what: "What people in the platform ask Grasp." },
  runs: { label: "Workflows", what: "Every time a live workflow runs." },
};

/** What does the work: a model by its own name, Stephen's voice and ears by what they are. */
const modelWords: Record<Model, { label: string; what: string }> = {
  opus: {
    label: MODEL_NAMES.opus,
    what: "The careful one: writes down what was said, draws the work, reads what was shared.",
  },
  sonnet: {
    label: MODEL_NAMES.sonnet,
    what: "The quick one: says Stephen’s lines, answers the chat, runs steps that need judgement.",
  },
  haiku: {
    label: MODEL_NAMES.haiku,
    what: "The small one: runs the plain steps of workflows.",
  },
  voice: {
    label: "Stephen’s voice",
    what: "What he says out loud, by the minute.",
  },
  ears: {
    label: "Stephen’s ears",
    what: "What he hears, written down as it is said, by the minute.",
  },
};

type Split = "model" | "purpose";

const splitOf = (value: unknown): Split =>
  value === "purpose" ? "purpose" : "model";

/** Use split both ways: by what did it, and by what it was for. */
type SplitUse = Pick<UsePeriod, "models" | "purposes">;

/** One part of a split: its key, its words, its shade, and what it took of some use. */
interface SplitKey {
  key: Model | Purpose;
  label: string;
  what: string;
  shade: ChartColor;
  takenIn: (split: SplitUse) => Use;
  /** What it cost on one day. */
  spentOn: (day: Usage["days"][number]) => number;
}

/** What the bars and rows are split by: each model, or each use. */
const keysOf = (split: Split): SplitKey[] =>
  split === "model"
    ? MODELS.map((key) => ({
        key,
        ...modelWords[key],
        shade: modelShade[key],
        takenIn: (each) => each.models[key],
        spentOn: (day) => day.models[key],
      }))
    : PURPOSES.map((key) => ({
        key,
        ...purposeWords[key],
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

/** What stands in the middle of the ring: the amount, and that it is all of it. Recharts hands it where the middle is. */
const Middle = ({
  viewBox,
  amount,
}: {
  viewBox?: { cx?: number; cy?: number };
  amount: string;
}) => {
  const { cx, cy } = viewBox ?? {};
  if (cx === undefined || cy === undefined) {
    return null;
  }
  return (
    <text dominantBaseline="middle" textAnchor="middle" x={cx} y={cy}>
      <tspan className="fill-foreground text-2xl font-medium" x={cx} y={cy - 6}>
        {amount}
      </tspan>
      <tspan className="fill-muted-foreground text-xs" x={cx} y={cy + 14}>
        in all
      </tspan>
    </text>
  );
};

/** What each model cost, as a ring, with all of it in the middle. */
const ModelDonut = ({
  models,
  period,
}: {
  models: Model[];
  period: UsePeriod;
}) => {
  const config: ChartConfig = Object.fromEntries(
    models.map((model) => [
      model,
      { label: modelWords[model].label, color: modelShade[model] },
    ])
  );
  const data = models.map((model) => ({
    model,
    spend: period.models[model].spend,
    // Recharts colours each part of the ring by its own `fill`.
    fill: chartColor(modelShade[model]),
  }));
  return (
    <div>
      <span className="sr-only">
        {models
          .map(
            (model) =>
              `${modelWords[model].label}: ${euro(period.models[model].spend)}`
          )
          .join(", ")}
      </span>
      <ChartContainer
        aria-hidden
        className="aspect-square h-40"
        config={config}
      >
        <PieChart>
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value, name) =>
                  `${modelWords[MODELS.find((model) => model === name) ?? "opus"].label}: ${euro(Number(value))}`
                }
                hideLabel
              />
            }
          />
          <Pie
            data={data}
            dataKey="spend"
            innerRadius={50}
            isAnimationActive={false}
            nameKey="model"
            outerRadius={72}
            strokeWidth={2}
          >
            <Label content={<Middle amount={euro(period.total.spend)} />} />
          </Pie>
        </PieChart>
      </ChartContainer>
    </div>
  );
};

/** Each use of AI, split by what did it; beside it the ring of what each model cost. */
const WhichModel = ({ period }: { period: UsePeriod }) => {
  const models = MODELS.filter((model) => period.models[model].spend > 0);
  const purposes = PURPOSES.filter(
    (purpose) => period.purposes[purpose].spend > 0
  );
  return (
    <div className="bg-border grid gap-px border-t lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
      <div className="bg-card flex min-w-0 flex-col items-center gap-4 px-5 py-5">
        <ModelDonut models={models} period={period} />
        <ul className="flex w-full flex-col gap-2">
          {models.map((model) => (
            <li
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-2"
              key={model}
            >
              <span
                aria-hidden
                className={cn(
                  "size-2 translate-y-px rounded-xs",
                  swatch[modelShade[model]]
                )}
              />
              <span className="truncate">{modelWords[model].label}</span>
              <span className="text-muted-foreground tabular-nums">
                {formatPercent(period.models[model].spend / period.total.spend)}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <ul className="bg-card flex min-w-0 flex-col justify-center gap-4 px-5 py-5">
        {purposes.map((purpose) => {
          const of = period.purposes[purpose].spend;
          const parts = MODELS.filter(
            (model) => period.matrix[purpose][model].spend > 0
          );
          return (
            <li className="flex min-w-0 flex-col gap-1.5" key={purpose}>
              <span className="flex items-baseline justify-between gap-3">
                <span>{purposeWords[purpose].label}</span>
                <span className="tabular-nums">{euro(of)}</span>
              </span>
              <ShareBar
                className="h-2.5"
                parts={parts.map((model) => ({
                  key: model,
                  share: period.matrix[purpose][model].spend / of,
                  shade: modelShade[model],
                }))}
              />
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
                    {modelWords[model].label}{" "}
                    {formatPercent(period.matrix[purpose][model].spend / of)}
                  </span>
                ))}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

/**
 * One row of the numbers: what it is, a bar as long as its share of the
 * cost, the tokens and the minutes where there is room for them, and what
 * it cost.
 */
const UseRow = ({
  label,
  what,
  use,
  most,
  shade,
}: {
  label: string;
  what: string;
  use: Use;
  most: number;
  shade: ChartColor;
}) => {
  const minutes = use.spoken + use.heard;
  const tokensLine =
    use.tokensIn + use.tokensOut > 0
      ? `${tokens(use.tokensIn)} read, ${tokens(use.tokensOut)} written`
      : "–";
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1.5 border-t px-5 py-3 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_minmax(0,11rem)_5.5rem]">
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{label}</span>
        <span className="text-muted-foreground text-xs">{what}</span>
      </span>
      <span className="bg-muted col-span-2 row-start-2 h-2 overflow-hidden rounded-full @3xl:col-span-1 @3xl:row-start-auto">
        {use.spend > 0 && most > 0 ? (
          <ShareBar
            className="h-full"
            parts={[{ key: label, share: use.spend / most, shade }]}
          />
        ) : null}
      </span>
      <span className="text-muted-foreground hidden min-w-0 flex-col text-right text-xs tabular-nums @3xl:flex">
        <span className="truncate">{tokensLine}</span>
        {minutes > 0 ? (
          <span className="truncate">{`${whole(minutes)} min by voice`}</span>
        ) : null}
      </span>
      <span
        className={cn(
          "col-start-2 row-start-1 text-right tabular-nums @3xl:col-start-auto @3xl:row-start-auto",
          use.spend === 0 && "text-muted-foreground"
        )}
      >
        {use.spend > 0 ? euro(use.spend) : "–"}
      </span>
    </li>
  );
};

/** What each model is counted at: a million tokens read and written, or a minute. */
const Prices = () => (
  <ul className="bg-border grid gap-px border-t sm:grid-cols-2 xl:grid-cols-3">
    {MODELS.map((model) => {
      const price = PRICES[model];
      return (
        <li className="bg-card flex flex-col gap-0.5 px-5 py-3" key={model}>
          <span className="flex items-center gap-2">
            <span
              aria-hidden
              className={cn("size-2 rounded-xs", swatch[modelShade[model]])}
            />
            {modelWords[model].label}
          </span>
          <span className="text-muted-foreground text-xs">
            {price.minute > 0
              ? `${euro(price.minute)} a minute`
              : `${euros(price.tokensIn)} a million tokens read, ${euros(price.tokensOut)} written`}
          </span>
        </li>
      );
    })}
  </ul>
);

/** What the month's spend is against what the contract covers, under its figure. */
const coveredLineOf = (spend: number, covered: number | null): string => {
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
      <div className="flex border-t px-5 py-4">
        <Link
          className={buttonVariants({ size: "sm", variant: "outline" })}
          params={{ clientId: admin.client.id }}
          to={sectionTo.steps}
        >
          To the first conversation
        </Link>
      </div>
    </Panel>
  );
};

/** An organization's AI use: what it took, what that cost, and what did it. */
export const AiUse = () => {
  const { view } = useOrganization();
  const { usage, contract } = view;
  const [period, setPeriod] = useState(allMonths);
  const [stack, setStack] = useState<Split>("model");
  const [table, setTable] = useState<Split>("purpose");

  if (usage.total.spend === 0) {
    return <NothingUsed />;
  }

  const month = period === allMonths ? null : period;
  const now = usageIn(usage, month);
  const covered =
    contract.status === "signed" && contract.aiIncluded > 0
      ? contract.aiIncluded
      : null;
  // The month the tile on the contract is about: the one picked, or the one that runs.
  const shown = month ?? usage.months.at(-1)?.month;
  const inMonth = month === null ? usage.thisMonth : now.total;
  const over = covered !== null && inMonth.spend > covered;
  const first = usage.months[0]?.month;
  const coveredLine = coveredLineOf(inMonth.spend, covered);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground min-w-0 flex-1 basis-64">
          {usage.counted
            ? "Counted as it happened, every time a model was asked. How long Stephen listened is worked out from how long people talked."
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
            label={shown === undefined ? "This month" : formatMonth(shown)}
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

      <Panel
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
            : "In euros, as Grasp pays for it."
        }
        title="What it cost, over time"
      >
        <div className="border-t px-3 pt-4 pb-3">
          <OverTime covered={covered} month={month} split={stack} />
        </div>
      </Panel>

      <Panel
        description="Each use of AI, split by what did it. The careful model is the dearest, so it only does what needs care."
        title="Which model does what"
      >
        {now.total.spend > 0 ? <WhichModel period={now} /> : null}
      </Panel>

      <Panel
        action={
          <SplitToggle
            label="What the rows are"
            onChange={setTable}
            value={table}
          />
        }
        description="Tokens are what a model reads and writes. Voice is counted by the minute."
        title="The numbers"
      >
        <ul className="@container flex flex-col">
          {keysOf(table).map(({ key, label, what, shade, takenIn }) => (
            <UseRow
              key={key}
              label={label}
              most={now.total.spend}
              shade={shade}
              use={takenIn(now)}
              what={what}
            />
          ))}
        </ul>
        <div className="bg-row-group grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-6 border-t px-5 py-2.5">
          <span>In all</span>
          <span className="tabular-nums">{euro(now.total.spend)}</span>
        </div>
      </Panel>

      <Panel
        description="What Grasp pays for AI, in euros. These are sample prices, the same for every organization."
        title="What it is counted at"
      >
        <Prices />
      </Panel>
    </>
  );
};
