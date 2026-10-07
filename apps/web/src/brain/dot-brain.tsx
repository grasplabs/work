import { cn } from "@grasp-os/ui/lib/utils";
import { useEffect, useRef, useSyncExternalStore } from "react";

import {
  ALPHAS,
  bucketOf,
  CANVAS,
  DOT_MOST,
  dotAlpha,
  dotShare,
  HEATS,
  LOOK,
  MORPH_S,
  palette,
  patchAt,
  REACH,
  shimmerAt,
  SPREAD_S,
  swayAt,
  tideOut,
} from "./dot-ink.ts";
import {
  CORE,
  dotShape,
  LINK,
  OPEN,
  PITCH,
  POINTS,
  shapeId,
} from "./dot-shapes.ts";
import type { DotShape, Nerve, ShapeKey } from "./dot-shapes.ts";

// The company brain in dots, ported from the prototype (grasplabs/prototype,
// packages/grasp: components/onboarding/dot-brain.tsx). It draws on a
// canvas, frame by frame, outside React: the component only hands the
// animation its scene and where the pointer is.

/** What the brain shows: its figure, how full it is, and in the org, how far each team is. */
export interface BrainScene {
  shape: ShapeKey;
  /** How full the brain is, 0 to 1: that share of its dots is inked, the rest stay grey. */
  fill: number;
  /** In the org, the share of each team that talked to us, by team. */
  teams?: number[];
  /** Grasp is asking whoever is shown: rings of dots come in to them from the top right as it speaks. */
  call?: boolean;
  /** Full and about to become the platform: every dot shows, and warmth shimmers through them all. */
  charge?: boolean;
  /** Grasp's voice is someone else's right now: this figure's mouth stays still, and nothing of it answers the voice. */
  quiet?: boolean;
  /** How much of the drifting faintness is taken away, 0 to 1: at 1 all of the figure shows all the time. For where a figure is there to be looked at. */
  clear?: number;
}

/**
 * The drawing's pixels per drawing unit and screen pixel, at least: above one, so it stays sharp
 * when shown a little larger than it is drawn. Shown larger still, it is drawn sharper to match.
 */
const SHARPNESS = 1.3;
const TAU = Math.PI * 2;
/**
 * Grasp asking someone: a ring of dots every so often from the top right corner, as fast as it
 * travels, as far as it goes before it has faded, and how thick it is, in drawing pixels.
 */
const RING = { every: 0.6, speed: 150, reach: 430, width: 6 };
/** How many nerves a figure's signals are kept for: more than any figure has. */
const NERVES = 16;
/**
 * A signal along a nerve, from its place in to the brain, as warmth: how long it takes to run the
 * nerve, how far its warmth reaches along it, how strong it is at least and at most, and how wide
 * and how long the brain stays warm where one came in. The figure stays calm however many nerves
 * it has: one signal sets off about every `every` seconds over all of them together, so a nerve
 * waits that long times the number of connected nerves, give or take `spread` of it.
 */
const SIGNAL = {
  seconds: 0.9,
  reach: 0.15,
  weakest: 0.45,
  strongest: 0.8,
  every: 2.6,
  spread: 0.4,
  around: 0.2,
  glow: 1,
};
/**
 * The first signal of a nerve that was just connected, made to be seen: slower and stronger, with
 * the nerve still warm behind it, each a little after the one before when several connect at
 * once, and the brain lights up wider and longer where it comes in.
 */
const ARRIVAL = {
  seconds: 1.4,
  reach: 0.22,
  tail: 0.55,
  apart: 0.09,
  around: 0.34,
  glow: 1.9,
};
/** How far the figure is from the eye, in figure units: it is seen straight on, always from the same place. */
const DISTANCE = 3.4;

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = Math.min(Math.max((value - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
};

/** A typed array's value, 0 past its end. */
const valueAt = (values: ArrayLike<number>, index: number): number =>
  values[index] ?? 0;

/** Ease in and out, in thirds: slow off, fast through the middle, slow in. */
const easeInOut = (t: number): number => {
  if (t <= 0) {
    return 0;
  }
  if (t >= 1) {
    return 1;
  }
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
};

/** A small seeded random (Park–Miller), so the brain looks the same every time it opens. */
const seeded = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state * 16_807) % 2_147_483_647;
    return (state - 1) / 2_147_483_646;
  };
};

/** Where the brain's dots are and how they print: what the next brain carries on from. */
interface Dots {
  position: Float32Array;
  tone: Float32Array;
  ink: Float32Array;
  presence: Float32Array;
  /** How inked each dot is, 0 grey to 1 inked, as last drawn. */
  inkedness: Float32Array;
  /** How warm its figure keeps each dot, as last drawn. */
  warmed: Float32Array;
  /** Where the voice comes from. */
  voice: [number, number];
  target: DotShape | null;
  targetId: string;
  fill: number;
  teams: Float32Array;
}

/** The last brain's dots, where they were and how they were printed when it went, for the next one to carry on from. */
let kept: Dots | null = null;

/** Each dot's own chance, grain, delay and lift, so figures fill and flow unevenly, like ink. */
interface Grain {
  seed: Float32Array;
  grain: Float32Array;
  delay: Float32Array;
  lift: Float32Array;
}

/** A nerve's signal, and when a signal last came in to the brain from it. */
interface Signals {
  /** Which figure with nerves was drawn last. */
  nerved: string;
  wasLive: Uint8Array;
  /** When its signal set off; -1 for none. */
  at: Float32Array;
  strength: Float32Array;
  /** Whether it is the first of a connection just made. */
  first: Uint8Array;
  /** How far along it is right now; -1 for none. */
  head: Float32Array;
  next: Float32Array;
  cameIn: Float32Array;
  cameInStrength: Float32Array;
  cameInFirst: Uint8Array;
}

