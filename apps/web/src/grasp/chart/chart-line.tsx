// ChartLine: one series as a line alone, a trend, with nothing filled under it. The line in the
// value colour says the number, drawn as ChartArea draws its own (an area whose shape is its line
// only, so both lines are one line); a point shows under the pointer or the keys.
//
// Several ChartLines compare: each takes a `look`, so lines are told apart by weight and dash and
// not by colour alone (the light has few hues). `quiet` is the earlier period: muted, thinner and
// dashed. ChartLabels names each at its end, in place of a legend.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect } from "react";
import { Area } from "recharts";

import { grasp, media } from "../tokens/tokens.stylex";
import { useReducedMotion } from "./chart";
import { useChart } from "./chart-context";
import type { ChartLineLook } from "./chart-context";

export type { ChartLineLook } from "./chart-context";

/** Every prop a ChartLine takes. */
export interface ChartLineProps {
  /** The series it draws: its key in each row, named in the chart's config. */
  series: string;
  /**
   * How it is drawn, so several are told apart without colour: `solid` (the value), `dashed`,
   * `dotted`, `thin`, or `quiet` for an earlier period (muted, thinner, dashed).
   * @default "solid"
   */
  look?: ChartLineLook;
}

// The line's width, in CSS pixels: an SVG attribute, as ChartArea's.
const LINE = 2;

// Each look's width and dash, in CSS pixels: SVG attributes, which take numbers.
const LOOKS: Record<
  ChartLineLook,
  { width: number; dash: string | undefined }
> = {
  solid: { width: LINE, dash: undefined },
  dashed: { width: LINE, dash: "6 4" },
  dotted: { width: LINE, dash: "0.1 4.5" },
  thin: { width: 1, dash: undefined },
  quiet: { width: 1.5, dash: "4 4" },
};

const styles = stylex.create({
  line: {
    fill: "none",
    stroke: { default: grasp.chartLine, [media.forced]: "CanvasText" },
    strokeLinejoin: "round",
    strokeLinecap: "round",
  },
  quiet: { stroke: { default: grasp.chartQuiet, [media.forced]: "GrayText" } },
  dot: {
    fill: { default: grasp.raised, [media.forced]: "Canvas" },
    stroke: { default: grasp.chartLine, [media.forced]: "CanvasText" },
  },
  dotQuiet: {
    stroke: { default: grasp.chartQuiet, [media.forced]: "GrayText" },
  },
});

interface Point {
  x: number | null;
  y: number | null;
}

/** The line through the points, as an SVG point list. */
const lineOf = (points: readonly Point[]) =>
  points
    .filter((p): p is { x: number; y: number } => p.x !== null && p.y !== null)
    .map((p) => `${p.x},${p.y}`)
    .join(" ");

export const ChartLine = ({ series, look = "solid" }: ChartLineProps) => {
  const { config, setLook } = useChart();
  const reduced = useReducedMotion();
  // The chart knows how this line is drawn, so its name at the end can match.
  useEffect(() => {
    setLook?.(series, look);
  }, [setLook, series, look]);
  const quiet = look === "quiet";
  const { width, dash } = LOOKS[look];
  const shape = ({ points = [] }: { points?: readonly Point[] }) => (
    <g>
      <polyline
        data-slot="chart-line"
        data-look={look}
        points={lineOf(points)}
        strokeWidth={width}
        strokeDasharray={dash}
        {...stylex.props(styles.line, quiet && styles.quiet)}
      />
    </g>
  );
  return (
    <Area
      dataKey={series}
      name={config[series]?.label ?? series}
      shape={shape}
      activeDot={{
        r: 4,
        strokeWidth: LINE,
        className: stylex.props(styles.dot, quiet && styles.dotQuiet).className,
      }}
      dot={false}
      isAnimationActive={!reduced}
    />
  );
};
