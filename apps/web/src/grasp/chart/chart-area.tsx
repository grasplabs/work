// ChartArea: one series as a line with the area under it filled. The line, in the value colour,
// says the number; the fill under it is plain and faint, or a dither, lit near the line.
"use client";

import * as stylex from "@stylexjs/stylex";
import { Area } from "recharts";

import { grasp, media } from "../tokens/tokens.stylex";
import { useReducedMotion } from "./chart";
import { useChart } from "./chart-context";
import { DitherBands, textureOf } from "./chart-patterns";
import type { ChartFill } from "./chart-patterns";

/** Every prop a ChartArea takes. */
export interface ChartAreaProps {
  /** The series it draws: its key in each row, named in the chart's config. */
  series: string;
  /**
   * `plain` a faint wash of the value colour, or a dither: `dither-pixels` chunky, `dither-dots` fine.
   * @default "plain"
   */
  fill?: ChartFill;
}

// The line's width, in CSS pixels: an SVG attribute.
const LINE = 2;
/** The clear room between the line and the fill under it, in dark (CSS pixels). */
const GAP = 2;

const styles = stylex.create({
  line: {
    fill: "none",
    stroke: { default: grasp.chartLine, [media.forced]: "CanvasText" },
    strokeLinejoin: "round",
    strokeLinecap: "round",
  },
  // The faint wash, opaque on the card's own ground, so the grid's lines stop at the area and do not
  // run through it (as a mark, it is whole).
  // 16% of the line on a light card, 12% on a dark one, where the same share already reads strong.
  wash: {
    fill: {
      default: `light-dark(color-mix(in oklch, ${grasp.chartLine} 16%, ${grasp.raised}), color-mix(in oklch, ${grasp.chartLine} 12%, ${grasp.raised}))`,
      [media.forced]: "transparent",
    },
  },
  // The gap under the line, in a mask: kept (light) in light, cut (dark) in dark, where the line
  // and the lit dither are one mint and the line was lost in the fill.
  maskKeep: { fill: "oklch(1 0 none)", forcedColorAdjust: "none" },
  maskGap: {
    fill: "none",
    stroke: "light-dark(oklch(1 0 none), oklch(0 0 none))",
    strokeLinejoin: "round",
    strokeLinecap: "round",
    forcedColorAdjust: "none",
  },
  dither: { display: { default: null, [media.forced]: "none" } },
  dot: {
    fill: { default: grasp.raised, [media.forced]: "Canvas" },
    stroke: { default: grasp.chartLine, [media.forced]: "CanvasText" },
  },
});

interface Point {
  x: number | null;
  y: number | null;
}
interface ShapeProps {
  points?: readonly Point[];
  baseLine?: number | readonly Point[];
}

// The line through the points, and the same closed down to the floor for the fill: chart marks,
// a polyline and a polygon, as SVG point lists.
const marks = (points: readonly Point[], floor: number) => {
  const shown = points.filter(
    (p): p is { x: number; y: number } => p.x !== null && p.y !== null
  );
  const first = shown.at(0);
  const last = shown.at(-1);
  if (first === undefined || last === undefined) {
    return null;
  }
  const line = shown.map((p) => `${p.x},${p.y}`).join(" ");
  return {
    line,
    area: `${line} ${last.x},${floor} ${first.x},${floor}`,
    left: first.x,
    right: last.x,
    top: Math.min(...shown.map((p) => p.y)),
  };
};

export const ChartArea = ({ series, fill = "plain" }: ChartAreaProps) => {
  const { config, id } = useChart();
  const reduced = useReducedMotion();
  const texture = textureOf(fill);
  const shape = ({ points = [], baseLine }: ShapeProps) => {
    const floor =
      typeof baseLine === "number"
        ? baseLine
        : Math.max(...(baseLine ?? []).map((p) => p.y ?? 0));
    const drawn = marks(points, floor);
    if (!drawn) {
      return <g />;
    }
    const clip = `${id}-${series}-area`;
    const gap = `${id}-${series}-gap`;
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
            {...stylex.props(styles.maskKeep)}
          />
          <polyline
            points={drawn.line}
            strokeWidth={LINE + 2 * GAP}
            {...stylex.props(styles.maskGap)}
          />
        </mask>
        <g mask={`url(#${gap})`}>
          <polygon points={drawn.area} {...stylex.props(styles.wash)} />
          {texture !== null && (
            <g clipPath={`url(#${clip})`} {...stylex.props(styles.dither)}>
              <DitherBands
                chart={id}
                texture={texture}
                x={drawn.left}
                width={drawn.right - drawn.left}
                top={drawn.top}
                bottom={floor}
              />
            </g>
          )}
        </g>
        <polyline
          points={drawn.line}
          strokeWidth={LINE}
          {...stylex.props(styles.line)}
        />
      </g>
    );
  };
  return (
    <Area
      dataKey={series}
      name={config[series]?.label ?? series}
      shape={shape}
      activeDot={{
        r: 4,
        strokeWidth: LINE,
        className: stylex.props(styles.dot).className,
      }}
      dot={false}
      isAnimationActive={!reduced}
    />
  );
};
