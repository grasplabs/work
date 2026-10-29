import {
  defaultMinutesSaved,
  minutesSaved,
  requestKinds,
  requestRanges,
  runningTotal,
} from "@grasp-os/shared/stephen-requests";
import type {
  RequestKind,
  RequestRange,
  RequestsPage,
  StephenRequestSettings,
} from "@grasp-os/shared/stephen-requests";
import { Button } from "@grasp-os/ui/components/button";
import {
  Area,
  Bar,
  CartesianGrid,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ComposedChart,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
  chartColor,
} from "@grasp-os/ui/components/chart";
import type { ChartConfig } from "@grasp-os/ui/components/chart";
import { Input } from "@grasp-os/ui/components/input";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { cn } from "@grasp-os/ui/lib/utils";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";

import { formatDay, formatMonth, formatNumber } from "../../format.ts";

// The plan in one picture, as the prototype's `request-plan.tsx`: the
// billed requests of the month climbing day by day toward the line of what
// the plan includes, dotted on from today at the last week's pace, and one
// figure with one line under it; over twelve months a bar a month. Beside
// it, the time those requests saved, by the minutes a request of each kind
// saves, which owners set to their own. A change of filter or span eases
// the chart's marks to their new place and counts both figures to their new
// value in 300 ms, and not at all for whoever asked for less motion
// (recharts reads it from the media query through `isAnimationActive`).

const rangeLabels = {
  month: msg`This month`,
  lastMonth: msg`Last month`,
  year: msg`12 months`,
} as const satisfies Record<RequestRange, MessageDescriptor>;

const kindLabels = {
  answered: msg`An answer`,
  lookedUp: msg`A look-up`,
  changed: msg`A change`,
  workflow: msg`A workflow started`,
} as const satisfies Record<RequestKind, MessageDescriptor>;

/** Whether the person asked for less motion. */
const stillWanted = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** How long a figure takes to count to its new value, as the chart's marks. */
const easeMs = 300;

/** A figure counting from what it showed to `value`, easing out; at once for whoever asked for less motion. */
const useEased = (value: number): number => {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    // For whoever asked for less motion, the first frame is the last.
    const duration = stillWanted() ? 0 : easeMs;
    const began = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const done = duration === 0 ? 1 : Math.min(1, (now - began) / duration);
      const at = start + (value - start) * (1 - (1 - done) ** 3);
      from.current = at;
      setShown(Math.round(at));
      if (done < 1) {
        frame = requestAnimationFrame(step);
      }
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [value]);
  return shown;
};

