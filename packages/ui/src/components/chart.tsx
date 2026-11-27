// Chart: numbers drawn, ChartContainer and its parts on Recharts 3, in
// StyleX. Bars, an area and lines on a shared drawing, plus four figures of their own: bars across
// (ChartBarList), parts of a whole (ChartPie), flows between stages (ChartSankey) and a trend beside
// its number (ChartSparkline).
//
//   <ChartContainer aria-label="Tickets solved" summary="Up from 40 in January to 72 in June."
//     data={rows} xKey="month" config={{ solved: { label: "Solved" } }}>
//     <ChartGrid />
//     <ChartXAxis />
//     <ChartBar dataKey="solved" pattern="dither-pixels" />
//     <ChartTooltip />
//   </ChartContainer>
//
// A chart is a figure named by `aria-label` and described by `summary`, and the same numbers stand
// in a table for screen readers. Every colour is a token, drawn through its CSS variable, so light,
// dark and forced colours follow the page with no palette copied here; the dither's cell sizes are
// numbers (lib/utils), as SVG attributes take numbers. The sums are pure, in chart-math.ts. A caller
// sets layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import { renderElement } from "@ui-sdk/react/primitive";
import {
  Fragment,
  createContext,
  use,
  useEffect,
  useId,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  Dispatch,
  KeyboardEvent,
  PointerEvent,
  ReactElement,
  ReactNode,
  SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
  useActiveTooltipCoordinate,
  useActiveTooltipDataPoints,
  useActiveTooltipLabel,
  usePlotArea,
  useXAxisScale,
  useYAxisScale,
} from "recharts";
import type {
  LegendPayload,
  TextAnchor,
  TooltipContentProps,
  XAxisTickContentProps,
  YAxisTickContentProps,
} from "recharts";

import { useI18n } from "../lib/i18n";
import {
  focusRing,
  focusRingInset,
  focusWithin,
  tapTargetAfter,
  visuallyHidden,
} from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  size,
  space,
} from "../lib/tokens.stylex";
import {
  BAYER_MATRIX,
  className,
  DITHER_GEOMETRY,
  DITHER_LEVELS,
  ownValue,
  safeHref,
} from "../lib/utils";
import type { DitherTexture, LayoutStyle } from "../lib/utils";
import { motionVars } from "../lib/vars.stylex";
import {
  SPAN,
  areaPath,
  arcPath,
  arcsOf,
  barPath,
  barTooltipLeft,
  ditherEdges,
  extentOf,
  layoutSankey,
  linePath,
  markOf,
  nearestOf,
  orderRows,
  pathThrough,
  pointAt,
  restOf,
  ribbonPath,
  rowKeys,
  spanOf,
  sparkShape,
  spread,
  tooltipTop,
  valueOf,
  valuesOf,
} from "./chart-math";
import type {
  Arc,
  ChartSankeyLink,
  ChartSankeyNode,
  PlacedLink,
  PlacedNode,
  SankeyLayout,
  Span,
  SparkPoint,
  SparkShape,
} from "./chart-math";
import { Link } from "./link";

export type { ChartSankeyLink, ChartSankeyNode } from "./chart-math";

const FORCED = media.forcedColors;
const REDUCED = media.reducedMotion;

// ---- The chart's context ------------------------------------------------------------------------

/** One series: its name, as a legend, a tooltip and the table say it. */
export interface ChartSeries {
  /** The series' name, in sentence case ("Tickets solved"). */
  label: string;
}

/** The series a chart draws, by the key each holds in a data point. */
export type ChartConfig = Record<string, ChartSeries>;

/** How a ChartLine is drawn: told apart by weight and dash, never by colour alone. */
export type ChartLineVariant = "solid" | "dashed" | "dotted" | "thin" | "muted";

/** How a bar, an area, a pie's first part or a node is filled: plain token colour, or a dither in one of two textures. */
export type ChartPattern = "none" | "dither-pixels" | "dither-dots";

type Row = Record<string, string | number>;

/** What a ChartContainer tells its parts. */
interface ChartContextValue {
  config: ChartConfig;
  xKey: string;
  /** The prefix for the ids of its patterns and clip paths, so two charts on one page never share one. */
  id: string;
  /** The rows, for a part that reads them beside Recharts (the names at the lines' ends). */
  data: readonly Row[];
  /** The live region the tooltip's words are said in, outside the drawing. */
  live: HTMLElement | null;
  /** Whether it draws bars: then no hover line, which would run through a bar. */
  bars: boolean;
  /** Each ChartBar counts itself in while it is there, and out as it goes. */
  setBarCount: Dispatch<SetStateAction<number>>;
  /** The room kept at the drawing's right for the names at the lines' ends, in CSS pixels. */
  setRoom: (room: number) => void;
  /** How each ChartLine is drawn, by its series, so its name at the end matches it. */
  variants: Readonly<Record<string, ChartLineVariant>>;
  setVariant: (dataKey: string, variant: ChartLineVariant) => void;
  /** How the chart's table and live region write a value: as its y axis or tooltip does. */
  valueFormatter: ((value: number) => string) | undefined;
  /** A part that writes values (a y axis, a tooltip) gives its formatter, so the chart's table writes them alike. */
  setValueFormatter: Dispatch<
    SetStateAction<((value: number) => string) | undefined>
  >;
  /** Each stacked ChartBar's stack, by its series: a stack's series take the chart tones. */
  stacks: Readonly<Record<string, string>>;
  setStacks: Dispatch<SetStateAction<Readonly<Record<string, string>>>>;
  /** The element Recharts draws in, for what stands over the drawing: the bars to press, the tooltip the keys open. */
  host: HTMLElement | null;
  /** The key (rowKeys) of the row whose bar the keyboard is on, when the bars can be pressed: the tooltip shows it. */
  focused: string | null;
  setFocused: Dispatch<SetStateAction<string | null>>;
  /** The pressed row, when the chart says one (`selectedIndex`): the other bars step back. */
  selectedIndex: number | null | undefined;
  /** Each reference line's words ("Budget: €4,000"), by the line, said after the summary. */
  setReferences: Dispatch<SetStateAction<Readonly<Record<string, string>>>>;
}

const nothing = () => {
  // Outside a ChartContainer there is nobody to tell.
};

const ChartContext = createContext<ChartContextValue>({
  config: {},
  xKey: "",
  id: "chart",
  data: [],
  live: null,
  bars: false,
  setBarCount: nothing,
  setRoom: nothing,
  variants: {},
  setVariant: nothing,
  valueFormatter: undefined,
  setValueFormatter: nothing,
  stacks: {},
  setStacks: nothing,
  host: null,
  focused: null,
  setFocused: nothing,
  selectedIndex: undefined,
  setReferences: nothing,
});

const useChart = () => use(ChartContext);

/** An id from React's, as SVG ids and url(#…) take it. */
const useChartId = () => `chart-${useId().replaceAll(/[^a-zA-Z0-9-]/gu, "")}`;

const reducedQuery = "(prefers-reduced-motion: reduce)";
const subscribeReduced = (change: () => void) => {
  const list = window.matchMedia(reducedQuery);
  list.addEventListener("change", change);
  return () => {
    list.removeEventListener("change", change);
  };
};

/** Whether the reader asked for less motion: Recharts' own animation is a prop, not a style. On the server, and until it is known, it is. */
const useReducedMotion = () =>
  useSyncExternalStore(
    subscribeReduced,
    () => window.matchMedia(reducedQuery).matches,
    () => true
  );

/** A part that writes values (a y axis, a tooltip) gives the chart its formatter, so the table writes them alike. */
const useTellFormatter = (
  formatter: ((value: number) => string) | undefined
) => {
  const { setValueFormatter } = useChart();
  useEffect(() => {
    if (formatter !== undefined) {
      // As a function of the last: a function given as itself would be called as one.
      setValueFormatter(() => formatter);
    }
  }, [formatter, setValueFormatter]);
};

// The room a chart keeps round its drawing, in CSS pixels: the drawing's own inset before any
// room for names, and the room the axes take (the x axis's names under the drawing, the y axis's
// values before it).
const chartInset = { top: 8, right: 8 } as const;
const chartAxisRoom = { x: 30, y: 36 } as const;

const plainNumber = (value: number) => value.toLocaleString();
const plainPercent = (share: number) =>
  share.toLocaleString(undefined, {
    style: "percent",
    maximumFractionDigits: 0,
  });

// ---- The dither ---------------------------------------------------------------------------------
//
// Ordered dither (lib/utils' 4×4 Bayer matrix) as SVG patterns, in token colours, with no script at
// run time. Each pattern is one level of density; a fill is a stack of bands, each band one level,
// so the lit colour thins from the value down to the floor. The patterns tile in the chart's own
// coordinates, so bands meet without a seam and cells sit on whole pixels. Two textures: `pixels`,
// 2px cells that fill their square; `dots`, 1px squares on a 3px pitch.

const TEXTURES: readonly DitherTexture[] = ["pixels", "dots"];

const patternStyles = stylex.create({
  ground: { fill: colors.chartDitherBg },
  lit: { fill: colors.chartDitherLit },
  // Cells on whole pixels, never smoothed into each other.
  crisp: { shapeRendering: "crispEdges" },
});

/** The id of one level's pattern, for `fill="url(#…)"`. */
const patternId = (chart: string, texture: DitherTexture, level: number) =>
  `${chart}-${texture}-${level}`;

const TEXTURE_OF: Record<ChartPattern, DitherTexture | null> = {
  none: null,
  "dither-pixels": "pixels",
  "dither-dots": "dots",
};

/** The texture each pattern draws with: none for a plain fill. */
const textureOf = (pattern: ChartPattern): DitherTexture | null =>
  TEXTURE_OF[pattern];

/** Every level of both textures, once per chart, hidden from screen readers with the rest of the drawing. */
const ChartPatterns = ({ id }: { id: string }) => (
  <defs>
    {TEXTURES.flatMap((texture) => {
      const { pitch, square } = DITHER_GEOMETRY[texture];
      const tile = pitch * 4;
      const offset = (pitch - square) / 2;
      return Array.from({ length: DITHER_LEVELS + 1 }, (_, level) => (
        <pattern
          key={`${texture}-${level}`}
          id={patternId(id, texture, level)}
          width={tile}
          height={tile}
          patternUnits="userSpaceOnUse"
          {...stylex.props(patternStyles.crisp)}
        >
          <rect
            width={tile}
            height={tile}
            {...stylex.props(patternStyles.ground)}
          />
          {BAYER_MATRIX.flatMap((row, y) =>
            row.map((threshold, x) =>
              threshold < level ? (
                <rect
                  key={`${x}-${y}`}
                  x={x * pitch + offset}
                  y={y * pitch + offset}
                  width={square}
                  height={square}
                  {...stylex.props(patternStyles.lit)}
                />
              ) : null
            )
          )}
        </pattern>
      ));
    })}
  </defs>
);

/**
 * The bands of a dither fill from `lit` (the value: most lit) to `floor` (where the mark starts:
 * least lit), either way round, along `axis`: down the page (`y`) or across it (`x`). Across the
 * other way they run from `start` for `breadth`. The caller clips them to the mark's shape.
 */
const DitherBands = ({
  chart,
  texture,
  axis,
  lit,
  floor,
  start,
  breadth,
}: {
  chart: string;
  texture: DitherTexture;
  axis: "x" | "y";
  lit: number;
  floor: number;
  start: number;
  breadth: number;
}) => {
  const edges = ditherEdges(lit, floor, DITHER_GEOMETRY[texture].pitch);
  return (
    <>
      {edges.slice(0, -1).map((from, index) => {
        const to = edges[index + 1] ?? from;
        const along = { at: Math.min(from, to), length: Math.abs(to - from) };
        return along.length > 0 ? (
          <rect
            key={index}
            x={axis === "x" ? along.at : start}
            y={axis === "y" ? along.at : start}
            width={axis === "x" ? along.length : breadth}
            height={axis === "y" ? along.length : breadth}
            fill={`url(#${patternId(chart, texture, DITHER_LEVELS - index)})`}
            {...stylex.props(patternStyles.crisp)}
          />
        ) : null;
      })}
    </>
  );
};

// The mask that cuts a clear room beside a dithered mark's cap in dark, where the cap and the lit
// dither are one mint and the cap was lost in the fill; in light the room is kept.
const maskStyles = stylex.create({
  keep: { fill: "oklch(1 0 none)", forcedColorAdjust: "none" },
  gap: {
    fill: "light-dark(oklch(1 0 none), oklch(0 0 none))",
    forcedColorAdjust: "none",
  },
  gapStroke: {
    fill: "none",
    stroke: "light-dark(oklch(1 0 none), oklch(0 0 none))",
    strokeLinejoin: "round",
    strokeLinecap: "round",
    forcedColorAdjust: "none",
  },
  // Forced colours drop the dither for a plain fill.
  dither: { display: { default: null, [FORCED]: "none" } },
});

// ---- The chart tones ----------------------------------------------------------------------------
//
// The value colour first, then the chart tones, each a step nearer the ground and 3:1 or more
// against it: a ring's parts and a stack's series take them in the config's order. Five at most,
// as the brand has five; a sixth would repeat the fifth. Forced colours draw every part in the text
// colour, told apart by the clear gap between them.

const TONES = [
  colors.chartPlain,
  colors.chart2,
  colors.chart3,
  colors.chart4,
  colors.chart5,
] as const;

const toneOf = (index: number) =>
  TONES[Math.min(Math.max(0, index), TONES.length - 1)] ?? colors.chart5;

const toneStyles = stylex.create({
  fill: (colour: string) => ({
    fill: { default: colour, [FORCED]: "CanvasText" },
  }),
  // A key beside a series' name: a small square in its tone.
  swatch: {
    flexShrink: 0,
    width: space[2],
    height: space[2],
    borderRadius: radius.xs,
    cornerShape: radius.shape,
  },
  background: (colour: string) => ({
    backgroundColor: { default: colour, [FORCED]: "CanvasText" },
  }),
});

// ---- ChartContainer -----------------------------------------------------------------------------

/** Every prop a ChartContainer takes. */
export interface ChartContainerProps {
  /** What the chart shows, as a screen reader and an agent say it ("Tickets solved by month"). */
  "aria-label": string;
  /** One sentence that says what the numbers mean ("Up from 40 in January to 72 in June"). */
  summary: string;
  /** The rows: one object per point along the bottom. */
  data: readonly Row[];
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
  /**
   * Makes each point along the bottom a button, the whole height of the drawing: called with its
   * row and that row's place when it is pressed, by the pointer, or by Enter or Space once Tab and
   * the arrow keys (Home, End) have reached it. Each is named by its point and its values
   * ("12 November, Tickets: 34"). Left out, the chart is a picture whose arrow keys move the tooltip.
   */
  onRowClick?: (row: Row, index: number) => void;
  /**
   * The pressed row's place in `data`, with `onRowClick`: its bar says it is pressed and the other
   * bars step back. `null` when none is (as is a place outside the rows); left out, the bars are
   * buttons that hold no state. It is a place: when rows come or go before it, the caller moves it.
   */
  selectedIndex?: number | null;
  /** Layout only: its width and where it sits. */
  style?: LayoutStyle;
}

const containerStyles = stylex.create({
  figure: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    rowGap: space[3],
    minWidth: 0,
    margin: 0,
  },
  // The drawing's room, held before the chart paints, so nothing below it moves.
  frame: (height: number) => ({
    position: "relative",
    width: "100%",
    height,
    minWidth: 0,
    fontFamily: font.sans,
    fontSize: font.textXs,
  }),
  fill: {
    width: "100%",
    height: "100%",
  },
  // The ring a step off the drawing, so it does not touch the axis' last label or top number.
  ringRoom: { outlineOffset: space[1] },
});

// The drawing is the svg Recharts makes, which takes no class or style of ours (both go to its
// wrapper). It takes a ref, so the shared ring's classes are put on it there: the keyboard sees the
// system's ring on the drawing, never the browser's.
const ringed = (svg: SVGSVGElement | null) => {
  const classes =
    className(focusRing, containerStyles.ringRoom)?.split(" ") ?? [];
  svg?.classList.add(...classes);
};