/** Everything the brain keeps from one frame to the next. */
interface Brain extends Dots {
  grain: Grain;
  /** Where each dot was, and how it printed, when its new figure was given. */
  from: Dots;
  morphAt: number;
  /** A new figure given while the dots are still on their way to the last: they all turn together. */
  flying: boolean;
  /** How charged it is, 0 to 1, easing towards the scene's charge. */
  charged: number;
  signals: Signals;
  /** The fill at the last wave: a wave runs when the brain has grown a few points since. */
  waveFill: number;
  waveAt: number;
  rings: { at: number; strength: number }[];
  lastRing: number;
  /** The warm spot glides after the pointer and fades in and out, so it never jumps. */
  spot: { x: number; y: number; strength: number };
  /** Per dot, where it is drawn, how large, and its colour. */
  screen: {
    x: Float32Array;
    y: Float32Array;
    radius: Float32Array;
    bucket: Uint16Array;
  };
}

const emptyDots = (): Dots => ({
  position: new Float32Array(POINTS * 3),
  tone: new Float32Array(POINTS),
  ink: new Float32Array(POINTS),
  presence: new Float32Array(POINTS),
  inkedness: new Float32Array(POINTS),
  warmed: new Float32Array(POINTS),
  voice: [0, 0],
  target: null,
  targetId: "",
  fill: 0,
  teams: new Float32Array(32),
});

const copyDots = (into: Dots, from: Dots): void => {
  into.position.set(from.position);
  into.tone.set(from.tone);
  into.ink.set(from.ink);
  into.presence.set(from.presence);
  into.inkedness.set(from.inkedness);
  into.warmed.set(from.warmed);
  into.voice = [from.voice[0], from.voice[1]];
  into.target = from.target;
  into.targetId = from.targetId;
  into.fill = from.fill;
  into.teams.set(from.teams);
};

const grainOf = (random: () => number): Grain => {
  const grain: Grain = {
    seed: new Float32Array(POINTS),
    grain: new Float32Array(POINTS),
    delay: new Float32Array(POINTS),
    lift: new Float32Array(POINTS),
  };
  for (let index = 0; index < POINTS; index += 1) {
    grain.seed[index] = random();
    // In looks with variety, many dots print small and a few large.
    grain.grain[index] = random() ** 2;
    grain.delay[index] = random() * SPREAD_S;
    grain.lift[index] = 0.12 + random() * 0.4;
  }
  return grain;
};

/** The dots start as a small cloud and gather into the first figure. */
const cloudOf = (random: () => number): Dots => {
  const dots = emptyDots();
  dots.ink.fill(0.4);
  dots.tone.fill(0.4);
  // Whether a point is part of the figure: points a figure does not need fade out and wait.
  dots.presence.fill(1);
  for (let index = 0; index < POINTS; index += 1) {
    const angle = random() * TAU;
    const radius = Math.sqrt(random()) * 0.35;
    dots.position[index * 3] = Math.cos(angle) * radius;
    dots.position[index * 3 + 1] = Math.sin(angle) * radius;
    dots.position[index * 3 + 2] = (random() - 0.5) * 0.3;
  }
  return dots;
};

/**
 * The dots it starts from. Beside another figure, it is its own from the start: nothing is taken
 * over, and nothing gathers. Else where the last brain was, so this one carries on from there;
 * the very first gathers from a small cloud.
 */
const startingDots = (
  random: () => number,
  scene: BrainScene,
  apart: boolean
): Dots => {
  const dots = cloudOf(random);
  if (apart) {
    const own = dotShape(scene.shape);
    dots.position.set(own.position);
    dots.tone.set(own.tone);
    dots.ink.set(own.ink);
    dots.presence.set(own.presence);
    dots.voice = [own.voice[0] ?? 0, own.voice[1] ?? 0];
    dots.target = own;
    dots.targetId = shapeId(scene.shape);
    dots.fill = scene.fill;
  } else if (kept) {
    copyDots(dots, kept);
  }
  return dots;
};

const brainOf = (scene: BrainScene, apart: boolean): Brain => {
  const random = seeded(7);
  const grain = grainOf(random);
  const dots = startingDots(random, scene, apart);
  return {
    ...dots,
    grain,
    from: emptyDots(),
    morphAt: -1,
    flying: false,
    charged: 0,
    signals: {
      nerved: "",
      wasLive: new Uint8Array(NERVES),
      at: new Float32Array(NERVES).fill(-1),
      strength: new Float32Array(NERVES),
      first: new Uint8Array(NERVES),
      head: new Float32Array(NERVES).fill(-1),
      next: new Float32Array(NERVES),
      cameIn: new Float32Array(NERVES).fill(-Infinity),
      cameInStrength: new Float32Array(NERVES),
      cameInFirst: new Uint8Array(NERVES),
    },
    waveFill: dots.target ? dots.fill : -1,
    waveAt: -Infinity,
    rings: [],
    lastRing: -Infinity,
    spot: { x: CANVAS / 2, y: CANVAS / 2, strength: 0 },
    screen: {
      x: new Float32Array(POINTS),
      y: new Float32Array(POINTS),
      radius: new Float32Array(POINTS),
      bucket: new Uint16Array(POINTS),
    },
  };
};

/** What the animation reads from the component on every frame. */
interface Live {
  scene: BrainScene;
  reduce: boolean;
  /** How large it is shown, against the size it is drawn at. */
  shown: number;
  apart?: { leaves: boolean };
  voice: () => number;
}

interface Pointer {
  x: number;
  y: number;
  inside: boolean;
}

/** How inked a group of the figure is, 0 to 1: the brain in the middle of its nerves as the brain is full, a made connection dark, one still to make grey, a team by its people who talked. */
const levelOf = (brain: Brain, group: number): number => {
  if (group === LINK) {
    return 0.85;
  }
  if (group === OPEN) {
    return 0;
  }
  return group < brain.teams.length ? (brain.teams[group] ?? 0) : brain.fill;
};

