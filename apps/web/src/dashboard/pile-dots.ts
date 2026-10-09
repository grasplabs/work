// How the dashboard's pile goes once its last card is dealt with, as the
// prototype has it (`lib/todo-dots.ts`): the card turns into dots, in the
// brain's own print, with ink where its words and buttons stood, and a
// wave runs over it from left to right. Where the wave has been, each dot
// lifts, drifts and fades, warm for a moment as it lets go. Pure: where
// the dots stand, when each goes, and how it is at a time; the canvas
// only prints that (`pile-farewell.tsx`).

/** The distance between two neighbouring dots on a card, in pixels. */
export const PITCH = 6;

/**
 * How long each part takes, in seconds: the dots come up, stand, the wave
 * crosses the card, and a dot is gone this long after it let go. `own` is
 * how much later than the wave a dot may let go, by its own number, so the
 * wave has no hard edge.
 */
export const FAREWELL = {
  up: 0.25,
  hold: 0.12,
  wave: 0.7,
  own: 0.28,
  go: 0.55,
};

/** By now every dot is gone, in seconds from the start. */
export const FAREWELL_ENDS =
  FAREWELL.up + FAREWELL.hold + FAREWELL.wave + FAREWELL.own + FAREWELL.go;

/** A stretch of the card something was printed on: a line of its name, a button. */
export interface Printed {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One dot of the card: where it stands, whether it stands on something
 * printed, and its own numbers, each 0 to 1: when it breathes and lets
 * go, how large it prints, how dark.
 */
export interface FieldDot {
  x: number;
  y: number;
  inked: boolean;
  seed: number;
  grain: number;
  ink: number;
}

/** A number from 0 to 1 that is a dot's own, from where it stands: the same card gives the same dots. */
const grainOf = (x: number, y: number, salt: number): number => {
  const value =
    Math.sin(x * 12.9898 + y * 78.233 + salt * 37.719) * 43_758.5453;
  return value - Math.floor(value);
};

/** How far a point lies outside a card's round corner, squared: 0 away from the corners. */
const outOfCorner = (
  x: number,
  y: number,
  width: number,
  height: number,
  corner: number
): number => {
  let nearX = 0;
  if (x < corner) {
    nearX = corner - x;
  } else if (x > width - corner) {
    nearX = x - (width - corner);
  }
  let nearY = 0;
  if (y < corner) {
    nearY = corner - y;
  } else if (y > height - corner) {
    nearY = y - (height - corner);
  }
  return nearX * nearX + nearY * nearY;
};

/**
 * The dots of a card this wide and high: one at every step of the print's
 * spacing, inside the card's round corners, in ink where it stands on
 * something printed.
 */
export const fieldOf = (
  width: number,
  height: number,
  printed: readonly Printed[] = [],
  corner = 12
): FieldDot[] => {
  const dots: FieldDot[] = [];
  for (let y = PITCH / 2; y < height; y += PITCH) {
    for (let x = PITCH / 2; x < width; x += PITCH) {
      if (outOfCorner(x, y, width, height, corner) <= corner * corner) {
        const inked = printed.some(
          (box) =>
            x >= box.x &&
            x <= box.x + box.width &&
            y >= box.y &&
            y <= box.y + box.height
        );
        dots.push({
          x,
          y,
          inked,
          seed: grainOf(x, y, 1),
          grain: grainOf(x, y, 2),
          ink: 0.55 + 0.45 * grainOf(x, y, 3),
        });
      }
    }
  }
  return dots;
};

/** When a dot lets go, in seconds from the start: when the wave gets to it, a little later by its own number. */
export const goesAt = (
  dot: Pick<FieldDot, "x" | "seed">,
  width: number
): number =>
  FAREWELL.up +
  FAREWELL.hold +
  (width > 0 ? dot.x / width : 0) * FAREWELL.wave +
  dot.seed * FAREWELL.own;

const smooth = (t: number): number => {
  const at = Math.min(Math.max(t, 0), 1);
  return at * at * (3 - 2 * at);
};

/**
 * How a dot is at a time: how much of it is there, 0 to 1; how far it has
 * moved from its place, in pixels; and how warm it is, 0 to 1.
 */
export interface DotNow {
  there: number;
  dx: number;
  dy: number;
  heat: number;
}

/**
 * A dot at a time, in seconds from the start. It comes up quickly, a
 * little after its neighbours by its own number; from the moment it lets
 * go it lifts and drifts with the wave, shrinks to nothing, and is warm
 * for the first part of that.
 */
export const dotAt = (dot: FieldDot, width: number, at: number): DotNow => {
  const up = smooth((at - dot.seed * 0.4 * FAREWELL.up) / (0.6 * FAREWELL.up));
  const gone = Math.min(
    Math.max((at - goesAt(dot, width)) / FAREWELL.go, 0),
    1
  );
  const eased = 1 - (1 - gone) ** 2;
  return {
    there: up * (1 - smooth(gone)),
    dx: eased * (10 + 14 * dot.grain),
    dy: -eased * (8 + 16 * dot.seed),
    heat: gone > 0 && gone < 0.4 ? Math.sin(Math.PI * (gone / 0.4)) : 0,
  };
};
