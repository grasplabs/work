// What the stage shows at one step of the build: which pieces stand, where they stand, and where
// each cursor is. Pure: the same round, layout and step always give the same picture.
import {
  AFTER,
  builderOf,
  firstLayout,
  layouts,
  nextLayout,
  orderOf,
  phaseAt,
  piecesOf,
  pointOf,
  swapOffset,
} from "./layouts";
import type { Phase, Piece } from "./layouts";

/** Where the build stands: its round, that round's layout, and the step within it. */
export interface At {
  round: number;
  layout: number;
  step: number;
}

/** A piece on the stage. */
export interface Shown {
  piece: Piece;
  index: number;
  moved: { x: number; y: number };
  cleared: boolean;
}

/** A cursor on the stage: the point it stands on, and whether it presses there at this step. */
export interface Hand {
  x: number;
  y: number;
  pressing: boolean;
}

// The first round opens two steps in: its frame (the bar and the piece after it) stands as the
// stage appears and a third piece is being placed, so the first second already shows the idea, and
// a build of ten seconds sees a whole interface made.
const OPENING = 2;

/** Where the build opens: the first round, a little way in. */
export const startAt = (seed: number): At => ({
  round: 0,
  layout: firstLayout(seed),
  step: OPENING,
});

/** The step after this one: the next in the round, or the first of the next round. */
export const advance = (at: At, seed: number): At => {
  const last = piecesOf(at.layout, seed, at.round).length + AFTER - 1;
  if (at.step < last) {
    return { ...at, step: at.step + 1 };
  }
  const round = at.round + 1;
  return { round, layout: nextLayout(at.layout, seed, round), step: 0 };
};

const REST = { x: 50, y: 50 };

// The point a cursor stands on while it builds: the next piece it builds, else the last it built.
const builderPoint = (
  pieces: readonly Piece[],
  order: readonly number[],
  step: number,
  cursor: number,
  cursors: number
) => {
  const mine = order.filter((index) => {
    const piece = pieces[index];
    return piece !== undefined && builderOf(piece.kind, cursors) === cursor;
  });
  const position = (index: number) => order.indexOf(index);
  const next = mine.find((index) => position(index) >= step);
  const last = mine.findLast((index) => position(index) < step);
  const piece = pieces[next ?? last ?? -1];
  return piece === undefined ? REST : pointOf(piece);
};

const handOf = (
  pieces: readonly Piece[],
  order: readonly number[],
  at: At,
  phase: Phase,
  cursor: number,
  cursors: number
): Hand => {
  const swap = layouts[at.layout]?.swap ?? [0, 0];
  if (cursor !== 0 || phase === "build") {
    const building = pieces[order[at.step] ?? -1];
    const pressing =
      phase === "build" &&
      building !== undefined &&
      builderOf(building.kind, cursors) === cursor;
    return {
      ...builderPoint(
        pieces,
        order,
        Math.min(at.step, order.length),
        cursor,
        cursors
      ),
      pressing,
    };
  }
  // The layout cursor takes one piece to the other's place: it reaches it, then carries it there.
  const target = pieces[phase === "reach" ? swap[0] : swap[1]];
  return {
    ...(target === undefined ? REST : pointOf(target)),
    pressing: phase === "reach",
  };
};

const piecesShown = (
  pieces: readonly Piece[],
  order: readonly number[],
  at: At,
  phase: Phase
): Shown[] => {
  if (phase === "empty") {
    return [];
  }
  const swap = layouts[at.layout]?.swap ?? [0, 0];
  const moved = phase === "swap" || phase === "rest" || phase === "clear";
  return pieces.flatMap((piece, index) => {
    if (phase === "build" && order.indexOf(index) > at.step) {
      return [];
    }
    return [
      {
        piece,
        index,
        moved: moved ? swapOffset(pieces, index, swap) : { x: 0, y: 0 },
        cleared: phase === "clear",
      },
    ];
  });
};

/**
 * How far apart two cursors stand, as shares of the stage: more than a name tag's width across, or
 * more than a cursor and its tag's height down, on the smallest stage (280px wide, about 250 tall).
 */
export const APART = { x: 26, y: 16 };

const taken = (x: number, y: number, placed: readonly Hand[]) =>
  placed.some(
    (other) =>
      Math.abs(x - other.x) < APART.x && Math.abs(y - other.y) < APART.y
  );

// Where a cursor that stands too close to another goes instead: down by a tag's height at a time,
// back to the top when it would leave the stage, until it stands clear.
const clearOf = (hand: Hand, placed: readonly Hand[]): Hand => {
  let { y } = hand;
  for (let tries = 0; tries < 8 && taken(hand.x, y, placed); tries += 1) {
    const down = y + APART.y;
    y = down > 90 ? 10 + (down - 90) : down;
  }
  return { x: hand.x, y, pressing: hand.pressing };
};

/**
 * The cursors, none on top of another: two that would stand on the same piece (one built it, the
 * other came to move it) are set apart, so no name tag covers another. A cursor that is pressing
 * stays on its piece; the others give way.
 */
export const apart = (hands: readonly Hand[]): Hand[] => {
  const order = hands
    .map((_, index) => index)
    .toSorted(
      (a, b) =>
        Number(hands[b]?.pressing === true) -
        Number(hands[a]?.pressing === true)
    );
  const placed = new Map<number, Hand>();
  const standing: Hand[] = [];
  for (const index of order) {
    const hand = hands[index];
    if (hand !== undefined) {
      const clear = clearOf(hand, standing);
      placed.set(index, clear);
      standing.push(clear);
    }
  }
  return hands.map((hand, index) => placed.get(index) ?? hand);
};

/** The stage at one step: its pieces and its cursors. */
export const planOf = (at: At, seed: number, cursors: number) => {
  const pieces = piecesOf(at.layout, seed, at.round);
  const order = orderOf(pieces, seed, at.round);
  const phase = phaseAt(at.step, pieces.length);
  const hands = Array.from({ length: cursors }, (_, cursor) =>
    handOf(pieces, order, at, phase, cursor, cursors)
  );
  return { shown: piecesShown(pieces, order, at, phase), hands: apart(hands) };
};

/** The still for reduced motion: the first layout, built, its cursors resting on their last pieces. */
export const stillOf = (seed: number, cursors: number) => {
  const layout = firstLayout(seed);
  const pieces = piecesOf(layout, seed, 0);
  const order = orderOf(pieces, seed, 0);
  const shown = pieces.map((piece, index) => ({
    piece,
    index,
    moved: { x: 0, y: 0 },
    cleared: false,
  }));
  const hands = Array.from({ length: cursors }, (_, cursor) => ({
    ...builderPoint(pieces, order, order.length, cursor, cursors),
    pressing: false,
  }));
  return { shown, hands: apart(hands) };
};