/**
 * A new figure takes each dot over from how it is drawn, as the dot moves: where it is, arc and
 * all, how inked and how warm it is, so the figure never prints itself anew before anything has
 * moved; given while the dots are still on their way, they all turn together.
 */
const retarget = (
  brain: Brain,
  key: ShapeKey,
  now: number,
  still: boolean
): void => {
  const id = shapeId(key);
  if (id === brain.targetId) {
    return;
  }
  copyDots(brain.from, brain);
  const target = dotShape(key);
  brain.target = target;
  brain.targetId = id;
  brain.flying = brain.morphAt >= 0;
  brain.morphAt = still ? -1 : now;
  if (still) {
    brain.position.set(target.position);
    brain.tone.set(target.tone);
    brain.ink.set(target.ink);
    brain.presence.set(target.presence);
  }
};

/** The scene's numbers, eased towards: how full, how charged, and how far each team is. */
const easeScene = (
  brain: Brain,
  scene: BrainScene,
  ease: (rate: number) => number
): void => {
  brain.fill += (scene.fill - brain.fill) * ease(0.035);
  brain.charged +=
    ((scene.charge === true ? 1 : 0) - brain.charged) * ease(0.05);
  const heard = scene.teams ?? [];
  for (let team = 0; team < brain.teams.length; team += 1) {
    const now = brain.teams[team] ?? 0;
    brain.teams[team] = now + ((heard[team] ?? 0) - now) * ease(0.035);
  }
};

/** Settled: the dots are where their figure has them. */
const settle = (brain: Brain, shape: DotShape, now: number): void => {
  if (brain.morphAt >= 0 && now - brain.morphAt > MORPH_S + SPREAD_S) {
    brain.position.set(shape.position);
    brain.tone.set(shape.tone);
    brain.ink.set(shape.ink);
    brain.presence.set(shape.presence);
    brain.morphAt = -1;
  }
};

/** Whether a nerve is a made connection. */
const isLive = (brain: Brain, nerve: Nerve | undefined): boolean =>
  nerve !== undefined && levelOf(brain, nerve.group) >= 0.5;

/** One nerve's signal this frame: whether it sets off, how far it has run, and whether it came in. */
const runSignal = (
  brain: Brain,
  nerves: Nerve[],
  nerve: number,
  now: number,
  rest: () => number
): void => {
  const { signals } = brain;
  const path = nerves[nerve];
  const morphing = brain.morphAt >= 0;
  if (
    path !== undefined &&
    isLive(brain, path) &&
    (signals.at[nerve] ?? -1) < 0 &&
    now > (signals.next[nerve] ?? 0) &&
    !morphing
  ) {
    signals.at[nerve] = now;
    signals.strength[nerve] =
      SIGNAL.weakest + (SIGNAL.strongest - SIGNAL.weakest) * Math.random();
    signals.first[nerve] = 0;
  }
  const started = signals.at[nerve] ?? -1;
  if (path === undefined || started < 0 || now < started) {
    return;
  }
  const first = signals.first[nerve] === 1;
  const head =
    ((now - started) / (first ? ARRIVAL.seconds : SIGNAL.seconds)) * path.along;
  if (head < path.along) {
    signals.head[nerve] = head;
    return;
  }
  // It came in: the brain warms there, and the nerve rests before its next.
  signals.cameIn[nerve] = now;
  signals.cameInStrength[nerve] = signals.strength[nerve] ?? 0;
  signals.cameInFirst[nerve] = signals.first[nerve] ?? 0;
  signals.at[nerve] = -1;
  signals.next[nerve] = now + rest();
};

/**
 * The nerves' signals. A figure new on stage simply has the connections it has; one that is made
 * while it stands there is seen. Says when the first signal of a connection made just now comes in
 * to the brain, if one was, and whether the brain is warm somewhere a signal came in.
 */
const runNerves = (
  brain: Brain,
  key: ShapeKey,
  shape: DotShape,
  now: number,
  still: boolean
): { arrives: number; glowing: boolean } => {
  const { signals } = brain;
  const { nerves } = shape;
  const family = nerves.length === 0 ? "" : key.kind;
  const morphing = brain.morphAt >= 0;
  const connected = Math.max(
    nerves.slice(0, NERVES).filter((nerve) => isLive(brain, nerve)).length,
    1
  );
  // How long a nerve waits for its next signal, so that all of them together keep the same calm pace.
  const rest = () =>
    SIGNAL.every *
    connected *
    (1 - SIGNAL.spread + 2 * SIGNAL.spread * Math.random());
  let arrives = -1;
  let fresh = 0;
  let glowing = false;
  for (let nerve = 0; nerve < NERVES; nerve += 1) {
    signals.head[nerve] = -1;
    if (nerve >= nerves.length || still) {
      signals.at[nerve] = -1;
      signals.wasLive[nerve] = 0;
      continue;
    }
    const live = isLive(brain, nerves[nerve]);
    if (family !== signals.nerved) {
      signals.at[nerve] = -1;
      signals.cameIn[nerve] = -Infinity;
      signals.next[nerve] =
        now + 0.6 + (brain.grain.seed[nerve] ?? 0) * SIGNAL.every * connected;
    } else if (live && signals.wasLive[nerve] !== 1) {
      // Its dots are nearly there by then.
      const at = now + (morphing ? MORPH_S * 0.85 : 0) + fresh * ARRIVAL.apart;
      fresh += 1;
      signals.at[nerve] = at;
      signals.strength[nerve] = 1;
      signals.first[nerve] = 1;
      if (arrives < 0) {
        arrives = at + ARRIVAL.seconds;
      }
    } else if (!live) {
      signals.at[nerve] = -1;
    }
    signals.wasLive[nerve] = live ? 1 : 0;
    runSignal(brain, nerves, nerve, now, rest);
    const glow = signals.cameInFirst[nerve] === 1 ? ARRIVAL.glow : SIGNAL.glow;
    if (now - (signals.cameIn[nerve] ?? -Infinity) < glow) {
      glowing = true;
    }
  }
  signals.nerved = family;
  return { arrives, glowing };
};

