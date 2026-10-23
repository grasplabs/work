import { seeded } from "../brain/reveal-motion.ts";

// The small signs that come up beside Stephen in an interview, ported from
// the prototype (grasplabs/prototype, packages/grasp: src/lib/dot-signs.ts):
// a question mark while he waits for an answer, three dots while he
// thinks, a pen as he writes something down, a check when a part is
// agreed, and the little he feels: an exclamation mark, a smile, a heart
// for thanks.
//
// They are the same print as he is. Each is drawn as lines and filled
// shapes in a square from -1 to 1 and printed on rows of dots, every other
// row half a step over, at the spacing his head is printed at; and every
// dot has what a dot of his has: its ink, which is how large it prints; a
// grain of its own, so many print small and a few large; and a chance of
// its own, by which it is inked or still grey as he fills. Pure numbers,
// computed once per sign and kept.

export const dotSigns = [
  "question",
  "thinking",
  "pen",
  "aha",
  "smile",
  "heart",
  "check",
] as const;
export type DotSign = (typeof dotSigns)[number];

/** One dot of a sign. */
export interface SignDot {
  /** Where it is, in a square from -1 to 1, with y up. */
  x: number;
  y: number;
  /** How large it prints, 0 to 1: boldest in the middle of a line, finer at its edge. */
  ink: number;
  /** Its own chance, 0 to 1: as he fills, the dots with the lowest are inked first. */
  seed: number;
  /** Its own grain, 0 to 1: many dots print small and a few large, like ink. */
  grain: number;
  /** Which part of the sign it belongs to, in the order the sign is drawn. */
  part: number;
  /** How far along the whole sign it is, 0 to 1: the way it is written out. */
  along: number;
}

/** Dots across the square: enough for a line to have a middle and an edge, few enough that it stays small. */
export const signColumns = 17;
/** The distance between neighbouring dots, in the sign's units. */
const signPitch = 2 / signColumns;

type Point = readonly [number, number];

/** A line through points, as thick as a pen: half its width. */
interface Stroke {
  points: Point[];
  width: number;
}

/** A filled round dot, or any filled shape given by how far outside it a point is (inside, below zero). */
type Solid =
  | { at: Point; radius: number }
  | { outside: (x: number, y: number) => number };

/** One part of a sign: lines, filled shapes, or both. A sign is written out part by part. */
interface Part {
  strokes?: Stroke[];
  solids?: Solid[];
}

/** Half the width of a fine line and of a bold one: a bold line is three dots across. */
const fine = 0.13;
const bold = 0.19;
/** The round point under a question mark and an exclamation mark, and an eye. */
const point = 0.19;

/**
 * A heart: two round lobes over a point, as how far outside it a place is,
 * large enough that the dip between the lobes gets a row of dots to itself.
 */
const heart = (x: number, y: number): number => {
  const lobe = 0.34;
  const radius = 0.36;
  const high = 0.3;
  const tip = -0.78;
  const lobes =
    Math.min(Math.hypot(x - lobe, y - high), Math.hypot(x + lobe, y - high)) -
    radius;
  if (y > high || y < tip) {
    return lobes;
  }
  // From the lobes' widest line it narrows to the tip, a little rounder than a straight side.
  const side =
    Math.abs(x) - (lobe + radius) * ((y - tip) / (high - tip)) ** 0.85;
  return Math.min(lobes, side);
};

const drawings: Record<DotSign, Part[]> = {
  // The hook, down into its stem, then its point.
  question: [
    {
      strokes: [
        {
          points: [
            [-0.4, 0.42],
            [-0.3, 0.68],
            [0, 0.8],
            [0.3, 0.68],
            [0.4, 0.42],
            [0.26, 0.16],
            [0, -0.02],
            [0, -0.26],
          ],
          width: bold,
        },
      ],
    },
    { solids: [{ at: [0, -0.7], radius: point }] },
  ],
  // Three dots, each a part, so they can come and go one after another.
  thinking: [-0.6, 0, 0.6].map((x) => ({
    solids: [{ at: [x, 0] as const, radius: 0.24 }],
  })),
  // The line being written, then the pen over it, leaning to the right.
  pen: [
    {
      strokes: [
        {
          points: [
            [-0.72, -0.62],
            [0.1, -0.62],
          ],
          width: fine,
        },
      ],
    },
    {
      strokes: [
        {
          points: [
            [-0.12, -0.46],
            [-0.02, -0.3],
          ],
          width: 0.08,
        },
        {
          points: [
            [-0.02, -0.3],
            [0.56, 0.62],
          ],
          width: bold,
        },
      ],
    },
  ],
  // The stroke of an exclamation mark, then its point.
  aha: [
    {
      strokes: [
        {
          points: [
            [0, 0.8],
            [0, -0.2],
          ],
          width: bold,
        },
      ],
    },
    { solids: [{ at: [0, -0.7], radius: point }] },
  ],
  // Two eyes, then the mouth.
  smile: [
    {
      solids: [
        { at: [-0.36, 0.34], radius: point },
        { at: [0.36, 0.34], radius: point },
      ],
    },
    {
      strokes: [
        {
          points: [
            [-0.58, -0.12],
            [-0.34, -0.42],
            [0, -0.54],
            [0.34, -0.42],
            [0.58, -0.12],
          ],
          width: fine,
        },
      ],
    },
  ],
  heart: [{ solids: [{ outside: heart }] }],
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
};

