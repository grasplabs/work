// ChartGrid: faint level lines behind the marks, in the line token, dotted, as the website's chart.
"use client";

import { CartesianGrid } from "recharts";

import { grasp } from "../tokens/tokens.stylex";

/** Every prop a ChartGrid takes. */
export interface ChartGridProps {
  /**
   * Upright lines too, one per point along the bottom.
   * @default false
   */
  vertical?: boolean;
}

interface LineProps {
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
}

const DASH = 2;
// 2 on 2, so the grid reads as lines, not as a scatter of dots.
const GAP = 2;

/**
 * One grid line, dotted so that it begins and ends on a dash: the gaps are stretched a little to
 * fit the line's length (a plain "2 2" would end in a gap, 2px short of the plot's end).
 */
const Dotted = ({ x1 = 0, y1 = 0, x2 = 0, y2 = 0 }: LineProps) => {
  const length = Math.hypot(x2 - x1, y2 - y1);
  const dashes = Math.max(1, Math.round((length - DASH) / (DASH + GAP)));
  const gap = dashes > 0 ? (length - DASH * (dashes + 1)) / dashes : GAP;
  return (
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke={grasp.chartGrid}
      strokeDasharray={`${DASH} ${gap}`}
    />
  );
};

// Presentation attributes take a CSS variable, so the token's light and dark both hold.
export const ChartGrid = ({ vertical = false }: ChartGridProps) => (
  <CartesianGrid
    vertical={vertical ? <Dotted /> : false}
    horizontal={<Dotted />}
  />
);