const noLines: Readonly<Record<string, string>> = {};

/** A figure's name and summary, and the lines drawn across it, read by a screen reader and never seen. */
const Caption = ({
  id,
  label,
  summary,
  lines = noLines,
}: {
  id: string;
  label: string;
  summary: string;
  lines?: Readonly<Record<string, string>>;
}) => (
  <figcaption {...stylex.props(visuallyHidden)}>
    <span id={id}>{label}</span> <span>{summary}</span>
    {Object.entries(lines).map(([key, line]) => (
      <Fragment key={key}>
        {" "}
        <span>{line}</span>
      </Fragment>
    ))}
  </figcaption>
);

/** A key as words: "day" is "Day". */
const sentenceCase = (key: string) =>
  key.charAt(0).toUpperCase() + key.slice(1);

const tableNumber = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});

/** A value as the table says it: through the chart's formatter, else a plain number, never raw. */
const writtenValue = (
  value: string | number | undefined,
  formatter: ((value: number) => string) | undefined
) => {
  if (typeof value !== "number") {
    return value;
  }
  return formatter === undefined ? tableNumber.format(value) : formatter(value);
};

// ---- Bars to press ------------------------------------------------------------------------------
//
// With `onRowClick`, each point along the bottom is a button the whole height of the drawing, over
// the marks and unseen: the pointer presses it where it stands, and the keyboard reaches the row's
// buttons as one stop, moves between them with the arrow keys, Home and End, and presses with Enter
// or Space. Each is named by its point and its values, as the live region would say them, and with
// `selectedIndex` says whether it is pressed. The drawing is not mirrored on a right-to-left page
// (the points still run left to right), so each arrow goes the way it points. The ring is the
// system's, just inside the column, as the columns touch; the tooltip shows the column the keys are
// on. The buttons stand in Recharts' own element, so its pointer still finds the point under them.

const pressStyles = stylex.create({
  // Left to right on any page, as the drawing is: each button's finger target (tapTargetAfter)
  // reaches out only where no button stands beside it, the first's to the left, the last's right.
  layer: {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    direction: "ltr",
  },
  bar: {
    position: "absolute",
    boxSizing: "border-box",
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    borderRadius: radius.sm,
    cornerShape: radius.shape,
    cursor: "pointer",
    pointerEvents: "auto",
    WebkitTapHighlightColor: "transparent",
  },
  at: (left: number, top: number, width: number, height: number) => ({
    left,
    top,
    width,
    height,
  }),
});

/** Whether the keyboard put focus here, not a press (lib/styles marks a press's focus). */
const byKeyboard = (element: HTMLElement) =>
  element.matches(":focus-visible") &&
  element.dataset.focusPointer === undefined;

/** The row an arrow key, Home or End moves to from `index`, of `count`; null for any other key. */
const nextRow = (key: string, index: number, count: number) => {
  if (key === "ArrowRight") {
    return Math.min(count - 1, index + 1);
  }
  if (key === "ArrowLeft") {
    return Math.max(0, index - 1);
  }
  if (key === "Home") {
    return 0;
  }
  return key === "End" ? count - 1 : null;
};

/** `index` when it is the place of one of `count` rows, else null. */
const rowAt = (index: number | null, count: number) =>
  index !== null && Number.isInteger(index) && index >= 0 && index < count
    ? index
    : null;

/**
 * Each row's column across the drawing: its middle, and its edges half-way to its neighbours'.
 * Bars stand in bands of one width; without bars Recharts sets the points from end to end.
 */
const pressColumns = (
  count: number,
  plot: { x: number; width: number },
  banded: boolean
) => {
  const middle = (index: number) => {
    if (banded) {
      return plot.x + ((index + 0.5) * plot.width) / count;
    }
    return count === 1
      ? plot.x + plot.width / 2
      : plot.x + (index * plot.width) / (count - 1);
  };
  return Array.from({ length: count }, (_, index) => {
    const left = index === 0 ? plot.x : (middle(index - 1) + middle(index)) / 2;
    const right =
      index === count - 1
        ? plot.x + plot.width
        : (middle(index) + middle(index + 1)) / 2;
    return { left, middle: middle(index), width: right - left };
  });
};

/** A row as the live region and its button say it: its point, then each series and its value. */
const pointWords = (
  words: ReturnType<typeof useI18n>["chart"],
  label: string,
  row: Row,
  config: ChartConfig,
  valueFormatter: ((value: number) => string) | undefined
) =>
  words.pointAt(
    label,
    Object.keys(config).map((key) =>
      words.point(
        config[key]?.label ?? key,
        writtenValue(ownValue(row, key), valueFormatter) ?? ""
      )
    )
  );

/** Each point along the bottom as a button over the drawing. */
const ChartPress = ({
  onRowClick,
}: {
  onRowClick: (row: Row, index: number) => void;
}) => {
  const {
    config,
    data,
    xKey,
    id,
    host,
    bars,
    selectedIndex,
    focused,
    setFocused,
    valueFormatter,
  } = useChart();
  const { chart: words } = useI18n();
  const plot = usePlotArea();
  // The row the keyboard last stood on, by its key, so it stays the same row as rows come and go:
  // Tab comes back to it.
  const [current, setCurrent] = useState<string | null>(null);
  if (host === null || plot === undefined || data.length === 0) {
    return null;
  }
  const rowIds = rowKeys(data, xKey);
  const columns = pressColumns(data.length, plot, bars);
  const last = current === null ? -1 : rowIds.indexOf(current);
  const stop = last === -1 ? (selectedIndex ?? 0) : last;
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    // Escape puts the keyboard's tooltip away, and only that, while it shows; focus stays.
    if (event.key === "Escape") {
      if (focused !== null) {
        event.preventDefault();
        event.stopPropagation();
        setFocused(null);
      }
      return;
    }
    const next = nextRow(event.key, index, data.length);
    if (next === null) {
      return;
    }
    event.preventDefault();
    const target = event.currentTarget.parentElement?.children.item(next);
    if (target instanceof HTMLElement) {
      target.focus();
    }
  };
  return createPortal(
    <div
      role="group"
      aria-labelledby={`${id}-label`}
      {...stylex.props(pressStyles.layer)}
    >
      {data.map((row, index) => {
        const key = rowIds[index] ?? String(index);
        const column = columns[index] ?? { left: 0, middle: 0, width: 0 };
        return (
          <button
            key={key}
            type="button"
            tabIndex={index === stop ? 0 : -1}
            aria-label={pointWords(
              words,
              String(ownValue(row, xKey) ?? ""),
              row,
              config,
              valueFormatter
            )}
            aria-pressed={
              selectedIndex === undefined ? undefined : index === selectedIndex
            }
            onClick={() => {
              onRowClick(row, index);
            }}
            onKeyDown={(event) => {
              move(event, index);
            }}
            onFocus={(event) => {
              setCurrent(key);
              setFocused(byKeyboard(event.currentTarget) ? key : null);
            }}
            onBlur={() => {
              setFocused(null);
            }}
            {...stylex.props(
              pressStyles.bar,
              focusRingInset,
              tapTargetAfter,
              pressStyles.at(column.left, plot.y, column.width, plot.height)
            )}
          />
        );
      })}
    </div>,
    host
  );
};

/** `record` with `key` set to `value`, or left out when it is undefined: the same record when nothing changes. */
const withEntry = <T,>(
  record: Readonly<Record<string, T>>,
  key: string,
  value?: T
): Readonly<Record<string, T>> => {
  if (ownValue(record, key) === value) {
    return record;
  }
  const rest = Object.fromEntries(
    Object.entries(record).filter(([each]) => each !== key)
  );
  return value === undefined ? rest : { ...rest, [key]: value };
};

