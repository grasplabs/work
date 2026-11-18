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
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";

import { formatIsoDayMonth, formatMonth, formatNumber } from "../../format.ts";
import { Card } from "../../grasp/card/index.ts";
import {
  Chart,
  ChartArea,
  ChartAxis,
  ChartBar,
  ChartGrid,
  ChartLabels,
  ChartLine,
  ChartTooltip,
} from "../../grasp/chart/index.ts";
import type { ChartConfig } from "../../grasp/chart/index.ts";
import { Input } from "../../grasp/input/index.ts";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "../../grasp/popover/index.ts";
import { Stat } from "../../grasp/stats/index.ts";
import { Text } from "../../grasp/text/index.ts";
import { Toggle, ToggleGroup } from "../../grasp/toggle/index.ts";
import { grasp } from "../../grasp/tokens/tokens.stylex.ts";

// The plan in one picture, as the prototype's `request-plan.tsx`: the
// billed requests of the month climbing day by day toward the line of what
// the plan includes, dotted on from today at the last week's pace, and one
// figure with one line under it; over twelve months a bar a month. Beside
// it, the time those requests saved, by the minutes a request of each kind
// saves, which owners set to their own. A change of filter or span eases
// the chart's marks to their new place and counts both figures to their new
// value in 300 ms, and not at all for whoever asked for less motion
// (the library's chart and `useEased` read it from the media query).

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
    // Nothing to count as the page first shows, or when read again unchanged.
    if (start !== value) {
      frame = requestAnimationFrame(step);
    }
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [value]);
  return shown;
};

const styles = stylex.create({
  // The figures, and how far back at the end of their row.
  head: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-start",
    justifyContent: "space-between",
    columnGap: grasp.space6,
    rowGap: grasp.space3,
  },
  figures: {
    display: "flex",
    flexWrap: "wrap",
    columnGap: grasp.space12,
    rowGap: grasp.space3,
  },
  figure: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: grasp.space1,
    minWidth: 0,
  },
  plan: { display: "flex", flexDirection: "column", gap: grasp.space6 },
  minutes: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) 5rem",
    alignItems: "center",
    columnGap: grasp.space4,
    rowGap: grasp.space2,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  minute: { display: "contents" },
  value: { justifySelf: "end" },
});

/** The most minutes a request may save, as core takes them. */
const mostMinutes = 600;

/** Whether `value` is minutes core takes: a whole number from none to ten hours. */
const isMinutes = (value: number): boolean =>
  Number.isInteger(value) && value >= 0 && value <= mostMinutes;

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
      <PopoverTrigger size="xs" variant="ghost">
        {t`Minutes saved a request`}
      </PopoverTrigger>
      <PopoverContent align="start">
        <PopoverTitle>{t`Minutes saved a request`}</PopoverTitle>
        <ul {...stylex.props(styles.minutes)}>
          {requestKinds.map((kind) => {
            const label = i18n._(kindLabels[kind]);
            const value =
              settings.minutesSaved[kind] ?? defaultMinutesSaved[kind];
            return (
              <li key={kind} {...stylex.props(styles.minute)}>
                <Text element="span" size="sm">
                  {label}
                </Text>
                {canSet ? (
                  <Input
                    aria-label={label}
                    defaultValue={String(value)}
                    inputMode="numeric"
                    onBlur={(event) => {
                      const next = Number(event.target.value);
                      if (isMinutes(next) && next !== value) {
                        onSet(kind, next);
                      }
                    }}
                    size="sm"
                  />
                ) : (
                  <Text
                    element="span"
                    layout={styles.value}
                    size="sm"
                    tone="muted"
                  >
                    {formatNumber(value)}
                  </Text>
                )}
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
};

/** A row of the chart, without the series it has no value for (a gap there). */
type Row = Record<string, string | number>;

/** The chart's rows: the running total and its pace a day, or the billed a month; the plan's line on each. */
const rowsOf = (page: RequestsPage, included: number | null): Row[] => {
  const { report, today } = page;
  const plan: Row = included === null ? {} : { plan: included };
  if (report.by !== "day") {
    return report.bars.map((bar) => ({
      at: bar.at,
      billed: Object.values(bar.kinds).reduce((sum, each) => sum + each, 0),
      ...plan,
    }));
  }
  return runningTotal(report, today).map(({ at, total, pace }) => ({
    at,
    ...(total === null ? {} : { total }),
    ...(pace === null ? {} : { pace }),
    ...plan,
  }));
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
  const { report, range, settings, pace } = page;
  const included = narrowed ? null : settings.requestsIncluded;
  const billed = formatNumber(useEased(report.total.billed));
  const hours = formatNumber(
    useEased(Math.round(minutesSaved(report, settings.minutesSaved) / 60))
  );
  const of = included === null ? "" : formatNumber(included);
  const ahead = pace === null ? "" : formatNumber(pace);
  // Days of this month or last, so without their year, as the prototype
  // writes them: "31 Oct".
  const end = formatIsoDayMonth(report.to);
  const over =
    range === "month" && included !== null && pace !== null && pace > included;
  const daily = report.by === "day";
  const format = (at: string | number) =>
    daily ? formatIsoDayMonth(String(at)) : formatMonth(String(at));
  const planLabel = t`Your plan · ${of}`;
  const config: ChartConfig = {
    ...(daily
      ? {
          total: { label: t`Billed so far` },
          pace: { label: t`At this pace` },
        }
      : { billed: { label: t`Billed` } }),
    ...(included === null ? {} : { plan: { label: planLabel } }),
  };
  const shown =
    included !== null && range !== "year" ? `${billed} / ${of}` : billed;
  return (
    <Card padding="lg">
      <div {...stylex.props(styles.plan)}>
        <div {...stylex.props(styles.head)}>
          <div {...stylex.props(styles.figures)}>
            <Stat
              bare
              title={t`Billed`}
              value={shown}
              {...(range === "month" && pace !== null
                ? {
                    change: t`About ${ahead} by ${end}`,
                    tone: over ? ("attention" as const) : ("neutral" as const),
                  }
                : {})}
            />
            <div {...stylex.props(styles.figure)}>
              <Stat
                bare
                title={t`Time saved`}
                value={t({ message: `${hours} h`, context: "hours, short" })}
              />
              <Saved canSet={canSet} onSet={onSetMinutes} settings={settings} />
            </div>
          </div>
          <ToggleGroup
            aria-label={t`How far back`}
            onValueChange={(value: string[]) => {
              const next = requestRanges.find((each) => each === value[0]);
              if (next !== undefined) {
                onRange(next);
              }
            }}
            size="sm"
            value={[range]}
          >
            {requestRanges.map((each) => (
              <Toggle key={each} value={each}>
                {i18n._(rangeLabels[each])}
              </Toggle>
            ))}
          </ToggleGroup>
        </div>
        <Chart
          aria-label={t`Billed requests over time`}
          config={config}
          data={rowsOf(page, included)}
          height={224}
          summary={
            included === null || range === "year"
              ? billed
              : t`${billed} of ${of}`
          }
          xKey="at"
        >
          <ChartGrid />
          <ChartAxis format={format} side="x" />
          <ChartAxis
            format={(value) => formatNumber(Number(value))}
            side="y"
            width={48}
          />
          {daily ? <ChartArea series="total" /> : <ChartBar series="billed" />}
          {daily ? <ChartLine series="pace" variant="dotted" /> : null}
          {included === null ? null : (
            <ChartLine series="plan" variant="quiet" />
          )}
          <ChartLabels />
          <ChartTooltip format={formatNumber} />
        </Chart>
      </div>
    </Card>
  );
};