/** The brain grows: a warm wave runs out from the middle. With a connection made just now, it waits for that nerve's first signal to come in. */
const runWave = (
  brain: Brain,
  fill: number,
  now: number,
  still: boolean,
  arrives: number
): void => {
  if (brain.waveFill < 0) {
    brain.waveFill = fill;
  }
  if (fill >= brain.waveFill + 0.03 && now - brain.waveAt > 1.8 && !still) {
    brain.waveAt = Math.max(now, arrives);
    brain.waveFill = fill;
  }
  if (fill < brain.waveFill) {
    brain.waveFill = fill;
  }
};

/** Everything a frame shares with every dot in it. */
interface Frame {
  now: number;
  still: boolean;
  shape: DotShape;
  morphing: boolean;
  scale: number;
  middle: number;
  reach: number;
  gap: number;
  tide: number;
  mouth: number;
  lifted: number;
  turn: number;
  voiceX: number;
  voiceY: number;
  band: number;
  wave: number;
  waveLeft: number;
  spot: Brain["spot"];
  hovering: boolean;
  charged: number;
  glowing: boolean;
  ringing: boolean;
  rung: (px: number, py: number) => number;
}

/** A dot where it is now, on its way to its figure or there: everything about it follows the same. */
interface Placed {
  x: number;
  y: number;
  z: number;
  lit: number;
  printed: number;
  there: number;
  /** How far it is on its way to the new figure. */
  e: number;
}

const placeDot = (brain: Brain, frame: Frame, index: number): Placed => {
  const at = index * 3;
  const { position } = brain;
  if (!frame.morphing) {
    return {
      x: valueAt(position, at),
      y: valueAt(position, at + 1),
      z: valueAt(position, at + 2),
      lit: valueAt(brain.tone, index),
      printed: valueAt(brain.ink, index),
      there: valueAt(brain.presence, index),
      e: 1,
    };
  }
  const { from, grain } = brain;
  const { shape } = frame;
  const delay = brain.flying ? 0 : valueAt(grain.delay, index);
  const e = easeInOut((frame.now - brain.morphAt - delay) / MORPH_S);
  const toward = (a: number, b: number) => a + (b - a) * e;
  const x = toward(valueAt(from.position, at), valueAt(shape.position, at));
  const y = toward(
    valueAt(from.position, at + 1),
    valueAt(shape.position, at + 1)
  );
  const z =
    toward(valueAt(from.position, at + 2), valueAt(shape.position, at + 2)) +
    Math.sin(Math.PI * e) * valueAt(grain.lift, index);
  const lit = toward(valueAt(from.tone, index), valueAt(shape.tone, index));
  const printed = toward(valueAt(from.ink, index), valueAt(shape.ink, index));
  const there = toward(
    valueAt(from.presence, index),
    valueAt(shape.presence, index)
  );
  // Kept as drawn, arc and all: a new figure given mid-flight carries on from where the dot is.
  position[at] = x;
  position[at + 1] = y;
  position[at + 2] = z;
  brain.tone[index] = lit;
  brain.ink[index] = printed;
  brain.presence[index] = there;
  return { x, y, z, lit, printed, there, e };
};

/** How a figure's own warm places pulse: a voice, two voices taking turns, a sweep, a steady glow. */
const pulseOf = (
  shape: DotShape,
  frame: Frame,
  index: number,
  x: number,
  seed: number
): number => {
  switch (shape.activity) {
    case "speak": {
      return 0.12 + 0.88 * frame.mouth;
    }
    case "alternate": {
      return shape.channel[index] === frame.turn
        ? 0.25 + 0.75 * frame.mouth
        : 0.06;
    }
    case "sweep": {
      return Math.exp(-(((x - frame.band) / 0.2) ** 2));
    }
    case "steady": {
      return 0.72 + 0.25 * Math.sin(frame.now * 1.3 + seed * 3);
    }
    case "none": {
      return 0;
    }
    default: {
      return shape.activity satisfies never;
    }
  }
};

/** A signal on its way along this dot's nerve: warm where it is, and behind the first one of a new connection the nerve stays warm a while. */
const signalWarmth = (
  brain: Brain,
  shape: DotShape,
  index: number,
  e: number
): number => {
  const nerve = shape.nerve[index] ?? NERVES;
  const head = brain.signals.head[nerve] ?? -1;
  if (nerve >= NERVES || head < 0) {
    return 0;
  }
  const first = brain.signals.first[nerve] === 1;
  const off = (shape.along[index] ?? 0) - head;
  let warmth =
    (brain.signals.strength[nerve] ?? 0) *
    Math.exp(-((off / (first ? ARRIVAL.reach : SIGNAL.reach)) ** 2));
  if (first && off < 0) {
    warmth = Math.max(warmth, ARRIVAL.tail * Math.exp(off / 0.5));
  }
  return warmth * e;
};

/** Where one came in, the brain is warm for a moment: it comes up fast and fades slowly. */
const cameInWarmth = (
  brain: Brain,
  nerves: Nerve[],
  now: number,
  x: number,
  y: number
): number => {
  const { signals } = brain;
  let heat = 0;
  for (const [each, nerve] of nerves.slice(0, NERVES).entries()) {
    const first = signals.cameInFirst[each] === 1;
    const gone =
      (now - (signals.cameIn[each] ?? -Infinity)) /
      (first ? ARRIVAL.glow : SIGNAL.glow);
    if (gone >= 1) {
      continue;
    }
    const off =
      Math.hypot(x - nerve.x, y - nerve.y) /
      (first ? ARRIVAL.around : SIGNAL.around);
    if (off < 2) {
      heat = Math.max(
        heat,
        (signals.cameInStrength[each] ?? 0) *
          Math.min(1, gone * 8) *
          (1 - gone) *
          Math.exp(-off * off)
      );
    }
  }
  return heat;
};

