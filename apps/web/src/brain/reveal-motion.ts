/* oxlint-disable no-bitwise, unicorn/prefer-math-trunc -- the Hilbert curve and the generator are integer bit arithmetic, kept as the prototype has them so they give the same numbers */
/**
 * The maths of the way into the platform, where the brain's dots fly out and build the page:
 * which dot goes where, and how it eases. Kept apart from the drawing, so it can be tested. Ported
 * whole from the prototype (grasplabs/prototype, packages/grasp: lib/reveal-motion.ts); the
 * Integrations banner lays its fibres with `seeded`, so it must be this generator, not the chat
 * sign's.
 */

/** Points, as two lists of coordinates. */
export interface Points {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
}

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
  for (let at = 0; at < count; at += 1) {
    left = Math.min(left, points.x[at] ?? 0);
    right = Math.max(right, points.x[at] ?? 0);
    top = Math.min(top, points.y[at] ?? 0);
    bottom = Math.max(bottom, points.y[at] ?? 0);
  }
  const width = Math.max(right - left, 1e-6);
  const height = Math.max(bottom - top, 1e-6);
  const keys = Array.from({ length: count }, (_, at) =>
    curveIndex(
      ((points.x[at] ?? 0) - left) / width,
      ((points.y[at] ?? 0) - top) / height
    )
  );
  return Array.from({ length: count }, (_, at) => at).toSorted(
    (a, b) => (keys[a] ?? 0) - (keys[b] ?? 0)
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
    const dot = dotOrder[Math.floor((rank * dotOrder.length) / matched)];
    const target =
      targetOrder[Math.floor((rank * targetOrder.length) / matched)];
    if (dot !== undefined && target !== undefined) {
      pairs[dot] = target;
    }
  }
  return pairs;
};

export const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);
/** Fast out of the gate and slowing all the way in: a burst that settles. */
export const easeOut = (t: number) => 1 - (1 - t) ** 2.2;
/** Under way from the first moment, though from standing still, and slowing all the way in: for what leaves at once and lands softly. */
export const glide = (t: number) => (1 - Math.cos(Math.PI * t ** 0.8)) / 2;
export const easeInCubic = (t: number) => t * t * t;
export const easeInQuad = (t: number) => t * t;

/** A small seeded random, so the same page builds the same way each time. */
export const seeded = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};
