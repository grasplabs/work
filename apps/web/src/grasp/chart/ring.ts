// The sums behind ChartRing: each part's arc with a clear gap between, and the outline of an
// arc. Pure, so they are tested (scripts/chart-layout.test.ts). Angles are in radians, from twelve o'clock, clockwise.

export interface Arc {
  /** Where it starts and ends, gaps taken out. */
  from: number;
  to: number;
  /** The middle of its share, for its name and its lift. */
  middle: number;
  /** Its share of the whole, 0 to 1. */
  share: number;
}

const TURN = Math.PI * 2;

/**
 * The arcs of `values` round a ring, in order, out of `whole` (their sum unless a larger whole is
 * given, as for a single share). A clear gap of `gap` radians stands between each two, and
 * between the last and the empty track; an arc too thin for its gap keeps a sliver.
 */
export const arcsOf = (
  values: readonly number[],
  gap: number,
  whole?: number
): Arc[] => {
  const sum = values.reduce((total, value) => total + Math.max(0, value), 0);
  const of = Math.max(sum, whole ?? 0);
  if (of <= 0) {
    return values.map(() => ({ from: 0, to: 0, middle: 0, share: 0 }));
  }
  const parts = values.length + (of > sum ? 1 : 0);
  const half = parts > 1 ? gap / 2 : 0;
  let start = 0;
  return values.map((value) => {
    const share = Math.max(0, value) / of;
    const sweep = share * TURN;
    const end = start + sweep;
    const pad = Math.min(half, sweep / 2 - 0.0005);
    const arc = {
      from: start + Math.max(0, pad),
      to: end - Math.max(0, pad),
      middle: start + sweep / 2,
      share,
    };
    start = end;
    return arc;
  });
};

/** The empty track after the arcs, when a whole larger than their sum is given. */
export const restOf = (
  arcs: readonly Arc[],
  gap: number
): { from: number; to: number } | null => {
  const used = arcs.reduce((total, arc) => total + arc.share, 0);
  if (used >= 0.9999) {
    return null;
  }
  return { from: used * TURN + gap / 2, to: TURN - gap / 2 };
};

/** A point at `radius` and `angle` round (`cx`, `cy`). */
export const pointAt = (
  cx: number,
  cy: number,
  radius: number,
  angle: number
) => ({
  x: cx + radius * Math.sin(angle),
  y: cy - radius * Math.cos(angle),
});

const fixed = (value: number) => Math.round(value * 100) / 100;

/** The outline of a ring's arc, from `outer` to `inner` radius, as an SVG path. */
export const arcPath = (
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  from: number,
  to: number
): string => {
  const sweep = to - from;
  if (sweep <= 0) {
    return "";
  }
  // A whole turn is drawn as two halves: an arc cannot start and end at one point.
  if (sweep >= TURN - 0.0001) {
    return `${arcPath(cx, cy, outer, inner, 0, Math.PI)}${arcPath(cx, cy, outer, inner, Math.PI, TURN)}`;
  }
  const large = sweep > Math.PI ? 1 : 0;
  const a = pointAt(cx, cy, outer, from);
  const b = pointAt(cx, cy, outer, to);
  const c = pointAt(cx, cy, inner, to);
  const d = pointAt(cx, cy, inner, from);
  return `M${fixed(a.x)},${fixed(a.y)}A${outer},${outer} 0 ${large} 1 ${fixed(b.x)},${fixed(b.y)}L${fixed(c.x)},${fixed(c.y)}A${inner},${inner} 0 ${large} 0 ${fixed(d.x)},${fixed(d.y)}Z`;
};
