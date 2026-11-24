import type { SetupStep } from "../setup.ts";
import type { Pose } from "./engine.ts";

// Where Stephen rests on each screen of the setup and how he moves there:
// another side of the window, another silk and another pace on every one,
// so no two screens feel the same. Parts of the window: 0 to 1 across and
// down.

/** Light falling from the top: a screen that has no place of its own for him. */
export const fromTheTop: Pose = {
  at: [0.5, 0],
  reach: [0.8, 0.42],
  seed: 0,
  tempo: 1,
  strength: 0.42,
};

/**
 * Gathered round the words while a screen opens: close to the middle,
 * brighter and quicker than at rest, so the wait is him getting it ready.
 * From here he moves on to the pose of the screen that opens.
 */
export const gathering: Pose = {
  // The words sit a little under the window's middle, below the header.
  at: [0.5, 0.54],
  reach: [0.3, 0.36],
  seed: 3.3,
  tempo: 1.7,
  strength: 0.62,
};

/**
 * Out of the way: a screen with its own room (the interview's
 * conversation). Nothing of him shows at rest; he stays mounted, so the
 * screen that changes to it changes nothing under it.
 */
export const aside: Pose = {
  at: [0.5, 0],
  reach: [0.5, 0.3],
  seed: 0,
  tempo: 1,
  strength: 0,
};

/** Low beside the words, a screen of the interview that asks something of them. */
export const beside: Pose = {
  at: [0.5, 1],
  reach: [0.9, 0.5],
  seed: 5.6,
  tempo: 0.8,
  strength: 0.4,
};

export const poses: Record<SetupStep, Pose> = {
  // Beside the flags' far edge, where they stand whole.
  welcome: {
    at: [0.92, 0.42],
    reach: [0.34, 0.7],
    seed: 1.7,
    tempo: 1.1,
    strength: 0.5,
  },
  ai: {
    at: [0.5, 0],
    reach: [0.85, 0.46],
    seed: 4.2,
    tempo: 0.9,
    strength: 0.46,
  },
  about: {
    at: [0.04, 0.5],
    reach: [0.36, 0.8],
    seed: 7.9,
    tempo: 0.8,
    strength: 0.46,
  },
  company: {
    at: [0.96, 0.04],
    reach: [0.6, 0.62],
    seed: 11.3,
    tempo: 1,
    strength: 0.48,
  },
  sources: {
    at: [0.02, 0.96],
    reach: [0.58, 0.6],
    seed: 14.6,
    tempo: 1.2,
    strength: 0.46,
  },
  documents: {
    at: [0.5, 1],
    reach: [0.9, 0.44],
    seed: 18.1,
    tempo: 0.85,
    strength: 0.44,
  },
  pulse: fromTheTop,
  leads: {
    at: [0.97, 0.6],
    reach: [0.38, 0.85],
    seed: 21.4,
    tempo: 1,
    strength: 0.46,
  },
  team: {
    at: [0.03, 0.2],
    reach: [0.42, 0.7],
    seed: 25.2,
    tempo: 0.95,
    strength: 0.46,
  },
  listening: fromTheTop,
  review: {
    at: [0.5, 0],
    reach: [0.7, 0.4],
    seed: 28.8,
    tempo: 0.75,
    strength: 0.42,
  },
  open: {
    at: [0.5, 0.46],
    reach: [0.62, 0.62],
    seed: 32.5,
    tempo: 0.7,
    strength: 0.5,
  },
};
