import { coarseScan } from "../brain/dot-shapes.ts";
import { leastCostPairs } from "./assign.ts";

// The figures Grasp's sign in the chat can take (grasplabs/prototype
// `lib/sign-figures.ts`): the head and the brain from the onboarding,
// printed on a few rows, and the signs it turns into while it works. All
// are printed on the same spacing, every other row half a step over as the
// onboarding prints. The sign is always the same dots: `signSlots` says
// where each of them goes in a figure, so that one figure flows into the
// next along the shortest ways. Pure numbers, computed once per figure and
// kept.

/**
 * A figure of the sign: Stephen's head; the brain; a pen over the line it
 * writes; lines of text; a workflow of two steps; a check mark; an
 * exclamation mark.
 */
export type SignFigure =
  | "head"
  | "brain"
  | "pen"
  | "lines"
  | "flow"
  | "check"
  | "alert";

export const SIGN_FIGURES: readonly SignFigure[] = [
  "head",
  "brain",
  "pen",
  "lines",
  "flow",
  "check",
  "alert",
];

/** One dot of a figure, as the figure is printed. */
export interface SignDot {
  /** Where it is, in a square from -1 to 1 with y up, and how far it stands out towards you. */
  x: number;
  y: number;
  z: number;
  /** How large it prints, 0 to 1. */
  ink: number;
  /** Which part of the figure it belongs to, in the order the figure is drawn: the pen's line is part 0 and the pen part 1. */
  part: number;
  /** How far along the whole figure it is, 0 to 1, in that same order: the way warmth travels through it. */
  along: number;
}

/** Dots across the square: enough for the head to be Stephen's, few enough that each dot still shows at the size of an icon. */
export const SIGN_COLUMNS = 23;
/** The distance between neighbouring dots, in the figure's units. */
export const SIGN_PITCH = 2 / SIGN_COLUMNS;

type Point = readonly [number, number];

/** A line through points, as thick as a pen: half its width, in the figure's units. */
interface Stroke {
  points: readonly Point[];
  width: number;
}

/** A filled round dot, or a filled box with round corners. */
type Solid =
  | { at: Point; radius: number }
  | { at: Point; half: Point; round: number };

/** One part of a drawing: lines, filled shapes, or both. Warmth runs through a drawing part by part. */
interface Part {
  strokes?: readonly Stroke[];
  solids?: readonly Solid[];
}

/**
 * How thick a sign's lines are, as half their width: `fine` prints two
 * rows of dots when it lies between two rows, `bold` three when it lies on
 * one.
 */
const fine = SIGN_PITCH * 0.8;
const bold = SIGN_PITCH * 1.3;

/** The height between two rows of dots, counted from the top: a line there prints on the row above it and the row below it alike. */
const between = (row: number): number => 1 - row * SIGN_PITCH;

/** Where the pen's point touches its line, and how far the pen travels along the line as it writes, either way from there. */
export const PEN_TIP = { x: -0.17, y: between(19) + 0.02, travel: 0.45 };
/** The line the pen writes, from where it starts to where it ends: as far as the pen's point comes. */
const penLine = { from: -0.66, to: 0.21, y: between(20) };

/** A point on the pen's middle line, from its point at 0 to its top at 1: it leans to the right. */
const penAt = (share: number): Point => [
  PEN_TIP.x + 0.5 * share,
  PEN_TIP.y + 1.24 * share,
];

const drawings: Record<
  Exclude<SignFigure, "head" | "brain">,
  readonly Part[]
> = {
  // The line being written, then the pen over it: its point on the line,
  // its body leaning to the right.
  pen: [
    {
      strokes: [
        {
          points: [
            [penLine.from, penLine.y],
            [penLine.to, penLine.y],
          ],
          width: fine,
        },
      ],
    },
    {
      // From its point up: it widens over the first third, like a
      // sharpened pencil, and is as wide from there on.
      strokes: [
        { points: [penAt(0), penAt(0.1)], width: SIGN_PITCH * 0.45 },
        { points: [penAt(0.1), penAt(0.2)], width: SIGN_PITCH * 0.95 },
        { points: [penAt(0.2), penAt(0.31)], width: SIGN_PITCH * 1.5 },
        { points: [penAt(0.31), penAt(1)], width: SIGN_PITCH * 2.1 },
      ],
    },
  ],
  // Lines of text, each a part, the last one short.
  lines: [4, 9, 14, 19].map((row, index) => ({
    strokes: [
      {
        points: [
          [-0.74, between(row)],
          [index === 3 ? 0.08 : 0.74, between(row)],
        ],
        width: fine,
      },
    ],
  })),
  // One step, the line out of it down and across, and the step it leads to.
  flow: [
    { solids: [{ at: [-0.42, 0.42], half: [0.29, 0.29], round: 0.1 }] },
    {
      strokes: [
        {
          points: [
            [-0.42, 0.13],
            [-0.42, -0.42],
            [0.13, -0.42],
          ],
          width: fine,
        },
      ],
    },
    { solids: [{ at: [0.42, -0.42], half: [0.29, 0.29], round: 0.1 }] },
  ],
  check: [
    {
      strokes: [
        {
          points: [
            [-0.62, -0.04],
            [-0.2, -0.5],
            [0.64, 0.5],
          ],
          width: bold,
        },
      ],
    },
  ],
  // The stroke of an exclamation mark, then its point.
  alert: [
    {
      strokes: [
        {
          points: [
            [0, 0.78],
            [0, -0.2],
          ],
          width: bold,
        },
      ],
    },
    { solids: [{ at: [0, -0.7], radius: 0.16 }] },
  ],
};

