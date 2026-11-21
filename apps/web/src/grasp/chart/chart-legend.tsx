// ChartLegend: each series' name beside a swatch of how it is drawn, under the chart.
"use client";

import * as stylex from "@stylexjs/stylex";
import { Legend } from "recharts";
import type { LegendPayload } from "recharts";

import { grasp } from "../tokens/tokens.stylex";
import { useChart } from "./chart-context";

/** Every prop a ChartLegend takes. */
export type ChartLegendProps = Record<string, never>;

const styles = stylex.create({
  list: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: grasp.space4,
    margin: 0,
    paddingBlockStart: grasp.space3,
    paddingInline: 0,
    listStyle: "none",
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
  item: { display: "inline-flex", alignItems: "center", gap: grasp.space2 },
  swatch: {
    width: grasp.space3,
    height: grasp.space1,
    borderRadius: grasp.cornerPill,
    backgroundColor: grasp.chartLine,
  },
});

export const ChartLegend = () => {
  const { config } = useChart();
  const content = ({ payload }: { payload?: readonly LegendPayload[] }) => (
    <ul {...stylex.props(styles.list)}>
      {(payload ?? []).map((entry) => {
        const key = String(
          typeof entry.dataKey === "function" ? "" : (entry.dataKey ?? "")
        );
        return (
          <li key={key} {...stylex.props(styles.item)}>
            <span aria-hidden="true" {...stylex.props(styles.swatch)} />
            {config[key]?.label ?? key}
          </li>
        );
      })}
    </ul>
  );
  return <Legend content={content} />;
};
