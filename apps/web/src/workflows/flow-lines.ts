// The lines between the blocks of a drawing, worked out from where the
// blocks stand (prototype `lib/flow-lines.ts`). Pure: the drawing measures
// its blocks and draws what this says. Here the blocks are a workflow's
// named parts, drawn as frames stacked or side by side: two frames on one
// row get a straight line; where the next frame starts a new row the
// line goes out of the row, under it, back to the start and down into the
// frame; frames side by side at different heights turn in the room
// between them, never along the next frame's own edge.

/** A block of the drawing by its edges, in the pixels of what the lines are drawn over. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const lines = {
  /** The room between a block's edge and the line that meets it. */
  gap: 3,
  /** How far a line runs out of a block before it turns down, and how far before a block it comes down to it. */
  lead: 26,
  /** How round a turn is. */
  round: 16,
  /** How far under a row the line back runs. */
  under: 20,
} as const;

/** One line to draw: its name, which it keeps while it is the same line, and its path. */
export interface Drawn {
  key: string;
  d: string;
  /** Its place in the chain, for when it comes onto the page. */
  order: number;
}

type Point = readonly [number, number];

const half = (value: number): number => Math.round(value * 2) / 2;

const middle = (box: Box): number => (box.top + box.bottom) / 2;

/** `points` without a point said twice in a row. */
const distinct = (points: readonly Point[]): Point[] =>
  points.filter((point, index) => {
    const before = points[index - 1];
    return (
      before === undefined || point[0] !== before[0] || point[1] !== before[1]
    );
  });

/** The rounded turn at `at`, between `from` and `to`, at most `radius` round. */
const turn = (from: Point, at: Point, to: Point, radius: number): string => {
  const [px, py] = from;
  const [x, y] = at;
  const [nx, ny] = to;
  const before = Math.hypot(x - px, y - py);
  const after = Math.hypot(nx - x, ny - y);
  const fromX = x - ((x - px) / before) * radius;
  const fromY = y - ((y - py) / before) * radius;
  const toX = x + ((nx - x) / after) * radius;
  const toY = y + ((ny - y) / after) * radius;
  return ` L ${half(fromX)} ${half(fromY)} Q ${half(x)} ${half(y)} ${half(toX)} ${half(toY)}`;
};

/**
 * A line through `points`, straight between them and round at every turn.
 * A turn is never rounder than the two stretches it joins have room for:
 * a stretch between two turns is shared by both, one at an end of the line
 * is the turn's alone.
 */
export const route = (
  points: readonly Point[],
  round: number = lines.round
): string => {
  const path = distinct(points);
  const [first] = path;
  if (first === undefined) {
    return "";
  }
  const last = path.length - 1;
  let d = `M ${half(first[0])} ${half(first[1])}`;
  for (let index = 1; index < last; index += 1) {
    const from = path[index - 1] ?? first;
    const at = path[index] ?? first;
    const to = path[index + 1] ?? at;
    const before = Math.hypot(at[0] - from[0], at[1] - from[1]);
    const after = Math.hypot(to[0] - at[0], to[1] - at[1]);
    const radius = Math.min(
      round,
      index === 1 ? before : before / 2,
      index + 1 === last ? after : after / 2
    );
    d +=
      radius < 0.5
        ? ` L ${half(at[0])} ${half(at[1])}`
        : turn(from, at, to, radius);
  }
  const end = path[last];
  if (last > 0 && end !== undefined) {
    d += ` L ${half(end[0])} ${half(end[1])}`;
  }
  return d;
};

/** One block of the chain, as the lines need it. */
export interface Placed {
  id: string;
  box: Box;
  /** The foot of the row it stands in: the lowest edge of what stands beside it. */
  foot: number;
  /** Its place in the chain. */
  order: number;
  /** The frame it stands in, where the drawing has frames. */
  frame?: Box;
}

/** Whether `b` stands to the right of `a`, on its row or at another height. */
const isBeside = (a: Box, b: Box): boolean => b.left >= a.right - 1;

/**
 * Where a line to a block further right turns up or down to its height:
 * just before it, or, where it is the first block of the next frame, in
 * the room between the two frames.
 */
const turnBefore = (a: Placed, b: Placed): number =>
  a.frame !== undefined && b.frame !== undefined && b.frame.left > a.frame.right
    ? (a.frame.right + b.frame.left) / 2
    : b.box.left - lines.lead;

/** To a block further right at another height: along, up or down, and in. */
const sideways = (a: Placed, b: Placed): string => {
  const from = middle(a.box);
  const to = middle(b.box);
  if (Math.abs(from - to) < 2) {
    return route([
      [a.box.right + lines.gap, from],
      [b.box.left - lines.gap, from],
    ]);
  }
  const via = turnBefore(a, b);
  return route([
    [a.box.right + lines.gap, from],
    [via, from],
    [via, to],
    [b.box.left - lines.gap, to],
  ]);
};

/** The line from `a` to `b`, the next block of the chain. */
const wireTo = (a: Placed, b: Placed): string => {
  if (isBeside(a.box, b.box)) {
    const oneRow = b.box.top < a.box.bottom && b.box.bottom > a.box.top;
    return oneRow
      ? route([
          [a.box.right + lines.gap, middle(a.box)],
          [b.box.left - lines.gap, middle(a.box)],
        ])
      : sideways(a, b);
  }
  const from = middle(a.box);
  const to = middle(b.box);
  const out = a.box.right + lines.lead;
  const down = b.box.left - lines.lead;
  // Under the row it leaves, and never nearer the next row than the row
  // it leaves: rows that stand close have it in their middle.
  const back =
    a.foot + Math.max(4, Math.min(lines.under, (b.box.top - a.foot) / 2));
  return route([
    [a.box.right + lines.gap, from],
    [out, from],
    [out, back],
    [down, back],
    [down, to],
    [b.box.left - lines.gap, to],
  ]);
};

/** The lines between the blocks of one chain, in its order. */
export const flowWires = (chain: readonly Placed[]): Drawn[] =>
  chain.flatMap((a, index) => {
    const b = chain[index + 1];
    return b === undefined
      ? []
      : [{ key: `to:${b.id}`, d: wireTo(a, b), order: b.order - 0.5 }];
  });