/** How far a point is from a stroke's middle line, and how far along the stroke the nearest point is, 0 to 1. */
const toStroke = (
  x: number,
  y: number,
  { points }: Stroke
): { far: number; along: number } => {
  const segments = points.slice(1).map((end, index) => {
    const start = points[index] ?? end;
    return {
      start,
      end,
      length: Math.hypot(end[0] - start[0], end[1] - start[1]),
    };
  });
  const total = segments.reduce((sum, { length }) => sum + length, 0);
  let far = Number.POSITIVE_INFINITY;
  let along = 0;
  let walked = 0;
  for (const { start, end, length } of segments) {
    const [ax, ay] = start;
    const [bx, by] = end;
    const t =
      length === 0
        ? 0
        : Math.min(
            1,
            Math.max(
              0,
              ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / (length * length)
            )
          );
    const off = Math.hypot(x - ax - (bx - ax) * t, y - ay - (by - ay) * t);
    if (off < far) {
      far = off;
      along = total === 0 ? 0 : (walked + length * t) / total;
    }
    walked += length;
  }
  return { far, along };
};

/** How far outside a filled shape a point is; inside, below zero. */
const toSolid = (x: number, y: number, solid: Solid): number => {
  if ("radius" in solid) {
    return Math.hypot(x - solid.at[0], y - solid.at[1]) - solid.radius;
  }
  const qx = Math.abs(x - solid.at[0]) - solid.half[0] + solid.round;
  const qy = Math.abs(y - solid.at[1]) - solid.half[1] + solid.round;
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
    Math.min(Math.max(qx, qy), 0) -
    solid.round
  );
};

/** Where a place is nearest a drawing: how far outside it, in which part, and how far along that part. */
const nearestOf = (
  x: number,
  y: number,
  parts: readonly Part[]
): { outside: number; part: number; within: number } => {
  let outside = Number.POSITIVE_INFINITY;
  let part = 0;
  let within = 0;
  for (const [index, each] of parts.entries()) {
    const strokes = each.strokes ?? [];
    for (const [order, stroke] of strokes.entries()) {
      const near = toStroke(x, y, stroke);
      if (near.far - stroke.width < outside) {
        outside = near.far - stroke.width;
        part = index;
        within = (order + near.along) / strokes.length;
      }
    }
    for (const solid of each.solids ?? []) {
      const far = toSolid(x, y, solid);
      if (far < outside) {
        outside = far;
        part = index;
        within = 0.5;
      }
    }
  }
  return { outside, part, within };
};

/** A drawing printed in dots: one per place on the rows it covers, as large as it is covered there. */
const print = (parts: readonly Part[]): SignDot[] => {
  const dots: SignDot[] = [];
  for (let row = 0; row < SIGN_COLUMNS; row += 1) {
    const y = 1 - (row + 0.5) * SIGN_PITCH;
    for (let column = 0; column < SIGN_COLUMNS; column += 1) {
      const x =
        -1 + (column + 0.5) * SIGN_PITCH + (row % 2 === 0 ? 0 : SIGN_PITCH / 2);
      const { outside, part, within } = nearestOf(x, y, parts);
      // Fully inked a little inside the edge, gone a little outside it:
      // the edge is a smaller dot, as in print.
      const ink = Math.min(1, Math.max(0, 0.5 - outside / (SIGN_PITCH * 0.55)));
      if (x <= 1 && ink >= 0.3) {
        // It bulges towards you a little in the middle, so it has a front
        // to turn.
        dots.push({
          x,
          y,
          z: 0.16 * Math.max(0, 1 - (x * x + y * y)),
          ink,
          part,
          along: (part + within) / parts.length,
        });
      }
    }
  }
  return dots;
};

/** The brain keeps this much of its size and its depth: seen so small it would otherwise fill the square to its corners and bulge out of it. */
const brainView = { size: 0.9, depth: 0.45 };

