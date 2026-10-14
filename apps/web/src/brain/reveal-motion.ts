/**
 * The maths of the dots that fly out of the brain and build a page: which dot goes where, and how
 * it eases. Kept apart from the drawing, so it can be tested. Ported from the prototype
 * (grasplabs/prototype, packages/grasp: lib/reveal-motion.ts).
 */

/* oxlint-disable no-bitwise, unicorn/prefer-math-trunc -- a Hilbert curve and a seeded random are 32-bit integer arithmetic, as the prototype's: Math.trunc would change their numbers */

/** Points, as two lists of coordinates. */
export interface Points {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
}

const at = (values: ArrayLike<number>, index: number): number =>
  values[index] ?? 0;

/**
 * Where a point falls along a Hilbert curve over the unit square, split into 2^order cells a
 * side: points near each other stay near each other along the curve.
 */
export const curveIndex = (x: number, y: number, order = 8): number => {
  const n = 1 << order;
  let px = Math.min(n - 1, Math.max(0, Math.floor(x * n)));
  let py = Math.min(n - 1, Math.max(0, Math.floor(y * n)));
  let index = 0;
  for (let s = n >> 1; s > 0; s >>= 1) {
    const rx = (px & s) > 0 ? 1 : 0;
    const ry = (py & s) > 0 ? 1 : 0;
    index += s * s * ((3 * rx) ^ ry);
    // Turn the quadrant, so the curve runs on unbroken into the next one.
    if (ry === 0) {
      if (rx === 1) {
        px = n - 1 - px;
        py = n - 1 - py;
      }
      const swap = px;
      px = py;
      py = swap;
    }
  }
  return index;
};

/** The order of points along the curve, each set measured within its own bounds. */
const alongCurve = (points: Points): number[] => {
  const count = points.x.length;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (let index = 0; index < count; index += 1) {
    left = Math.min(left, at(points.x, index));
    right = Math.max(right, at(points.x, index));
    top = Math.min(top, at(points.y, index));
    bottom = Math.max(bottom, at(points.y, index));
  }
  const width = Math.max(right - left, 1e-6);
  const height = Math.max(bottom - top, 1e-6);
  const keys = Array.from({ length: count }, (_, index) =>
    curveIndex(
      (at(points.x, index) - left) / width,
      (at(points.y, index) - top) / height
    )
  );
  return Array.from({ length: count }, (_, index) => index).toSorted(
    (a, b) => at(keys, a) - at(keys, b)
  );
};

/**
 * Which target each dot flies to, so the picture grows rather than scrambles: both are ordered
 * along the same curve, each within its own bounds, and matched by rank. A dot in the top left of
 * the brain lands in the top left of the page. With more dots than targets, the dots spread evenly
 * along the curve are matched and the rest get -1; with more targets than dots, the targets spread
 * evenly along the curve are used.
 */
export const pairAlongCurve = (dots: Points, targets: Points): Int32Array => {
  const pairs = new Int32Array(dots.x.length).fill(-1);
  const dotOrder = alongCurve(dots);
  const targetOrder = alongCurve(targets);
  const matched = Math.min(dotOrder.length, targetOrder.length);
  for (let rank = 0; rank < matched; rank += 1) {
    const dot = at(dotOrder, Math.floor((rank * dotOrder.length) / matched));
    const target = at(
      targetOrder,
      Math.floor((rank * targetOrder.length) / matched)
    );
    pairs[dot] = target;
  }
  return pairs;
};

export const clamp01 = (value: number): number =>
  Math.min(Math.max(value, 0), 1);

/** Fast out of the gate and slowing all the way in: a burst that settles. */
export const easeOut = (t: number): number => 1 - (1 - t) ** 2.2;

/** Under way from the first moment, though from standing still, and slowing all the way in: for what leaves at once and lands softly. */
export const glide = (t: number): number =>
  (1 - Math.cos(Math.PI * t ** 0.8)) / 2;

export const easeInCubic = (t: number): number => t * t * t;

export const easeInQuad = (t: number): number => t * t;

/** A small seeded random (mulberry32), so the same page builds the same way each time. */
export const seeded = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state + 0x6d_2b_79_f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
};
