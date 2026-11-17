import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Progress } from "../grasp/progress/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

/** A share from nothing to all of it. */
const shareOf = (value: number, of: number): number =>
  of > 0 ? Math.min(Math.max(value / of, 0), 1) : 0;

const styles = stylex.create({
  // The words take the room they need, and the bars start in one line.
  list: {
    display: "grid",
    gridTemplateColumns:
      "minmax(0, max-content) minmax(5rem, 1fr) minmax(1.5rem, auto)",
    columnGap: grasp.space3,
    rowGap: grasp.space2,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  row: {
    display: "grid",
    gridColumn: "1 / -1",
    gridTemplateColumns: "subgrid",
    alignItems: "center",
  },
  label: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  value: {
    textAlign: "end",
    fontVariantNumeric: "tabular-nums",
  },
});

/**
 * A few things counted, as rows: what each is, a bar as long as its share
 * of the most, and the number.
 */
export const BarList = ({
  rows,
  label,
}: {
  rows: { id: string; label: ReactNode; value: number; shown?: string }[];
  label: string;
}) => {
  const most = Math.max(1, ...rows.map((row) => row.value));
  return (
    <ul aria-label={label} {...stylex.props(styles.list)}>
      {rows.map((row) => (
        <li key={row.id} {...stylex.props(styles.row)}>
          <span {...stylex.props(styles.label)}>
            <Text element="span" tone="muted">
              {row.label}
            </Text>
          </span>
          {/* The row's words and number say it: the bar is only seen. */}
          <span aria-hidden="true">
            <Progress
              label={label}
              showLabel={false}
              size="sm"
              value={shareOf(row.value, most) * 100}
            />
          </span>
          <span {...stylex.props(styles.value)}>
            <Text element="span">{row.shown ?? row.value}</Text>
          </span>
        </li>
      ))}
    </ul>
  );
};
