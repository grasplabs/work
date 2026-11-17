// The sums behind ChartSpark: where each value stands in a drawing whose width is 100 units (the
// SVG stretches it across its box, and its strokes do not stretch) and whose height is the
// drawing's own in CSS pixels, so a level line sits on a whole pixel. Pure, so it is tested
// (scripts/chart-layout.test.ts).

/** The drawing's width in its own units: x runs 0 to 100, whatever its box. */
export const SPAN = 100;

export interface SparkPoint {
  x: number;
  y: number;
}

export interface SparkShape {
  points: SparkPoint[];
  /** Where zero stands, when the series crosses it; else null and no zero line is drawn. */
  zero: number | null;
  /** The floor an area under the line fills down to: the drawing's foot, under every segment. */
  floor: number;
  /** The highest point's height, where an area's fade starts. */
  top: number;
}

const finite = (values: readonly number[]) =>
  values.filter((value) => Number.isFinite(value));

/**
 * Each value's place, from `pad` to `height - pad` down the drawing, the highest at the top. One
 * value, or all alike, draw a straight line across the middle: never an error.
 */
export const sparkShape = (
  values: readonly number[],
  height: number,
  pad: number
): SparkShape => {
  const shown = finite(values);
  const middle = height / 2;
  if (shown.length === 0) {
    return { points: [], zero: null, floor: height, top: height };
  }
  const min = Math.min(...shown);
  const max = Math.max(...shown);
  // A wobble of a few per cent is drawn as one: the drawn range is at least a sixth of the largest
  // value's size, centred on the values, so 31, 32, 31 reads nearly flat and not as a zigzag.
  const least = Math.max(Math.abs(min), Math.abs(max)) / 6;
  const range = Math.max(max - min, least);
  const top = (max + min) / 2 + range / 2;
  const yOf = (value: number) =>
    max === min ? middle : pad + ((top - value) / range) * (height - 2 * pad);
  const points =
    shown.length === 1
      ? [
          { x: 0, y: middle },
          { x: SPAN, y: middle },
        ]
      : shown.map((value, index) => ({
          x: (index / (shown.length - 1)) * SPAN,
          y: yOf(value),
        }));
  const crosses = min < 0 && max > 0;
  // A level line on a whole pixel and a half, so its one pixel is sharp.
  const zero = crosses ? Math.round(yOf(0)) + 0.5 : null;
  return {
    points,
    zero,
    floor: height,
    top: Math.min(...points.map((point) => point.y)),
  };
};

const round = (value: number) => Math.round(value * 100) / 100;

/** The line through the points, as an SVG path. */
export const linePath = (points: readonly SparkPoint[]): string =>
  points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${round(point.x)},${round(point.y)}`
    )
    .join("");

/** The area under the line down to `floor`, as an SVG path. */
export const areaPath = (
  points: readonly SparkPoint[],
  floor: number
): string => {
  const first = points.at(0);
  const last = points.at(-1);
  if (first === undefined || last === undefined) {
    return "";
  }
  return `${linePath(points)}L${round(last.x)},${round(floor)}L${round(first.x)},${round(floor)}Z`;
};

/** The one point a spark marks, if any: the last, the lowest or the highest (the first of equals). */
export const markOf = (
  values: readonly number[],
  mark: "last" | "min" | "max" | "none"
): number | null => {
  const shown = finite(values);
  if (mark === "none" || shown.length === 0) {
    return null;
  }
  if (mark === "last") {
    return shown.length - 1;
  }
  const target = mark === "min" ? Math.min(...shown) : Math.max(...shown);
  return shown.indexOf(target);
};

/** The point nearest a place across the drawing, 0 to 1, for a pointer over it. */
export const nearestOf = (count: number, across: number): number =>
  count <= 1
    ? 0
    : Math.min(count - 1, Math.max(0, Math.round(across * (count - 1))));
