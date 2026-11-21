// ChartBar: one series as bars with round top corners. Plain, a bar is the plain token colour.
// Dithered, its body is the dither, lit near the top, and a solid cap in the value colour says the
// number: the fill is decoration.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect } from "react";
import { Bar } from "recharts";

import { grasp, media } from "../tokens/tokens.stylex";
import { useReducedMotion } from "./chart";
import { useChart } from "./chart-context";
import { DitherBands, textureOf } from "./chart-patterns";
import type { ChartFill } from "./chart-patterns";

/** Every prop a ChartBar takes. */
export interface ChartBarProps {
  /** The series it draws: its key in each row, named in the chart's config. */
  series: string;
  /**
   * `plain` in the token colour, or a dither: `dither-pixels` chunky, `dither-dots` fine.
   * @default "plain"
   */
  fill?: ChartFill;
}

// The bar's corner and its cap's height, in CSS pixels: SVG geometry takes numbers.
const CORNER = 4;
const CAP = 2;

const styles = stylex.create({
  plain: { fill: { default: grasp.chartPlain, [media.forced]: "CanvasText" } },
  cap: { fill: { default: grasp.chartLine, [media.forced]: "CanvasText" } },
  // Forced colours drop the dither for a plain fill.
  dither: { display: { default: null, [media.forced]: "none" } },
  // The gap under a dithered bar's cap, in a mask: kept in light, cut in dark, where the cap and the
  // lit dither are one mint and the cap was lost in the fill.
  maskKeep: { fill: "oklch(1 0 none)", forcedColorAdjust: "none" },
  maskGap: {
    fill: "light-dark(oklch(1 0 none), oklch(0 0 none))",
    forcedColorAdjust: "none",
  },
});

/** The clear room under a dithered bar's cap, in dark (CSS pixels). */
const GAP = 2;

// A rectangle with its two top corners rounded, from two chart marks: a rect rounded all round,
// and a square rect over its lower part. Both take the same fill, and together they clip too.
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
  const r = Math.max(0, Math.min(CORNER, width / 2, height));
  return (
    <>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={r}
        ry={r}
        {...(look === undefined ? {} : stylex.props(look))}
      />
      <rect
        x={x}
        y={y + r}
        width={width}
        height={height - r}
        {...(look === undefined ? {} : stylex.props(look))}
      />
    </>
  );
};

interface ShapeProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  index?: number;
}

export const ChartBar = ({ series, fill = "plain" }: ChartBarProps) => {
  const { config, id, setBars } = useChart();
  const reduced = useReducedMotion();
  // The chart draws no hover line through bars: say there are bars.
  useEffect(() => {
    setBars?.(true);
  }, [setBars]);
  const texture = textureOf(fill);
  const shape = ({
    x = 0,
    y = 0,
    width = 0,
    height = 0,
    index = 0,
  }: ShapeProps) => {
    if (height <= 0 || width <= 0) {
      return <g />;
    }
    const box = { x, y, width, height };
    if (texture === null) {
      return (
        <g>
          <RoundTop {...box} look={styles.plain} />
        </g>
      );
    }
    const clip = `${id}-${series}-bar-${index}`;
    const gap = `${id}-${series}-bar-gap-${index}`;
    return (
      <g>
        <clipPath id={clip}>
          <RoundTop {...box} />
        </clipPath>
        <mask
          id={gap}
          maskUnits="userSpaceOnUse"
          x={x - 1}
          y={y - 1}
          width={width + 2}
          height={height + 2}
        >
          <rect
            x={x - 1}
            y={y - 1}
            width={width + 2}
            height={height + 2}
            {...stylex.props(styles.maskKeep)}
          />
          <rect
            x={x - 1}
            y={y + CAP}
            width={width + 2}
            height={Math.max(0, Math.min(GAP, height - CAP))}
            {...stylex.props(styles.maskGap)}
          />
        </mask>
        <g mask={`url(#${gap})`}>
          <RoundTop {...box} look={styles.plain} />
          <g clipPath={`url(#${clip})`} {...stylex.props(styles.dither)}>
            <DitherBands
              chart={id}
              texture={texture}
              x={x}
              width={width}
              top={y}
              bottom={y + height}
            />
          </g>
        </g>
        <g clipPath={`url(#${clip})`}>
          <rect
            x={x}
            y={y}
            width={width}
            height={Math.min(CAP, height)}
            {...stylex.props(styles.cap)}
          />
        </g>
      </g>
    );
  };
  return (
    <Bar
      dataKey={series}
      name={config[series]?.label ?? series}
      shape={shape}
      isAnimationActive={!reduced}
    />
  );
};
