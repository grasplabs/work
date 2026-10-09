import {
  PEN_TIP,
  SIGN_FIGURES,
  SIGN_PITCH,
  signDots,
  signFigure,
  signSlots,
} from "./sign-figures.ts";
import type { SignFigure, SignSlots } from "./sign-figures.ts";

// How the dots of Grasp's sign move from one figure into the next: as one
// mass (grasplabs/prototype `lib/sign-body.ts`). Every dot has a place in
// every figure, and on a change every dot goes from its place in the one
// to its place in the other, so the whole figure flows into the next. A
// small figure has fewer places than there are dots: several dots then
// share a place, one of them seen. The others are seen only on their way:
// they come out from behind the dot they shared a place with as the figure
// opens up, and are gone as they arrive where the next one closes. Nothing
// vanishes where it stood, and nothing appears from nowhere.
//
// Every dot is on a soft spring to its place, so it sets off gently, never
// overshoots, and takes a new place at any moment without a jolt: a figure
// that changes while the last change is still under way simply bends the
// dots' paths. All dots take the same time whatever the distance, so a
// figure deforms as a whole. No DOM and no clock of its own: the sign steps
// it frame by frame, and so do its tests.

export const MOTION = {
  /** About how long a dot takes to get most of the way to a new place, in seconds; it has arrived in about three times that. */
  smooth: 0.19,
  /** A dot that shares a place is seen while it is further from it than the second of these, and gone once it is nearer than the first, in the figure's units. */
  arrive: [SIGN_PITCH * 0.5, SIGN_PITCH * 2],
  /** How fast a dot shows and goes, as a share of `smooth`. */
  fade: 0.45,
  /** A dot that is not seen at its place prints this much smaller than one that is, so what flows into a figure is finer than the figure. */
  shared: 0.45,
  /** A change of figure is over between these many seconds after it began: from then on a dot that shares a place is not seen, however its place moves. */
  over: [0.5, 0.8],
  /** How much later the last dot sets off than the first, from the top of the sign to its foot: a figure changes as a wave runs down it. */
  wave: 0.07,
  /** A new figure counts as formed, for the warmth that runs through it, between these many seconds after it began. */
  formed: [0.32, 0.72],
} as const;

/** How the pen stands over its line: how far along the line it is, 0 to 1 with 0.5 at rest; how far it is lifted off it, 0 to 1; and whether it writes. */
export interface PenPose {
  at: number;
  lift: number;
  writing: boolean;
}

const atRest: PenPose = { at: 0.5, lift: 0, writing: false };
/** A dot that has not been given a figure yet. */
const none = 255;
const penIndex = SIGN_FIGURES.indexOf("pen");

/** A small seeded random (Park–Miller), so the sign gathers the same way each time. */
export const seeded = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state * 16_807) % 2_147_483_647;
    return (state - 1) / 2_147_483_646;
  };
};

/** Reads a typed array where the index is known to be inside it. */
const at = (values: ArrayLike<number>, index: number): number =>
  values[index] ?? 0;

/** The dots of the sign: where each is and how fast it moves, how large it prints and how much it is there. */
export interface SignBody {
  count: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  vz: Float32Array;
  ink: Float32Array;
  vink: Float32Array;
  there: Float32Array;
  vthere: Float32Array;
  /** The figure each dot is in or on its way to, as its place in `SIGN_FIGURES`. */
  aim: Uint8Array;
  /** The figure the sign takes, and when it began to; none until its first. */
  figure: SignFigure | null;
  since: number;
}

const tables: (SignSlots | undefined)[] = [];

/** Where every dot goes in a figure, by the figure's place in `SIGN_FIGURES`. */
export const slotsOf = (index: number): SignSlots => {
  const known = tables[index];
  if (known !== undefined) {
    return known;
  }
  const table = signSlots(SIGN_FIGURES[index] ?? "head");
  tables[index] = table;
  return table;
};

let order: Float32Array | undefined;

/** When in the wave each dot sets off, 0 for the first and 1 for the last: by how high its home in the head is. */
const waveOrder = (): Float32Array => {
  if (order === undefined) {
    const homes = signFigure("head");
    const top = Math.max(...homes.map((home) => home.y));
    const foot = Math.min(...homes.map((home) => home.y));
    order = Float32Array.from(
      homes,
      (home) => (top - home.y) / (top - foot || 1)
    );
  }
  return order;
};

/** A sign that has no figure yet: its dots in a small cloud in the middle, unseen. */
export const newBody = (): SignBody => {
  const count = signDots();
  const random = seeded(7);
  const body: SignBody = {
    count,
    x: new Float32Array(count),
    y: new Float32Array(count),
    z: new Float32Array(count),
    vx: new Float32Array(count),
    vy: new Float32Array(count),
    vz: new Float32Array(count),
    ink: new Float32Array(count).fill(0.4),
    vink: new Float32Array(count),
    there: new Float32Array(count),
    vthere: new Float32Array(count),
    aim: new Uint8Array(count).fill(none),
    figure: null,
    since: 0,
  };
  for (let dot = 0; dot < count; dot += 1) {
    const angle = random() * Math.PI * 2;
    const far = Math.sqrt(random()) * 0.28;
    body.x[dot] = Math.cos(angle) * far;
    body.y[dot] = Math.sin(angle) * far;
  }
  return body;
};

/** Has the sign take a figure from now on: its dots set off for it one after another, within the wave. */
export const takeFigure = (
  body: SignBody,
  figure: SignFigure,
  now: number
): void => {
  if (body.figure === figure) {
    return;
  }
  body.figure = figure;
  body.since = now;
};