/** How warm a dot is: its figure's warm places, a signal, the pointer, the charge, the voice, the wave. */
const heatOf = (
  brain: Brain,
  frame: Frame,
  index: number,
  dot: Placed,
  near: number,
  screen: { sx: number; sy: number }
): { heat: number; voiced: number } => {
  const { shape, still, now } = frame;
  const seed = brain.grain.seed[index] ?? 0;
  let heat = 0;
  const hot = shape.hot[index] ?? 0;
  if (hot > 0) {
    const pulse = pulseOf(shape, frame, index, dot.x, seed);
    heat = hot * (still ? Math.min(pulse, 0.6) : pulse);
  }
  // A figure's warm places cool on the dots leaving them and warm on the dots arriving, as they go.
  if (frame.morphing) {
    const was = brain.from.warmed[index] ?? 0;
    heat = was + (heat - was) * dot.e;
  }
  brain.warmed[index] = heat;
  heat = Math.max(heat, signalWarmth(brain, shape, index, dot.e));
  if (frame.glowing && shape.group[index] === CORE) {
    heat = Math.max(heat, cameInWarmth(brain, shape.nerves, now, dot.x, dot.y));
  }
  // A warm tint, not a spotlight: the swelling does most of it.
  heat = Math.max(heat, LOOK.warm * near);
  // Charged, warmth shimmers through every dot, each at its own pace.
  if (frame.charged > 0.01 && !still) {
    heat = Math.max(
      heat,
      frame.charged * (0.3 + 0.25 * Math.sin(now * 5 + seed * 40))
    );
  }
  // While Grasp speaks, soft rings of warmth run out from the mouth, fading with distance.
  let voiced = 0;
  if (frame.mouth > 0.02 && !still) {
    const off = Math.hypot(dot.x - frame.voiceX, dot.y - frame.voiceY);
    voiced =
      frame.mouth *
      Math.exp(-((off / 0.5) ** 2)) *
      (0.55 + 0.45 * Math.sin(off * 14 - now * 3));
    heat = Math.max(heat, 0.5 * voiced);
  }
  if (frame.wave >= 0 && frame.waveLeft > 0) {
    const off =
      Math.hypot(screen.sx - frame.middle, screen.sy - frame.middle) -
      frame.wave;
    if (off * off < 2000) {
      heat = Math.max(
        heat,
        0.75 * frame.waveLeft * Math.exp(-(off * off) / 500)
      );
    }
  }
  // A call's rings warm the figure as they pass through it.
  if (frame.ringing) {
    const warmth = frame.rung(screen.sx, screen.sy);
    if (warmth > 0.02) {
      heat = Math.max(heat, 0.8 * warmth);
    }
  }
  return { heat, voiced };
};

/** Under the pointer the dots swell and glow; as it moves on they shrink back. */
const nearPointer = (frame: Frame, sx: number, sy: number): number => {
  if (!frame.hovering) {
    return 0;
  }
  const d2 = (sx - frame.spot.x) ** 2 + (sy - frame.spot.y) ** 2;
  if (d2 >= frame.reach * frame.reach) {
    return 0;
  }
  const t = 1 - Math.sqrt(d2) / frame.reach;
  return frame.spot.strength * t * t * (3 - 2 * t);
};

/** Works out where one dot is drawn, how large, and in which colour. */
const printDot = (
  brain: Brain,
  frame: Frame,
  index: number,
  taken: (sx: number, sy: number) => void
): void => {
  const dot = placeDot(brain, frame, index);
  const { screen } = brain;
  if (dot.there < 0.01) {
    screen.bucket[index] = 0;
    return;
  }
  const seed = brain.grain.seed[index] ?? 0;
  // Alive, not heaving, and only sideways: a faint sway through the rows, so neighbouring dots move together. The voice never moves anything.
  const x = frame.still ? dot.x : dot.x + swayAt(dot.y, seed, frame.now);
  // Seen straight on, always from the same place: it never turns, so the view never changes.
  const perspective = DISTANCE / (DISTANCE - dot.z);
  const sx = frame.middle + x * perspective * frame.scale;
  const sy = frame.middle - dot.y * perspective * frame.scale;
  const near = nearPointer(frame, sx, sy);

  // Inked or grey: a team fills with its people, a made connection is dark, one still to make stays grey, and the rest, the brain in the middle of its nerves too, fills as the brain does.
  const group = frame.shape.group[index] ?? 0;
  const inkedTo = seed < levelOf(brain, group) ? 1 : 0;
  const wasInked = brain.from.inkedness[index] ?? 0;
  const inked = frame.morphing
    ? wasInked + (inkedTo - wasInked) * dot.e
    : inkedTo;
  brain.inkedness[index] = inked;
  // Ink carries the shading in the dot's size; its depth of colour follows a little. On its way, a dot goes from grey to inked as it goes.
  const greyAlpha = dotAlpha(dot.printed, dot.lit, false);
  let alpha =
    greyAlpha + (dotAlpha(dot.printed, dot.lit, true) - greyAlpha) * inked;
  if (!frame.still) {
    alpha *= shimmerAt(seed, frame.now);
  }
  alpha *=
    Math.min(1, Math.max(0, (1.3 - Math.hypot(dot.x, dot.y)) / 0.35)) *
    dot.there;
  if (frame.tide > 0) {
    const clear =
      1 - frame.tide * (1 - patchAt(dot.x, dot.y, frame.now, frame.lifted));
    // The pointer finds what the tide hides.
    alpha *= clear + (1 - clear) * LOOK.reveal * near;
  }
  const { heat, voiced } = heatOf(brain, frame, index, dot, near, { sx, sy });
  if (frame.ringing && dot.there > 0.5) {
    taken(sx, sy);
  }
  if (heat > 0.12) {
    alpha = Math.max(alpha, 0.45 + 0.5 * heat);
  }
  screen.x[index] = sx;
  screen.y[index] = sy;
  // Sized against the spacing, so dots always stand apart: the darkest, and those under the pointer too.
  const grain = brain.grain.grain[index] ?? 0;
  const greyShare = dotShare(dot.printed, false, grain);
  const share =
    greyShare + (dotShare(dot.printed, true, grain) - greyShare) * inked;
  screen.radius[index] =
    frame.gap *
    share *
    perspective *
    Math.min(
      1 + 0.25 * heat + 0.15 * voiced + LOOK.grow * near,
      DOT_MOST / share
    );
  screen.bucket[index] = bucketOf(alpha, heat);
};

