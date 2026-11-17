// ChartSpark: a trend small enough to sit beside its number: in a table cell, on a line of text,
// or under a highlight's figure. A line in the value colour, a soft area under it if asked, and at
// most one marked point (the last, the lowest or the highest). No axis, no grid, no words inside:
// the number beside it says the value, and its label and summary say the trend to a screen reader.
//
//   <ChartSpark label="Revenue, last 12 weeks" summary="Up 8%." values={weeks} mark="last" />
//
// It is drawn on the server as on the client, with no measuring: the drawing is 100 units wide and
// stretches across its box, its strokes keep their width (non-scaling), and its points are round
// caps on paths of no length, so they stay round however it stretches. No dither: at this size its
// bands would be two or three pixels tall, noise rather than light. No draw-in: many sparks
// arriving at once would be the page popping in. At the tile size, given `onPoint`, the pointer or
// the arrow keys pick a point and the caller shows it in the tile's own figure; never a tooltip.
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";
import type { PointerEvent } from "react";

import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { grasp, media } from "../tokens/tokens.stylex";
import type { ChartLayoutStyle } from "./chart";
import {
  SPAN,
  areaPath,
  linePath,
  markOf,
  nearestOf,
  sparkShape,
} from "./spark";
import type { SparkPoint, SparkShape } from "./spark";

/** Every prop a ChartSpark takes. */
export interface ChartSparkProps {
  /** What it shows, as a screen reader and an agent say it ("Revenue, last 12 weeks"). */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /** The trend in one short sentence ("Up 8%", "Down from 52 to 47 days"). */
  summary: string;
  /** The values, oldest first. One value, or all alike, draws a straight line. */
  values: readonly number[];
  /**
   * `line` sits on a line of text (20px tall, 80px wide unless its style says otherwise); `tile`
   * stands under a highlight's figure (44px tall, as wide as its box).
   * @default "line"
   */
  size?: "line" | "tile";
  /**
   * `value` in the value colour, or `quiet` for a comparison: last year's, another team's.
   * @default "value"
   */
  variant?: "value" | "quiet";
  /** @deprecated Use `variant`. */
  look?: "value" | "quiet";
  /**
   * A soft area under the line.
   * @default false
   */
  area?: boolean;
  /**
   * The one point marked with a dot: the `last`, the lowest (`min`) or the highest (`max`).
   * @default "none"
   */
  mark?: "none" | "last" | "min" | "max";
  /**
   * At the tile size: called with the point under the pointer or the arrow keys, and null when
   * none, so the tile's figure can say it. Without it the spark is a picture, not a control.
   */
  onPoint?: (index: number | null) => void;
  /** Each point's name, as a screen reader says it when the arrow keys reach it ("Week 7"). */
  pointLabels?: readonly string[];
  /** Writes a value as people read it, for a screen reader at the tile size ("€12.4k"). */
  format?: (value: number) => string;
  /** Its width and where it sits. */
  layout?: ChartLayoutStyle;
  /** @deprecated Use `layout`. */
  style?: ChartLayoutStyle;
}

// Each size's height, line width, dot and the room kept at the top and bottom so a dot is never
// cut, in CSS pixels: SVG geometry.
const SIZES = {
  line: { height: 20, stroke: 1.5, dot: 4, pad: 3 },
  tile: { height: 44, stroke: 2, dot: 6, pad: 5 },
} as const;

// The room round a control's drawing, each side, in CSS pixels.
const LIVE_PAD = 8;

const styles = stylex.create({
  box: {
    display: "inline-block",
    boxSizing: "border-box",
    verticalAlign: "middle",
    lineHeight: 0,
    // Room at each end for a dot, which the stretched drawing cannot keep itself.
    paddingInline: 3,
    outlineOffset: 2,
  },
  line: { width: 80 },
  tile: { display: "block", width: "100%" },
  // A control: more room round the drawing, so the keyboard's ring stands clear of the line.
  live: {
    position: "relative",
    borderRadius: grasp.corner,
    paddingInline: LIVE_PAD,
    paddingBlock: 4,
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
    stroke: { default: grasp.chartLine, [media.forced]: "CanvasText" },
    strokeLinejoin: "round",
    strokeLinecap: "round",
  },
  quiet: { stroke: { default: grasp.chartQuiet, [media.forced]: "GrayText" } },
  // The area: the line's colour fading downward from 16% at the line to nothing at the foot, so it
  // has no bottom edge and no gap under a dip.
  washTop: { stopColor: grasp.chartLine, stopOpacity: 0.16 },
  washTopQuiet: { stopColor: grasp.chartQuiet, stopOpacity: 0.12 },
  washFoot: { stopColor: grasp.chartLine, stopOpacity: 0 },
  washFootQuiet: { stopColor: grasp.chartQuiet, stopOpacity: 0 },
  washForced: { display: { default: null, [media.forced]: "none" } },
  zero: {
    stroke: { default: grasp.chartGrid, [media.forced]: "GrayText" },
    strokeWidth: 1,
    shapeRendering: "crispEdges",
  },
  ring: { stroke: { default: grasp.raised, [media.forced]: "Canvas" } },
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
  size,
  quiet,
  ring = false,
}: {
  at: SparkPoint;
  size: number;
  quiet: boolean;
  ring?: boolean;
}) => (
  <path
    d={`M${at.x},${at.y}h0`}
    strokeWidth={size}
    vectorEffect="non-scaling-stroke"
    {...stylex.props(styles.stroke, quiet && styles.quiet, ring && styles.ring)}
  />
);

