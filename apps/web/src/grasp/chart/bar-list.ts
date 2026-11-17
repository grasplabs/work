// The sums behind ChartBarList: which rows come first, where zero stands on a bar's track, and the
// span each value takes. Pure, so they are tested (scripts/chart-layout.test.ts).

type Row = Readonly<Record<string, string | number>>;

/** A row's value for a key, as a number: anything that is not one is nothing. */
export const valueOf = (row: Row, key: string): number => {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

/** The rows, largest first by the first series (`value`), or as given. A copy: the data is not changed. */
export const orderRows = <T extends Row>(
  rows: readonly T[],
  key: string,
  order: "value" | "given"
): T[] =>
  order === "given"
    ? [...rows]
    : rows.toSorted((a, b) => valueOf(b, key) - valueOf(a, key));

/** The least and the most of every value, with zero always inside, so every bar starts at zero. */
export const extentOf = (
  rows: readonly Row[],
  keys: readonly string[]
): { min: number; max: number } => {
  const values = rows.flatMap((row) => keys.map((key) => valueOf(row, key)));
  return { min: Math.min(0, ...values), max: Math.max(0, ...values) };
};

/** A bar on a track `width` wide: where it starts, how wide it is, where zero is and which end is its tip. */
export interface Span {
  x: number;
  width: number;
  zero: number;
  /** Whether the tip (the value's end) is on the right: false for a value below zero. */
  rightward: boolean;
}

export const spanOf = (
  value: number,
  extent: { min: number; max: number },
  width: number
): Span => {
  const range = extent.max - extent.min;
  if (range <= 0 || width <= 0) {
    return { x: 0, width: 0, zero: 0, rightward: true };
  }
  const zero = (-extent.min / range) * width;
  const length = (Math.abs(value) / range) * width;
  return value >= 0
    ? { x: zero, width: length, zero, rightward: true }
    : { x: zero - length, width: length, zero, rightward: false };
};

/**
 * A bar's outline: square where it starts, its two corners at the tip rounded by `corner` (less
 * when the bar is too short or thin for it), as an SVG path.
 */
export const barPath = (
  span: Span,
  y: number,
  height: number,
  corner: number
): string => {
  const { x, width, rightward } = span;
  const r = Math.max(0, Math.min(corner, width, height / 2));
  const right = x + width;
  const bottom = y + height;
  if (rightward) {
    return `M${x},${y}H${right - r}A${r},${r} 0 0 1 ${right},${y + r}V${bottom - r}A${r},${r} 0 0 1 ${right - r},${bottom}H${x}Z`;
  }
  return `M${right},${y}V${bottom}H${x + r}A${r},${r} 0 0 1 ${x},${bottom - r}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}Z`;
};
