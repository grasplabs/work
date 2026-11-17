// ChartBarList: kinds compared as bars laid across, one row each, largest first. Each row's name is
// read where its bar starts, above it, and wraps by the word on a narrow screen, never cut; each
// value stands at the row's end beside its bar. No axis: the words carry the numbers. A second
// series is drawn quieter under the first (last year under this year), named on the first row.
//
//   <ChartBarList label="Spend by supplier" summary="Cloud hosting took the most." data={rows}
//     nameKey="supplier" config={{ spend: { label: "Spend" } }} format={euros} />
//
// It is its own figure, as Chart is, and it is a list: a screen reader reads each name and value.
"use client";

import * as stylex from "@stylexjs/stylex";
import { Fragment, useId } from "react";

import { visuallyHidden } from "../hidden/hidden";
import { grasp, media } from "../tokens/tokens.stylex";
import { barPath, extentOf, orderRows, spanOf, valueOf } from "./bar-list";
import type { Span } from "./bar-list";
import type { ChartLayoutStyle } from "./chart";
import type { ChartConfig } from "./chart-context";
import { ChartPatterns, DitherAcross, textureOf } from "./chart-patterns";
import type { ChartFill, ChartTexture } from "./chart-patterns";
import { saidStyles } from "./chart-said";
import { useWidth } from "./use-width";

/** Every prop a ChartBarList takes. */
export interface ChartBarListProps {
  /** What the chart shows, as a screen reader and an agent say it ("Spend by supplier"). */
  label: string;
  /** One sentence that says what the numbers mean ("Cloud hosting took a third"). */
  summary: string;
  /** The rows: one object per kind compared. */
  data: readonly Record<string, string | number>[];
  /** The key that names each row (a supplier, a team). */
  nameKey: string;
  /** The series drawn, by their key in each row, with their names. The first is the value; a second is drawn quieter. */
  config: ChartConfig;
  /**
   * How the first series is filled: `plain` in the token colour, or a dither lit at the bar's tip.
   * @default "plain"
   */
  fill?: ChartFill;
  /**
   * `value` puts the largest first (by the first series); `given` keeps the rows' own order, for
   * kinds that have one (age bands, stages).
   * @default "value"
   */
  order?: "value" | "given";
  /** Writes a value as people read it ("€12.4k", "−3%"). */
  format?: (value: number) => string;
  /** Its width and where it sits. */
  style?: ChartLayoutStyle;
}

// A bar's thickness and corner, in CSS pixels: SVG geometry takes numbers. Thinner when a row holds two.
const BAR = 14;
const BAR_PAIR = 10;
const CORNER = 2;
// The solid cap at a dithered bar's tip, and the clear room beside it in dark.
const CAP = 2;
const GAP = 2;

// The chart's own width, not the window's: a list in a narrow column folds as on a phone.
const NARROW = "@container (width < 30rem)";

const grow = stylex.keyframes({
  from: { transform: "scaleX(0)" },
  to: { transform: "scaleX(1)" },
});

