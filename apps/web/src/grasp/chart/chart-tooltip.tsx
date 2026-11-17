// ChartTooltip: the point under the pointer or the keyboard, in the Tooltip component's own panel
// (src/components/tooltip/styles.ts): the name along the bottom, then each series and its value.
// A faint band marks the point in the chart. It stands clear of what it explains: a gap off the
// crosshair, and above the highest hovered mark or below the lowest when there is room
// (tooltip-place.ts), never over a hovered point.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import { createPortal } from "react-dom";
import {
  Tooltip,
  useActiveTooltipCoordinate,
  useActiveTooltipDataPoints,
  useActiveTooltipLabel,
  usePlotArea,
  useYAxisScale,
} from "recharts";
import type { TooltipContentProps } from "recharts";

import { grasp } from "../tokens/tokens.stylex";
import { tooltipStyles } from "../tooltip/styles";
import { useReducedMotion } from "./chart";
import { useChart } from "./chart-context";
import { barTooltipLeft, tooltipTop } from "./tooltip-place";

// The clear room between the tooltip and the crosshair or any hovered mark, in CSS pixels.
const CLEAR = 16;

/** Every prop a ChartTooltip takes. */
export interface ChartTooltipProps {
  /** Writes a value as people read it ("1,240", "40%"). */
  format?: (value: number) => string;
  /**
   * The series in the config's order (`given`), or the highest first (`value`), as several lines
   * compared read best.
   * @default "given"
   */
  order?: "given" | "value";
}

type Entry = TooltipContentProps["payload"][number];

/** The entries, highest first, for a tooltip that lists several lines by value. */
const byValue = (payload: readonly Entry[]) =>
  payload.toSorted(
    (a, b) =>
      (typeof b.value === "number" ? b.value : 0) -
      (typeof a.value === "number" ? a.value : 0)
  );

const styles = stylex.create({
  title: { display: "block", fontWeight: grasp.weightMedium },
  row: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: grasp.space3,
    fontWeight: grasp.weightRegular,
  },
  value: { fontVariantNumeric: "tabular-nums", fontWeight: grasp.weightMedium },
  cursor: { fill: grasp.ghostFillHover, stroke: "none" },
  // Over a chart the tooltip is solid: translucent, the bars behind it showed through as stripes
  // and its words lost their ground. The tooltip's own colour, made opaque, with nothing blurred.
  solid: {
    backgroundColor: `oklch(from ${grasp.tooltipFill} l c h / 1)`,
    backdropFilter: "none",
  },
  cursorLine: { stroke: grasp.chartGrid, strokeWidth: 1, fill: "none" },
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
        {...stylex.props(styles.cursorLine)}
      />
    );
  }
  return (
    <rect
      x={x}
      y={y}
      width={width}
      height={height}
      {...stylex.props(styles.cursor)}
    />
  );
};

// Says the active point in the chart's live region, as the arrow keys move it.
const Announcer = () => {
  const { config, live } = useChart();
  const label = useActiveTooltipLabel();
  const points = useActiveTooltipDataPoints<Record<string, string | number>>();
  const [row] = points ?? [];
  if (live === null || label === undefined || row === undefined) {
    return null;
  }
  const words = [
    label,
    ...Object.keys(config).map((key) => `${config[key]?.label}: ${row[key]}`),
  ].join(", ");
  return createPortal(words, live);
};

// The hovered marks' heights in the drawing: one per series at the active point.
const useMarks = () => {
  const { config } = useChart();
  const y = useYAxisScale();
  const points = useActiveTooltipDataPoints<Record<string, string | number>>();
  const [row] = points ?? [];
  if (y === undefined || row === undefined) {
    return [];
  }
  return Object.keys(config)
    .map((key) => row[key])
    .filter((value) => typeof value === "number")
    .map((value) => y(value) ?? 0);
};

export const ChartTooltip = ({
  format,
  order = "given",
}: ChartTooltipProps) => {
  const { config, bars } = useChart();
  const reduced = useReducedMotion();
  const plot = usePlotArea();
  const marks = useMarks();
  const at = useActiveTooltipCoordinate();
  // The panel's own size, read as it is drawn, so it can stand clear above the marks.
  const [size, setSize] = useState({ width: 0, height: 0 });
  const measure = (panel: HTMLDivElement | null) => {
    if (
      panel !== null &&
      (panel.offsetHeight !== size.height || panel.offsetWidth !== size.width)
    ) {
      setSize({ width: panel.offsetWidth, height: panel.offsetHeight });
    }
  };
  const top =
    plot === undefined || size.height === 0
      ? undefined
      : tooltipTop(marks, plot, size.height, CLEAR);
  // Over bars it stands centred above the bar it explains, or beside it where the bar is too tall:
  // never on the bar itself.
  const { data = [] } = useChart();
  const above =
    top !== undefined &&
    marks.length > 0 &&
    top + size.height <= Math.min(...marks);
  const band = plot === undefined ? 0 : plot.width / Math.max(1, data.length);
  const over =
    bars && at !== undefined && plot !== undefined && size.width > 0
      ? { x: barTooltipLeft(at.x, band, size.width, plot, CLEAR, above) }
      : {};
  const besideTop = plot === undefined ? top : plot.y;
  const position =
    top === undefined
      ? undefined
      : { ...over, y: bars && !above ? besideTop : top };
  const content = ({ active, label, payload }: TooltipContentProps) => {
    if (!active || payload.length === 0) {
      return null;
    }
    return (
      <div ref={measure} {...stylex.props(tooltipStyles.panel, styles.solid)}>
        <span {...stylex.props(styles.title)}>{label}</span>
        {(order === "value" ? byValue(payload) : payload).map((entry) => {
          const key = String(
            typeof entry.dataKey === "function" ? "" : (entry.dataKey ?? "")
          );
          const value =
            typeof entry.value === "number" && format !== undefined
              ? format(entry.value)
              : entry.value;
          return (
            <span key={key} {...stylex.props(styles.row)}>
              <span>{config[key]?.label ?? key}</span>
              <span {...stylex.props(styles.value)}>{value}</span>
            </span>
          );
        })}
      </div>
    );
  };
  return (
    <>
      <Tooltip
        content={content}
        cursor={bars ? false : <Cursor />}
        isAnimationActive={!reduced}
        offset={CLEAR}
        position={position}
      />
      <Announcer />
    </>
  );
};
