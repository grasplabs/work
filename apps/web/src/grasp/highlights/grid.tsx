// HighlightsGrid: several highlights read as one row (highlight.tsx), after Palermo's
// HighlightsGrid: one box with the system's edge, its cells parted by hairlines. It takes at
// most two columns under 768px.
import * as stylex from "@stylexjs/stylex";

import { useHighlightBody } from "./highlight";
import type { HighlightProps } from "./highlight";
import { highlightStyles as styles } from "./styles";

/** Every prop a HighlightsGrid takes. */
export interface HighlightsGridProps {
  /** The highlights, in reading order: each takes a Highlight's props. */
  items: HighlightProps[];
  /** What the row is about, for a screen reader and an agent ("This month"). */
  "aria-label": string;
  /**
   * How many stand in a row on a wide screen. Leave it out to fit them all, up to 4.
   */
  columns?: 1 | 2 | 3 | 4;
  /**
   * Every highlight is still loading.
   * @default false
   */
  loading?: boolean;
}

// How many columns the last highlight takes: what its row leaves, at the wide count and at the two
// columns under 768px, so no place in the last row stands empty.
const spanOf = (columns: 1 | 2 | 3 | 4, count: number) => {
  const left = (wide: number) =>
    count % wide === 0 ? 1 : wide - (count % wide) + 1;
  const wide = left(columns);
  const narrow = columns >= 3 ? left(2) : 1;
  switch (`${wide}-${narrow}`) {
    case "2-1": {
      return styles.wide2;
    }
    case "3-1": {
      return styles.wide3;
    }
    case "3-2": {
      return styles.wide3narrow2;
    }
    case "4-1": {
      return styles.wide4;
    }
    case "4-2": {
      return styles.wide4narrow2;
    }
    case "1-2": {
      return styles.narrow2;
    }
    default: {
      return null;
    }
  }
};

const Cell = ({
  item,
  loading,
  span,
}: {
  item: HighlightProps;
  loading: boolean;
  span: ReturnType<typeof spanOf> | null;
}) => {
  const { id, body } = useHighlightBody({
    ...item,
    loading: item.loading === true || loading,
  });
  return (
    <li aria-labelledby={id} {...stylex.props(styles.cell, span)}>
      <div {...stylex.props(styles.card)}>{body}</div>
    </li>
  );
};

const columnStyles = {
  1: styles.cols1,
  2: styles.cols2,
  3: styles.cols3,
  4: styles.cols4,
} as const;

/** As many columns as highlights, from one to four. */
const columnsFor = (count: number): 1 | 2 | 3 | 4 => {
  if (count <= 1) {
    return 1;
  }
  if (count === 2) {
    return 2;
  }
  if (count === 3) {
    return 3;
  }
  return 4;
};

/** The row: one box, hairlines between its highlights. */
export const HighlightsGrid = ({
  items,
  "aria-label": ariaLabel,
  columns,
  loading = false,
}: HighlightsGridProps) => {
  const count = columns ?? columnsFor(items.length);
  return (
    <ul
      aria-label={ariaLabel}
      aria-busy={loading || undefined}
      {...stylex.props(styles.grid, columnStyles[count])}
    >
      {items.map((item, index) => (
        // Two highlights may share a title; their place tells them apart.
        <Cell
          key={`${index}-${item.title}`}
          item={item}
          loading={loading}
          span={index === items.length - 1 ? spanOf(count, items.length) : null}
        />
      ))}
    </ul>
  );
};
