// The interfaces App building puts together, and the order it builds them in. Plain data and pure
// functions: no randomness, so a seed and a count of rounds always give the same build.
//
// Each layout is a handful of pieces on a 100 by 100 frame (percentages of the stage): a top bar,
// a sidebar, cards, a chart, a table. One round builds a layout piece by piece, swaps two of its
// pieces of the same size, rests, clears and starts the next. The next layout is never the one
// before, may be mirrored, and its pieces come in an order mixed from the seed and the round.

/** What a piece is: it decides what is drawn inside it and which cursor builds it. */
export type PieceKind = "bar" | "side" | "card" | "chart" | "table";

/** One piece of a layout, in percentages of the stage. */
export interface Piece {
  kind: PieceKind;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A layout: its pieces, and the two of the same size that change places once it is built. */
export interface Layout {
  pieces: readonly Piece[];
  swap: readonly [number, number];
}

const bar: Piece = { kind: "bar", x: 3, y: 4, w: 94, h: 9 };

export const layouts: readonly Layout[] = [
  // A dashboard: a sidebar, three cards, a chart and a table.
  {
    pieces: [
      bar,
      { kind: "side", x: 3, y: 16, w: 18, h: 80 },
      { kind: "card", x: 24, y: 16, w: 23.6, h: 18 },
      { kind: "card", x: 48.7, y: 16, w: 23.6, h: 18 },
      { kind: "card", x: 73.4, y: 16, w: 23.6, h: 18 },
      { kind: "chart", x: 24, y: 37, w: 73, h: 30 },
      { kind: "table", x: 24, y: 70, w: 73, h: 26 },
    ],
    swap: [2, 4],
  },
  // A list and its detail: a sidebar, a long table, two cards and a chart beside it.
  {
    pieces: [
      bar,
      { kind: "side", x: 3, y: 16, w: 18, h: 80 },
      { kind: "table", x: 24, y: 16, w: 44, h: 80 },
      { kind: "card", x: 71, y: 16, w: 26, h: 24 },
      { kind: "card", x: 71, y: 43, w: 26, h: 24 },
      { kind: "chart", x: 71, y: 70, w: 26, h: 26 },
    ],
    swap: [3, 4],
  },
  // A board: three columns of cards over a table.
  {
    pieces: [
      bar,
      { kind: "card", x: 3, y: 16, w: 30.4, h: 22 },
      { kind: "card", x: 3, y: 41, w: 30.4, h: 22 },
      { kind: "card", x: 34.8, y: 16, w: 30.4, h: 22 },
      { kind: "chart", x: 34.8, y: 41, w: 30.4, h: 22 },
      { kind: "card", x: 66.6, y: 16, w: 30.4, h: 22 },
      { kind: "card", x: 66.6, y: 41, w: 30.4, h: 22 },
      { kind: "table", x: 3, y: 66, w: 94, h: 30 },
    ],
    swap: [1, 6],
  },
  // A report: a wide chart, two cards beside it, a table under both.
  {
    pieces: [
      bar,
      { kind: "chart", x: 3, y: 16, w: 62, h: 44 },
      { kind: "card", x: 68, y: 16, w: 29, h: 20.5 },
      { kind: "card", x: 68, y: 39.5, w: 29, h: 20.5 },
      { kind: "table", x: 3, y: 63, w: 94, h: 33 },
    ],
    swap: [2, 3],
  },
];

/** The cursors, by what they build: 0 lays out (the bar, the sidebar), 1 the data, 2 the words. */
export const builderOf = (kind: PieceKind, cursors: number) => {
  if (cursors <= 1 || kind === "bar" || kind === "side") {
    return 0;
  }
  if (kind === "chart" || kind === "table") {
    return 1;
  }
  return cursors >= 3 ? 2 : 1;
};

// A number mixed from a seed and a number: three rounds of squaring modulo a prime, so numbers
// next to each other end far apart. The same two always give the same result. Plain arithmetic,
// every product inside a safe integer.
const PRIME = 65_521;
const square = (value: number) => (value * value + 7919) % PRIME;
const mix = (seed: number, n: number) => {
  const start =
    ((Math.abs(Math.trunc(seed)) % PRIME) * 7919 +
      (n % PRIME) * 104_729 +
      12_345) %
    PRIME;
  return square(square(square(start)));
};

/** The layout of the round after this one: never the same one twice in a row. */
export const nextLayout = (current: number, seed: number, round: number) =>
  (current + 1 + (mix(seed, round) % (layouts.length - 1))) % layouts.length;

/** The first round's layout. */
export const firstLayout = (seed: number) => mix(seed, 0) % layouts.length;

/** The pieces of a round: its layout, mirrored on some rounds (the sidebar to the other side). */
export const piecesOf = (
  layout: number,
  seed: number,
  round: number
): readonly Piece[] => {
  const pieces = layouts[layout]?.pieces ?? [bar];
  const mirrored = mix(seed, round + 7919) % 2 === 1;
  return mirrored
    ? pieces.map((piece) => ({ ...piece, x: 100 - piece.x - piece.w }))
    : pieces;
};

/** The order a round builds its pieces in: the frame first (bar and sidebar), then the rest, mixed. */
export const orderOf = (
  pieces: readonly Piece[],
  seed: number,
  round: number
): readonly number[] => {
  const frame = pieces.flatMap((piece, index) =>
    piece.kind === "bar" || piece.kind === "side" ? [index] : []
  );
  const rest = pieces.flatMap((piece, index) =>
    piece.kind === "bar" || piece.kind === "side" ? [] : [index]
  );
  const mixed = rest
    .map((index) => ({ index, key: mix(seed, round * 64 + index + 1) }))
    .toSorted((a, b) => a.key - b.key)
    .map(({ index }) => index);
  const sideFirst = mix(seed, round * 64) % 2 === 1;
  return [...(sideFirst ? frame.toReversed() : frame), ...mixed];
};

/**
 * The steps the finished interface rests for: with eight pieces to build, the finished screen
 * stands for about half the round (ten steps of twenty), a calm rhythm. More is calmer; with the
 * beat (the app-building-beat token) it sets how long a round is.
 */
export const RESTS = 8;

/** The steps of a round after its pieces are built: reach, swap, the rests, clear, empty. */
export const AFTER = RESTS + 4;

/** Where a round stands at a step. */
export type Phase = "build" | "reach" | "swap" | "rest" | "clear" | "empty";

export const phaseAt = (step: number, count: number): Phase => {
  const after = step - count;
  if (after < 0) {
    return "build";
  }
  if (after === 0) {
    return "reach";
  }
  if (after === 1) {
    return "swap";
  }
  if (after < 2 + RESTS) {
    return "rest";
  }
  return after === 2 + RESTS ? "clear" : "empty";
};

/** The point a cursor presses on a piece: a little in from its start, near its middle. */
export const pointOf = (piece: Piece) => ({
  x: piece.x + piece.w * 0.32,
  y: piece.y + piece.h * 0.42,
});

/** The swap's move for a piece, as a share of its own size: to the other's place, or none. */
export const swapOffset = (
  pieces: readonly Piece[],
  index: number,
  swap: readonly [number, number]
) => {
  const [first, second] = swap;
  const partner = index === second ? first : -1;
  const other = index === first ? second : partner;
  const from = pieces[index];
  const to = pieces[other];
  if (from === undefined || to === undefined) {
    return { x: 0, y: 0 };
  }
  return {
    x: ((to.x - from.x) / from.w) * 100,
    y: ((to.y - from.y) / from.h) * 100,
  };
};