/** Where a dot is headed in its figure, and how much it is to be seen there. */
interface Goal {
  x: number;
  y: number;
  shown: number;
}

/**
 * Finds where a dot is headed in its figure, and how much it is to be seen
 * there, into `goal`: kept rather than handed back, so a frame makes no
 * litter. Only the pen moves its dots about: the pen itself goes along its
 * line and lifts off it, and lays the line down as it goes. What it has
 * not written yet waits unseen under its point, and is there once the
 * point has passed, so no dot of the line ever stands by itself where
 * nothing is written.
 */
const setGoal = (
  goal: Goal,
  table: SignSlots,
  index: number,
  dot: number,
  pen: PenPose
): void => {
  goal.x = at(table.x, dot);
  goal.y = at(table.y, dot);
  goal.shown = at(table.shown, dot);
  if (index !== penIndex) {
    return;
  }
  const shift = (pen.at - 0.5) * 2 * PEN_TIP.travel;
  if (at(table.part, dot) === 1) {
    goal.x += shift;
    goal.y += 0.12 * Math.sin(Math.PI * pen.lift);
  } else if (pen.writing) {
    const point = PEN_TIP.x + shift;
    goal.shown *=
      Math.min(1, Math.max(0, (point - goal.x) / 0.08 + 1)) * (1 - pen.lift);
    goal.x = Math.min(goal.x, point);
  }
};

const goal: Goal = { x: 0, y: 0, shown: 0 };

/** Puts the sign in a figure at once, every dot in its place and at rest: for people who ask for less motion. */
export const standIn = (
  body: SignBody,
  figure: SignFigure,
  pen: PenPose = atRest
): void => {
  const index = SIGN_FIGURES.indexOf(figure);
  const table = slotsOf(index);
  body.figure = figure;
  for (let dot = 0; dot < body.count; dot += 1) {
    body.aim[dot] = index;
    setGoal(goal, table, index, dot, pen);
    body.x[dot] = goal.x;
    body.y[dot] = goal.y;
    body.z[dot] = at(table.z, dot);
    body.ink[dot] =
      at(table.ink, dot) * (MOTION.shared + (1 - MOTION.shared) * goal.shown);
    body.there[dot] = goal.shown;
    body.vx[dot] = 0;
    body.vy[dot] = 0;
    body.vz[dot] = 0;
    body.vink[dot] = 0;
    body.vthere[dot] = 0;
  }
};

/** A spring that is exactly as damped as it takes not to overshoot, in a form that holds for a step of any length. */
interface Spring {
  omega: number;
  decay: number;
}

const spring = (smooth: number, dt: number): Spring => {
  const omega = 2 / smooth;
  const k = omega * dt;
  return { omega, decay: 1 / (1 + k + 0.48 * k * k + 0.235 * k * k * k) };
};

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = Math.min(Math.max((value - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
};

/** Moves one value of a dot on by `dt` towards `target`, on the spring `by`. */
const follow = (
  value: Float32Array,
  speed: Float32Array,
  dot: number,
  target: number,
  by: Spring,
  dt: number
): void => {
  const off = at(value, dot) - target;
  const pull = (at(speed, dot) + by.omega * off) * dt;
  speed[dot] = (at(speed, dot) - by.omega * pull) * by.decay;
  value[dot] = target + (off + pull) * by.decay;
};

/** Moves every dot on by `dt` seconds towards its place. */
export const moveBody = (
  body: SignBody,
  now: number,
  dt: number,
  pen: PenPose = atRest
): void => {
  if (body.figure === null || dt <= 0) {
    return;
  }
  const wanted = SIGN_FIGURES.indexOf(body.figure);
  const wave = waveOrder();
  const place = spring(MOTION.smooth, dt);
  const fade = spring(MOTION.smooth * MOTION.fade, dt);
  // While the figure is changing, a dot that shares a place is seen on its
  // way there.
  const changing =
    1 - smoothstep(MOTION.over[0], MOTION.over[1], now - body.since);
  for (let dot = 0; dot < body.count; dot += 1) {
    if (
      body.aim[dot] !== wanted &&
      now >= body.since + MOTION.wave * at(wave, dot)
    ) {
      body.aim[dot] = wanted;
    }
    const index = at(body.aim, dot);
    if (index !== none) {
      const table = slotsOf(index);
      setGoal(goal, table, index, dot, pen);
      follow(body.x, body.vx, dot, goal.x, place, dt);
      follow(body.y, body.vy, dot, goal.y, place, dt);
      follow(body.z, body.vz, dot, at(table.z, dot), place, dt);
      follow(
        body.ink,
        body.vink,
        dot,
        at(table.ink, dot) * (MOTION.shared + (1 - MOTION.shared) * goal.shown),
        place,
        dt
      );
      const onItsWay =
        changing *
        smoothstep(
          MOTION.arrive[0],
          MOTION.arrive[1],
          Math.hypot(at(body.x, dot) - goal.x, at(body.y, dot) - goal.y)
        );
      follow(
        body.there,
        body.vthere,
        dot,
        goal.shown + (1 - goal.shown) * onItsWay,
        fade,
        dt
      );
    }
  }
};

/** How formed the figure the sign is taking is, 0 to 1: the warmth of what Grasp is doing comes up with it, so dots under way stay plain. */
export const formed = (body: SignBody, now: number): number =>
  body.figure === null
    ? 0
    : smoothstep(MOTION.formed[0], MOTION.formed[1], now - body.since);