const figures = new Map<SignFigure, SignDot[]>();

const printed = (figure: SignFigure): SignDot[] => {
  if (figure === "head") {
    // Stephen from the onboarding, on the sign's rows: one part, top to
    // bottom, so warmth can run down him.
    return coarseScan({ kind: "head" }, SIGN_COLUMNS).map((dot) => ({
      x: dot.x,
      y: dot.y,
      z: dot.z,
      ink: dot.ink,
      part: 0,
      along: (1 - dot.y) / 2,
    }));
  }
  if (figure === "brain") {
    // The brain the onboarding ends on, seen from the same side: one part,
    // top to bottom.
    return coarseScan({ kind: "brain" }, SIGN_COLUMNS).map((dot) => ({
      x: dot.x * brainView.size,
      y: dot.y * brainView.size,
      z: dot.z * brainView.depth,
      ink: dot.ink,
      part: 0,
      along: (1 - dot.y) / 2,
    }));
  }
  return print(drawings[figure]);
};

/** The dots of a figure, printed the first time and kept. */
export const signFigure = (figure: SignFigure): SignDot[] => {
  const known = figures.get(figure);
  if (known !== undefined) {
    return known;
  }
  const dots = printed(figure);
  figures.set(figure, dots);
  return dots;
};

/**
 * Where each of the sign's dots goes in a figure. The sign has as many
 * dots as the head, its largest figure, and every dot has its home there.
 * In any other figure, each of its places is taken by one dot that is seen
 * there, chosen so that all of them together travel as little as they can
 * from their homes; every other dot goes to the place nearest its home and
 * shares it, unseen. So the dots of the head never cross on their way into
 * a figure or back, and from one figure into another every dot stays near
 * where it was.
 */
export interface SignSlots {
  count: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  ink: Float32Array;
  /** 1 for the dot that is seen at its place, 0 for one that waits there unseen. */
  shown: Uint8Array;
  part: Uint8Array;
  along: Float32Array;
}

const slots = new Map<SignFigure, SignSlots>();

/** How many dots the sign has: the head's. */
export const signDots = (): number => signFigure("head").length;

/** The place nearest `home` among `places`. */
const nearestPlace = (
  home: SignDot,
  places: readonly SignDot[]
): SignDot | undefined => {
  let [nearest] = places;
  let least = Number.POSITIVE_INFINITY;
  for (const place of places) {
    const far = (place.x - home.x) ** 2 + (place.y - home.y) ** 2;
    if (far < least) {
      least = far;
      nearest = place;
    }
  }
  return nearest;
};

const slotsFor = (figure: SignFigure): SignSlots => {
  const homes = signFigure("head");
  const places = signFigure(figure);
  const count = homes.length;
  if (places.length > count) {
    throw new Error(`The ${figure} has more dots than the head`);
  }
  const table: SignSlots = {
    count,
    x: new Float32Array(count),
    y: new Float32Array(count),
    z: new Float32Array(count),
    ink: new Float32Array(count),
    shown: new Uint8Array(count),
    part: new Uint8Array(count),
    along: new Float32Array(count),
  };
  const put = (slot: number, place: SignDot, shown: number): void => {
    table.x[slot] = place.x;
    table.y[slot] = place.y;
    table.z[slot] = place.z;
    table.ink[slot] = place.ink;
    table.shown[slot] = shown;
    table.part[slot] = place.part;
    table.along[slot] = place.along;
  };
  if (figure === "head") {
    for (const [slot, home] of homes.entries()) {
      put(slot, home, 1);
    }
    return table;
  }
  // How far each place is from each home, squared: what a dot's journey
  // costs.
  const cost = new Float32Array(places.length * count);
  for (const [row, place] of places.entries()) {
    for (const [slot, home] of homes.entries()) {
      cost[row * count + slot] =
        (place.x - home.x) ** 2 + (place.y - home.y) ** 2;
    }
  }
  const taken = leastCostPairs(places.length, count, cost);
  const seen = new Uint8Array(count);
  for (const [row, place] of places.entries()) {
    const slot = taken[row] ?? 0;
    put(slot, place, 1);
    seen[slot] = 1;
  }
  for (const [slot, home] of homes.entries()) {
    const nearest = nearestPlace(home, places);
    if (seen[slot] === 0 && nearest !== undefined) {
      put(slot, nearest, 0);
    }
  }
  return table;
};

/** Where each of the sign's dots goes in `figure`, worked out the first time and kept. */
export const signSlots = (figure: SignFigure): SignSlots => {
  const known = slots.get(figure);
  if (known !== undefined) {
    return known;
  }
  const table = slotsFor(figure);
  slots.set(figure, table);
  return table;
};