interface Picked {
  active: number | null;
  pick: (index: number | null) => void;
}

// The point the pointer or the keys are on, told to the caller.
const usePicked = (
  onPoint: ((index: number | null) => void) | undefined
): Picked => {
  const [active, setActive] = useState<number | null>(null);
  const pick = (index: number | null) => {
    setActive(index);
    onPoint?.(index);
  };
  return { active, pick };
};

interface DrawingProps {
  shape: SparkShape;
  size: "line" | "tile";
  quiet: boolean;
  area: boolean;
  markAt: SparkPoint | undefined;
  activeAt: SparkPoint | undefined;
  name?: string;
}

// The drawing: the zero line where the series crosses it, the area, the line, and one point.
// Named as a picture when the spark is one; hidden when the control around it carries the name.
const Drawing = ({
  shape,
  size,
  quiet,
  area,
  markAt,
  activeAt,
  name,
}: DrawingProps) => {
  const geometry = SIZES[size];
  const fade = `spark-${useId().replaceAll(/[^a-zA-Z0-9-]/gu, "")}`;
  return (
    <svg
      role={name === undefined ? undefined : "img"}
      aria-label={name}
      aria-hidden={name === undefined ? true : undefined}
      viewBox={`0 0 ${SPAN} ${geometry.height}`}
      preserveAspectRatio="none"
      height={geometry.height}
      {...stylex.props(styles.drawing)}
    >
      {shape.zero !== null && (
        <line
          x1={0}
          x2={SPAN}
          y1={shape.zero}
          y2={shape.zero}
          vectorEffect="non-scaling-stroke"
          {...stylex.props(styles.zero)}
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
              {...stylex.props(quiet ? styles.washTopQuiet : styles.washTop)}
            />
            <stop
              offset="1"
              {...stylex.props(quiet ? styles.washFootQuiet : styles.washFoot)}
            />
          </linearGradient>
          <path
            d={areaPath(shape.points, shape.floor)}
            fill={`url(#${fade})`}
            {...stylex.props(styles.washForced)}
          />
        </>
      )}
      <path
        d={linePath(shape.points)}
        strokeWidth={geometry.stroke}
        vectorEffect="non-scaling-stroke"
        {...stylex.props(styles.stroke, quiet && styles.quiet)}
      />
      {markAt !== undefined && activeAt === undefined && (
        <Dot at={markAt} size={geometry.dot} quiet={quiet} />
      )}
      {activeAt !== undefined && (
        <>
          <Dot at={activeAt} size={geometry.dot + 4} quiet={quiet} />
          <Dot at={activeAt} size={geometry.dot - 1} quiet={quiet} ring />
        </>
      )}
    </svg>
  );
};

interface LiveProps extends Omit<DrawingProps, "activeAt" | "name"> {
  label: string;
  summary: string;
  values: readonly number[];
  onPoint: (index: number | null) => void;
  pointLabels: readonly string[] | undefined;
  format: (value: number) => string;
  layout: ChartLayoutStyle | undefined;
}

// At the tile size with onPoint: a control. A range input lies over the drawing, unseen: it takes
// the keys (arrows, Home, End) and the pointer, and says the point's name and value to a screen
// reader; the caller shows it in the tile's figure. The ring is drawn round the spark.
const Live = ({
  label,
  summary,
  values,
  onPoint,
  pointLabels,
  format,
  layout: style,
  ...drawing
}: LiveProps) => {
  const count = values.length;
  const id = useId();
  const { active, pick } = usePicked(onPoint);
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
  const said = `${pointLabels?.[at] ?? ""} ${format(values[at] ?? 0)}`.trim();
  return (
    <span
      data-slot="chart-spark"
      {...stylex.props(
        styles.box,
        styles.tile,
        styles.live,
        focus.within,
        style
      )}
    >
      <Drawing
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
        {...stylex.props(styles.range)}
      />
      <span id={id} {...stylex.props(visuallyHidden)}>
        {summary}
      </span>
    </span>
  );
};

export const ChartSpark = ({
  label: labelDeprecated,
  "aria-label": label = labelDeprecated ?? "",
  summary,
  values,
  size = "line",
  look: lookDeprecated,
  variant: look = lookDeprecated ?? "value",
  area = false,
  mark = "none",
  onPoint,
  pointLabels,
  format = String,
  style: styleDeprecated,
  layout: style = styleDeprecated,
}: ChartSparkProps) => {
  const shape = sparkShape(values, SIZES[size].height, SIZES[size].pad);
  const marked = markOf(values, mark);
  const markAt =
    marked === null ? undefined : placeOf(shape, marked, values.length);
  const drawing = { shape, size, quiet: look === "quiet", area, markAt };
  if (size === "tile" && onPoint !== undefined && values.length > 0) {
    return (
      <Live
        {...drawing}
        label={label}
        summary={summary}
        values={values}
        onPoint={onPoint}
        pointLabels={pointLabels}
        format={format}
        layout={style}
      />
    );
  }
  return (
    <span
      data-slot="chart-spark"
      {...stylex.props(styles.box, styles[size], style)}
    >
      <Drawing
        {...drawing}
        activeAt={undefined}
        name={`${label}. ${summary}`}
      />
    </span>
  );
};