/**
 * The rings of a call run over a grid at the figure's own spacing, only where the figure is not;
 * over the figure they warm its dots instead, so they seem to reach whoever is shown.
 */
interface RingField {
  cell: number;
  across: number;
  taken: Uint8Array;
  dots: number[][];
}

const ringFieldOf = (): RingField => {
  const cell = PITCH * CANVAS * 0.43 * LOOK.air;
  const across = Math.ceil(CANVAS / cell);
  return {
    cell,
    across,
    taken: new Uint8Array(across * across),
    dots: Array.from({ length: ALPHAS * HEATS }, () => []),
  };
};

/** How strongly the rings are at a point now, 0 to 1: strongest at their middle, fading as they go. */
const rungAt = (
  rings: Brain["rings"],
  now: number,
  px: number,
  py: number
): number => {
  const far = Math.hypot(px - CANVAS, py);
  let most = 0;
  for (const ring of rings) {
    const travelled = (now - ring.at) * RING.speed;
    const off = (far - travelled) / RING.width;
    if (off * off > 9) {
      continue;
    }
    const left = 1 - travelled / RING.reach;
    most = Math.max(most, ring.strength * left * left * Math.exp(-off * off));
  }
  return most;
};

/** The rings' own dots, where the figure is not, fading at the edge of the brain's field. */
const ringDots = (field: RingField, frame: Frame): void => {
  for (const list of field.dots) {
    list.length = 0;
  }
  const edge = 1.3 * frame.scale;
  const { cell, across, taken } = field;
  for (let gy = 0; gy < across; gy += 1) {
    for (let gx = 0; gx < across; gx += 1) {
      const px = (gx + 0.5) * cell;
      const py = (gy + 0.5) * cell;
      const warmth = taken[gy * across + gx] === 1 ? 0 : frame.rung(px, py);
      if (warmth < 0.04) {
        continue;
      }
      const fade =
        Math.min(
          1,
          Math.max(
            0,
            (edge - Math.hypot(px - frame.middle, py - frame.middle)) / 40
          )
        ) * smoothstep(0, 24, Math.min(px, py, CANVAS - px, CANVAS - py));
      const a = Math.round((0.2 + 0.7 * warmth) * fade * (ALPHAS - 1));
      if (a <= 0) {
        continue;
      }
      const h = Math.min(
        HEATS - 1,
        Math.round((0.3 + 0.5 * warmth) * (HEATS - 1))
      );
      field.dots[h * ALPHAS + Math.min(a, ALPHAS - 1)]?.push(
        px,
        py,
        cell * (0.1 + 0.12 * warmth)
      );
    }
  }
};

/** One path per colour: every dot of the same ink and warmth drawn in a single fill. */
const paint = (
  context: CanvasRenderingContext2D,
  brain: Brain,
  styles: string[],
  shown: number,
  rings: RingField | null
): void => {
  const { screen } = brain;
  const byColour: number[][] = Array.from({ length: ALPHAS * HEATS }, () => []);
  for (let index = 0; index < POINTS; index += 1) {
    const bucket = valueAt(screen.bucket, index);
    if (bucket % ALPHAS > 0) {
      byColour[bucket]?.push(index);
    }
  }
  context.clearRect(0, 0, CANVAS, CANVAS);
  // The finest dots are drawn as squares, which is quicker and looks no different while they are under a pixel and a half on screen.
  const fine = 0.75 / Math.max(1, shown);
  for (const [bucket, indexes] of byColour.entries()) {
    if (indexes.length === 0) {
      continue;
    }
    context.fillStyle = styles[bucket] ?? "transparent";
    context.beginPath();
    for (const index of indexes) {
      const r = valueAt(screen.radius, index);
      const x = valueAt(screen.x, index);
      const y = valueAt(screen.y, index);
      if (r < fine) {
        context.rect(x - r, y - r, r * 2, r * 2);
      } else {
        context.moveTo(x + r, y);
        context.arc(x, y, r, 0, TAU);
      }
    }
    context.fill();
  }
  if (rings === null) {
    return;
  }
  for (const [bucket, list] of rings.dots.entries()) {
    if (list.length === 0) {
      continue;
    }
    context.fillStyle = styles[bucket] ?? "transparent";
    context.beginPath();
    for (let at = 0; at < list.length; at += 3) {
      const x = valueAt(list, at);
      const y = valueAt(list, at + 1);
      const r = valueAt(list, at + 2);
      context.moveTo(x + r, y);
      context.arc(x, y, r, 0, TAU);
    }
    context.fill();
  }
};