/** The minutes a request of each kind saves: to change for owners, to read for everyone else. */
const Saved = ({
  settings,
  canSet,
  onSet,
}: {
  settings: StephenRequestSettings;
  canSet: boolean;
  onSet: (kind: RequestKind, minutes: number) => void;
}) => {
  const { t, i18n } = useLingui();
  return (
    <Popover>
      <PopoverTrigger render={<Button size="xs" variant="link" />}>
        {t`Time saved`}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <PopoverHeader>
          <PopoverTitle>{t`Minutes saved a request`}</PopoverTitle>
        </PopoverHeader>
        <ul className="flex flex-col gap-2">
          {requestKinds.map((kind) => {
            const label = i18n._(kindLabels[kind]);
            const value =
              settings.minutesSaved[kind] ?? defaultMinutesSaved[kind];
            return (
              <li
                className="flex items-center justify-between gap-4"
                key={kind}
              >
                <span>{label}</span>
                {canSet ? (
                  <span className="w-20">
                    <Input
                      aria-label={label}
                      defaultValue={value}
                      inputMode="numeric"
                      max={600}
                      min={0}
                      onBlur={(event) => {
                        const next = Number(event.target.value);
                        if (Number.isInteger(next) && next !== value) {
                          onSet(kind, next);
                        }
                      }}
                      type="number"
                    />
                  </span>
                ) : (
                  <span className="text-muted-foreground tabular-nums">
                    {formatNumber(value)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
};

/** The month against the plan, the time saved, and how far back. */
export const RequestPlan = ({
  page,
  narrowed,
  canSet,
  onRange,
  onSetMinutes,
}: {
  page: RequestsPage;
  /** Narrowed to a place or a team: the plan's line is the whole company's, so it isn't drawn. */
  narrowed: boolean;
  canSet: boolean;
  onRange: (range: RequestRange) => void;
  onSetMinutes: (kind: RequestKind, minutes: number) => void;
}) => {
  const { t, i18n } = useLingui();
  const { report, range, today, settings, pace } = page;
  const included = narrowed ? null : settings.requestsIncluded;
  const billed = formatNumber(useEased(report.total.billed));
  const hours = formatNumber(
    useEased(Math.round(minutesSaved(report, settings.minutesSaved) / 60))
  );
  const of = included === null ? "" : formatNumber(included);
  const ahead = pace === null ? "" : formatNumber(pace);
  const end = formatDay(report.to);
  const over =
    range === "month" && included !== null && pace !== null && pace > included;
  const config: ChartConfig = {
    total: { label: t`Billed so far`, color: "chart-1" },
    pace: { label: t`At this pace`, color: "chart-3" },
    billed: { label: t`Billed`, color: "chart-1" },
  };
  const daily = report.by === "day";
  const format = (at: string) => (daily ? formatDay(at) : formatMonth(at));
  const data: {
    at: string;
    total?: number | null;
    pace?: number | null;
    billed?: number;
  }[] = daily
    ? runningTotal(report, today)
    : report.bars.map((bar) => ({
        at: bar.at,
        billed: Object.values(bar.kinds).reduce((sum, each) => sum + each, 0),
      }));
  const motion = {
    isAnimationActive: !stillWanted(),
    animationDuration: 300,
    animationEasing: "ease-out",
  } as const;
  const planLabel = t`Your plan · ${of}`;
  return (
    <section className="bg-card flex flex-col gap-5 rounded-xl border py-6">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-6">
        <div className="flex flex-wrap gap-x-12 gap-y-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-3xl font-medium tracking-tight tabular-nums">
              {billed}
              {included !== null && range !== "year" ? (
                <span className="text-muted-foreground"> / {of}</span>
              ) : null}
            </span>
            {range === "month" && pace !== null ? (
              <span
                className={cn(
                  "text-xs",
                  over ? "text-status-attention" : "text-muted-foreground"
                )}
              >
                {t`About ${ahead} by ${end}`}
              </span>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-3xl font-medium tracking-tight tabular-nums">
              {t({ message: `${hours} h`, context: "hours, short" })}
            </span>
            <Saved canSet={canSet} onSet={onSetMinutes} settings={settings} />
          </div>
        </div>
        <ToggleGroup
          aria-label={t`How far back`}
          onValueChange={(value: unknown[]) => {
            const next = requestRanges.find((each) => each === value[0]);
            if (next !== undefined) {
              onRange(next);
            }
          }}
          size="sm"
          spacing={0}
          value={[range]}
          variant="outline"
        >
          {requestRanges.map((each) => (
            <ToggleGroupItem key={each} value={each}>
              {i18n._(rangeLabels[each])}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="px-3 sm:px-5">
        <ChartContainer
          aria-label={t`Billed requests over time`}
          className="aspect-auto h-56 w-full"
          config={config}
        >
          <ComposedChart
            barCategoryGap="30%"
            data={data}
            margin={{ top: 12, right: 8, bottom: 0, left: 0 }}
          >
            <CartesianGrid strokeDasharray="3 4" vertical={false} />
            <XAxis
              axisLine={false}
              dataKey="at"
              minTickGap={daily ? 32 : 24}
              tickFormatter={format}
              tickLine={false}
            />
            <YAxis
              allowDecimals={false}
              axisLine={false}
              tickCount={4}
              tickFormatter={(value: number) => formatNumber(value)}
              tickLine={false}
              width={48}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(value) =>
                    typeof value === "string" ? format(value) : ""
                  }
                />
              }
              cursor={false}
            />
            {daily ? (
              <Area
                connectNulls={false}
                dataKey="total"
                fill={chartColor("chart-1")}
                fillOpacity={0.08}
                stroke={chartColor("chart-1")}
                strokeWidth={2}
                type="monotone"
                {...motion}
              />
            ) : (
              <Bar
                dataKey="billed"
                fill={chartColor("chart-1")}
                maxBarSize={32}
                {...motion}
              />
            )}
            {daily ? (
              <Line
                connectNulls
                dataKey="pace"
                dot={false}
                stroke={chartColor("chart-3")}
                strokeDasharray="2 4"
                strokeWidth={2}
                type="monotone"
                {...motion}
              />
            ) : null}
            {included === null ? null : (
              <ReferenceLine
                ifOverflow="extendDomain"
                label={{
                  value: planLabel,
                  position: "insideTopLeft",
                  fontSize: 11,
                }}
                strokeDasharray="4 4"
                y={included}
              />
            )}
          </ComposedChart>
        </ChartContainer>
      </div>
    </section>
  );
};