/** The drawing, its name and summary, a live region for the point the keys are on, and its numbers as a table. */
export const ChartContainer = ({
  "aria-label": label,
  summary,
  data,
  xKey,
  xLabel,
  config,
  children,
  height = 240,
  onRowClick,
  selectedIndex,
  style,
}: ChartContainerProps) => {
  const id = useChartId();
  const keys = Object.keys(config);
  const [live, setLive] = useState<HTMLElement | null>(null);
  // The element Recharts draws in: the bars to press and the keyboard's tooltip stand in it.
  const [host, setHost] = useState<HTMLElement | null>(null);
  const drawing = (svg: SVGSVGElement | null) => {
    ringed(svg);
    setHost(svg?.parentElement ?? null);
  };
  // Set by each stacked ChartBar: its stack.
  const [stacks, setStacks] = useState<Readonly<Record<string, string>>>({});
  const [focused, setFocused] = useState<string | null>(null);
  // Set by each ChartReferenceLine: its words, said after the summary.
  const [references, setReferences] = useState<
    Readonly<Record<string, string>>
  >({});
  // How many ChartBars it holds: a chart with bars draws no hover line through them.
  const [barCount, setBarCount] = useState(0);
  // Set by ChartLabels: the room its names need at the right.
  const [room, setRoom] = useState(0);
  // Set by each ChartLine: how it is drawn.
  const [variants, setVariants] = useState<
    Readonly<Record<string, ChartLineVariant>>
  >({});
  const setVariant = (dataKey: string, variant: ChartLineVariant) => {
    setVariants((was) =>
      was[dataKey] === variant ? was : { ...was, [dataKey]: variant }
    );
  };
  // How the table writes a value: as the y axis or the tooltip writes it, else a plain number.
  const [valueFormatter, setValueFormatter] =
    useState<(value: number) => string>();
  const rowIds = rowKeys(data, xKey);
  const context: ChartContextValue = {
    config,
    xKey,
    id,
    data,
    live,
    bars: barCount > 0,
    setBarCount,
    setRoom,
    variants,
    setVariant,
    valueFormatter,
    setValueFormatter,
    stacks,
    setStacks,
    host,
    focused: onRowClick === undefined ? null : focused,
    setFocused,
    selectedIndex:
      onRowClick === undefined || selectedIndex === undefined
        ? undefined
        : rowAt(selectedIndex, data.length),
    setReferences,
  };
  return (
    // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
    <ChartContext value={context}>
      <figure
        aria-labelledby={`${id}-label`}
        data-slot="chart"
        {...stylex.props(containerStyles.figure, style)}
      >
        <Caption
          id={`${id}-label`}
          label={label}
          summary={summary}
          lines={references}
        />
        <div {...stylex.props(containerStyles.frame(height))}>
          <ComposedChart
            ref={drawing}
            data={data}
            // Bars to press are the keyboard's stops themselves: the drawing is then no stop of its own.
            accessibilityLayer={onRowClick === undefined}
            responsive
            // Recharts' wrapper takes a class: it fills the frame by plain CSS sizing.
            className={className(containerStyles.fill)}
            margin={{
              top: chartInset.top,
              right: chartInset.right + room,
              bottom: 0,
              left: 0,
            }}
            title={label}
            desc={summary}
          >
            <ChartPatterns id={id} />
            {onRowClick !== undefined && <ChartPress onRowClick={onRowClick} />}
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
            {data.map((row, index) => (
              <tr key={rowIds[index]}>
                <th scope="row">{row[xKey]}</th>
                {keys.map((key) => (
                  <td key={key}>
                    {writtenValue(ownValue(row, key), valueFormatter)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </figure>
    </ChartContext>
  );
};

// ---- ChartBar -----------------------------------------------------------------------------------
//
// One series as bars with round top corners. Plain, a bar is the plain token colour. Dithered, its
// body is the dither, lit near the top, and a solid cap in the value colour says the number: the
// fill is decoration. Stacked (a `stackId` shared with other ChartBars), each series is one part of
// a bar, in its chart tone by its place in its stack, the first at the foot; a clear gap stands
// between two parts, and only the stack's top part is rounded. Recharts does the stacking.

/** Every prop a ChartBar takes. */
export interface ChartBarProps {
  /** The series it draws: its key in each row, named in the chart's config. */
  dataKey: string;
  /**
   * `none` in the token colour, or a dither: `dither-pixels` chunky, `dither-dots` fine. A stacked
   * bar is always plain, in its tone.
   * @default "none"
   */
  pattern?: ChartPattern;
  /**
   * Stacks it on the other ChartBars with the same id, one bar a row: each series in a chart tone
   * of its own, in the config's order (five at most), named by ChartLegend and the tooltip. The
   * values of a stack are 0 or more.
   */
  stackId?: string;
}

// The bar's corner; the solid cap at a dithered bar's tip and the clear room beside it in dark, an
// upright bar's and a bar's across alike. In CSS pixels: SVG geometry takes numbers.
const BAR_CORNER = 4;
const CAP = 2;
const CAP_GAP = 2;

// The clear gap between two parts of a stacked bar, in CSS pixels.
const STACK_GAP = 2;
// How far a mark steps back while another is picked: a bar not pressed, a flow not lit.
const STEP_BACK = 0.32;

const markStyles = stylex.create({
  plain: { fill: { default: colors.chartPlain, [FORCED]: "CanvasText" } },
  cap: { fill: { default: colors.chart1, [FORCED]: "CanvasText" } },
  // A bar whose row is not the pressed one, while one is: it steps back, the pressed one stays.
  bar: {
    transitionProperty: "opacity",
    transitionDuration: motionVars.hover,
    transitionTimingFunction: duration.ease,
  },
  rest: { opacity: STEP_BACK },
});

// A rectangle with its two top corners rounded, from two marks: a rect rounded all round, and a
// square rect over its lower part. Both take the same fill, and together they clip too.
const RoundTop = ({
  x,
  y,
  width,
  height,
  look,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  look?: stylex.StyleXStyles;
}) => {
  const r = Math.max(0, Math.min(BAR_CORNER, width / 2, height));
  const props = look === undefined ? {} : stylex.props(look);
  return (
    <>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={r}
        ry={r}
        {...props}
      />
      <rect x={x} y={y + r} width={width} height={height - r} {...props} />
    </>
  );
};

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A dithered bar, upright (its tip at the `top`) or across (its tip at the `left` or the `right`):
 * its body the dither, lit at the tip, and a solid cap at the tip in the value colour that says the
 * number, with a clear room cut beside the cap in dark, where the cap and the lit dither are one
 * mint. `outline` draws the bar's shape, in a look, or bare for its clip.
 */
const DitheredBar = ({
  chart,
  clip,
  texture,
  box,
  tip,
  outline,
}: {
  chart: string;
  clip: string;
  texture: DitherTexture;
  box: Box;
  tip: "top" | "left" | "right";
  outline: (look?: stylex.StyleXStyles) => ReactNode;
}) => {
  const { x, y, width, height } = box;
  const upright = tip === "top";
  const room = Math.max(0, Math.min(CAP_GAP, (upright ? height : width) - CAP));
  const capX = tip === "right" ? x + width - CAP : x;
  const cap = upright
    ? { x, y, width, height: Math.min(CAP, height) }
    : { x: capX, y, width: Math.min(CAP, width), height };
  const gap = upright
    ? { x: x - 1, y: y + CAP, width: width + 2, height: room }
    : {
        x: tip === "right" ? capX - CAP_GAP : x + CAP,
        y: y - 1,
        width: room,
        height: height + 2,
      };
  const frame = { x: x - 1, y: y - 1, width: width + 2, height: height + 2 };
  return (
    <>
      <clipPath id={clip}>{outline()}</clipPath>
      <mask id={`${clip}-gap`} maskUnits="userSpaceOnUse" {...frame}>
        <rect {...frame} {...stylex.props(maskStyles.keep)} />
        <rect {...gap} {...stylex.props(maskStyles.gap)} />
      </mask>
      <g mask={`url(#${clip}-gap)`}>
        {outline(markStyles.plain)}
        <g clipPath={`url(#${clip})`} {...stylex.props(maskStyles.dither)}>
          <DitherBands
            chart={chart}
            texture={texture}
            axis={upright ? "y" : "x"}
            lit={{ top: y, left: x, right: x + width }[tip]}
            floor={{ top: y + height, left: x + width, right: x }[tip]}
            start={upright ? x : y}
            breadth={upright ? width : height}
          />
        </g>
      </g>
      <g clipPath={`url(#${clip})`}>
        <rect {...cap} {...stylex.props(markStyles.cap)} />
      </g>
    </>
  );
};

interface BarShapeProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  index?: number;
  value?: number | readonly number[];
}

/** The keys stacked with `stackId`, and the row's sum over them: where the stack's top is. */
const stackTop = (
  row: Row | undefined,
  stacks: Readonly<Record<string, string>>,
  stackId: string
) =>
  Object.keys(stacks)
    .filter((key) => stacks[key] === stackId)
    .reduce(
      (sum, key) =>
        sum + Math.max(0, row === undefined ? 0 : valueOf(row, key)),
      0
    );

/**
 * A stacked series' place among its stack's series in the config's order, which picks its tone:
 * the first at the foot takes the value colour, whatever else the chart draws.
 */
const toneIndex = (
  config: ChartConfig,
  stacks: Readonly<Record<string, string>>,
  dataKey: string,
  stackId = ownValue(stacks, dataKey)
) =>
  Object.keys(config)
    .filter((key) => key === dataKey || ownValue(stacks, key) === stackId)
    .indexOf(dataKey);

/** A series as bars. */
export const ChartBar = ({
  dataKey,
  pattern = "none",
  stackId,
}: ChartBarProps) => {
  const { config, id, data, setBarCount, stacks, setStacks, selectedIndex } =
    useChart();
  const reduced = useReducedMotion();
  // The chart draws no hover line through bars: count this one in while it is there.
  useEffect(() => {
    setBarCount((count) => count + 1);
    return () => {
      setBarCount((count) => count - 1);
    };
  }, [setBarCount]);
  // The chart knows which stack this series is in, so its tooltip, legend and stack top follow;
  // before it paints, so the first frame already rounds only the top.
  useLayoutEffect(() => {
    setStacks((was) => withEntry(was, dataKey, stackId));
    return () => {
      setStacks((was) => withEntry(was, dataKey));
    };
  }, [setStacks, dataKey, stackId]);
  const texture = stackId === undefined ? textureOf(pattern) : null;
  const tone = toneOf(toneIndex(config, stacks, dataKey, stackId));
  const shape = ({
    x = 0,
    y = 0,
    width = 0,
    height = 0,
    index = 0,
    value,
  }: BarShapeProps) => {
    if (height <= 0 || width <= 0) {
      return <g />;
    }
    const resting =
      typeof selectedIndex === "number" && index !== selectedIndex;
    const step = stylex.props(markStyles.bar, resting && markStyles.rest);
    if (stackId !== undefined) {
      // Only the stack's top part is rounded; every part under it gives up its top to the gap.
      const high = typeof value === "number" ? value : (value?.[1] ?? 0);
      // Its top is the stack's when it reaches the sum of the stack's parts, to a rounding.
      const sum = stackTop(data[index], stacks, stackId);
      const top = high >= sum - Math.abs(sum) * 1e-9;
      const cut = top ? 0 : Math.min(STACK_GAP, height);
      const part = { x, y: y + cut, width, height: height - cut };
      return (
        <g {...step}>
          {part.height > 0 && top && (
            <RoundTop {...part} look={toneStyles.fill(tone)} />
          )}
          {part.height > 0 && !top && (
            <rect {...part} {...stylex.props(toneStyles.fill(tone))} />
          )}
        </g>
      );
    }
    const box = { x, y, width, height };
    const outline = (look?: stylex.StyleXStyles) => (
      <RoundTop {...box} look={look} />
    );
    return (
      <g {...step}>
        {texture === null ? (
          outline(markStyles.plain)
        ) : (
          <DitheredBar
            chart={id}
            clip={`${id}-${dataKey}-bar-${index}`}
            texture={texture}
            box={box}
            tip="top"
            outline={outline}
          />
        )}
      </g>
    );
  };
  return (
    <Bar
      dataKey={dataKey}
      name={config[dataKey]?.label ?? dataKey}
      stackId={stackId}
      shape={shape}
      isAnimationActive={!reduced}
    />
  );
};

// ---- ChartArea and ChartLine --------------------------------------------------------------------
//
// ChartArea: one series as a line with the area under it filled. The line, in the value colour,
// says the number; the fill under it is plain and faint, or a dither, lit near the line.
//
// ChartLine: one series as a line alone, a trend, drawn as ChartArea draws its own (an area whose
// shape is its line only, so both lines are one line); a point shows under the pointer or the keys.
// Several ChartLines compare: each takes a `variant`, so lines are told apart by weight and dash and
// not by colour alone (the light has few hues). `muted` is the earlier period: muted, thinner and
// dashed. ChartLabels names each at its end, in place of a legend.

/** Every prop a ChartArea takes. */
export interface ChartAreaProps {
  /** The series it draws: its key in each row, named in the chart's config. */
  dataKey: string;
  /**
   * `none` a faint wash of the value colour, or a dither: `dither-pixels` chunky, `dither-dots` fine.
   * @default "none"
   */
  pattern?: ChartPattern;
}

/** Every prop a ChartLine takes. */
export interface ChartLineProps {
  /** The series it draws: its key in each row, named in the chart's config. */
  dataKey: string;
  /**
   * How it is drawn, so several are told apart without colour: `solid` (the value), `dashed`,
   * `dotted`, `thin`, or `muted` for an earlier period (muted, thinner, dashed).
   * @default "solid"
   */
  variant?: ChartLineVariant;
}

// The line's width and the clear room between the line and the fill under it in dark, in CSS
// pixels: SVG attributes.
const LINE = 2;
const LINE_GAP = 2;

// Each variant's width and dash, in CSS pixels: SVG attributes, which take numbers.
const LINE_VARIANTS: Record<
  ChartLineVariant,
  { width: number; dash: string | undefined }
> = {
  solid: { width: LINE, dash: undefined },
  dashed: { width: LINE, dash: "6 4" },
  dotted: { width: LINE, dash: "0.1 4.5" },
  thin: { width: 1, dash: undefined },
  muted: { width: 1.5, dash: "4 4" },
};

const lineStyles = stylex.create({
  line: {
    fill: "none",
    stroke: { default: colors.chart1, [FORCED]: "CanvasText" },
    strokeLinejoin: "round",
    strokeLinecap: "round",
  },
  muted: { stroke: { default: colors.chartMuted, [FORCED]: "GrayText" } },
  // The faint wash, opaque on the card's own ground, so the grid's lines stop at the area and do not
  // run through it: 16% of the line on a light card, 12% on a dark one, where the same share
  // already reads strong.
  wash: {
    fill: {
      default: `light-dark(color-mix(in oklch, ${colors.chart1} 16%, ${colors.card}), color-mix(in oklch, ${colors.chart1} 12%, ${colors.card}))`,
      [FORCED]: "transparent",
    },
  },
  dot: {
    fill: { default: colors.card, [FORCED]: "Canvas" },
    stroke: { default: colors.chart1, [FORCED]: "CanvasText" },
  },
  dotMuted: {
    stroke: { default: colors.chartMuted, [FORCED]: "GrayText" },
  },
});

interface Point {
  x: number | null;
  y: number | null;
}

const shownPoints = (points: readonly Point[]) =>
  points.filter(
    (point): point is { x: number; y: number } =>
      point.x !== null && point.y !== null
  );

// The line through the points, and the same closed down to the floor for the fill, as SVG point lists.
const areaMarks = (points: readonly Point[], floor: number) => {
  const shown = shownPoints(points);
  const first = shown.at(0);
  const last = shown.at(-1);
  if (first === undefined || last === undefined) {
    return null;
  }
  const line = shown.map((point) => `${point.x},${point.y}`).join(" ");
  return {
    line,
    area: `${line} ${last.x},${floor} ${first.x},${floor}`,
    left: first.x,
    right: last.x,
    top: Math.min(...shown.map((point) => point.y)),
  };
};

interface AreaShapeProps {
  points?: readonly Point[];
  baseLine?: number | readonly Point[];
}

/** A series as a line with the area under it filled. */
export const ChartArea = ({ dataKey, pattern = "none" }: ChartAreaProps) => {
  const { config, id } = useChart();
  const reduced = useReducedMotion();
  const texture = textureOf(pattern);
  const shape = ({ points = [], baseLine }: AreaShapeProps) => {
    const floor =
      typeof baseLine === "number"
        ? baseLine
        : Math.max(...(baseLine ?? []).map((point) => point.y ?? 0));
    const drawn = areaMarks(points, floor);
    if (!drawn) {
      return <g />;
    }
    const clip = `${id}-${dataKey}-area`;
    const gap = `${id}-${dataKey}-gap`;
    return (
      <g>
        <clipPath id={clip}>
          <polygon points={drawn.area} />
        </clipPath>
        <mask
          id={gap}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="100%"
          height="100%"
        >
          <rect
            x="0"
            y="0"
            width="100%"
            height="100%"
            {...stylex.props(maskStyles.keep)}
          />
          <polyline
            points={drawn.line}
            strokeWidth={LINE + 2 * LINE_GAP}
            {...stylex.props(maskStyles.gapStroke)}
          />
        </mask>
        <g mask={`url(#${gap})`}>
          <polygon points={drawn.area} {...stylex.props(lineStyles.wash)} />
          {texture !== null && (
            <g clipPath={`url(#${clip})`} {...stylex.props(maskStyles.dither)}>
              <DitherBands
                chart={id}
                texture={texture}
                axis="y"
                lit={drawn.top}
                floor={floor}
                start={drawn.left}
                breadth={drawn.right - drawn.left}
              />
            </g>
          )}
        </g>
        <polyline
          points={drawn.line}
          strokeWidth={LINE}
          {...stylex.props(lineStyles.line)}
        />
      </g>
    );
  };
  return (
    <Area
      dataKey={dataKey}
      name={config[dataKey]?.label ?? dataKey}
      shape={shape}
      activeDot={{
        r: 4,
        strokeWidth: LINE,
        className: className(lineStyles.dot),
      }}
      dot={false}
      isAnimationActive={!reduced}
    />
  );
};

/** A series as a line alone. */
export const ChartLine = ({ dataKey, variant = "solid" }: ChartLineProps) => {
  const { config, setVariant } = useChart();
  const reduced = useReducedMotion();
  // The chart knows how this line is drawn, so its name at the end can match.
  useEffect(() => {
    setVariant(dataKey, variant);
  }, [setVariant, dataKey, variant]);
  const muted = variant === "muted";
  const { width, dash } = LINE_VARIANTS[variant];
  const shape = ({ points = [] }: { points?: readonly Point[] }) => (
    <g>
      <polyline
        data-slot="chart-line"
        data-variant={variant}
        points={shownPoints(points)
          .map((point) => `${point.x},${point.y}`)
          .join(" ")}
        strokeWidth={width}
        strokeDasharray={dash}
        {...stylex.props(lineStyles.line, muted && lineStyles.muted)}
      />
    </g>
  );
  return (
    <Area
      dataKey={dataKey}
      name={config[dataKey]?.label ?? dataKey}
      shape={shape}
      activeDot={{
        r: 4,
        strokeWidth: LINE,
        className: className(lineStyles.dot, muted && lineStyles.dotMuted),
      }}
      dot={false}
      isAnimationActive={!reduced}
    />
  );
};

// ---- ChartXAxis and ChartYAxis ------------------------------------------------------------------
//
// The names along the bottom or the numbers up the side, in muted small type with tabular figures,
// with no axis line or tick marks: the grid carries the levels.

/** Every prop a ChartXAxis takes. */
export interface ChartXAxisProps {
  /** Writes a name along the bottom as people read it ("Jan"). */
  valueFormatter?: (value: string | number) => string;
}

/** Every prop a ChartYAxis takes. */
export interface ChartYAxisProps {
  /** Writes a value as people read it ("40k"); the chart's table writes its values the same way. */
  valueFormatter?: (value: string | number) => string;
  /**
   * The axis's width in pixels, room for its longest label: wider for currency or long numbers
   * ("€5,000" needs about 52).
   * @default 36
   */
  width?: number;
}

const axisStyles = stylex.create({
  tick: {
    fill: colors.chartTick,
    fontFamily: font.sans,
    fontSize: font.textXs,
    fontVariantNumeric: "tabular-nums",
  },
});

interface TickProps {
  x: number;
  y: number;
  payload?: { value: string | number };
  textAnchor?: TextAnchor;
  valueFormatter?: (value: string | number) => string;
  dy: string;
}

// Our own tick: a text element with the StyleX class, so no rule has to reach into Recharts.
const Tick = ({ x, y, payload, textAnchor, valueFormatter, dy }: TickProps) => {
  const value = payload?.value ?? "";
  return (
    <text
      x={x}
      y={y}
      dy={dy}
      textAnchor={textAnchor}
      {...stylex.props(axisStyles.tick)}
    >
      {valueFormatter === undefined ? value : valueFormatter(value)}
    </text>
  );
};

/** The names along the bottom. */
export const ChartXAxis = ({ valueFormatter }: ChartXAxisProps) => {
  const { xKey } = useChart();
  const tick = (props: XAxisTickContentProps) => (
    <Tick
      x={Number(props.x)}
      y={Number(props.y)}
      payload={props.payload}
      textAnchor={props.textAnchor}
      valueFormatter={valueFormatter}
      dy="0.9em"
    />
  );
  return (
    <XAxis
      dataKey={xKey}
      axisLine={false}
      tickLine={false}
      tickMargin={4}
      height={chartAxisRoom.x}
      tick={tick}
    />
  );
};

/** The numbers up the side. */
export const ChartYAxis = ({
  valueFormatter,
  width = chartAxisRoom.y,
}: ChartYAxisProps) => {
  // The y axis writes the values: the chart's table writes them the same way.
  useTellFormatter(valueFormatter);
  const tick = (props: YAxisTickContentProps) => (
    <Tick
      x={Number(props.x)}
      y={Number(props.y)}
      payload={props.payload}
      textAnchor={props.textAnchor}
      valueFormatter={valueFormatter}
      dy="0.32em"
    />
  );
  return (
    <YAxis
      axisLine={false}
      tickLine={false}
      tickMargin={4}
      width={width}
      tick={tick}
    />
  );
};

// ---- ChartGrid ----------------------------------------------------------------------------------

/** Every prop a ChartGrid takes. */
export interface ChartGridProps {
  /**
   * Upright lines too, one per point along the bottom.
   * @default false
   */
  vertical?: boolean;
}

interface GridLineProps {
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
}

// 2 on 2, so the grid reads as lines, not as a scatter of dots.
const GRID_DASH = 2;
const GRID_GAP = 2;

/**
 * One grid line, dotted so that it begins and ends on a dash: the gaps are stretched a little to
 * fit the line's length (a plain "2 2" would end in a gap, 2px short of the plot's end).
 * Presentation attributes take a CSS variable, so the token's light and dark both hold.
 */
const Dotted = ({ x1 = 0, y1 = 0, x2 = 0, y2 = 0 }: GridLineProps) => {
  const length = Math.hypot(x2 - x1, y2 - y1);
  const dashes = Math.max(
    1,
    Math.round((length - GRID_DASH) / (GRID_DASH + GRID_GAP))
  );
  const gap = (length - GRID_DASH * (dashes + 1)) / dashes;
  return (
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke={colors.chartGrid}
      strokeDasharray={`${GRID_DASH} ${gap}`}
    />
  );
};

/** Faint level lines behind the marks, dotted. */
export const ChartGrid = ({ vertical = false }: ChartGridProps) => (
  <CartesianGrid
    vertical={vertical ? <Dotted /> : false}
    horizontal={<Dotted />}
  />
);

// ---- ChartTooltip -------------------------------------------------------------------------------
//
// The point under the pointer or the keyboard, in the tooltip's own panel: the name along the
// bottom, then each series and its value. A faint band marks the point in the chart. It stands clear
// of what it explains: a gap off the crosshair, and above the highest hovered mark or below the
// lowest when there is room, never over a hovered point. The point is said in the chart's live
// region as the arrow keys move it.

/** Every prop a ChartTooltip takes. */
export interface ChartTooltipProps {
  /** Writes a value as people read it ("1,240", "40%"); the chart's table writes its values the same way. */
  valueFormatter?: (value: number) => string;
  /**
   * The series in the config's order (`none`), or the highest first (`descending`), as several
   * lines compared read best.
   * @default "none"
   */
  sortOrder?: "descending" | "none";
}

// The clear room between the tooltip and the crosshair or any hovered mark, in CSS pixels.
const CLEAR = 16;

/** One row of the tooltip: a series and its value at the point. */
interface TooltipRow {
  key: string;
  value: unknown;
}

/** The rows, highest first, for a tooltip that lists several lines by value. */
const byValue = (rows: readonly TooltipRow[]) =>
  rows.toSorted(
    (a, b) =>
      (typeof b.value === "number" ? b.value : 0) -
      (typeof a.value === "number" ? a.value : 0)
  );

/** A value as the tooltip writes it: a number through its formatter, words as they are. */
const shownValue = (
  value: unknown,
  formatter: ((value: number) => string) | undefined
): string | number | null => {
  if (typeof value === "number") {
    return formatter === undefined ? value : formatter(value);
  }
  return typeof value === "string" ? value : null;
};

/** A tooltip or legend entry's series key, as Recharts gives it. */
const entryKey = (entry: { dataKey?: unknown }) =>
  typeof entry.dataKey === "string" || typeof entry.dataKey === "number"
    ? String(entry.dataKey)
    : "";

const tooltipStyles = stylex.create({
  // The tooltip's panel: the one corner, lifted like every popup, never interactive. Over a chart
  // it is solid: translucent, the bars behind it showed through as stripes and its words lost their
  // ground. Forced colours drop the fill and the lift, so a 1px border draws its edge.
  panel: {
    boxSizing: "border-box",
    margin: 0,
    padding: size.tooltipPadding,
    borderWidth: { default: 0, [FORCED]: size.hairline },
    borderStyle: "solid",
    borderColor: "CanvasText",
    color: colors.tooltipForeground,
    backgroundColor: `oklch(from ${colors.tooltip} l c h / 1)`,
    boxShadow: shadow.sm,
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    fontFamily: font.sans,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontWeight: font.weightMedium,
    textWrap: "pretty",
    overflowWrap: "anywhere",
    hyphens: "manual",
  },
  title: { display: "block", fontWeight: font.weightMedium },
  row: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space[3],
    fontWeight: font.weightNormal,
  },
  value: { fontVariantNumeric: "tabular-nums", fontWeight: font.weightMedium },
  // The panel for the bar the keys are on, where Recharts would stand its own.
  keyed: {
    position: "absolute",
    zIndex: 1,
    top: 0,
    left: 0,
    pointerEvents: "none",
  },
  unplaced: { visibility: "hidden" },
  placed: (x: number, y: number) => ({
    transform: `translate(${x}px, ${y}px)`,
  }),
  cursor: { fill: colors.accent, stroke: "none" },
  cursorLine: {
    stroke: colors.chartGrid,
    strokeWidth: size.hairline,
    fill: "none",
  },
});

interface CursorProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  points?: readonly { x: number; y: number }[];
}

// Our own cursor: a faint band over the point's column, or a hairline where Recharts draws a line.
const Cursor = ({ x, y, width, height, points }: CursorProps) => {
  const [from, to, ...rest] = points ?? [];
  if (from !== undefined && to !== undefined && rest.length === 0) {
    return (
      <line
        x1={from.x}
        y1={from.y}
        x2={to.x}
        y2={to.y}
        {...stylex.props(tooltipStyles.cursorLine)}
      />
    );
  }
  return (
    <rect
      x={x}
      y={y}
      width={width}
      height={height}
      {...stylex.props(tooltipStyles.cursor)}
    />
  );
};

// Says the active point in the chart's live region, as the arrow keys move it: its values written
// as the table writes them.
const Announcer = () => {
  const { config, live, valueFormatter } = useChart();
  const { chart: words } = useI18n();
  const label = useActiveTooltipLabel();
  const points = useActiveTooltipDataPoints<Row>();
  const [row] = points ?? [];
  if (live === null || label === undefined || row === undefined) {
    return null;
  }
  return createPortal(
    pointWords(words, String(label), row, config, valueFormatter),
    live
  );
};

/**
 * The marks' heights at a row, in the drawing: one per series, or one per stack at the stack's top,
 * so the tooltip stands clear of the whole bar.
 */
const marksOf = (
  row: Row | undefined,
  config: ChartConfig,
  stacks: Readonly<Record<string, string>>,
  y: ((value: number) => number | undefined) | undefined
) => {
  if (y === undefined || row === undefined) {
    return [];
  }
  const keys = Object.keys(config);
  const alone = keys
    .filter((key) => ownValue(stacks, key) === undefined)
    .map((key) => ownValue(row, key))
    .filter((value) => typeof value === "number");
  const tops = [...new Set(Object.values(stacks))].map((stackId) =>
    stackTop(row, stacks, stackId)
  );
  return [...alone, ...tops].map((value) => y(value) ?? 0);
};

// The hovered marks' heights in the drawing.
const useMarks = () => {
  const { config, stacks } = useChart();
  const y = useYAxisScale();
  const points = useActiveTooltipDataPoints<Row>();
  const [row] = points ?? [];
  return marksOf(row, config, stacks, y);
};

const keyStyles = stylex.create({
  // A stacked series' name in the tooltip, after the square of its tone.
  name: { display: "inline-flex", alignItems: "center", gap: space[2] },
});

/** The point under the pointer or the keys, in a panel beside it. */
export const ChartTooltip = ({
  valueFormatter,
  sortOrder = "none",
}: ChartTooltipProps) => {
  // The tooltip writes the values: the chart's table writes them the same way.
  useTellFormatter(valueFormatter);
  const { config, bars, data, xKey, stacks, host, focused } = useChart();
  const reduced = useReducedMotion();
  const plot = usePlotArea();
  const y = useYAxisScale();
  const marks = useMarks();
  const at = useActiveTooltipCoordinate();
  // The panel's own size, read as it is drawn, so it can stand clear above the marks.
  const [box, setBox] = useState({ width: 0, height: 0 });
  const measure = (panel: HTMLDivElement | null) => {
    if (
      panel !== null &&
      (panel.offsetHeight !== box.height || panel.offsetWidth !== box.width)
    ) {
      setBox({ width: panel.offsetWidth, height: panel.offsetHeight });
    }
  };
  // Where the panel stands for marks at `x`: clear above them, else beside the bar over bars.
  const placeAt = (
    heights: readonly number[],
    x: number | undefined,
    band: number,
    beside: boolean
  ) => {
    const top =
      plot === undefined || box.height === 0
        ? undefined
        : tooltipTop(heights, plot, box.height, CLEAR);
    // Over bars it stands centred above the bar it explains, or beside it where the bar is too
    // tall: never on the bar itself.
    const above =
      top !== undefined &&
      heights.length > 0 &&
      top + box.height <= Math.min(...heights);
    const across =
      beside && x !== undefined && plot !== undefined && box.width > 0
        ? { x: barTooltipLeft(x, band, box.width, plot, CLEAR, above) }
        : {};
    return top === undefined
      ? undefined
      : {
          ...across,
          y: beside && !above && plot !== undefined ? plot.y : top,
        };
  };
  const position = placeAt(
    marks,
    at?.x,
    plot === undefined ? 0 : plot.width / Math.max(1, data.length),
    bars
  );
  const panel = (label: ReactNode, rows: readonly TooltipRow[]) => (
    <div ref={measure} {...stylex.props(tooltipStyles.panel)}>
      <span {...stylex.props(tooltipStyles.title)}>{label}</span>
      {(sortOrder === "descending" ? byValue(rows) : rows).map((row) => {
        const value = shownValue(row.value, valueFormatter);
        const name = config[row.key]?.label ?? row.key;
        const stacked = ownValue(stacks, row.key) !== undefined;
        return (
          <span key={row.key} {...stylex.props(tooltipStyles.row)}>
            {stacked ? (
              <span {...stylex.props(keyStyles.name)}>
                <span
                  aria-hidden="true"
                  {...stylex.props(
                    toneStyles.swatch,
                    toneStyles.background(
                      toneOf(toneIndex(config, stacks, row.key))
                    )
                  )}
                />
                {name}
              </span>
            ) : (
              <span>{name}</span>
            )}
            <span {...stylex.props(tooltipStyles.value)}>{value}</span>
          </span>
        );
      })}
    </div>
  );
  const content = ({ active, label, payload }: TooltipContentProps) => {
    if (!active || payload.length === 0) {
      return null;
    }
    return panel(
      label,
      payload.map((entry) => ({ key: entryKey(entry), value: entry.value }))
    );
  };
  // The row the keyboard is on, when the bars can be pressed: Recharts' tooltip follows only its own
  // keys, so this panel stands where it would, in the same element, and Recharts' waits. A row gone
  // from the data shows none.
  const keyed = focused === null ? -1 : rowKeys(data, xKey).indexOf(focused);
  const row = data[keyed];
  const column =
    row === undefined || plot === undefined
      ? undefined
      : pressColumns(data.length, plot, bars)[keyed];
  const place =
    column === undefined
      ? undefined
      : placeAt(
          marksOf(row, config, stacks, y),
          column.middle,
          column.width,
          true
        );
  return (
    <>
      <Tooltip
        content={content}
        cursor={bars ? false : <Cursor />}
        isAnimationActive={!reduced}
        offset={CLEAR}
        position={position}
        active={row === undefined ? undefined : false}
      />
      {row !== undefined &&
        host !== null &&
        createPortal(
          <div
            {...stylex.props(
              tooltipStyles.keyed,
              place === undefined
                ? tooltipStyles.unplaced
                : tooltipStyles.placed(place.x ?? 0, place.y)
            )}
          >
            {panel(
              String(ownValue(row, xKey) ?? ""),
              Object.keys(config).map((key) => ({
                key,
                value: ownValue(row, key),
              }))
            )}
          </div>,
          host
        )}
      <Announcer />
    </>
  );
};

// ---- ChartLegend --------------------------------------------------------------------------------

/** Every prop a ChartLegend takes. */
export type ChartLegendProps = Record<string, never>;

const legendStyles = stylex.create({
  list: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: space[4],
    margin: 0,
    paddingBlockStart: space[3],
    paddingInline: 0,
    listStyle: "none",
    fontFamily: font.sans,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
  },
  item: { display: "inline-flex", alignItems: "center", gap: space[2] },
  swatch: {
    width: space[3],
    height: space[1],
    borderRadius: radius.full,
    backgroundColor: colors.chart1,
  },
});

/** Each series' name beside a swatch of how it is drawn, under the chart: a stacked series' in its tone. */
export const ChartLegend = () => {
  const { config, stacks } = useChart();
  const keys = Object.keys(config);
  const content = ({ payload }: { payload?: readonly LegendPayload[] }) => (
    <ul {...stylex.props(legendStyles.list)}>
      {(payload ?? []).map((entry) => {
        const key = entryKey(entry);
        const stacked = ownValue(stacks, key) !== undefined;
        return (
          <li key={key} {...stylex.props(legendStyles.item)}>
            <span
              aria-hidden="true"
              {...stylex.props(
                stacked ? toneStyles.swatch : legendStyles.swatch,
                stacked &&
                  toneStyles.background(toneOf(toneIndex(config, stacks, key)))
              )}
            />
            {config[key]?.label ?? key}
          </li>
        );
      })}
    </ul>
  );
  // A stack's series read in the config's order, the foot's first, as the bars stand; other
  // series by name, as before.
  const stacked = Object.keys(stacks).length > 0;
  return (
    <Legend
      content={content}
      itemSorter={
        stacked
          ? (entry: LegendPayload) => keys.indexOf(entryKey(entry))
          : "value"
      }
    />
  );
};

// ---- ChartLabels --------------------------------------------------------------------------------
//
// Each line named at its end, beside its last point, in place of a legend. Where two lines end close
// together their names are pushed apart just enough not to touch, and the chart keeps room at its
// right for the longest. A muted line's name is muted too.

/** Every prop a ChartLabels takes. */
export type ChartLabelsProps = Record<string, never>;

// The space between a line's end and its name, the least room between two names, and the room
// kept beyond the longest name, in CSS pixels: SVG geometry.
const LABEL_OFFSET = 8;
const LABEL_GAP = 18;
const LABEL_PAD = 4;

const labelStyles = stylex.create({
  name: {
    fill: { default: colors.bodyForeground, [FORCED]: "CanvasText" },
    fontFamily: font.sans,
    fontSize: font.textXs,
    dominantBaseline: "central",
  },
  muted: { fill: { default: colors.mutedForeground, [FORCED]: "GrayText" } },
});

const SVG = "http://www.w3.org/2000/svg";
const measured = new Map<string, { width: number; height: number }>();

interface TextBox {
  width: number;
  height: number;
}

const noBox: TextBox = { width: 0, height: 0 };

/**
 * Each of `words`' drawn width and height, in CSS pixels, as an SVG text with `className`: set in a
 * hidden SVG text with the same class as the label that will show it, in the engine the page runs
 * in (a canvas measure with a guessed font came out a pixel or more short in Firefox and WebKit).
 * Kept once the page's fonts are in. It touches the page, so only useTextBoxes calls it, from an
 * effect.
 */
const measureText = (
  words: readonly string[],
  look: string | undefined
): TextBox[] => {
  const keyOf = (word: string) => `${look ?? ""}\n${word}`;
  const fresh = new Map<string, { width: number; height: number }>();
  const missing = words.filter((word) => !measured.has(keyOf(word)));
  if (missing.length > 0) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.setAttribute("visibility", "hidden");
    const texts = missing.map((word) => {
      const text = document.createElementNS(SVG, "text");
      text.setAttribute("class", look ?? "");
      text.textContent = word;
      svg.append(text);
      return text;
    });
    document.body.append(svg);
    // Kept only once the page's fonts are in: a box read in the fallback font is read again.
    const settled = document.fonts.status === "loaded";
    for (const [index, text] of texts.entries()) {
      const box = text.getBBox();
      fresh.set(keyOf(missing[index] ?? ""), {
        width: Math.ceil(box.width),
        height: Math.ceil(box.height),
      });
    }
    if (settled) {
      for (const [key, box] of fresh) {
        measured.set(key, box);
      }
    }
    svg.remove();
  }
  return words.map(
    (word) => measured.get(keyOf(word)) ?? fresh.get(keyOf(word)) ?? noBox
  );
};

/**
 * Each of `words`' drawn box (measureText), measured once the part is on the page, before it
 * paints, and again once the page's fonts are in. Empty boxes on the server and until then: the
 * parts that use them draw only once they have a width.
 */
const useTextBoxes = (
  words: readonly string[],
  look: string | undefined
): TextBox[] => {
  const joined = words.join("\n");
  const [read, setRead] = useState<{
    joined: string;
    boxes: TextBox[];
  } | null>(null);
  useLayoutEffect(() => {
    let current = true;
    const measure = () => {
      if (current) {
        setRead({
          joined,
          boxes: measureText(joined === "" ? [] : joined.split("\n"), look),
        });
      }
    };
    measure();
    if (document.fonts.status !== "loaded") {
      const settled = async () => {
        await document.fonts.ready;
        measure();
      };
      void settled();
    }
    return () => {
      current = false;
    };
  }, [joined, look]);
  return read?.joined === joined ? read.boxes : words.map(() => noBox);
};

/** Each series' last row with a number. */
const endOf = (data: readonly Row[], key: string) => {
  const row = data.findLast((each) => typeof ownValue(each, key) === "number");
  return row === undefined ? null : { row, value: Number(ownValue(row, key)) };
};

/** Each line's name at its end. */
export const ChartLabels = () => {
  const { config, data, xKey, variants, setRoom } = useChart();
  const x = useXAxisScale();
  const y = useYAxisScale();
  const plot = usePlotArea();
  // The lines ChartLine says it draws; until they have said, every series.
  const drawn = Object.keys(variants);
  const keys = drawn.length > 0 ? drawn : Object.keys(config);
  const names = keys.map((key) => config[key]?.label ?? key);
  // Each name as this engine draws it, in the names' own type.
  const boxes = useTextBoxes(names, className(labelStyles.name));
  const longest = Math.max(0, ...boxes.map((box) => box.width));
  const gap = Math.max(LABEL_GAP, ...boxes.map((box) => box.height + 2));
  // The room at the right, kept by the chart, for the longest name.
  useEffect(() => {
    setRoom(longest + LABEL_OFFSET + LABEL_PAD);
    return () => {
      setRoom(0);
    };
  }, [setRoom, longest]);
  if (x === undefined || y === undefined || plot === undefined) {
    return null;
  }
  const shown = keys.flatMap((key) => {
    const end = endOf(data, key);
    return end === null
      ? []
      : [{ key, x: x(end.row[xKey]) ?? 0, y: y(end.value) ?? 0 }];
  });
  const placed = spread(
    shown.map((end) => end.y),
    gap,
    plot.y,
    plot.y + plot.height
  );
  return (
    <g aria-hidden="true" data-slot="chart-labels">
      {shown.map((end, index) => (
        <text
          key={end.key}
          x={end.x + LABEL_OFFSET}
          y={placed[index]}
          {...stylex.props(
            labelStyles.name,
            variants[end.key] === "muted" && labelStyles.muted
          )}
        >
          {config[end.key]?.label ?? end.key}
        </text>
      ))}
    </g>
  );
};

// ---- ChartReferenceLine -------------------------------------------------------------------------
//
// A line across the drawing at a value up the side (a budget, a limit), or up it at a point along
// the bottom (a launch): dashed, in ink, on a halo of the card's own ground, so it reads where it
// crosses a bar in light and dark, with its name at its end. Recharts places it, and widens the axis
// so the line is always inside the drawing. A screen reader hears its name and value after the
// chart's summary.

/** Every prop a ChartReferenceLine takes: one of `y` and `x`. */
export interface ChartReferenceLineProps {
  /** A value up the side: the line runs across the drawing there (a budget, a limit). */
  y?: number;
  /** A point along the bottom, a value of the rows' `xKey`: the line runs up the drawing there (a launch). */
  x?: string | number;
  /** Its name, drawn at its end and said with its value ("Budget"). */
  children?: string;
}

// The line's dash, its width and its halo's, and the room between the line and its name, in CSS
// pixels: SVG attributes.
const REFERENCE_DASH = "6 4";
const REFERENCE_WIDTH = 1.5;
const REFERENCE_HALO = 5;
const REFERENCE_NAME_HALO = 4;
const REFERENCE_GAP = 4;
// The room its name takes up and down: one line of the axis's type.
const REFERENCE_NAME_LINE = 16;

const referenceStyles = stylex.create({
  halo: {
    fill: "none",
    stroke: { default: colors.card, [FORCED]: "Canvas" },
  },
  line: {
    fill: "none",
    stroke: { default: colors.foreground, [FORCED]: "CanvasText" },
  },
  // Its name, on a halo of the ground drawn under the letters, so it reads over a bar.
  name: {
    fill: { default: colors.foreground, [FORCED]: "CanvasText" },
    stroke: { default: colors.card, [FORCED]: "Canvas" },
    strokeWidth: REFERENCE_NAME_HALO,
    strokeLinejoin: "round",
    paintOrder: "stroke",
    fontFamily: font.sans,
    fontSize: font.textXs,
    fontWeight: font.weightMedium,
    // Its anchor is a side of the drawing on any page; its words still read in their own
    // direction, set from their first letter.
    direction: "ltr",
    unicodeBidi: "plaintext",
  },
});

/**
 * Where a reference line's name stands, by the edge of its words that meets the line's end: across,
 * its end at the line's end, above the line, or under it where the drawing's top is too near; up,
 * at the top beside it, after it in the drawing's left half and before it in the right.
 */
const referenceNameAt = (
  line: { x1: number; y1: number; x2: number; y2: number },
  across: boolean,
  plot: { x: number; y: number; width: number }
): {
  x: number;
  y: number;
  anchor: "start" | "end";
  baseline: "text-after-edge" | "text-before-edge";
} => {
  if (across) {
    const above = line.y1 - REFERENCE_GAP - REFERENCE_NAME_LINE >= plot.y;
    return {
      x: line.x2,
      y: above ? line.y1 - REFERENCE_GAP : line.y1 + REFERENCE_GAP,
      anchor: "end",
      baseline: above ? "text-after-edge" : "text-before-edge",
    };
  }
  const after = line.x1 <= plot.x + plot.width / 2;
  return {
    x: after ? line.x1 + REFERENCE_GAP : line.x1 - REFERENCE_GAP,
    y: Math.min(line.y1, line.y2),
    anchor: after ? "start" : "end",
    baseline: "text-before-edge",
  };
};

interface ReferenceShapeProps {
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
}

/** A dashed line across or up the drawing at a value, with its name at its end. */
export const ChartReferenceLine = ({
  x,
  y,
  children,
}: ChartReferenceLineProps) => {
  const { setReferences, valueFormatter } = useChart();
  const { chart: words } = useI18n();
  const plot = usePlotArea();
  const key = useId();
  const value = y === undefined ? x : writtenValue(y, valueFormatter);
  const said =
    children === undefined || value === undefined
      ? null
      : words.point(children, String(value));
  useEffect(() => {
    setReferences((was) => withEntry(was, key, said ?? undefined));
    return () => {
      setReferences((was) => withEntry(was, key));
    };
  }, [setReferences, key, said]);
  const shape = ({ x1 = 0, y1 = 0, x2 = 0, y2 = 0 }: ReferenceShapeProps) => {
    const at =
      plot === undefined
        ? null
        : referenceNameAt({ x1, y1, x2, y2 }, y !== undefined, plot);
    return (
      <g aria-hidden="true" data-slot="chart-reference-line">
        <line
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          strokeWidth={REFERENCE_HALO}
          {...stylex.props(referenceStyles.halo)}
        />
        <line
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          strokeWidth={REFERENCE_WIDTH}
          strokeDasharray={REFERENCE_DASH}
          {...stylex.props(referenceStyles.line)}
        />
        {children !== undefined && at !== null && (
          <text
            x={at.x}
            y={at.y}
            textAnchor={at.anchor}
            dominantBaseline={at.baseline}
            {...stylex.props(referenceStyles.name)}
          >
            {children}
          </text>
        )}
      </g>
    );
  };
  return <ReferenceLine x={x} y={y} ifOverflow="extendDomain" shape={shape} />;
};

// ---- The figures of their own -------------------------------------------------------------------
//
// ChartBarList, ChartPie and ChartSankey stand alone, not on a ChartContainer: each is its own
// figure, named and summed up in words for a screen reader, with its numbers in a list or as named
// parts. ChartSparkline is a picture with a name, or a control at its large size.

const figureStyles = stylex.create({
  figure: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    rowGap: space[3],
    minWidth: 0,
    margin: 0,
    fontFamily: font.sans,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.bodyForeground,
  },
});

/** How wide a box is drawn, in whole CSS pixels, kept as it changes; 0 until it is laid out. */
const useWidth = (): [number, (element: Element | null) => () => void] => {
  const [width, setWidth] = useState(0);
  // A ref callback: it watches the box while it is there and stops when it goes.
  const watch = (element: Element | null) => {
    const observer = new ResizeObserver((entries) => {
      const entry = entries.at(-1);
      if (entry !== undefined) {
        setWidth(Math.floor(entry.contentRect.width));
      }
    });
    if (element !== null) {
      observer.observe(element);
    }
    return () => {
      observer.disconnect();
    };
  };
  return [width, watch];
};

// ---- ChartBarList -------------------------------------------------------------------------------
//
// Kinds compared as bars laid across, one row each, largest first. Each row's name is read where its
// bar starts, above it, and wraps by the word on a narrow screen, never cut; each value stands at the
// row's end beside its bar. No axis: the words carry the numbers. A second series is drawn muted
// under the first (last year under this year), named on the first row. It is a list: a screen
// reader reads each name and value. With `rowLink` a row's name is a link to the thing it is, each
// a stop for Tab in the rows' order.

/** Every prop a ChartBarList takes. */
export interface ChartBarListProps {
  /** What the chart shows, as a screen reader and an agent say it ("Spend by supplier"). */
  "aria-label": string;
  /** One sentence that says what the numbers mean ("Cloud hosting took a third"). */
  summary: string;
  /** The rows: one object per kind compared. */
  data: readonly Row[];
  /** The key that names each row (a supplier, a team). */
  nameKey: string;
  /** The series drawn, by their key in each row, with their names. The first is the value; a second is drawn muted. */
  config: ChartConfig;
  /**
   * How the first series is filled: `none` in the token colour, or a dither lit at the bar's tip.
   * @default "none"
   */
  pattern?: ChartPattern;
  /**
   * `descending` puts the largest first (by the first series); `none` keeps the rows' own order,
   * for kinds that have one (age bands, stages).
   * @default "descending"
   */
  sortOrder?: "descending" | "none";
  /** Writes a value as people read it ("€12.4k", "−3%"). */
  valueFormatter?: (value: number) => string;
  /**
   * Where a row's name leads, as a link to the thing the row is: its `href` (an address, or a path
   * on this site), or a router's link as `render` (`render: <Link to="/teams/$id" params={…} />`),
   * which takes the name as its words. `href` is checked (`safeHref`, paths on this site allowed):
   * a row it gives nothing, or an address that is not safe, is its name alone. A `render` element
   * is the caller's own and keeps its own address, unchecked.
   */
  rowLink?: (
    row: Readonly<Row>
  ) =>
    | { href?: string; render?: ReactElement<Record<string, unknown>> }
    | undefined;
  /** Layout only: its width and where it sits. */
  style?: LayoutStyle;
}

// A bar's thickness and corner, in CSS pixels: SVG geometry takes numbers. Thinner when a row holds
// two.
const LIST_BAR = 14;
const LIST_BAR_PAIR = 10;
const LIST_CORNER = 2;

// The figure's own width, not the window's: a list or a pie in a narrow column folds as on a phone.
const NARROW = "@container (width < 30rem)";

const grow = stylex.keyframes({
  from: { transform: "scaleX(0)" },
  to: { transform: "scaleX(1)" },
});

const listStyles = stylex.create({
  list: {
    containerType: "inline-size",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    columnGap: space[4],
    rowGap: space[5],
    margin: 0,
    padding: 0,
    listStyle: "none",
    // The rows stand one under another, so a linked name has no control beside it in a row: its
    // finger's target takes its whole width either side, though the row before holds a link too.
    "--tap-room-inline": size.tapTarget,
  },
  row: {
    display: "grid",
    gridColumn: "1 / -1",
    gridTemplateColumns: "subgrid",
    rowGap: space[1],
    alignItems: "center",
  },
  name: {
    gridColumn: "1 / -1",
    color: colors.bodyForeground,
    overflowWrap: "normal",
    wordBreak: "normal",
    textWrap: "pretty",
  },
  // One series: the name beside its value, the bar under both, close to its name.
  single: { rowGap: space[1] },
  nameBeside: { gridColumn: 1 },
  track: {
    gridColumn: 1,
    display: "block",
    width: "100%",
    overflow: "visible",
  },
  trackWide: { gridColumn: "1 / -1" },
  value: {
    gridColumn: 2,
    justifySelf: "end",
    color: colors.foreground,
    fontWeight: font.weightMedium,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  // Beside a pair's bars the value takes no more height than its figures, so the two bars sit close.
  valueTight: { lineHeight: 1 },
  valueMuted: { color: colors.mutedForeground },
  // The series' names on the first row: beside the values on a wide chart, above each bar on a
  // narrow one, where beside them they took the bars' room.
  series: {
    color: colors.mutedForeground,
    fontWeight: font.weightNormal,
    marginInlineEnd: space[2],
    display: { default: "inline", [NARROW]: "none" },
  },
  seriesAbove: {
    gridColumn: "1 / -1",
    color: colors.mutedForeground,
    display: { default: "none", [NARROW]: "block" },
  },
  muted: { fill: { default: colors.chartMutedBg, [FORCED]: "GrayText" } },
  zero: {
    stroke: colors.chartGrid,
    strokeWidth: size.hairline,
    shapeRendering: "crispEdges",
  },
  // The bar grows from zero once, as it arrives; under reduced motion it is simply there.
  grow: (origin: string) => ({
    transformOrigin: origin,
    animationName: { default: grow, [REDUCED]: "none" },
    animationDuration: duration.open,
    animationTimingFunction: duration.ease,
    animationFillMode: "both",
  }),
});

interface MarkProps {
  chart: string;
  clip: string;
  span: Span;
  height: number;
  texture: DitherTexture | null;
  muted: boolean;
}

const Mark = ({ chart, clip, span, height, texture, muted }: MarkProps) => {
  if (span.width <= 0) {
    return null;
  }
  const path = barPath(span, 0, height, LIST_CORNER);
  const outline = (look?: stylex.StyleXStyles) => (
    <path d={path} {...stylex.props(look)} />
  );
  if (texture === null || muted) {
    return outline(muted ? listStyles.muted : markStyles.plain);
  }
  return (
    <DitheredBar
      chart={chart}
      clip={clip}
      texture={texture}
      box={{ x: span.x, y: 0, width: span.width, height }}
      tip={span.rightward ? "right" : "left"}
      outline={outline}
    />
  );
};

interface TrackProps {
  chart: string;
  clip: string;
  value: number;
  extent: { min: number; max: number };
  width: number;
  height: number;
  texture: DitherTexture | null;
  muted: boolean;
  wide: boolean;
  watch: ((element: Element | null) => () => void) | undefined;
}

// One bar on its track, the zero line through the track when some value is below zero.
const Track = ({
  chart,
  clip,
  value,
  extent,
  width,
  height,
  texture,
  muted,
  wide,
  watch,
}: TrackProps) => {
  const span = spanOf(value, extent, width);
  return (
    <svg
      ref={watch}
      aria-hidden="true"
      height={height}
      {...stylex.props(listStyles.track, wide && listStyles.trackWide)}
    >
      {extent.min < 0 && width > 0 && (
        <line
          x1={span.zero + 0.5}
          x2={span.zero + 0.5}
          y1={-2}
          y2={height + 2}
          {...stylex.props(listStyles.zero)}
        />
      )}
      <g {...stylex.props(listStyles.grow(`${span.zero}px 0`))}>
        <Mark
          chart={chart}
          clip={clip}
          span={span}
          height={height}
          texture={texture}
          muted={muted}
        />
      </g>
    </svg>
  );
};

/** A row's name: a link where `rowLink` leads it somewhere safe, else its words. */
const nameOf = (
  row: Row,
  nameKey: string,
  rowLink: ChartBarListProps["rowLink"]
): ReactNode => {
  const name = row[nameKey];
  const to = rowLink?.(row);
  const href = safeHref(to?.href, { relative: true }) ?? undefined;
  if (to?.render === undefined && href === undefined) {
    return name;
  }
  // A link on its own line, Link's `plain`: it also takes a finger's whole target.
  return (
    <Link asChild variant="plain">
      {renderElement("a", { href, children: name }, to?.render)}
    </Link>
  );
};

interface BarRowProps {
  chart: string;
  row: Row;
  index: number;
  nameKey: string;
  keys: readonly string[];
  config: ChartConfig;
  extent: { min: number; max: number };
  width: number;
  texture: DitherTexture | null;
  valueFormatter: (value: number) => string;
  rowLink: ChartBarListProps["rowLink"];
  watch: ((element: Element | null) => () => void) | undefined;
}

const BarRow = ({
  chart,
  row,
  index,
  nameKey,
  keys,
  config,
  extent,
  width,
  texture,
  valueFormatter,
  rowLink,
  watch,
}: BarRowProps) => {
  const [first = ""] = keys;
  const track = { chart, extent, width, texture };
  const name = nameOf(row, nameKey, rowLink);
  // One series: the name and the value on one line, the bar under them across the whole row.
  if (keys.length < 2) {
    return (
      <li {...stylex.props(listStyles.row, listStyles.single)}>
        <span {...stylex.props(listStyles.name, listStyles.nameBeside)}>
          {name}
        </span>
        <span {...stylex.props(listStyles.value)}>
          {valueFormatter(valueOf(row, first))}
        </span>
        <Track
          {...track}
          clip={`${chart}-${index}`}
          value={valueOf(row, first)}
          height={LIST_BAR}
          muted={false}
          wide
          watch={index === 0 ? watch : undefined}
        />
      </li>
    );
  }
  // Two: the name, then each bar with its value at the row's end. The first row names the series
  // where the eye starts; a screen reader hears them on every row.
  return (
    <li {...stylex.props(listStyles.row)}>
      <span {...stylex.props(listStyles.name)}>{name}</span>
      {keys.map((key, place) => (
        <Fragment key={key}>
          {/* On a narrow chart the first row names each bar above it, so the names never squeeze the bars. */}
          {index === 0 && (
            <span {...stylex.props(listStyles.seriesAbove)}>
              {config[key]?.label ?? key}
            </span>
          )}
          <Track
            {...track}
            clip={`${chart}-${index}-${key}`}
            value={valueOf(row, key)}
            height={LIST_BAR_PAIR}
            muted={place > 0}
            wide={false}
            watch={index === 0 && place === 0 ? watch : undefined}
          />
          <span
            {...stylex.props(
              listStyles.value,
              listStyles.valueTight,
              place > 0 && listStyles.valueMuted
            )}
          >
            <span
              {...stylex.props(
                index === 0 ? listStyles.series : visuallyHidden
              )}
            >
              {config[key]?.label ?? key}
            </span>
            {valueFormatter(valueOf(row, key))}
          </span>
        </Fragment>
      ))}
    </li>
  );
};

/** Kinds compared as bars laid across, a list of names and values. */
export const ChartBarList = ({
  "aria-label": label,
  summary,
  data,
  nameKey,
  config,
  pattern = "none",
  sortOrder = "descending",
  valueFormatter = plainNumber,
  rowLink,
  style,
}: ChartBarListProps) => {
  const chart = useChartId();
  const keys = Object.keys(config).slice(0, 2);
  const [first = ""] = keys;
  const rows = orderRows(data, first, sortOrder);
  const rowIds = rowKeys(rows, nameKey);
  const extent = extentOf(rows, keys);
  const [width, watch] = useWidth();
  const texture = textureOf(pattern);
  return (
    <figure
      aria-labelledby={`${chart}-label`}
      data-slot="chart-bar-list"
      {...stylex.props(figureStyles.figure, style)}
    >
      <Caption id={`${chart}-label`} label={label} summary={summary} />
      {/* The patterns, once, in a drawing of their own that takes no room. */}
      <svg
        aria-hidden="true"
        width={0}
        height={0}
        {...stylex.props(visuallyHidden)}
      >
        <ChartPatterns id={chart} />
      </svg>
      <ol {...stylex.props(listStyles.list)}>
        {rows.map((row, index) => (
          <BarRow
            key={rowIds[index]}
            chart={chart}
            row={row}
            index={index}
            nameKey={nameKey}
            keys={keys}
            config={config}
            extent={extent}
            width={width}
            texture={texture}
            valueFormatter={valueFormatter}
            rowLink={rowLink}
            watch={watch}
          />
        ))}
      </ol>
    </figure>
  );
};

// ---- ChartPie -----------------------------------------------------------------------------------
//
// Parts of a whole as a ring, a figure in its centre. Each part is one series of the config, in
// order round from twelve o'clock, with a clear gap between. The first is the value colour (or its
// dither, lit at the outer edge); the rest step down the chart tones. The names live in a quiet list
// (key, name, value, share), never hung round the ring: beside it, its middle on the ring's middle,
// or under it on a narrow chart. Hover or focus a part: it lifts a little and the centre says it;
// nothing else steps back. One share (62% of a target) is its simplest form: one value and a
// `total` it is part of.

/** Every prop a ChartPie takes. */
export interface ChartPieProps {
  /** What the pie shows, as a screen reader and an agent say it ("October's invoices"). */
  "aria-label": string;
  /** One sentence that says what the parts mean ("Two in three matched themselves"). */
  summary: string;
  /** Each part's value, by its key in the config, in the order they go round. */
  values: Readonly<Record<string, number>>;
  /** The parts, by key, with their names. Five at most: past that, use bars across. */
  config: ChartConfig;
  /** The one line of words under the centre's figure ("invoices in October"). */
  caption: string;
  /** For one share: the total it is part of (100, a target). The rest of the ring is an empty track. */
  total?: number;
  /**
   * How the first part is filled: `none` in the value colour, or a dither lit at its outer edge.
   * @default "none"
   */
  pattern?: ChartPattern;
  /** Writes a value as people read it ("812", "€12.4k"). */
  valueFormatter?: (value: number) => string;
  /** Writes a share as people read it ("62%"). */
  percentFormatter?: (share: number) => string;
  /** Layout only: its width and where it sits. */
  style?: LayoutStyle;
}

// The ring's size, its thickness, the gap between parts, a part's lift and the dither's cap, in CSS
// pixels: SVG geometry.
const PIE_OUTER = 96;
const PIE_THICK = 20;
const PIE_GAP = 3;
const PIE_LIFT = 4;
const PIE_CAP = 2;
// The gap between parts, as an angle on the ring's middle.
const PIE_GAP_ANGLE = PIE_GAP / (PIE_OUTER - PIE_THICK / 2);

const pieStyles = stylex.create({
  // The pie's own width decides how it folds, not the window's.
  room: { containerType: "inline-size", minWidth: 0 },
  box: {
    display: "grid",
    gridTemplateColumns: {
      default: "auto minmax(0, 1fr)",
      [NARROW]: "minmax(0, 1fr)",
    },
    alignItems: "center",
    justifyItems: { default: "start", [NARROW]: "center" },
    columnGap: space[8],
    rowGap: space[5],
  },
  boxAlone: { gridTemplateColumns: "minmax(0, 1fr)", justifyItems: "stretch" },
  stack: { display: "grid", placeItems: "center", minWidth: 0, width: "100%" },
  drawing: {
    gridArea: "1 / 1",
    display: "block",
    overflow: "visible",
    maxWidth: "100%",
  },
  centre: {
    gridArea: "1 / 1",
    display: "grid",
    justifyItems: "center",
    rowGap: space[1],
    maxWidth: (PIE_OUTER - PIE_THICK) * 1.7,
    textAlign: "center",
    pointerEvents: "none",
  },
  figure: {
    color: colors.foreground,
    fontSize: font.headingMd,
    lineHeight: font.headingMdLine,
    fontWeight: font.weightMedium,
    fontVariantNumeric: "tabular-nums",
    letterSpacing: font.trackingTitle,
  },
  caption: { color: colors.mutedForeground, textWrap: "balance" },
  part: {
    cursor: "default",
    outline: "none",
    transitionProperty: "transform, opacity",
    transitionDuration: motionVars.hover,
    transitionTimingFunction: duration.ease,
    stroke: { default: "transparent", ":focus-visible": colors.ring },
    strokeWidth: size.ringWidth,
  },
  lift: (x: number, y: number) => ({ transform: `translate(${x}px, ${y}px)` }),
  // The row of the part under the pointer or the keys: its name in ink. Nothing else dims.
  rowActive: { color: colors.foreground },
  // A share's empty track: muted, as it is no part.
  track: {
    fill: { default: colors.chartMutedBg, [FORCED]: "GrayText" },
  },
  cap: {
    fill: "none",
    stroke: { default: colors.chart1, [FORCED]: "CanvasText" },
  },
  list: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr) auto auto",
    columnGap: space[3],
    rowGap: space[2],
    alignItems: "baseline",
    margin: 0,
    padding: 0,
    listStyle: "none",
    minWidth: 0,
    width: "100%",
    maxWidth: 360,
  },
  row: {
    display: "grid",
    gridColumn: "1 / -1",
    gridTemplateColumns: "subgrid",
    transitionProperty: "opacity",
    transitionDuration: motionVars.hover,
  },
  swatch: { alignSelf: "center" },
  rowName: { color: colors.bodyForeground, minWidth: 0 },
  rowValue: {
    color: colors.foreground,
    fontWeight: font.weightMedium,
    fontVariantNumeric: "tabular-nums",
    textAlign: "end",
  },
  rowShare: {
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
    textAlign: "end",
    minWidth: "4ch",
  },
});

