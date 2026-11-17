// Chart: a bar or an area chart on Recharts 3, from shadcn's Chart (registry/bases/base/ui/chart.tsx),
// converted from Tailwind to StyleX and made Grasp's. A trial: it asks whether Recharts can be
// styled through props and tokens alone, and whether a dither fill works on its marks.
//
//   <Chart label="Tickets solved" summary="Up from 40 in January to 72 in June." data={rows} xKey="month"
//     config={{ solved: { label: "Solved" } }}>
//     <ChartGrid />
//     <ChartAxis side="x" />
//     <ChartBar series="solved" fill="dither-pixels" />
//     <ChartTooltip />
//   </Chart>
//
// A chart is a figure named by `label` and described by `summary`, and the same numbers stand in a
// table for screen readers. Every colour is a token (src/tokens); the dither's cell sizes are set
// in chart-patterns.tsx, as SVG attributes take numbers. A caller sets its height and layout.
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { useId, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { ComposedChart } from "recharts";

import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { grasp } from "../tokens/tokens.stylex";
import { ChartContext } from "./chart-context";
import type {
  ChartConfig,
  ChartContextValue,
  ChartLineLook,
} from "./chart-context";
import { ChartPatterns } from "./chart-patterns";

type Layout = string | number | null;

/** What a caller may style: its size and where it sits. */
export type ChartLayoutStyle = stylex.StyleXStyles<{
  width?: Layout;
  maxWidth?: Layout;
  height?: Layout;
  alignSelf?: Layout;
  justifySelf?: Layout;
  flexGrow?: Layout;
  gridArea?: Layout;
  gridColumn?: Layout;
  gridRow?: Layout;
  margin?: Layout;
  marginBlock?: Layout;
  marginInline?: Layout;
}>;

/** Every prop a Chart takes. */
export interface ChartProps {
  /** What the chart shows, as a screen reader and an agent say it ("Tickets solved by month"). */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /** One sentence that says what the numbers mean ("Up from 40 in January to 72 in June"). */
  summary: string;
  /** The rows: one object per point along the bottom. */
  data: readonly Record<string, string | number>[];
  /** The key along the bottom (a month, a day). */
  xKey: string;
  /**
   * What the key along the bottom is called, in words: the heading of its column in the table a
   * screen reader reads ("Month"). Left out, the key itself in sentence case.
   */
  xLabel?: string;
  /** The series drawn, by their key in each row, with their names. */
  config: ChartConfig;
  /** The grid, the axes, the marks, the tooltip and the legend. */
  children: ReactNode;
  /**
   * How tall the drawing is, in CSS pixels, so the page keeps its room before the chart paints.
   * @default 240
   */
  height?: number;
  /** Its width and where it sits. */
  layout?: ChartLayoutStyle;
  /** @deprecated Use `layout`. */
  style?: ChartLayoutStyle;
}

const styles = stylex.create({
  figure: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    rowGap: grasp.space3,
    minWidth: 0,
    margin: 0,
  },
  // The drawing's room, held before the chart paints, so nothing below it moves.
  frame: (height: number) => ({
    position: "relative",
    width: "100%",
    height,
    minWidth: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
  }),
  fill: {
    width: "100%",
    height: "100%",
  },
  ringRoom: { outlineOffset: grasp.space1 },
});

// The drawing is the svg Recharts makes, which takes no class or style of ours (both go to its
// wrapper). It takes a ref, so the shared ring's classes (src/focus) are put on it there: the
// keyboard sees Grasp's ring on the drawing, never the browser's.
const ringed = (svg: SVGSVGElement | null) => {
  // The ring a step off the drawing, so it does not touch the axis' last label or top number.
  const classes =
    stylex.props(focus.ring, styles.ringRoom).className?.split(" ") ?? [];
  svg?.classList.add(...classes);
};

const reducedQuery = "(prefers-reduced-motion: reduce)";
const subscribe = (change: () => void) => {
  const list = window.matchMedia(reducedQuery);
  list.addEventListener("change", change);
  return () => {
    list.removeEventListener("change", change);
  };
};

/** Whether the reader asked for less motion. On the server, and until it is known, it is. */
export const useReducedMotion = () =>
  useSyncExternalStore(
    subscribe,
    () => window.matchMedia(reducedQuery).matches,
    () => true
  );