/** Grasp asking someone: a new ring comes in with the voice, as strong as it is; paused, none. */
const callRings = (
  brain: Brain,
  scene: BrainScene,
  now: number,
  still: boolean,
  talking: number
): void => {
  if (
    scene.call === true &&
    !still &&
    talking > 0.05 &&
    now - brain.lastRing > RING.every
  ) {
    brain.rings.push({
      at: now,
      strength: 0.5 + 0.5 * Math.min(1, talking * 1.4),
    });
    brain.lastRing = now;
  }
  while (
    brain.rings.length > 0 &&
    (now - (brain.rings[0]?.at ?? now)) * RING.speed > RING.reach
  ) {
    brain.rings.shift();
  }
};

/** The warm spot glides after the pointer and fades in and out, so it never jumps. */
const followPointer = (
  brain: Brain,
  pointer: Pointer,
  still: boolean
): void => {
  const follow = still ? 1 : 0.22;
  if (pointer.inside) {
    brain.spot.x += (pointer.x - brain.spot.x) * follow;
    brain.spot.y += (pointer.y - brain.spot.y) * follow;
  }
  brain.spot.strength +=
    ((pointer.inside ? 1 : 0) - brain.spot.strength) * (still ? 1 : 0.12);
};

/** What this frame shares with every dot. */
const frameOf = (
  brain: Brain,
  live: Live,
  shape: DotShape,
  now: number,
  glowing: boolean,
  rings: RingField
): Frame => {
  const { scene, reduce: still } = live;
  const morphing = brain.morphAt >= 0;
  const scale = CANVAS * 0.43 * LOOK.air;
  // Patches of faintness drift over the figure; every half minute or so they recede, and it all shows. Charged, nothing hides: the whole brain shows.
  const tide = still
    ? 0
    : tideOut(now) *
      (1 - brain.charged) *
      (1 - Math.min(Math.max(scene.clear ?? 0, 0), 1));
  // Grasp's own voice when it speaks: the heads' mouths, and a soft pulse out from them.
  const talking = live.voice();
  callRings(brain, scene, now, still, talking);
  // Asking someone, the voice is Grasp's, not theirs: their mouth stays still. So does the mouth of whoever stands beside the one speaking.
  const mouth = scene.call === true || scene.quiet === true ? 0 : talking;
  const turn = Math.floor(now / 2.4) % 2;
  // Where the voice comes from moves with the figure: from the last one's mouth to this one's.
  const channel = shape.activity === "alternate" ? turn : 0;
  const toVoiceX = shape.voice[channel * 2] ?? 0;
  const toVoiceY = shape.voice[channel * 2 + 1] ?? 0;
  const along = morphing
    ? smoothstep(0, MORPH_S + SPREAD_S, now - brain.morphAt)
    : 1;
  const voiceX = brain.from.voice[0] + (toVoiceX - brain.from.voice[0]) * along;
  const voiceY = brain.from.voice[1] + (toVoiceY - brain.from.voice[1]) * along;
  brain.voice = [voiceX, voiceY];
  const ringing = brain.rings.length > 0;
  if (ringing) {
    rings.taken.fill(0);
  }
  return {
    now,
    still,
    shape,
    morphing,
    scale,
    middle: CANVAS / 2,
    reach: REACH * LOOK.reach,
    // The spacing between neighbouring dots, in drawing pixels.
    gap: PITCH * scale,
    tide,
    mouth,
    // Grasp's voice lifts the patches, in looks that listen to it.
    lifted: LOOK.voice * mouth,
    turn,
    voiceX,
    voiceY,
    band: ((now * 0.42) % 2.8) - 1.4,
    wave: still ? -1 : (now - brain.waveAt) * 240,
    waveLeft: 1 - (now - brain.waveAt) / 1.8,
    spot: brain.spot,
    hovering: brain.spot.strength > 0.01,
    charged: brain.charged,
    glowing,
    ringing,
    rung: (px, py) => rungAt(brain.rings, now, px, py),
  };
};

/**
 * Draws the brain on a canvas until the returned function stops it. Reads the scene, the pointer
 * and how large it is shown from `live` and `pointer` on every frame.
 */
const animate = (
  element: HTMLCanvasElement,
  live: { current: Live },
  pointer: { current: Pointer }
): (() => void) => {
  const context = element.getContext("2d");
  if (context === null) {
    return () => {
      // Nothing to draw on, so nothing to stop.
    };
  }
  // Drawn as sharp as the screen is dense and the size it is shown at asks for, in quarter steps, and never less sharp again. Both are looked at before every drawing: a window moves to a denser screen. A canvas given a new size is empty, so this is done right before a drawing.
  let sharp = 0;
  const sharpen = () => {
    const needed =
      Math.min(window.devicePixelRatio || 1, 2) *
      Math.max(SHARPNESS, Math.ceil(live.current.shown * 4) / 4);
    if (needed <= sharp) {
      return;
    }
    sharp = needed;
    element.width = CANVAS * sharp;
    element.height = CANVAS * sharp;
    context.setTransform(sharp, 0, 0, sharp, 0, 0);
  };
  let styles = palette(element);
  const repaint = () => {
    styles = palette(element);
  };
  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", repaint);
  const themes = new MutationObserver(repaint);
  themes.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme", "style"],
  });
  const brain = brainOf(live.current.scene, live.current.apart !== undefined);
  const rings = ringFieldOf();
  const taken = (sx: number, sy: number) => {
    const cx = Math.floor(sx / rings.cell);
    const cy = Math.floor(sy / rings.cell);
    for (
      let gy = Math.max(cy - 1, 0);
      gy <= Math.min(cy + 1, rings.across - 1);
      gy += 1
    ) {
      for (
        let gx = Math.max(cx - 1, 0);
        gx <= Math.min(cx + 1, rings.across - 1);
        gx += 1
      ) {
        rings.taken[gy * rings.across + gx] = 1;
      }
    }
  };
  let visible = true;
  const watcher = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true;
  });
  watcher.observe(element);

  let frame = 0;
  // The last frame's time, so easing follows the clock rather than the frame rate.
  let then = -1;
  const draw = (ms: number) => {
    frame = requestAnimationFrame(draw);
    if (!visible) {
      return;
    }
    sharpen();
    const now = ms / 1000;
    const since = then < 0 ? 1 / 60 : Math.min(now - then, 0.1);
    then = now;
    const { scene, reduce: still } = live.current;
    // What a sixtieth of a second's easing comes to over the time since the last frame.
    const ease = (rate: number) => (still ? 1 : 1 - (1 - rate) ** (since * 60));
    retarget(brain, scene.shape, now, still);
    const shape = brain.target;
    if (shape === null) {
      return;
    }
    easeScene(brain, scene, ease);
    settle(brain, shape, now);
    const { arrives, glowing } = runNerves(
      brain,
      scene.shape,
      shape,
      now,
      still
    );
    runWave(brain, scene.fill, now, still, arrives);
    followPointer(brain, pointer.current, still);
    const shared = frameOf(brain, live.current, shape, now, glowing, rings);
    for (let index = 0; index < POINTS; index += 1) {
      printDot(brain, shared, index, taken);
    }
    if (shared.ringing) {
      ringDots(rings, shared);
    }
    paint(
      context,
      brain,
      styles,
      live.current.shown,
      shared.ringing ? rings : null
    );
  };
  frame = requestAnimationFrame(draw);

  return () => {
    cancelAnimationFrame(frame);
    // Mid-flight, the next brain finishes the flight from here; settled, it simply stays. Of two side by side, only the one that leaves hands its dots on.
    const { apart } = live.current;
    if (apart === undefined || apart.leaves) {
      const dots = emptyDots();
      copyDots(dots, brain);
      dots.targetId = brain.morphAt >= 0 ? "" : brain.targetId;
      kept = dots;
    }
    watcher.disconnect();
    themes.disconnect();
    scheme.removeEventListener("change", repaint);
  };
};