const styles = stylex.create({
  list: {
    containerType: "inline-size",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    columnGap: grasp.space4,
    rowGap: grasp.space5,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  row: {
    display: "grid",
    gridColumn: "1 / -1",
    gridTemplateColumns: "subgrid",
    rowGap: grasp.space1,
    alignItems: "center",
  },
  name: {
    gridColumn: "1 / -1",
    color: grasp.text,
    overflowWrap: "normal",
    wordBreak: "normal",
    textWrap: "pretty",
  },
  // One series: the name beside its value, the bar under both, close to its name.
  single: { rowGap: grasp.space1 },
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
    color: grasp.ink,
    fontWeight: grasp.weightMedium,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  // Beside a pair's bars the value takes no more height than its figures, so the two bars sit close.
  valueTight: { lineHeight: 1 },
  valueQuiet: { color: grasp.muted },
  // The series' names on the first row: beside the values on a wide chart, above each bar on a
  // narrow one (under 30rem), where beside them they took the bars' room.
  series: {
    color: grasp.muted,
    fontWeight: grasp.weightRegular,
    marginInlineEnd: grasp.space2,
    display: { default: "inline", [NARROW]: "none" },
  },
  seriesAbove: {
    gridColumn: "1 / -1",
    color: grasp.muted,
    display: { default: "none", [NARROW]: "block" },
  },
  plain: { fill: { default: grasp.chartPlain, [media.forced]: "CanvasText" } },
  quiet: {
    fill: { default: grasp.chartQuietFill, [media.forced]: "GrayText" },
  },
  cap: { fill: { default: grasp.chartLine, [media.forced]: "CanvasText" } },
  dither: { display: { default: null, [media.forced]: "none" } },
  zero: {
    stroke: grasp.chartGrid,
    strokeWidth: 1,
    shapeRendering: "crispEdges",
  },
  maskKeep: { fill: "oklch(1 0 none)", forcedColorAdjust: "none" },
  maskGap: {
    fill: "light-dark(oklch(1 0 none), oklch(0 0 none))",
    forcedColorAdjust: "none",
  },
  // The bar grows from zero once, as it arrives; under reduced motion it is simply there.
  grow: (origin: string) => ({
    transformOrigin: origin,
    animationName: { default: grow, [media.reduced]: "none" },
    animationDuration: grasp.durationOpen,
    animationTimingFunction: grasp.ease,
    animationFillMode: "both",
  }),
});

interface MarkProps {
  chart: string;
  clip: string;
  span: Span;
  height: number;
  texture: ChartTexture | null;
  quiet: boolean;
}

// A dithered bar: its body the dither, lit at the tip, and a solid cap at the tip saying the
// number, with a clear room cut beside the cap in dark, as a dithered upright bar has.
const DitheredBar = ({
  chart,
  clip,
  span,
  height,
  texture,
}: MarkProps & { texture: ChartTexture }) => {
  const path = barPath(span, 0, height, CORNER);
  const tip = span.rightward ? span.x + span.width : span.x;
  const capX = span.rightward ? tip - CAP : tip;
  const gapX = span.rightward ? capX - GAP : tip + CAP;
  return (
    <>
      <clipPath id={clip}>
        <path d={path} />
      </clipPath>
      <mask
        id={`${clip}-gap`}
        maskUnits="userSpaceOnUse"
        x={span.x - 1}
        y={-1}
        width={span.width + 2}
        height={height + 2}
      >
        <rect
          x={span.x - 1}
          y={-1}
          width={span.width + 2}
          height={height + 2}
          {...stylex.props(styles.maskKeep)}
        />
        <rect
          x={gapX}
          y={-1}
          width={Math.max(0, Math.min(GAP, span.width - CAP))}
          height={height + 2}
          {...stylex.props(styles.maskGap)}
        />
      </mask>
      <g mask={`url(#${clip}-gap)`}>
        <path d={path} {...stylex.props(styles.plain)} />
        <g clipPath={`url(#${clip})`} {...stylex.props(styles.dither)}>
          <DitherAcross
            chart={chart}
            texture={texture}
            y={0}
            height={height}
            lit={tip}
            floor={span.rightward ? span.x : span.x + span.width}
          />
        </g>
      </g>
      <g clipPath={`url(#${clip})`}>
        <rect
          x={capX}
          y={0}
          width={Math.min(CAP, span.width)}
          height={height}
          {...stylex.props(styles.cap)}
        />
      </g>
    </>
  );
};

const Mark = (props: MarkProps) => {
  const { span, height, texture, quiet } = props;
  if (span.width <= 0) {
    return null;
  }
  if (texture !== null && !quiet) {
    return <DitheredBar {...props} texture={texture} />;
  }
  return (
    <path
      d={barPath(span, 0, height, CORNER)}
      {...stylex.props(quiet ? styles.quiet : styles.plain)}
    />
  );
};

interface RowProps {
  chart: string;
  row: Readonly<Record<string, string | number>>;
  index: number;
  nameKey: string;
  keys: readonly string[];
  config: ChartConfig;
  extent: { min: number; max: number };
  width: number;
  texture: ChartTexture | null;
  format: (value: number) => string;
  watch: ((element: Element | null) => () => void) | undefined;
}

interface TrackProps {
  chart: string;
  clip: string;
  value: number;
  extent: { min: number; max: number };
  width: number;
  height: number;
  texture: ChartTexture | null;
  quiet: boolean;
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
  quiet,
  wide,
  watch,
}: TrackProps) => {
  const span = spanOf(value, extent, width);
  return (
    <svg
      ref={watch}
      aria-hidden="true"
      height={height}
      {...stylex.props(styles.track, wide && styles.trackWide)}
    >
      {extent.min < 0 && width > 0 && (
        <line
          x1={span.zero + 0.5}
          x2={span.zero + 0.5}
          y1={-2}
          y2={height + 2}
          {...stylex.props(styles.zero)}
        />
      )}
      <g {...stylex.props(styles.grow(`${span.zero}px 0`))}>
        <Mark
          chart={chart}
          clip={clip}
          span={span}
          height={height}
          texture={texture}
          quiet={quiet}
        />
      </g>
    </svg>
  );
};

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
  format,
  watch,
}: RowProps) => {
  const [first = ""] = keys;
  const track = { chart, extent, width, texture };
  // One series: the name and the value on one line, the bar under them across the whole row.
  if (keys.length < 2) {
    return (
      <li {...stylex.props(styles.row, styles.single)}>
        <span {...stylex.props(styles.name, styles.nameBeside)}>
          {row[nameKey]}
        </span>
        <span {...stylex.props(styles.value)}>
          {format(valueOf(row, first))}
        </span>
        <Track
          {...track}
          clip={`${chart}-${index}`}
          value={valueOf(row, first)}
          height={BAR}
          quiet={false}
          wide
          watch={index === 0 ? watch : undefined}
        />
      </li>
    );
  }
  // Two: the name, then each bar with its value at the row's end. The first row names the series
  // where the eye starts; a screen reader hears them on every row.
  return (
    <li {...stylex.props(styles.row)}>
      <span {...stylex.props(styles.name)}>{row[nameKey]}</span>
      {keys.map((key, place) => (
        <Fragment key={key}>
          {/* On a narrow chart the first row names each bar above it, so the names never squeeze the bars. */}
          {index === 0 && (
            <span {...stylex.props(styles.seriesAbove)}>
              {config[key]?.label ?? key}
            </span>
          )}
          <Track
            {...track}
            clip={`${chart}-${index}-${key}`}
            value={valueOf(row, key)}
            height={BAR_PAIR}
            quiet={place > 0}
            wide={false}
            watch={index === 0 && place === 0 ? watch : undefined}
          />
          <span
            {...stylex.props(
              styles.value,
              styles.valueTight,
              place > 0 && styles.valueQuiet
            )}
          >
            <span
              {...stylex.props(index === 0 ? styles.series : visuallyHidden)}
            >
              {config[key]?.label ?? key}
            </span>
            {format(valueOf(row, key))}
          </span>
        </Fragment>
      ))}
    </li>
  );
};

