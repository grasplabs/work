import type { FigureState } from "./body.ts";
import { TAU, hash } from "./solid.ts";

/** The eye's life: its clock, its gaze and the spring that carries it, and what comes next. */
export interface EyeLife {
  clock: number;
  /** Where it looks now, -1 to 1 each way, and how fast that is moving. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** The small movement it is making now, and when it makes the next. */
  sx: number;
  sy: number;
  nextGlance: number;
  /** The blink under way (its start and length) and when the next comes. */
  blinkStart: number;
  blinkLasts: number;
  nextBlink: number;
  /** The lid's twitch while it dreams, and when the next comes. */
  twitchStart: number;
  nextTwitch: number;
  /** A job done: the lower lid risen, like a smile in the eyes, 0 to 1. */
  squint: number;
  /** How many chances it has drawn: each draw a new steady number. */
  draws: number;
  seed: number;
}

export const eyeLifeOf = (seed: number): EyeLife => ({
  clock: 0,
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  sx: 0,
  sy: 0,
  nextGlance: 1.2,
  blinkStart: -9,
  blinkLasts: 0.22,
  nextBlink: 2.4 + (seed % 3),
  twitchStart: -9,
  nextTwitch: 5,
  squint: 0,
  draws: 0,
  seed,
});

/** A mood: where it looks (left out: at you, or the pointer), how far its glances go, how often, and how long a blink lasts. */
interface Mood {
  away?: readonly [number, number];
  glance: number;
  every: readonly [number, number];
  blink: number;
}

const moods: Record<FigureState, Mood> = {
  // Shut, dreaming: it looks nowhere.
  asleep: { away: [0, 0], glance: 0, every: [9, 9], blink: 0 },
  // Calm: at you, or where the pointer is, with small easy glances.
  idle: { glance: 0.07, every: [1, 2], blink: 0.22 },
  // Paying attention: it locks on and hardly wanders.
  listening: { glance: 0.02, every: [1.4, 2.4], blink: 0.2 },
  // Looking away, up and to the side, searching in small quick glances; slower blinks.
  thinking: {
    away: [0.62, 0.5],
    glance: 0.22,
    every: [0.45, 1.1],
    blink: 0.32,
  },
  done: { glance: 0.05, every: [1, 2], blink: 0.22 },
};

/** The spring the gaze rides on: it settles in about 300ms, overshooting a little. */
const STIFF = 420;
const DAMP = 24.6;

/** How long the squint of a job done holds before it eases back to calm. */
const SQUINT_HOLDS = 1.1;

const draw = (life: EyeLife): number => {
  life.draws += 1;
  return hash(life.draws * 1.7 + life.seed, 13.1);
};

/** Steps the eye's life by `dt` seconds in `state`, looking toward `look` (-1 to 1); `since` is the seconds in this state. */
export const stepEye = (
  life: EyeLife,
  state: FigureState,
  dt: number,
  look: { x: number; y: number },
  since: number
): void => {
  life.clock += dt;
  const mood = moods[state];
  if (life.clock >= life.nextGlance) {
    life.sx = (draw(life) - 0.5) * 2 * mood.glance;
    life.sy = (draw(life) - 0.5) * 1.4 * mood.glance;
    life.nextGlance =
      life.clock + mood.every[0] + draw(life) * (mood.every[1] - mood.every[0]);
  }
  const tx = (mood.away?.[0] ?? look.x) + life.sx;
  const ty = (mood.away?.[1] ?? look.y) + life.sy;
  // The spring, in steps of at most 1/120s so a slow frame never throws it.
  for (let left = dt; left > 0; left -= 1 / 120) {
    const h = Math.min(left, 1 / 120);
    life.vx += (STIFF * (tx - life.x) - DAMP * life.vx) * h;
    life.vy += (STIFF * (ty - life.y) - DAMP * life.vy) * h;
    life.x += life.vx * h;
    life.y += life.vy * h;
  }
  if (state !== "asleep" && life.clock >= life.nextBlink) {
    life.blinkStart = life.clock;
    life.blinkLasts = mood.blink;
    // Now and then a second blink straight after the first.
    life.nextBlink =
      life.clock + (draw(life) < 0.16 ? 0.36 : 3 + draw(life) * 5);
  }
  if (state === "asleep" && life.clock >= life.nextTwitch) {
    life.twitchStart = life.clock;
    life.nextTwitch = life.clock + 4 + draw(life) * 6;
  }
  const squinting = state === "done" && since < SQUINT_HOLDS ? 1 : 0;
  life.squint += (squinting - life.squint) * (1 - Math.exp(-dt / 0.12));
};

/** How far shut a blink has the eye now, 0 to 1. */
export const shutOf = (life: EyeLife): number => {
  const into = life.clock - life.blinkStart;
  return into >= 0 && into < life.blinkLasts
    ? Math.sin((Math.PI * into) / life.blinkLasts)
    : 0;
};

/** The lid's twitch in a dream, -1 to 1, mostly 0. */
export const twitchOf = (life: EyeLife): number => {
  const into = life.clock - life.twitchStart;
  return into >= 0 && into < 0.3
    ? Math.sin((Math.PI * into) / 0.3) * Math.sin(into * 42)
    : 0;
};

/** Its breath asleep, -1 to 1, one in about four and a half seconds. */
export const breathOf = (life: EyeLife): number =>
  Math.sin((life.clock * TAU) / 4.5);