/** Draws the brain on its canvas, at the size it is shown, until the returned function stops it. */
const watch = (
  element: HTMLCanvasElement,
  live: { current: Live },
  pointer: { current: Pointer }
): (() => void) => {
  // How large it is shown, against the size it is drawn at.
  const sizes = new ResizeObserver(([entry]) => {
    const width = entry?.contentRect.width ?? CANVAS;
    live.current = { ...live.current, shown: width / CANVAS };
  });
  sizes.observe(element);
  const stop = animate(element, live, pointer);
  return () => {
    sizes.disconnect();
    stop();
  };
};

/** Grasp is not speaking. */
const silent = () => 0;

const lessMotion = "(prefers-reduced-motion: reduce)";

const prefersLessMotion = () => window.matchMedia(lessMotion).matches;

const onMotionChange = (listener: () => void) => {
  const media = window.matchMedia(lessMotion);
  media.addEventListener("change", listener);
  return () => {
    media.removeEventListener("change", listener);
  };
};

/**
 * The company brain: a cloud of dots in rows, like a depth scan printed in dither, seen straight
 * on, that takes a new figure for every step: a head, the org, pages, a laptop, a crowd, two
 * heads, a brain. Inked dots are what we know; grey dots wait. Warmth shows activity: a voice, a
 * lead, the pointer, and a wave whenever the brain grows. Where the brain stands in the middle of
 * its nerves, every connected nerve carries a signal in to it now and then, as warmth; a nerve
 * that is connected while you watch carries a stronger one first, and the brain's wave waits for
 * it. Each dot's size carries the shading, as in halftone print. Under the pointer, dots swell and
 * glow. It never turns; its dots only sway sideways, faintly. When Grasp speaks a soft pulse of
 * warmth runs out from the mouth. Patches of it fade and return, so it is only ever partly there
 * until the pointer finds the rest. When Grasp asks whoever is shown something, rings of dots
 * come in from the top right as it speaks. Charged, at the very end, all of it shows and warmth
 * shimmers through it. It carries on where it was when it is drawn again, after a change of
 * language or a visit elsewhere, rather than gathering from the start. Still for people who ask
 * for less motion. The label says the same in words.
 *
 * It is made to be the one figure on stage. Where two stand side by side, each is `apart`: it is
 * its figure from its first frame, and only the one that `leaves` hands its dots to the brain that
 * comes after them.
 *
 * It fills the square its parent gives it (`className`), drawn at `CANVAS` and scaled, so a change
 * of size eases instead of redrawing. `voice` says how loud Grasp speaks right now, 0 to 1.
 */
export const DotBrain = ({
  scene,
  label,
  className,
  apart,
  voice = silent,
}: {
  scene: BrainScene;
  label: string;
  className?: string;
  apart?: { leaves: boolean };
  voice?: () => number;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const reduce = useSyncExternalStore(
    onMotionChange,
    prefersLessMotion,
    () => false
  );
  const live = useRef<Live>({ scene, reduce, shown: 1, apart, voice });
  // Where the pointer is over the brain; only the dots near it answer, never the figure as a whole.
  const pointer = useRef<Pointer>({ x: 0, y: 0, inside: false });

  useEffect(() => {
    live.current = { ...live.current, scene, reduce, apart, voice };
  });

  useEffect(() => {
    const element = canvas.current;
    return element === null ? undefined : watch(element, live, pointer);
  }, []);

  return (
    <div className={cn("relative aspect-square max-w-full", className)}>
      <span className="sr-only">{label}</span>
      <canvas
        aria-hidden="true"
        className="absolute inset-0 size-full"
        onPointerLeave={() => {
          pointer.current = { ...pointer.current, inside: false };
        }}
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          pointer.current = {
            x: ((event.clientX - box.left) / box.width) * CANVAS,
            y: ((event.clientY - box.top) / box.height) * CANVAS,
            inside: true,
          };
        }}
        ref={canvas}
      />
    </div>
  );
};