const plainNumber = (value: number) => value.toLocaleString();

export const ChartBarList = ({
  label,
  summary,
  data,
  nameKey,
  config,
  fill = "plain",
  order = "value",
  format = plainNumber,
  style,
}: ChartBarListProps) => {
  const chart = `chart-${useId().replaceAll(/[^a-zA-Z0-9-]/gu, "")}`;
  const keys = Object.keys(config).slice(0, 2);
  const [first = ""] = keys;
  const rows = orderRows(data, first, order);
  const extent = extentOf(rows, keys);
  const [width, watch] = useWidth();
  const texture = textureOf(fill);
  return (
    <figure
      aria-labelledby={`${chart}-label`}
      data-slot="chart-bar-list"
      {...stylex.props(saidStyles.figure, style)}
    >
      <figcaption {...stylex.props(visuallyHidden)}>
        <span id={`${chart}-label`}>{label}</span> <span>{summary}</span>
      </figcaption>
      {/* The patterns, once, in a drawing of their own that takes no room. */}
      <svg
        aria-hidden="true"
        width={0}
        height={0}
        {...stylex.props(visuallyHidden)}
      >
        <ChartPatterns id={chart} />
      </svg>
      <ol {...stylex.props(styles.list)}>
        {rows.map((row, index) => (
          <BarRow
            key={String(row[nameKey])}
            chart={chart}
            row={row}
            index={index}
            nameKey={nameKey}
            keys={keys}
            config={config}
            extent={extent}
            width={width}
            texture={texture}
            format={format}
            watch={watch}
          />
        ))}
      </ol>
    </figure>
  );
};
