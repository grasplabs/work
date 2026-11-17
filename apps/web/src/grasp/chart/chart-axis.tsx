// ChartAxis: the names along the bottom or the numbers up the side, in muted small type with
// tabular figures, with no axis line or tick marks: the grid carries the levels.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";
import { XAxis, YAxis } from "recharts";
import type {
  TextAnchor,
  XAxisTickContentProps,
  YAxisTickContentProps,
} from "recharts";

import { grasp } from "../tokens/tokens.stylex";
import { useChart } from "./chart-context";

/** Every prop a ChartAxis takes. */
export interface ChartAxisProps {
  /** `x` for the names along the bottom, `y` for the numbers up the side. */
  side: "x" | "y";
  /** Writes a value as people read it ("40k", "Jan"). */
  format?: (value: string | number) => string;
  /**
   * The y axis's width in pixels, room for its longest label: wider for currency or long numbers
   * ("€5,000" needs about 52). The x axis takes the chart's width.
   * @default 36
   */
  width?: number;
}

const styles = stylex.create({
  tick: {
    fill: grasp.chartTick,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    fontVariantNumeric: "tabular-nums",
  },
});

interface TickProps {
  x?: number;
  y?: number;
  payload?: { value: string | number };
  textAnchor?: TextAnchor;
  format?: (value: string | number) => string;
  side: "x" | "y";
}

// Our own tick: a text element with the StyleX class, so no rule has to reach into Recharts.
const Tick = ({
  x = 0,
  y = 0,
  payload,
  textAnchor,
  format,
  side,
}: TickProps) => {
  const value = payload?.value ?? "";
  return (
    <text
      x={x}
      y={y}
      dy={side === "x" ? "0.9em" : "0.32em"}
      textAnchor={textAnchor}
      {...stylex.props(styles.tick)}
    >
      {format === undefined ? value : format(value)}
    </text>
  );
};

export const ChartAxis = ({ side, format, width = 36 }: ChartAxisProps) => {
  const { xKey, setValueFormat } = useChart();
  // The y axis writes the values: the chart's table writes them the same way. One wrapper for good,
  // reading the latest format, so a format written inline never makes the chart draw again.
  const latest = useRef(format);
  useEffect(() => {
    latest.current = format;
  });
  // oxlint-disable-next-line react/hook-use-state -- a writer made once, never replaced
  const [written] = useState(
    () => (value: number) => latest.current?.(value) ?? String(value)
  );
  const writes = side === "y" && format !== undefined;
  useEffect(() => {
    if (writes) {
      setValueFormat?.(written);
    }
  }, [writes, written, setValueFormat]);
  const tick = (props: XAxisTickContentProps | YAxisTickContentProps) => (
    <Tick
      x={Number(props.x)}
      y={Number(props.y)}
      payload={props.payload}
      textAnchor={props.textAnchor}
      side={side}
      format={format}
    />
  );
  return side === "x" ? (
    <XAxis
      dataKey={xKey}
      axisLine={false}
      tickLine={false}
      tickMargin={4}
      tick={tick}
    />
  ) : (
    <YAxis
      axisLine={false}
      tickLine={false}
      tickMargin={4}
      width={width}
      tick={tick}
    />
  );
};
