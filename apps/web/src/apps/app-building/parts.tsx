// What is drawn inside each piece App building puts together: abstract lines, dots and bars, never
// words, so it never reads as a picture of a real product. The kind decides their shape.
import * as stylex from "@stylexjs/stylex";

import type { PieceKind } from "./layouts.ts";
import { blocks, delays, styles } from "./styles.ts";

interface PartsProps {
  still: boolean;
}

type PartStyle = stylex.StyleXStyles;

interface LineProps extends PartsProps {
  /** Its width, or its shape (a dot, a square). */
  shape: PartStyle;
  /** How many beats after the piece it comes in. */
  at: number;
  strong?: boolean;
  extra?: PartStyle;
}

const Line = ({ still, shape, at, strong = false, extra }: LineProps) => (
  <span
    {...stylex.props(
      styles.part,
      strong ? blocks.strong : blocks.part,
      shape,
      extra,
      delays[at],
      still && styles.still
    )}
  />
);

const Bar = (props: PartsProps) => (
  <>
    <Line {...props} shape={styles.square} at={1} strong />
    <Line {...props} shape={styles.w20} at={2} />
    <Line {...props} shape={styles.dot} at={3} extra={styles.push} />
    <Line {...props} shape={styles.dot} at={3} />
    <Line {...props} shape={styles.dot} at={4} strong />
  </>
);

const sideLines = [styles.w70, styles.w45, styles.w60, styles.w85, styles.w45];

const Side = (props: PartsProps) => (
  <>
    {sideLines.map((shape, index) => (
      <Line
        key={index}
        {...props}
        shape={shape}
        at={index + 1}
        strong={index === 0}
      />
    ))}
  </>
);

const Card = (props: PartsProps) => (
  <>
    <Line {...props} shape={styles.w45} at={1} />
    <Line {...props} shape={styles.w60} at={2} strong extra={styles.thick} />
    <Line {...props} shape={styles.w85} at={3} extra={styles.thin} />
  </>
);

const heights = [
  styles.h45,
  styles.h70,
  styles.h55,
  styles.h85,
  styles.h30,
  styles.h100,
  styles.h70,
];

const Chart = ({ still }: PartsProps) => (
  <>
    {heights.map((height, index) => (
      <span
        key={index}
        {...stylex.props(
          styles.column,
          blocks.strong,
          height,
          delays[Math.min(index, 5)],
          still && styles.still
        )}
      />
    ))}
  </>
);

const cells = [styles.w30, styles.w20, styles.w20];

const Table = (props: PartsProps) => (
  <>
    {[0, 1, 2, 3, 4].map((row) => (
      <span key={row} {...stylex.props(styles.row)}>
        {cells.map((shape, index) => (
          <Line
            key={index}
            {...props}
            shape={shape}
            at={Math.min(row + 1, 5)}
            strong={row === 0}
            extra={index === 0 ? null : styles.thin}
          />
        ))}
      </span>
    ))}
  </>
);

/** The parts of one piece, by its kind. */
export const Parts = ({ kind, ...props }: PartsProps & { kind: PieceKind }) => {
  if (kind === "bar") {
    return <Bar {...props} />;
  }
  if (kind === "side") {
    return <Side {...props} />;
  }
  if (kind === "card") {
    return <Card {...props} />;
  }
  if (kind === "chart") {
    return <Chart {...props} />;
  }
  return <Table {...props} />;
};

/** How a piece is laid out inside, by its kind. */
export const kindStyles = {
  bar: styles.bar,
  side: styles.side,
  card: styles.card,
  chart: styles.chart,
  table: styles.table,
} as const;