interface Kept {
  setValueFormat: (format: (value: number) => string) => void;
  live: HTMLElement | null;
  bars: boolean;
  setBars: (bars: boolean) => void;
  setRoom: (room: number) => void;
  looks: Readonly<Record<string, ChartLineLook>>;
  setLook: (series: string, look: ChartLineLook) => void;
}

// What the chart tells its parts, built in one place.
const contextOf = (
  config: ChartConfig,
  xKey: string,
  id: string,
  data: ChartProps["data"],
  kept: Kept
): ChartContextValue => ({
  config,
  xKey,
  id,
  data,
  ...kept,
});

/** A key as words: "day" is "Day". */
const sentenceCase = (key: string) =>
  key.charAt(0).toUpperCase() + key.slice(1);

const plainNumber = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});

/** A value as the table says it: through the chart's format, else a plain number, never raw. */
const writtenValue = (
  value: string | number | undefined,
  format: ((value: number) => string) | undefined
) => {
  if (typeof value !== "number") {
    return value;
  }
  return format === undefined ? plainNumber.format(value) : format(value);
};

// The drawing's margin: a little at the top and the right, and at the right the room the names at
// the lines' ends ask for.
const marginOf = (room: number) => ({
  top: 8,
  right: 8 + room,
  bottom: 0,
  left: 0,
});

export const Chart = ({
  label: labelDeprecated,
  "aria-label": label = labelDeprecated ?? "",
  summary,
  data,
  xKey,
  xLabel,
  config,
  children,
  height = 240,
  style: styleDeprecated,
  layout: style = styleDeprecated,
}: ChartProps) => {
  const id = `chart-${useId().replaceAll(/[^a-zA-Z0-9-]/gu, "")}`;
  const keys = Object.keys(config);
  const [live, setLive] = useState<HTMLElement | null>(null);
  // Set by a ChartBar when it mounts: a chart with bars draws no hover line through them.
  const [bars, setBars] = useState(false);
  // Set by ChartLabels: the room its names need at the right.
  const [room, setRoom] = useState(0);
  // Set by each ChartLine: how it is drawn.
  const [looks, setLooks] = useState<Readonly<Record<string, ChartLineLook>>>(
    {}
  );
  const setLook = (series: string, look: ChartLineLook) => {
    setLooks((was) =>
      was[series] === look ? was : { ...was, [series]: look }
    );
  };
  // How the table writes a value: as the y axis or the tooltip writes it, else a plain number.
  const [writer, setWriter] = useState<{
    format: (value: number) => string;
  } | null>(null);
  const setValueFormat = (format: (value: number) => string) => {
    setWriter((was) => (was?.format === format ? was : { format }));
  };
  const written = (value: string | number | undefined) =>
    writtenValue(value, writer?.format);
  const context = contextOf(config, xKey, id, data, {
    live,
    bars,
    setBars,
    setRoom,
    looks,
    setLook,
    setValueFormat,
  });
  return (
    <ChartContext.Provider value={context}>
      <figure
        aria-labelledby={`${id}-label`}
        data-slot="chart"
        {...stylex.props(styles.figure, style)}
      >
        <figcaption {...stylex.props(visuallyHidden)}>
          <span id={`${id}-label`}>{label}</span> <span>{summary}</span>
        </figcaption>
        <div {...stylex.props(styles.frame(height))}>
          <ComposedChart
            ref={ringed}
            data={data}
            responsive
            // Recharts' wrapper takes a class: it fills the frame by plain CSS sizing.
            className={stylex.props(styles.fill).className}
            margin={marginOf(room)}
            title={label}
            desc={summary}
          >
            <ChartPatterns id={id} />
            {children}
          </ComposedChart>
        </div>
        {/* The point the keyboard is on, said as it moves: the drawing itself has no live region. */}
        <div
          ref={setLive}
          aria-live="polite"
          {...stylex.props(visuallyHidden)}
        />
        {/* The same numbers as a table, for a screen reader. */}
        <table {...stylex.props(visuallyHidden)}>
          <caption>{label}</caption>
          <thead>
            <tr>
              <th scope="col">{xLabel ?? sentenceCase(xKey)}</th>
              {keys.map((key) => (
                <th key={key} scope="col">
                  {config[key]?.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={String(row[xKey])}>
                <th scope="row">{row[xKey]}</th>
                {keys.map((key) => (
                  <td key={key}>{written(row[key])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </figure>
    </ChartContext.Provider>
  );
};