interface Part {
  key: string;
  name: string;
  value: number;
  arc: Arc;
}

// The dither on the first part: rings of density from its outer edge (lit) in to its inner edge,
// clipped to the part, with a solid cap along the outer edge saying where it ends.
const DitherArc = ({
  chart,
  clip,
  texture,
  cx,
  cy,
  d,
}: {
  chart: string;
  clip: string;
  texture: DitherTexture;
  cx: number;
  cy: number;
  d: string;
}) => {
  const edges = ditherEdges(
    PIE_OUTER,
    PIE_OUTER - PIE_THICK,
    DITHER_GEOMETRY[texture].pitch
  );
  return (
    <>
      <clipPath id={clip}>
        <path d={d} />
      </clipPath>
      <g clipPath={`url(#${clip})`} {...stylex.props(maskStyles.dither)}>
        {edges.slice(0, -1).map((from, index) => {
          const to = edges[index + 1] ?? from;
          return from > to ? (
            <circle
              key={index}
              cx={cx}
              cy={cy}
              r={(from + to) / 2}
              strokeWidth={from - to}
              fill="none"
              stroke={`url(#${patternId(chart, texture, DITHER_LEVELS - index)})`}
              {...stylex.props(patternStyles.crisp)}
            />
          ) : null;
        })}
        <circle
          cx={cx}
          cy={cy}
          r={PIE_OUTER - PIE_CAP / 2}
          strokeWidth={PIE_CAP}
          {...stylex.props(pieStyles.cap)}
        />
      </g>
    </>
  );
};