/** The length of each of a stroke's pieces. */
const piecesOf = (stroke: Stroke): number[] =>
  stroke.points.slice(1).map((to, at) => {
    const from = stroke.points[at] ?? to;
    return Math.hypot(to[0] - from[0], to[1] - from[1]);
  });

/** How far a point is from a stroke's middle line, and how far along the stroke the nearest point is, 0 to 1. */
const toStroke = (
  x: number,
  y: number,
  stroke: Stroke
): { far: number; along: number } => {
  const lengths = piecesOf(stroke);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  let far = Number.POSITIVE_INFINITY;
  let along = 0;
  let walked = 0;
  for (const [at, length] of lengths.entries()) {
    const [ax, ay] = stroke.points[at] ?? [0, 0];
    const [bx, by] = stroke.points[at + 1] ?? [0, 0];
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
    const distance = Math.hypot(x - ax - (bx - ax) * t, y - ay - (by - ay) * t);
    if (distance < far) {
      far = distance;
      along = total === 0 ? 0 : (walked + length * t) / total;
    }
    walked += length;
  }
  return { far, along };
};

/** How far outside a solid a place is. */
const outsideOf = (solid: Solid, x: number, y: number): number =>
  "outside" in solid
    ? solid.outside(x, y)
    : Math.hypot(x - solid.at[0], y - solid.at[1]) - solid.radius;

/** How far outside a drawing a place is, and in which part and how far along it the nearest of it is. */
const nearestOf = (parts: Part[], x: number, y: number) => {
  let outside = Number.POSITIVE_INFINITY;
  let part = 0;
  let within = 0;
  for (const [index, each] of parts.entries()) {
    const strokes = each.strokes ?? [];
    for (const [at, stroke] of strokes.entries()) {
      const near = toStroke(x, y, stroke);
      if (near.far - stroke.width < outside) {
        outside = near.far - stroke.width;
        part = index;
        within = (at + near.along) / strokes.length;
      }
    }
    for (const solid of each.solids ?? []) {
      const far = outsideOf(solid, x, y);
      if (far < outside) {
        outside = far;
        part = index;
        within = (1 - y) / 2;
      }
    }
  }
  return { outside, part, within };
};

/**
 * A drawing printed in dots: one per place on the rows it covers. How far
 * inside the drawing a place is, is its ink: bold in the middle of a line,
 * fine at its edge. `order` keeps one sign's grain apart from another's.
 */
const print = (parts: Part[], order: number): SignDot[] => {
  const dots: SignDot[] = [];
  const random = seeded(11 + order * 7);
  for (let row = 0; row < signColumns; row += 1) {
    const y = 1 - (row + 0.5) * signPitch;
    for (let column = 0; column < signColumns; column += 1) {
      const x =
        -1 + (column + 0.5) * signPitch + (row % 2 === 0 ? 0 : signPitch / 2);
      if (x <= 1) {
        const { outside, part, within } = nearestOf(parts, x, y);
        const covered = Math.min(
          1,
          Math.max(0, 0.5 - outside / (signPitch * 0.55))
        );
        if (covered >= 0.3) {
          const seed = random();
          const grain = random() ** 2;
          dots.push({
            x,
            y,
            ink: 0.35 + 0.65 * covered,
            seed,
            grain,
            part,
            along: (part + within) / parts.length,
          });
        }
      }
    }
  }
  return dots;
};

const printed = new Map<DotSign, SignDot[]>();

/** The dots of a sign, printed the first time and kept. */
export const signDots = (sign: DotSign): SignDot[] => {
  const known = printed.get(sign);
  if (known !== undefined) {
    return known;
  }
  const dots = print(drawings[sign], dotSigns.indexOf(sign));
  printed.set(sign, dots);
  return dots;
};
