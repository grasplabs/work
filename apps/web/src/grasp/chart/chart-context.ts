// What a Chart tells its parts: the series' names, the key along the bottom, and the prefix for the
// ids of its patterns and clip paths, so two charts on one page never share one.
"use client";

import { createContext, useContext } from "react";

/** One series: its name, as a legend, a tooltip and the table say it. */
export interface ChartSeries {
  /** The series' name, in sentence case ("Tickets solved"). */
  label: string;
}

/** The series a chart draws, by the key each holds in a data point. */
export type ChartConfig = Record<string, ChartSeries>;

export interface ChartContextValue {
  config: ChartConfig;
  xKey: string;
  id: string;
  /** The live region the tooltip's words are said in, outside the drawing. */
  live: HTMLElement | null;
  /** Whether it draws bars: then no hover line, which would run through a bar. */
  bars: boolean;
  /** A ChartBar says it is there, so the chart knows it draws bars. */
  setBars?: (bars: boolean) => void;
  /** The rows, for a part that reads them beside Recharts (the names at the lines' ends). */
  data?: readonly Record<string, string | number>[];
  /** The room kept at the drawing's right for the names at the lines' ends, in CSS pixels. */
  setRoom?: (room: number) => void;
  /** How each ChartLine is drawn, by its series, so its name at the end matches it. */
  looks?: Readonly<Record<string, ChartLineLook>>;
  setLook?: (series: string, look: ChartLineLook) => void;
  /** A part that writes values (a y axis, a tooltip) gives its format, so the chart's table writes them alike. */
  setValueFormat?: (format: (value: number) => string) => void;
}

/** How a ChartLine is drawn: told apart by weight and dash, never by colour alone. */
export type ChartLineLook = "solid" | "dashed" | "dotted" | "thin" | "quiet";

export const ChartContext = createContext<ChartContextValue>({
  config: {},
  xKey: "",
  id: "chart",
  live: null,
  bars: false,
});

export const useChart = () => useContext(ChartContext);