interface PieDrawingProps {
  chart: string;
  parts: readonly Part[];
  total: number | undefined;
  side: number;
  texture: DitherTexture | null;
  active: number | null;
  setActive: (index: number | null) => void;
  said: (part: Part) => string;
}

const PieDrawing = ({
  chart,
  parts,
  total,
  side,
  texture,
  active,
  setActive,
  said,
}: PieDrawingProps) => {
  const centre = side / 2;
  const rest =
    total === undefined
      ? null
      : restOf(
          parts.map((part) => part.arc),
          PIE_GAP_ANGLE
        );
  return (
    <svg width={side} height={side} {...stylex.props(pieStyles.drawing)}>
      <ChartPatterns id={chart} />
      {rest !== null && (
        <path
          aria-hidden="true"
          d={arcPath(
            centre,
            centre,
            PIE_OUTER,
            PIE_OUTER - PIE_THICK,
            rest.from,
            rest.to
          )}
          {...stylex.props(pieStyles.track)}
        />
      )}
      <g>
        {parts.map((part, index) => {
          const d = arcPath(
            centre,
            centre,
            PIE_OUTER,
            PIE_OUTER - PIE_THICK,
            part.arc.from,
            part.arc.to
          );
          const lifted = pointAt(
            0,
            0,
            active === index ? PIE_LIFT : 0,
            part.arc.middle
          );
          return (
            <g
              key={part.key}
              role="graphics-symbol"
              tabIndex={0}
              aria-label={said(part)}
              data-part={part.key}
              onPointerEnter={() => {
                setActive(index);
              }}
              onPointerLeave={() => {
                setActive(null);
              }}
              onFocus={() => {
                setActive(index);
              }}
              onBlur={() => {
                setActive(null);
              }}
              {...stylex.props(
                pieStyles.part,
                pieStyles.lift(lifted.x, lifted.y)
              )}
            >
              <path d={d} {...stylex.props(toneStyles.fill(toneOf(index)))} />
              {index === 0 && texture !== null && (
                <DitherArc
                  chart={chart}
                  clip={`${chart}-arc`}
                  texture={texture}
                  cx={centre}
                  cy={centre}
                  d={d}
                />
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
};

// The quiet list beside the ring: each part's swatch, name, value and share.
const PieList = ({
  parts,
  active,
  setActive,
  valueFormatter,
  percentFormatter,
}: {
  parts: readonly Part[];
  active: number | null;
  setActive: (index: number | null) => void;
  valueFormatter: (value: number) => string;
  percentFormatter: (share: number) => string;
}) => (
  <ul aria-hidden="true" {...stylex.props(pieStyles.list)}>
    {parts.map((part, index) => (
      <li
        key={part.key}
        onPointerEnter={() => {
          setActive(index);
        }}
        onPointerLeave={() => {
          setActive(null);
        }}
        {...stylex.props(pieStyles.row)}
      >
        <span
          {...stylex.props(
            toneStyles.swatch,
            pieStyles.swatch,
            toneStyles.background(toneOf(index))
          )}
        />
        <span
          {...stylex.props(
            pieStyles.rowName,
            active === index && pieStyles.rowActive
          )}
        >
          {part.name}
        </span>
        <span {...stylex.props(pieStyles.rowValue)}>
          {valueFormatter(part.value)}
        </span>
        <span {...stylex.props(pieStyles.rowShare)}>
          {percentFormatter(part.arc.share)}
        </span>
      </li>
    ))}
  </ul>
);

/** The parts, from the config's order (five at most) and their values. */
const partsOf = (
  config: ChartConfig,
  values: Readonly<Record<string, number>>,
  total: number | undefined
): Part[] => {
  const keys = Object.keys(config).slice(0, 5);
  const arcs = arcsOf(
    keys.map((key) => ownValue(values, key) ?? 0),
    PIE_GAP_ANGLE,
    total
  );
  return keys.map((key, index) => ({
    key,
    name: config[key]?.label ?? key,
    value: ownValue(values, key) ?? 0,
    arc: arcs[index] ?? { from: 0, to: 0, middle: 0, share: 0 },
  }));
};

/** What the centre says: the part under the pointer or the keys, else the sum (or the one share) and the caption. */
const centreOf = (
  parts: readonly Part[],
  shown: Part | undefined,
  total: number | undefined,
  caption: string,
  valueFormatter: (value: number) => string,
  percentFormatter: (share: number) => string,
  partShare: (name: string, share: string) => string
) => {
  if (shown !== undefined) {
    return {
      figure: valueFormatter(shown.value),
      words: partShare(shown.name, percentFormatter(shown.arc.share)),
    };
  }
  const sum = parts.reduce((all, part) => all + part.value, 0);
  const figure =
    total === undefined
      ? valueFormatter(sum)
      : percentFormatter(parts[0]?.arc.share ?? 0);
  return { figure, words: caption };
};

/** Parts of a whole as a ring, its sum in its centre. */
export const ChartPie = ({
  "aria-label": label,
  summary,
  values,
  config,
  caption,
  total,
  pattern = "none",
  valueFormatter = plainNumber,
  percentFormatter = plainPercent,
  style,
}: ChartPieProps) => {
  const chart = useChartId();
  const { chart: say } = useI18n();
  const parts = partsOf(config, values, total);
  const [active, setActive] = useState<number | null>(null);
  const said = (part: Part) =>
    say.part(
      part.name,
      valueFormatter(part.value),
      percentFormatter(part.arc.share)
    );
  const { figure, words } = centreOf(
    parts,
    active === null ? undefined : parts[active],
    total,
    caption,
    valueFormatter,
    percentFormatter,
    say.partShare
  );
  return (
    <figure
      aria-labelledby={`${chart}-label`}
      data-slot="chart-pie"
      {...stylex.props(figureStyles.figure, style)}
    >
      <Caption id={`${chart}-label`} label={label} summary={summary} />
      <div {...stylex.props(pieStyles.room)}>
        <div
          {...stylex.props(
            pieStyles.box,
            parts.length < 2 && pieStyles.boxAlone
          )}
        >
          <div {...stylex.props(pieStyles.stack)}>
            <PieDrawing
              chart={chart}
              parts={parts}
              total={total}
              // The ring and room for a part's lift.
              side={2 * (PIE_OUTER + PIE_LIFT + 2)}
              texture={textureOf(pattern)}
              active={active}
              setActive={setActive}
              said={said}
            />
            <div {...stylex.props(pieStyles.centre)}>
              <span {...stylex.props(pieStyles.figure)}>{figure}</span>
              <span {...stylex.props(pieStyles.caption)}>{words}</span>
            </div>
          </div>
          {parts.length > 1 && (
            <PieList
              parts={parts}
              active={active}
              setActive={setActive}
              valueFormatter={valueFormatter}
              percentFormatter={percentFormatter}
            />
          )}
        </div>
      </div>
    </figure>
  );
};

// ---- ChartSankey --------------------------------------------------------------------------------
//
// How a whole moves between stages: nodes in columns, each as tall as what passes through it, and
// flows as ribbons whose thickness is their value. Each node is named beside it with its value;
// hover or focus a flow and the whole path through it lights while the rest steps back, with its
// value and its share of where it came from, said in a line under the drawing. The ribbons draw in
// from left to right once, as it arrives (still under reduced motion). On a narrow screen (under
// 32rem of its own width) the flows turn into a list by stage, each with a bar of its share. The
// layout is its own (chart-math.ts): columns by longest path, nodes ordered to cut crossings.

/** What a flow is called for a screen reader: its ends, its value and its share of its source. */
export interface ChartSankeyFlow {
  source: string;
  target: string;
  value: string;
  share: string;
}

/** Every prop a ChartSankey takes. */
export interface ChartSankeyProps {
  /** What it shows, as a screen reader and an agent say it ("Where October's invoices went"). */
  "aria-label": string;
  /** One sentence that says what the flows mean ("Nine in ten were paid; 61 are disputed"). */
  summary: string;
  /** The stages' nodes: an id, the name read beside it, and `muted` for an end not hoped for. */
  nodes: readonly ChartSankeyNode[];
  /** The flows between them, by id, with their values. */
  links: readonly ChartSankeyLink[];
  /**
   * How the nodes are filled: `none` in the value colour, or a dither lit at the top.
   * @default "none"
   */
  pattern?: ChartPattern;
  /**
   * How tall the drawing is, in CSS pixels.
   * @default 360
   */
  height?: number;
  /** Writes a value as people read it ("1,217", "€12.4k"). */
  valueFormatter?: (value: number) => string;
  /** Writes a share as people read it ("67%"). */
  percentFormatter?: (share: number) => string;
  /** Layout only: its width and where it sits. */
  style?: LayoutStyle;
}

// A node's width, the room between two nodes in a column, between a node and its name, the width
// under which it turns into a list, and a name's line, in CSS pixels: SVG geometry and a measure.
const NODE = 12;
const NODE_PADDING = 40;
const NODE_SPACE = 8;
const SANKEY_NARROW = 512;
const NAME_LINE = 16;

const draw = stylex.keyframes({
  from: { transform: "scaleX(0)" },
  to: { transform: "scaleX(1)" },
});

const sankeyStyles = stylex.create({
  box: { position: "relative", minWidth: 0 },
  drawing: { display: "block", overflow: "visible" },
  // The arrival: one quiet draw from left to right, the light's one longer move; none when reduced.
  arrive: {
    transformOrigin: "0 0",
    animationName: { default: draw, [REDUCED]: "none" },
    animationDuration: duration.arrive,
    animationTimingFunction: duration.ease,
    animationFillMode: "both",
  },
  flow: {
    outline: "none",
    stroke: { default: "transparent", ":focus-visible": colors.ring },
    strokeWidth: size.ringWidth,
    transitionProperty: "opacity",
    transitionDuration: motionVars.hover,
  },
  back: { opacity: STEP_BACK },
  rest: { stopColor: colors.chartRibbon },
  restMuted: { stopColor: colors.chartRibbonMuted },
  lit: { stopColor: colors.chartRibbonLit },
  litMuted: { stopColor: colors.chartMutedBg },
  forced: { fill: { default: null, [FORCED]: "GrayText" } },
  node: { fill: { default: colors.chartPlain, [FORCED]: "CanvasText" } },
  nodeMuted: {
    fill: { default: colors.chartNodeMuted, [FORCED]: "GrayText" },
  },
  name: {
    fill: colors.bodyForeground,
    fontFamily: font.sans,
    fontSize: font.textXs,
  },
  value: { fill: colors.mutedForeground, fontVariantNumeric: "tabular-nums" },
  // A name on ribbons: the full ink for both its lines, which holds 4.5:1 on a ribbon at rest, lit
  // or stepped back, in light and dark.
  onRibbon: { fill: { default: colors.foreground, [FORCED]: "CanvasText" } },
  // The names lie over the ribbons; the pointer goes through them to the flow beneath.
  names: { pointerEvents: "none" },
  readout: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: space[3],
    minHeight: font.textXsLine,
    marginBlockStart: space[3],
  },
  readFlow: { color: colors.foreground, fontWeight: font.weightMedium },
  readValue: { color: colors.foreground, fontVariantNumeric: "tabular-nums" },
  readShare: {
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
  },
  // The list on a narrow screen.
  list: {
    display: "grid",
    rowGap: space[5],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  stage: { display: "grid", rowGap: space[2] },
  stageHead: {
    display: "flex",
    justifyContent: "space-between",
    gap: space[3],
    color: colors.foreground,
    fontWeight: font.weightMedium,
  },
  rows: {
    display: "grid",
    rowGap: space[2],
    margin: 0,
    paddingInlineStart: space[3],
    listStyle: "none",
    borderInlineStartWidth: 1,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: colors.border,
  },
  row: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    columnGap: space[3],
    rowGap: space[1],
  },
  rowName: { color: colors.bodyForeground, overflowWrap: "normal" },
  rowValue: {
    color: colors.foreground,
    fontVariantNumeric: "tabular-nums",
    textAlign: "end",
  },
  share: { color: colors.mutedForeground, marginInlineStart: space[2] },
  track: {
    display: "block",
    gridColumn: "1 / -1",
    height: space[1],
    borderRadius: radius.full,
    backgroundColor: colors.chart5,
    overflow: "hidden",
  },
  bar: (share: number) => ({
    display: "block",
    width: `${Math.round(share * 1000) / 10}%`,
    height: "100%",
    borderRadius: radius.full,
  }),
  barTone: {
    backgroundColor: { default: colors.chartPlain, [FORCED]: "CanvasText" },
  },
  barMuted: {
    backgroundColor: { default: colors.chartMuted, [FORCED]: "GrayText" },
  },
});

// A node: plain, or its dither lit at the top, in a column.
const SankeyNodeMark = ({
  chart,
  node,
  texture,
}: {
  chart: string;
  node: PlacedNode;
  texture: DitherTexture | null;
}) => {
  const look = node.muted === true ? sankeyStyles.nodeMuted : sankeyStyles.node;
  const box = { x: node.x, y: node.y, width: NODE, height: node.height, rx: 1 };
  if (texture === null || node.muted === true) {
    return <rect data-node={node.id} {...box} {...stylex.props(look)} />;
  }
  const clip = `${chart}-node-${node.id}`;
  return (
    <g data-node={node.id}>
      <clipPath id={clip}>
        <rect {...box} />
      </clipPath>
      <rect {...box} {...stylex.props(look)} />
      <g clipPath={`url(#${clip})`} {...stylex.props(maskStyles.dither)}>
        <DitherBands
          chart={chart}
          texture={texture}
          axis="y"
          lit={node.y}
          floor={node.y + node.height}
          start={node.x}
          breadth={NODE}
        />
      </g>
    </g>
  );
};

// Each node's name and value beside it: to the left of the first column, to the right of every
// other. In the columns between, a name stands on its node's own ribbons (the gap above a node was
// tried: ribbons arriving from above ran through it), so both its lines take the full ink.
const SankeyNames = ({
  nodes,
  columns,
  valueFormatter,
}: {
  nodes: readonly PlacedNode[];
  columns: number;
  valueFormatter: (value: number) => string;
}) => (
  <g aria-hidden="true" {...stylex.props(sankeyStyles.names)}>
    {nodes.map((node) => {
      const first = node.column === 0 && columns > 1;
      const between = !first && node.column < columns - 1;
      const x = first ? node.x - NODE_SPACE : node.x + NODE + NODE_SPACE;
      const middle = node.y + node.height / 2;
      return (
        <text
          key={node.id}
          data-name={node.id}
          x={x}
          y={middle - NAME_LINE / 2 + 4}
          textAnchor={first ? "end" : "start"}
          {...stylex.props(sankeyStyles.name, between && sankeyStyles.onRibbon)}
        >
          <tspan x={x}>{node.label}</tspan>
          <tspan
            x={x}
            dy={NAME_LINE}
            {...stylex.props(
              sankeyStyles.value,
              between && sankeyStyles.onRibbon
            )}
          >
            {valueFormatter(node.value)}
          </tspan>
        </text>
      );
    })}
  </g>
);

interface FlowsProps {
  chart: string;
  links: readonly PlacedLink[];
  nodes: ReadonlyMap<string, PlacedNode>;
  lit: ReadonlySet<number> | null;
  say: (link: PlacedLink) => string;
  setActive: (link: number | null) => void;
}

// The ribbons, each a gradient from its source's tone to its target's, focusable and named.
const Flows = ({ chart, links, nodes, lit, say, setActive }: FlowsProps) => (
  <g>
    {links.map((link) => {
      const on = lit?.has(link.index) === true;
      const tone = (id: string) => {
        const muted = nodes.get(id)?.muted === true;
        if (on) {
          return muted ? sankeyStyles.litMuted : sankeyStyles.lit;
        }
        return muted ? sankeyStyles.restMuted : sankeyStyles.rest;
      };
      const gradient = `${chart}-flow-${link.index}`;
      const show = () => {
        setActive(link.index);
      };
      const hide = () => {
        setActive(null);
      };
      return (
        <g key={link.index}>
          <linearGradient
            id={gradient}
            gradientUnits="userSpaceOnUse"
            x1={link.x0}
            x2={link.x1}
            y1={0}
            y2={0}
          >
            <stop offset="0" {...stylex.props(tone(link.source))} />
            <stop offset="1" {...stylex.props(tone(link.target))} />
          </linearGradient>
          <path
            role="graphics-symbol"
            tabIndex={0}
            aria-label={say(link)}
            data-flow={`${link.source}-${link.target}`}
            d={ribbonPath(link)}
            fill={`url(#${gradient})`}
            onPointerEnter={show}
            onPointerLeave={hide}
            onFocus={show}
            onBlur={hide}
            {...stylex.props(
              sankeyStyles.flow,
              sankeyStyles.forced,
              lit !== null && !on && sankeyStyles.back
            )}
          />
        </g>
      );
    })}
  </g>
);

// The flows as a list by stage, for a narrow screen: each node with where its flows go.
const FlowList = ({
  nodes,
  links,
  valueFormatter,
  percentFormatter,
}: {
  nodes: readonly ChartSankeyNode[];
  links: readonly ChartSankeyLink[];
  valueFormatter: (value: number) => string;
  percentFormatter: (share: number) => string;
}) => {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const sources = nodes.filter((node) =>
    links.some((link) => link.source === node.id)
  );
  return (
    <ul {...stylex.props(sankeyStyles.list)}>
      {sources.map((node) => {
        const out = links
          .filter((link) => link.source === node.id)
          .toSorted((a, b) => b.value - a.value);
        const sum = out.reduce((all, link) => all + link.value, 0);
        return (
          <li key={node.id} {...stylex.props(sankeyStyles.stage)}>
            <span {...stylex.props(sankeyStyles.stageHead)}>
              <span>{node.label}</span>
              <span>{valueFormatter(sum)}</span>
            </span>
            <ul {...stylex.props(sankeyStyles.rows)}>
              {out.map((link) => {
                const target = byId.get(link.target);
                const share = sum > 0 ? link.value / sum : 0;
                return (
                  <li key={link.target} {...stylex.props(sankeyStyles.row)}>
                    <span {...stylex.props(sankeyStyles.rowName)}>
                      {target?.label ?? link.target}
                    </span>
                    <span {...stylex.props(sankeyStyles.rowValue)}>
                      {valueFormatter(link.value)}
                      <span {...stylex.props(sankeyStyles.share)}>
                        {percentFormatter(share)}
                      </span>
                    </span>
                    <span
                      aria-hidden="true"
                      {...stylex.props(sankeyStyles.track)}
                    >
                      <span
                        {...stylex.props(
                          sankeyStyles.bar(share),
                          target?.muted === true
                            ? sankeyStyles.barMuted
                            : sankeyStyles.barTone
                        )}
                      />
                    </span>
                  </li>
                );
              })}
            </ul>
          </li>
        );
      })}
    </ul>
  );
};

interface SankeyWords {
  valueFormatter: (value: number) => string;
  percentFormatter: (share: number) => string;
  shareOf: (share: string, source: string) => string;
  flow: (source: string, target: string) => string;
}

/** A flow's share of its source, written. */
const shareWords = (
  link: PlacedLink,
  source: PlacedNode | undefined,
  words: SankeyWords
) =>
  words.percentFormatter(
    source !== undefined && source.value > 0 ? link.value / source.value : 0
  );

// What the pointer or the keys are on, said in one line under the drawing, where it covers
// nothing: the flow, its value and its share of where it came from. Its room is kept when nothing
// is lit, so nothing moves as it fills.
const Readout = ({
  link,
  nodes,
  words,
}: {
  link: PlacedLink | undefined;
  nodes: ReadonlyMap<string, PlacedNode>;
  words: SankeyWords;
}) => {
  if (link === undefined) {
    return (
      <div
        aria-hidden="true"
        data-slot="chart-sankey-readout"
        {...stylex.props(sankeyStyles.readout)}
      />
    );
  }
  const source = nodes.get(link.source);
  const target = nodes.get(link.target);
  return (
    <div
      aria-hidden="true"
      data-slot="chart-sankey-readout"
      {...stylex.props(sankeyStyles.readout)}
    >
      <span {...stylex.props(sankeyStyles.readFlow)}>
        {words.flow(source?.label ?? link.source, target?.label ?? link.target)}
      </span>
      <span {...stylex.props(sankeyStyles.readValue)}>
        {words.valueFormatter(link.value)}
      </span>
      <span {...stylex.props(sankeyStyles.readShare)}>
        {words.shareOf(
          shareWords(link, source, words),
          source?.label ?? link.source
        )}
      </span>
    </div>
  );
};

interface SankeyDrawingProps {
  chart: string;
  width: number;
  height: number;
  layout: SankeyLayout | null;
  byId: ReadonlyMap<string, PlacedNode>;
  lit: ReadonlySet<number> | null;
  say: (link: PlacedLink) => string;
  setActive: (link: number | null) => void;
  texture: DitherTexture | null;
  valueFormatter: (value: number) => string;
}

// The drawing: the flows and nodes drawn in from left to right as it arrives, the names beside.
const SankeyDrawing = ({
  chart,
  width,
  height,
  layout,
  byId,
  lit,
  say,
  setActive,
  texture,
  valueFormatter,
}: SankeyDrawingProps) => (
  <svg width={width} height={height} {...stylex.props(sankeyStyles.drawing)}>
    <ChartPatterns id={chart} />
    <clipPath id={`${chart}-arrive`}>
      <rect
        x={0}
        y={-4}
        width={width}
        height={height + 8}
        {...stylex.props(sankeyStyles.arrive)}
      />
    </clipPath>
    {layout !== null && (
      <>
        <g clipPath={`url(#${chart}-arrive)`}>
          <Flows
            chart={chart}
            links={layout.links}
            nodes={byId}
            lit={lit}
            say={say}
            setActive={setActive}
          />
          <g aria-hidden="true">
            {layout.nodes.map((node) => (
              <SankeyNodeMark
                key={node.id}
                chart={chart}
                node={node}
                texture={texture}
              />
            ))}
          </g>
        </g>
        <SankeyNames
          nodes={layout.nodes}
          columns={layout.columns}
          valueFormatter={valueFormatter}
        />
      </>
    )}
  </svg>
);

/**
 * The room beside the first and last columns for their nodes' names and values, as this engine
 * draws them in their own type.
 */
const useSankeyRoom = (
  nodes: readonly ChartSankeyNode[],
  links: readonly ChartSankeyLink[],
  valueFormatter: (value: number) => string
) => {
  const through = valuesOf(nodes, links);
  const starts = nodes.filter(
    (node) => !links.some((link) => link.target === node.id)
  );
  const ends = nodes.filter(
    (node) => !links.some((link) => link.source === node.id)
  );
  const sides = [...starts, ...ends];
  const names = useTextBoxes(
    sides.map((node) => node.label),
    className(sankeyStyles.name)
  );
  const values = useTextBoxes(
    sides.map((node) => valueFormatter(through.get(node.id) ?? 0)),
    className(sankeyStyles.name, sankeyStyles.value)
  );
  const roomFor = (from: number, to: number) =>
    Math.max(
      0,
      ...[...names.slice(from, to), ...values.slice(from, to)].map(
        (box) => box.width
      )
    ) +
    NODE_SPACE +
    2;
  return {
    left: roomFor(0, starts.length),
    right: roomFor(starts.length, sides.length),
  };
};

/** How a whole moves between stages, as ribbons between nodes. */
export const ChartSankey = ({
  "aria-label": label,
  summary,
  nodes,
  links,
  pattern = "none",
  height = 360,
  valueFormatter = plainNumber,
  percentFormatter = plainPercent,
  style,
}: ChartSankeyProps) => {
  const chart = useChartId();
  const { chart: said } = useI18n();
  const [width, watch] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const room = useSankeyRoom(nodes, links, valueFormatter);
  const words: SankeyWords = {
    valueFormatter,
    percentFormatter,
    shareOf: said.shareOf,
    flow: said.flow,
  };
  const narrow = width > 0 && width < SANKEY_NARROW;
  const layout =
    width > 0 && !narrow
      ? layoutSankey(nodes, links, {
          left: room.left,
          right: width - room.right,
          top: 4,
          bottom: height - 4,
          nodeWidth: NODE,
          padding: NODE_PADDING,
        })
      : null;
  const byId = new Map((layout?.nodes ?? []).map((node) => [node.id, node]));
  const shown =
    active === null || layout === null ? undefined : layout.links[active];
  const lit =
    shown === undefined || layout === null
      ? null
      : pathThrough(layout.links, shown);
  // How a screen reader says a flow: its ends, its value and its share of its source.
  const say = (link: PlacedLink) => {
    const source = byId.get(link.source);
    return said.flowLabel({
      source: source?.label ?? link.source,
      target: byId.get(link.target)?.label ?? link.target,
      value: valueFormatter(link.value),
      share: said.shareOf(
        shareWords(link, source, words),
        source?.label ?? link.source
      ),
    });
  };
  return (
    <figure
      aria-labelledby={`${chart}-label`}
      data-slot="chart-sankey"
      {...stylex.props(figureStyles.figure, style)}
    >
      <Caption id={`${chart}-label`} label={label} summary={summary} />
      <div ref={watch} {...stylex.props(sankeyStyles.box)}>
        {narrow ? (
          <FlowList
            nodes={nodes}
            links={links}
            valueFormatter={valueFormatter}
            percentFormatter={percentFormatter}
          />
        ) : (
          <>
            <SankeyDrawing
              chart={chart}
              width={width}
              height={height}
              layout={layout}
              byId={byId}
              lit={lit}
              say={say}
              setActive={setActive}
              texture={textureOf(pattern)}
              valueFormatter={valueFormatter}
            />
            <Readout link={shown} nodes={byId} words={words} />
          </>
        )}
      </div>
    </figure>
  );
};

// ---- ChartSparkline -----------------------------------------------------------------------------
//
// A trend small enough to sit beside its number: in a table cell, on a line of text, or under a
// stat's figure. A line in the value colour, a soft area under it if asked, and at most one marked
// point (the last, the lowest or the highest). No axis, no grid, no words inside: the number beside
// it says the value, and its name and summary say the trend to a screen reader.
//
// It is drawn on the server as on the client, with no measuring: the drawing is 100 units wide and
// stretches across its box, its strokes keep their width (non-scaling), and its points are round
// caps on paths of no length, so they stay round however it stretches. No dither: at this size its
// bands would be two or three pixels tall, noise rather than light. No draw-in: many sparklines
// arriving at once would be the page popping in. At the large size, given `onHighlightChange`, the
// pointer or the arrow keys pick a point and the caller shows it in its own figure; never a tooltip.

/** Every prop a ChartSparkline takes. */
export interface ChartSparklineProps {
  /** What it shows, as a screen reader and an agent say it ("Revenue, last 12 weeks"). */
  "aria-label": string;
  /** The trend in one short sentence ("Up 8%", "Down from 52 to 47 days"). */
  summary: string;
  /** The values, oldest first. One value, or all alike, draws a straight line. */
  values: readonly number[];
  /**
   * `default` sits on a line of text (20px tall, 80px wide unless its style says otherwise); `lg`
   * stands under a stat's figure (44px tall, as wide as its box).
   * @default "default"
   */
  size?: "default" | "lg";
  /**
   * `default` in the value colour, or `muted` for a comparison: last year's, another team's.
   * @default "default"
   */
  variant?: "default" | "muted";
  /**
   * A soft area under the line.
   * @default false
   */
  area?: boolean;
  /**
   * The one point marked with a dot: the `last`, the lowest (`min`) or the highest (`max`).
   * @default "none"
   */
  showHighlight?: "none" | "last" | "min" | "max";
  /**
   * At the `lg` size: called with the point under the pointer or the arrow keys, and null when
   * none, so the caller's figure can say it. Without it the sparkline is a picture, not a control.
   */
  onHighlightChange?: (index: number | null) => void;
  /** Each point's name, as a screen reader says it when the arrow keys reach it ("Week 7"). */
  pointLabels?: readonly string[];
  /** Writes a value as people read it, for a screen reader at the `lg` size ("€12.4k"). */
  valueFormatter?: (value: number) => string;
  /** Layout only: its width and where it sits. */
  style?: LayoutStyle;
}

// Each size's height, line width, dot and the room kept at the top and bottom so a dot is never
// cut, in CSS pixels: SVG geometry.
const SPARK_SIZES = {
  default: { height: 20, stroke: 1.5, dot: 4, pad: 3 },
  lg: { height: 44, stroke: 2, dot: 6, pad: 5 },
} as const;

// The room round a control's drawing, each side, in CSS pixels.
const LIVE_PAD = 8;

const sparkStyles = stylex.create({
  box: {
    display: "inline-block",
    boxSizing: "border-box",
    verticalAlign: "middle",
    lineHeight: 0,
    // Room at each end for a dot, which the stretched drawing cannot keep itself.
    paddingInline: 3,
    outlineOffset: size.ringOffsetMark,
  },
  default: { width: 80 },
  lg: { display: "block", width: "100%" },
  // A control: more room round the drawing, so the keyboard's ring stands clear of the line.
  live: {
    position: "relative",
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    paddingInline: LIVE_PAD,
    paddingBlock: space[1],
  },
  // The range input over the drawing: there for the keys, the pointer and a screen reader, unseen.
  range: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    margin: 0,
    opacity: 0,
    cursor: "crosshair",
    touchAction: "pan-y",
    appearance: "none",
  },
  drawing: { display: "block", width: "100%", overflow: "visible" },
  stroke: {
    fill: "none",
    stroke: { default: colors.chart1, [FORCED]: "CanvasText" },
    strokeLinejoin: "round",
    strokeLinecap: "round",
  },
  muted: { stroke: { default: colors.chartMuted, [FORCED]: "GrayText" } },
  // The area: the line's colour fading downward from 16% at the line to nothing at the foot, so it
  // has no bottom edge and no gap under a dip.
  washTop: { stopColor: colors.chart1, stopOpacity: 0.16 },
  washTopMuted: { stopColor: colors.chartMuted, stopOpacity: 0.12 },
  washFoot: { stopColor: colors.chart1, stopOpacity: 0 },
  washFootMuted: { stopColor: colors.chartMuted, stopOpacity: 0 },
  washForced: { display: { default: null, [FORCED]: "none" } },
  zero: {
    stroke: { default: colors.chartGrid, [FORCED]: "GrayText" },
    strokeWidth: size.hairline,
    shapeRendering: "crispEdges",
  },
  ring: { stroke: { default: colors.card, [FORCED]: "Canvas" } },
});

/** Where a point is drawn: one value is drawn across, and its point stands at the end. */
const placeOf = (
  shape: SparkShape,
  index: number,
  count: number
): SparkPoint | undefined =>
  count === 1 ? shape.points.at(-1) : shape.points[index];

// A round point that keeps its shape however the drawing stretches: a path of no length with a
// round cap, its width not scaled.
const Dot = ({
  at,
  size: dot,
  muted,
  ring = false,
}: {
  at: SparkPoint;
  size: number;
  muted: boolean;
  ring?: boolean;
}) => (
  <path
    d={`M${at.x},${at.y}h0`}
    strokeWidth={dot}
    vectorEffect="non-scaling-stroke"
    {...stylex.props(
      sparkStyles.stroke,
      muted && sparkStyles.muted,
      ring && sparkStyles.ring
    )}
  />
);

interface SparkDrawingProps {
  shape: SparkShape;
  size: "default" | "lg";
  muted: boolean;
  area: boolean;
  markAt: SparkPoint | undefined;
  activeAt: SparkPoint | undefined;
  name?: string;
}

// The drawing: the zero line where the series crosses it, the area, the line, and one point.
// Named as a picture when the sparkline is one; hidden when the control around it carries the name.
const SparkDrawing = ({
  shape,
  size: sparkSize,
  muted,
  area,
  markAt,
  activeAt,
  name,
}: SparkDrawingProps) => {
  const geometry = SPARK_SIZES[sparkSize];
  const fade = useChartId();
  return (
    <svg
      role={name === undefined ? undefined : "img"}
      aria-label={name}
      aria-hidden={name === undefined ? true : undefined}
      viewBox={`0 0 ${SPAN} ${geometry.height}`}
      preserveAspectRatio="none"
      height={geometry.height}
      {...stylex.props(sparkStyles.drawing)}
    >
      {shape.zero !== null && (
        <line
          x1={0}
          x2={SPAN}
          y1={shape.zero}
          y2={shape.zero}
          vectorEffect="non-scaling-stroke"
          {...stylex.props(sparkStyles.zero)}
        />
      )}
      {area && (
        <>
          <linearGradient
            id={fade}
            gradientUnits="userSpaceOnUse"
            x1={0}
            x2={0}
            y1={shape.top}
            y2={shape.floor}
          >
            <stop
              offset="0"
              {...stylex.props(
                muted ? sparkStyles.washTopMuted : sparkStyles.washTop
              )}
            />
            <stop
              offset="1"
              {...stylex.props(
                muted ? sparkStyles.washFootMuted : sparkStyles.washFoot
              )}
            />
          </linearGradient>
          <path
            d={areaPath(shape.points, shape.floor)}
            fill={`url(#${fade})`}
            {...stylex.props(sparkStyles.washForced)}
          />
        </>
      )}
      <path
        d={linePath(shape.points)}
        strokeWidth={geometry.stroke}
        vectorEffect="non-scaling-stroke"
        {...stylex.props(sparkStyles.stroke, muted && sparkStyles.muted)}
      />
      {markAt !== undefined && activeAt === undefined && (
        <Dot at={markAt} size={geometry.dot} muted={muted} />
      )}
      {activeAt !== undefined && (
        <>
          <Dot at={activeAt} size={geometry.dot + 4} muted={muted} />
          <Dot at={activeAt} size={geometry.dot - 1} muted={muted} ring />
        </>
      )}
    </svg>
  );
};

interface LiveSparklineProps extends Omit<
  SparkDrawingProps,
  "activeAt" | "name"
> {
  label: string;
  summary: string;
  values: readonly number[];
  onHighlightChange: (index: number | null) => void;
  pointLabels: readonly string[] | undefined;
  valueFormatter: (value: number) => string;
  style: LayoutStyle | undefined;
}

// At the lg size with onHighlightChange: a control. A range input lies over the drawing, unseen: it
// takes the keys (arrows, Home, End) and the pointer, and says the point's name and value to a
// screen reader; the caller shows it in its own figure. The ring is drawn round the sparkline.
const LiveSparkline = ({
  label,
  summary,
  values,
  onHighlightChange,
  pointLabels,
  valueFormatter,
  style,
  ...drawing
}: LiveSparklineProps) => {
  const count = values.length;
  const id = useId();
  const { chart: words } = useI18n();
  const [active, setActive] = useState<number | null>(null);
  const pick = (index: number | null) => {
    setActive(index);
    onHighlightChange(index);
  };
  const pointer = (event: PointerEvent<HTMLInputElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    pick(
      nearestOf(
        count,
        (event.clientX - box.left - LIVE_PAD) /
          Math.max(1, box.width - 2 * LIVE_PAD)
      )
    );
  };
  const at = active ?? count - 1;
  const said = words.step(
    pointLabels?.[at] ?? "",
    valueFormatter(values[at] ?? 0)
  );
  return (
    <span
      data-slot="chart-sparkline"
      {...stylex.props(
        sparkStyles.box,
        sparkStyles.lg,
        sparkStyles.live,
        focusWithin,
        style
      )}
    >
      <SparkDrawing
        {...drawing}
        activeAt={
          active === null ? undefined : placeOf(drawing.shape, active, count)
        }
      />
      <input
        type="range"
        min={0}
        max={count - 1}
        step={1}
        value={at}
        aria-label={label}
        aria-describedby={id}
        aria-valuetext={said}
        onChange={(event) => {
          pick(Number(event.currentTarget.value));
        }}
        onPointerMove={pointer}
        onPointerLeave={(event) => {
          pick(event.currentTarget === document.activeElement ? at : null);
        }}
        onFocus={() => {
          pick(at);
        }}
        onBlur={() => {
          pick(null);
        }}
        {...stylex.props(sparkStyles.range)}
      />
      <span id={id} {...stylex.props(visuallyHidden)}>
        {summary}
      </span>
    </span>
  );
};

/** A trend small enough to sit beside its number. */
export const ChartSparkline = ({
  "aria-label": label,
  summary,
  values,
  size: sparkSize = "default",
  variant = "default",
  area = false,
  showHighlight = "none",
  onHighlightChange,
  pointLabels,
  valueFormatter = String,
  style,
}: ChartSparklineProps) => {
  const { chart: words } = useI18n();
  const shape = sparkShape(
    values,
    SPARK_SIZES[sparkSize].height,
    SPARK_SIZES[sparkSize].pad
  );
  const marked = markOf(values, showHighlight);
  const markAt =
    marked === null ? undefined : placeOf(shape, marked, values.length);
  const drawing = {
    shape,
    size: sparkSize,
    muted: variant === "muted",
    area,
    markAt,
  };
  if (
    sparkSize === "lg" &&
    onHighlightChange !== undefined &&
    values.length > 0
  ) {
    return (
      <LiveSparkline
        {...drawing}
        label={label}
        summary={summary}
        values={values}
        onHighlightChange={onHighlightChange}
        pointLabels={pointLabels}
        valueFormatter={valueFormatter}
        style={style}
      />
    );
  }
  return (
    <span
      data-slot="chart-sparkline"
      {...stylex.props(
        sparkStyles.box,
        sparkSize === "lg" ? sparkStyles.lg : sparkStyles.default,
        style
      )}
    >
      <SparkDrawing
        {...drawing}
        activeAt={undefined}
        name={words.described(label, summary)}
      />
    </span>
  );
};
