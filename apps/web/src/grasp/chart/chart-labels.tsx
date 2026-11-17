// ChartLabels: each line named at its end, beside its last point, in place of a legend. Where two
// lines end close together their names are pushed apart just enough not to touch, and the chart
// keeps room at its right for the longest. A quiet line's name is quiet too.
//
//   <Chart …>
//     <ChartLine series="now" />
//     <ChartLine series="before" look="quiet" />
//     <ChartLabels />
//   </Chart>
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect } from "react";
import { usePlotArea, useXAxisScale, useYAxisScale } from "recharts";

import { grasp, media } from "../tokens/tokens.stylex";
import { useChart } from "./chart-context";
import type { ChartConfig } from "./chart-context";
import { measureText } from "./measure-text";
import { spread } from "./spread";

/** Every prop a ChartLabels takes. */
export type ChartLabelsProps = Record<string, never>;

// The space between a line's end and its name, the least room between two names, and the room
// kept beyond the longest name, in CSS pixels: SVG geometry.
const OFFSET = 8;
const GAP = 18;
const PAD = 4;

const styles = stylex.create({
  name: {
    fill: { default: grasp.text, [media.forced]: "CanvasText" },
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    dominantBaseline: "central",
  },
  quiet: { fill: { default: grasp.muted, [media.forced]: "GrayText" } },
});

type Row = Readonly<Record<string, string | number>>;

/** Each series' last row with a number, and that number. */
const endOf = (data: readonly Row[], key: string) => {
  const row = data.findLast((each) => typeof each[key] === "number");
  return row === undefined ? null : { row, value: Number(row[key]) };
};

const namesOf = (config: ChartConfig, keys: readonly string[]) =>
  keys.map((key) => config[key]?.label ?? key);

export const ChartLabels = () => {
  const { config, data = [], xKey, looks = {}, setRoom } = useChart();
  const x = useXAxisScale();
  const y = useYAxisScale();
  const plot = usePlotArea();
  // The lines ChartLine says it draws; until they have said, every series.
  const drawn = Object.keys(looks);
  const keys = drawn.length > 0 ? drawn : Object.keys(config);
  const names = namesOf(config, keys);
  // Each name as this engine draws it, in the names' own type.
  const boxes = measureText(names, stylex.props(styles.name).className);
  const longest = Math.max(0, ...boxes.map((box) => box.width));
  const gap = Math.max(GAP, ...boxes.map((box) => box.height + 2));
  // The room at the right, kept by the chart, for the longest name.
  useEffect(() => {
    setRoom?.(longest + OFFSET + PAD);
    return () => {
      setRoom?.(0);
    };
  }, [setRoom, longest]);
  if (x === undefined || y === undefined || plot === undefined) {
    return null;
  }
  const ends = keys.map((key) => {
    const end = endOf(data, key);
    return end === null
      ? null
      : { key, x: x(end.row[xKey]) ?? 0, y: y(end.value) ?? 0 };
  });
  const shown = ends.filter((end) => end !== null);
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
          x={end.x + OFFSET}
          y={placed[index]}
          {...stylex.props(
            styles.name,
            looks[end.key] === "quiet" && styles.quiet
          )}
        >
          {config[end.key]?.label ?? end.key}
        </text>
      ))}
    </g>
  );
};
