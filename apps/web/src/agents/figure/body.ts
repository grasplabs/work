import { BAYER_MATRIX } from "@grasp-os/ui/lib/utils";

import {
  breathOf,
  eyeLifeOf,
  shutOf,
  stepEye,
  twitchOf,
  warmthOf,
} from "./eye.ts";
import type { EyeLife } from "./eye.ts";
import { laterParts } from "./figures.ts";
import type { Drawn, Hit, Sphere } from "./solid.ts";
import { TAU, clamp, missed, noise, sphereHit } from "./solid.ts";

export { hash } from "./solid.ts";

/** The poses a figure takes here. */
export const figureStates = [
  "asleep",
  "idle",
  "listening",
  "thinking",
  "done",
  "speaking",
] as const;
export type FigureState = (typeof figureStates)[number];

/** The shapes an agent can be given. */
export const figureShapes = [
  "orb",
  "trio",
  "pair",
  "swarm",
  "prism",
  "crystal",
  "planet",
  "torus",
  "crater",
  "comet",
  "orbit",
  "crescent",
  "eclipse",
  "sun",
  "jellyfish",
  "mushroom",
  "cloud",
  "lantern",
  "bell",
] as const;
export type FigureShape = (typeof figureShapes)[number];

/** The numbers that pose the light and the motion. */
const PARAMS = [
  "key",
  "az",
  "el",
  "wrap",
  "gloss",
  "rim",
  "glow",
  "speed",
  "spread",
  "size",
  "wander",
  "open",
  "pupil",
] as const;
type Param = (typeof PARAMS)[number];
type Pose = Record<Param, number>;

const poses: Record<FigureState, Pose> = {
  asleep: {
    key: 0.62,
    az: -0.75,
    el: 0.55,
    wrap: 0.4,
    gloss: 0.12,
    rim: 0.08,
    glow: 0.04,
    speed: 0,
    spread: 0.94,
    size: 0.96,
    wander: 0,
    open: 0,
    pupil: 1,
  },
  idle: {
    key: 1,
    az: -0.75,
    el: 0.55,
    wrap: 0.15,
    gloss: 0.55,
    rim: 0.16,
    glow: 0.22,
    speed: 1,
    spread: 1,
    size: 1,
    wander: 0.15,
    open: 1,
    pupil: 1,
  },
  listening: {
    key: 1.08,
    az: -0.25,
    el: 0.35,
    wrap: 0.25,
    gloss: 0.7,
    rim: 0.2,
    glow: 0.36,
    speed: 1.6,
    spread: 1.07,
    size: 1.04,
    wander: 0.08,
    open: 1.3,
    pupil: 1.35,
  },
  thinking: {
    key: 1,
    az: 1.15,
    el: 0.5,
    wrap: 0.3,
    gloss: 0.5,
    rim: 0.32,
    glow: 0.28,
    speed: 2.6,
    spread: 0.92,
    size: 0.98,
    wander: 0.6,
    open: 0.9,
    pupil: 0.8,
  },
  done: {
    key: 1.25,
    az: -0.45,
    el: 0.45,
    wrap: 0.45,
    gloss: 0.9,
    rim: 0.12,
    glow: 0.55,
    speed: 1.2,
    spread: 1.12,
    size: 1.06,
    wander: 0.1,
    open: 1,
    pupil: 1.2,
  },
  // Telling: the light comes round toward you and its surface turns quicker; the voice does the rest (`Body.voice`).
  speaking: {
    key: 1.02,
    az: -0.5,
    el: 0.5,
    wrap: 0.25,
    gloss: 0.65,
    rim: 0.24,
    glow: 0.3,
    speed: 2,
    spread: 1.04,
    size: 1.02,
    wander: 0.12,
    open: 1.1,
    pupil: 1.1,
  },
};

/** A cell's Bayer threshold, 0 to 1. */
export const thresholdAt = (column: number, row: number): number =>
  ((BAYER_MATRIX[row % 4]?.[column % 4] ?? 8) + 0.5) / 16;

/** The codes a cell can hold: nothing, the ground, or one of five lights (2 to 6). */
export const CODES = 7;

/** Two smoothing stages: a change of pose leaves with no jolt and never overshoots. */
// A pose eases in two stages, each with this time constant: a new state stands within 300ms (the
// library's motion rule), from wherever the numbers were.
const TAU_MORPH = 0.05;
/** Alive, a pose comes on unhurried; sleep comes slower still, its turning running down. */
const TAU_ALIVE = 0.16;
const TAU_SLEEP = 0.9;
/** How fast an alive orb's surface turns at a pose's speed of 1, in radians a second, and how much faster his voice makes it. */
const SPIN = 0.3;
const SPIN_VOICE = 1.1;
const nearestAngle = (from: number, to: number) =>
  to + Math.round((from - to) / TAU) * TAU;

/** A figure's body: the pose now, its first smoothing stage, its goal, and its clocks. */
export interface Body {
  now: Pose;
  stage: Pose;
  goal: Pose;
  /** How far its bodies have travelled, in turns of their own speed. */
  travel: number;
  seconds: number;
  state: FigureState;
  shape: FigureShape;
  /** The main agent's orb looks out with one eye (Stephen's own). */
  eye: boolean;
  /** Its eye is alive (it looks about, blinks, breathes): never in a still picture. */
  blinks: boolean;
  /** Seconds since its pose was last set: the squint of a job done. */
  since: number;
  /** Where the eye is asked to look, -1 to 1 each way: the pointer, a focused control, or straight out. */
  look: Lean;
  /** The eye's life (eye.ts). */
  life: EyeLife;
  /** How far into thinking it is, 0 to 1, eased: the main agent's thought comes and goes with it. */
  thinking: number;
  /** Where that thought is on its way round, an angle. */
  orbit: number;
  /**
   * Stephen alive without his eye, as he holds a conversation (the interview's orb): his surface
   * turns, a thought goes round him while he thinks, his light follows his voice, and he eases
   * into a pose rather than taking it.
   */
  alive: boolean;
  /** How far his surface has turned, an angle: faster as he attends, thinks and speaks, still asleep. */
  spin: number;
  /** How loud the voice he follows is now, 0 to 1, eased; `voiceGoal` is what it is told. */
  voice: number;
  voiceGoal: number;
  /** How quickly the pose changes, the time constant of each of its two stages, in seconds. */
  morph: number;
}

/**
 * The main agent thinking: a thought, a small light of its own, goes round its orb on a tilted
 * way, in front and behind, and its eye follows it. Looking away alone (as the other figures
 * think) was too little to see.
 */
const THOUGHT_SECONDS = 2.6;
const THOUGHT_WAY = 0.86;
const THOUGHT_SIZE = 0.14;
/** The orb is this much smaller while it thinks, so the thought has room to go round. */
const THOUGHT_ROOM = 0.14;

const thoughtOf = (body: Body): Sphere => {
  const tilt = 1.2;
  const lean = 0.32;
  const across = Math.cos(body.orbit) * THOUGHT_WAY;
  const deep = Math.sin(body.orbit) * THOUGHT_WAY;
  const z = deep * Math.sin(tilt);
  return {
    kind: "sphere",
    x: across * Math.cos(lean) - deep * Math.cos(tilt) * Math.sin(lean),
    y: across * Math.sin(lean) + deep * Math.cos(tilt) * Math.cos(lean),
    z,
    r: THOUGHT_SIZE * (1 + 0.22 * z) * body.thinking,
    silk: false,
  };
};

export const bodyOf = (
  state: FigureState,
  shape: FigureShape,
  seed = 1,
  eye = false,
  alive = false
): Body => ({
  now: { ...poses[state] },
  stage: { ...poses[state] },
  goal: poses[state],
  travel: seed * 1.37,
  seconds: seed * 2.1,
  state,
  shape,
  eye,
  blinks: true,
  since: 9,
  look: { x: 0, y: 0 },
  life: eyeLifeOf(seed),
  thinking: state === "thinking" ? 1 : 0,
  // A still picture has it up and to the side, where the eye looks.
  orbit: 0.75,
  alive,
  spin: seed * 0.9,
  voice: 0,
  voiceGoal: 0,
  morph: TAU_MORPH,
});

/** A new pose or shape, from wherever the numbers are now. */
export const setPose = (
  body: Body,
  state: FigureState,
  shape: FigureShape = body.shape
): void => {
  if (body.state !== state) {
    body.since = 0;
  }
  if (body.alive) {
    body.morph = state === "asleep" ? TAU_SLEEP : TAU_ALIVE;
  }
  body.state = state;
  body.shape = shape;
  body.goal = poses[state];
};

export const stepBody = (body: Body, dt: number): void => {
  const { now, stage, goal } = body;
  const k = 1 - Math.exp(-dt / body.morph);
  for (const key of PARAMS) {
    const target = key === "az" ? nearestAngle(stage.az, goal.az) : goal[key];
    stage[key] += (target - stage[key]) * k;
    now[key] += (stage[key] - now[key]) * k;
  }
  // Asleep (speed 0) its silk and its light stand still too: the clock runs at its pace, never faster.
  body.seconds += dt * Math.min(1, now.speed);
  body.travel += dt * 0.32 * now.speed;
  body.since += dt;
  const busy = body.state === "thinking";
  body.thinking += ((busy ? 1 : 0) - body.thinking) * (1 - Math.exp(-dt / 0.1));
  body.orbit += (dt * TAU) / THOUGHT_SECONDS;
  if (body.alive) {
    // His voice rises quickly and falls back slower, as a light that follows it should.
    const toward = body.voiceGoal > body.voice ? 0.06 : 0.22;
    body.voice += (body.voiceGoal - body.voice) * (1 - Math.exp(-dt / toward));
    body.spin += dt * (SPIN * now.speed + SPIN_VOICE * body.voice);
  }
  if (body.eye && body.blinks) {
    const thought = busy && body.shape === "orb" ? thoughtOf(body) : undefined;
    stepEye(
      body.life,
      body.state,
      dt,
      body.look,
      body.since,
      thought && { x: thought.x * 1.25, y: thought.y * 1.25 + 0.12 }
    );
  }
};

/** Where the pointer leans, -1 to 1 each way. */
export interface Lean {
  x: number;
  y: number;
}

// ---- The bodies a shape is made of.

/** A bevelled solid seen from the front: an outline as a distance, and how its edge rounds. */
interface Solid {
  kind: "prism" | "crystal";
  x: number;
  y: number;
  r: number;
  turn: number;
}

/** A thin ring in a tilted plane round the centre. */
interface Ring {
  kind: "ring";
  inner: number;
  outer: number;
  /** The plane's tilt from facing you: its height on screen is cos of it. */
  tilt: number;
  turn: number;
}

export type Part = Sphere | Solid | Ring | Drawn;

/** Bodies on a tilted circle: each a sphere, nearer ones larger. */
const circling = (
  count: number,
  radius: number,
  size: number,
  phase: number,
  tilt: number,
  lean: number
): Sphere[] =>
  Array.from({ length: count }, (_, index) => {
    const angle = phase + (index * TAU) / count;
    const across = Math.cos(angle) * radius;
    const deep = Math.sin(angle) * radius;
    const x = across * Math.cos(lean) - deep * Math.cos(tilt) * Math.sin(lean);
    const y = across * Math.sin(lean) + deep * Math.cos(tilt) * Math.cos(lean);
    const z = deep * Math.sin(tilt);
    return { kind: "sphere", x, y, z, r: size * (1 + 0.22 * z), silk: false };
  });

const SQRT3 = Math.sqrt(3);

/** The distance to an upright equilateral triangle of circumradius `r`, after Inigo Quilez. */
const triangleEdge = (x: number, y: number, r: number): number => {
  const side = r * SQRT3 * 0.5;
  let px = Math.abs(x) - side;
  let py = y + side / SQRT3;
  if (px + SQRT3 * py > 0) {
    const nx = (px - SQRT3 * py) / 2;
    const ny = (-SQRT3 * px - py) / 2;
    px = nx;
    py = ny;
  }
  px -= clamp(px, -2 * side, 0);
  return -Math.hypot(px, py) * Math.sign(py);
};

/** A regular hexagon's distance and the facet a point is on. */
const hexagon = (x: number, y: number, r: number) => {
  const angle = Math.atan2(y, x);
  const facet = Math.round(angle / (TAU / 6)) * (TAU / 6);
  const along = x * Math.cos(facet) + y * Math.sin(facet);
  return { edge: along - r * Math.cos(Math.PI / 6), facet };
};

const prismHit = (part: Solid, x: number, y: number, reach: number): Hit => {
  const cos = Math.cos(part.turn);
  const sin = Math.sin(part.turn);
  const u = (x - part.x) * cos + (y - part.y) * sin;
  const v = -(x - part.x) * sin + (y - part.y) * cos;
  const edge = triangleEdge(u, v, part.r) - part.r * 0.1;
  if (edge > reach) {
    return missed(edge);
  }
  // A three-sided pyramid seen from above: each face one flat light, leaning to its edge.
  const third = TAU / 3;
  const face =
    Math.round((Math.atan2(v, u) - Math.PI / 6) / third) * third + Math.PI / 6;
  const world = face + part.turn + Math.PI;
  const tilt = 0.78;
  return {
    edge,
    depth: 0.3,
    nx: Math.cos(world) * Math.sin(tilt),
    ny: Math.sin(world) * Math.sin(tilt),
    nz: Math.cos(tilt),
    grain: 0.5,
  };
};

const crystalHit = (part: Solid, x: number, y: number, reach: number): Hit => {
  const cos = Math.cos(part.turn);
  const sin = Math.sin(part.turn);
  const u = (x - part.x) * cos + (y - part.y) * sin;
  const v = -(x - part.x) * sin + (y - part.y) * cos;
  const { edge, facet } = hexagon(u, v, part.r);
  if (edge > reach) {
    return missed(edge);
  }
  // A table in the middle, six facets falling away round it: each facet one flat light.
  const table = hexagon(u, v, part.r * 0.42).edge < 0;
  const world = facet + part.turn;
  const tilt = table ? 0 : 0.62;
  return {
    edge,
    depth: 0.3,
    nx: Math.cos(world) * Math.sin(tilt),
    ny: Math.sin(world) * Math.sin(tilt),
    nz: Math.cos(tilt),
    grain: 0.5,
  };
};

const ringHit = (part: Ring, x: number, y: number, reach: number): Hit => {
  const cos = Math.cos(part.turn);
  const sin = Math.sin(part.turn);
  const u = x * cos + y * sin;
  const v = (-x * sin + y * cos) / Math.cos(part.tilt);
  const radius = Math.hypot(u, v);
  const width = (part.outer - part.inner) / 2;
  const middle = (part.outer + part.inner) / 2;
  const edge = (Math.abs(radius - middle) - width) * Math.cos(part.tilt) * 2.4;
  if (edge > reach) {
    return missed(edge);
  }
  // Its near half passes in front of what it circles, its far half behind.
  return {
    edge,
    depth: -v * Math.sin(part.tilt) * 0.9,
    nx: 0,
    ny: Math.sin(part.tilt) * 0.9,
    nz: Math.cos(part.tilt) + 0.35,
    grain: noise(radius * 26, 3.3),
  };
};

/** The orb, and round the main agent's while it thinks, its thought. */
const orbParts = (body: Body, size: number): Part[] => {
  const orb: Sphere = {
    kind: "sphere",
    x: 0,
    y: 0,
    z: 0,
    // Alive, his size stays: the thought goes round him, in front and behind.
    r: 0.74 * size * (body.eye ? 1 - THOUGHT_ROOM * body.thinking : 1),
    silk: true,
    ...(body.alive ? { spin: body.spin } : {}),
  };
  return (body.eye || body.alive) && body.thinking > 0.03
    ? [orb, thoughtOf(body)]
    : [orb];
};

/** How large its pose makes it: alive, his size stays, whatever the pose. */
const sizeOf = (body: Body): number => (body.alive ? 1 : body.now.size);

/** The scene a shape is now, in the unit square (-1 to 1, y up). */
const partsOf = (body: Body): Part[] => {
  const { now, travel } = body;
  // Every scene a little over the unit, so it fills its square as Stephen fills his.
  const size = sizeOf(body) * 1.12;
  const { spread } = now;
  const turn = travel * TAU;
  switch (body.shape) {
    case "orb": {
      return orbParts(body, size);
    }
    case "trio": {
      return circling(3, 0.48 * spread, 0.32 * size, turn, 1.05, 0.12);
    }
    case "pair": {
      return circling(2, 0.38 * spread, 0.4 * size, turn * 0.8, 1.15, -0.35);
    }
    case "swarm": {
      return [
        { kind: "sphere", x: 0, y: 0, z: 0, r: 0.3 * size, silk: true },
        ...circling(3, 0.56 * spread, 0.15 * size, turn * 1.3, 1.2, 0.4),
        ...circling(4, 0.82 * spread, 0.12 * size, -turn * 0.9 + 1, 1.3, -0.5),
        ...circling(2, 0.42 * spread, 0.1 * size, turn * 1.9 + 2, 0.7, 1.4),
      ];
    }
    case "prism": {
      return [
        {
          kind: "prism",
          x: 0,
          y: -0.1,
          r: 0.66 * size,
          turn: Math.sin(turn * 0.35) * 0.18,
        },
      ];
    }
    case "crystal": {
      return [
        { kind: "crystal", x: 0, y: 0, r: 0.72 * size, turn: turn * 0.25 },
      ];
    }
    case "torus":
    case "crater":
    case "comet":
    case "orbit":
    case "crescent":
    case "eclipse":
    case "sun":
    case "jellyfish":
    case "mushroom":
    case "cloud":
    case "lantern":
    case "bell": {
      return laterParts[body.shape](size, spread, turn);
    }
    case "planet": {
      const tilt = 1.22 + 0.06 * Math.sin(turn * 0.5);
      return [
        { kind: "sphere", x: 0, y: 0, z: 0, r: 0.42 * size, silk: true },
        {
          kind: "ring",
          inner: 0.56 * size,
          outer: 0.88 * size * spread,
          tilt,
          turn: -0.32,
        },
      ];
    }
    default: {
      return [];
    }
  }
};

const hitOf = (
  part: Part,
  x: number,
  y: number,
  seconds: number,
  reach: number
): Hit => {
  switch (part.kind) {
    case "sphere": {
      return sphereHit(part, x, y, seconds, reach);
    }
    case "prism": {
      return prismHit(part, x, y, reach);
    }
    case "crystal": {
      return crystalHit(part, x, y, reach);
    }
    case "ring": {
      return ringHit(part, x, y, reach);
    }
    case "drawn": {
      return part.hit(x, y, reach);
    }
    default: {
      return missed(9);
    }
  }
};

/** The light a surface takes: key with wrap, gloss, rim, and its grain. */
const lit = (
  now: Pose,
  light: { x: number; y: number; z: number },
  hit: Hit
): number => {
  const length = Math.hypot(hit.nx, hit.ny, hit.nz) || 1;
  const nx = hit.nx / length;
  const ny = hit.ny / length;
  const nz = hit.nz / length;
  const facing = nx * light.x + ny * light.y + nz * light.z;
  const diffuse = clamp((facing + now.wrap) / (1 + now.wrap));
  // The gloss: where the light glances off toward the eye.
  const reflected = 2 * facing * nz - light.z;
  const gloss = now.gloss * clamp(reflected) ** 24;
  const rim = now.rim * (1 - nz) ** 2.4;
  const grain = 1 + (hit.grain - 0.5) * 0.9;
  return now.key * diffuse ** 1.2 * grain + gloss + rim;
};

// ---- The main agent's eye: one, in the middle of its orb, drawn in the same light and dither.

/** How the eye stands this frame: how open, where it looks (-1 to 1 each way), its pupil, its squint, a dream's twitch. */
interface Gaze {
  open: number;
  x: number;
  y: number;
  pupil: number;
  squint: number;
  twitch: number;
}

const gazeOf = (body: Body): Gaze => {
  const { now, life } = body;
  if (!body.blinks) {
    // A still picture: open (or shut, asleep), looking out.
    return {
      open: now.open,
      x: 0,
      y: 0,
      pupil: now.pupil,
      squint: warmthOf(body.state),
      twitch: 0,
    };
  }
  const x = clamp(life.x, -1.2, 1.2);
  const y = clamp(life.y, -1.2, 1.2);
  // The lids follow the gaze: looking down lowers the upper lid a little, looking up lifts it.
  const lids = 1 - 0.3 * Math.max(0, -y) + 0.08 * Math.max(0, y);
  return {
    open: now.open * (1 - shutOf(life)) * lids,
    x,
    y,
    pupil: now.pupil,
    squint: life.squint,
    twitch: twitchOf(life),
  };
};

/** The eye's half width and its open half height, in the orb's radius. */
// Round, not a person's almond eye: with a full pupil and a clear glint it reads as friendly,
// where the narrow one stared.
const EYE_WIDE = 0.33;
const EYE_HIGH = 0.28;
const IRIS = 0.21;
const PUPIL = 0.11;
const SPARK = 0.055;

/**
 * A fine line round the opening, in cells, in the orb's own shadow: on a bright orb (listening,
 * done) the white of the eye is as light as what is round it, and without the line it was lost.
 */
const RIM = 0.6;

/** How far round the opening the lids' shading reaches, in the orb's radius. */
const LID = 0.1;

/** A soft step from 0 to 1 as `x` goes from `low` to `high`. */
const ramp = (x: number, low: number, high: number) =>
  clamp((x - low) / (high - low));

/**
 * The eye at list size: a bright opening in a band of the orb's shadow, and a pupil. A cell of
 * shadow stands for the lids (not night): any softer and it blurs into the orb at 24 pixels.
 */
const smallEyeLight = (
  gaze: Gaze,
  u: number,
  v: number,
  light: number,
  cell: number
): number | undefined => {
  const across = 1 - (u / EYE_WIDE) ** 2;
  if (across <= 0) {
    return undefined;
  }
  if (gaze.open < 0.12) {
    return Math.abs(v + EYE_HIGH * 0.2 * across) < cell * 0.6
      ? light * 0.3
      : undefined;
  }
  const inside = EYE_HIGH * Math.max(1, gaze.open) * across - Math.abs(v);
  if (inside < -cell * 0.5) {
    return undefined;
  }
  if (inside < cell * 0.5) {
    return light * (v > 0 ? 0.25 : 0.5);
  }
  return Math.hypot(u - gaze.x * cell, v - gaze.y * cell) < cell * 1.1
    ? 0
    : 0.5 + 0.6 * light;
};

/** The lids round the opening: the upper a soft band of the orb's own shadow, the lower lighter. */
const lidLight = (
  outside: number,
  upper: boolean,
  light: number
): number | undefined => {
  const fade = ramp(outside, 0, LID);
  if (fade >= 1) {
    return undefined;
  }
  return upper
    ? light * (0.8 + 0.2 * fade ** 1.5)
    : light * (0.8 + 0.2 * fade) + 0.06 * (1 - fade);
};

/**
 * What the eye makes of a cell on the orb at (u, v), in the orb's radius: undefined where the
 * orb's own light shows, else the light it takes. It is drawn on the sphere, not over it: placed by
 * the surface's own angles (so it narrows a little toward the limb), every part lit by the orb's
 * light at that cell, and no outline: the opening shows by the sclera's light against the lids'
 * shading.
 */
const eyeLight = (
  gaze: Gaze,
  flatU: number,
  flatV: number,
  light: number,
  cell: number
): number | undefined => {
  // The whole eye shifts a hair with its gaze, so it turns its attention, not just its pupil.
  const u = Math.asin(clamp(flatU, -0.99, 0.99)) - gaze.x * 0.035;
  const v = Math.asin(clamp(flatV, -0.99, 0.99)) - gaze.y * 0.03;
  // Under a dozen cells to the orb's radius (24 pixels) an iris is a smudge: a bolder eye.
  if (cell > 1 / 12) {
    return smallEyeLight(gaze, u / 1.25, v / 1.25, light, cell / 1.25);
  }
  const across = 1 - (u / EYE_WIDE) ** 2;
  if (across <= 0) {
    return undefined;
  }
  // Shut: the lids meet in a seam of shadow, curved a little down, the upper lid shaded above it.
  if (gaze.open < 0.12) {
    const below = v + EYE_HIGH * 0.28 * across - gaze.twitch * 0.02 * across;
    if (Math.abs(below) < cell * 0.8) {
      return light * 0.3;
    }
    return below > 0 && below < LID * across
      ? light * (0.6 + 0.4 * ramp(below, 0, LID * across))
      : undefined;
  }
  // Glad, the lower lid rises and arcs up in the middle, as a cheek pushes it: the opening
  // narrows toward a crescent, the way eyes smile.
  const reach = EYE_HIGH * gaze.open * across;
  const lower = -reach * (1 - gaze.squint) + reach * 0.5 * gaze.squint;
  const inside = Math.min(reach - v, v - lower);
  if (inside <= 0) {
    return lidLight(
      -inside / Math.max(0.3, across),
      v > (reach + lower) / 2,
      light
    );
  }
  if (inside < cell * RIM) {
    return Math.min(light, 1) * 0.22;
  }
  // The upper lid's shadow falls on the top of the opening.
  const shade =
    v > 0
      ? 0.9 + 0.1 * ramp(inside, 0, 0.07)
      : 0.85 + 0.15 * ramp(inside, 0, 0.05);
  const ix = gaze.x * (EYE_WIDE - IRIS) * 0.75;
  const iy = gaze.y * Math.max(0, EYE_HIGH * gaze.open - IRIS) * 0.75;
  const fromIris = Math.hypot(u - ix, v - iy);
  if (
    Math.hypot(u - ix + IRIS * 0.35, v - iy - IRIS * 0.35) <
    SPARK + cell * 0.3
  ) {
    return 1.2;
  }
  if (fromIris < PUPIL * gaze.pupil) {
    return 0;
  }
  if (fromIris < IRIS) {
    // Kept dark on a bright orb, so the pupil and the glint stay clear.
    return (0.12 + 0.22 * Math.min(light, 1)) * shade;
  }
  return (0.32 + 0.8 * light) * shade;
};

/**
 * The light of a cell of the main agent: on its orb the eye's, where the eye is; on its thought a
 * light of its own, bright at the middle whatever side the orb is lit from, with a dark edge that
 * keeps it apart from the orb where it passes in front of the lit side.
 */
const mainLight = (
  orb: Sphere,
  onOrb: boolean,
  front: Hit,
  gaze: Gaze,
  x: number,
  y: number,
  shone: number,
  cell: number
): number => {
  if (!onOrb) {
    return front.nz < 0.42 ? 0.12 : 0.3 + 0.8 * front.nz ** 1.6;
  }
  return (
    eyeLight(
      gaze,
      (x - orb.x) / orb.r,
      (y - orb.y) / orb.r,
      shone,
      cell / orb.r
    ) ?? shone
  );
};

/** The glow round a figure: how fast it fades (figure units), its gain, and the floor a lit dot clears. */
const GLOW_FADE = 0.11;
const GLOW_GAIN = 2.6;
const GLOW_FLOOR = 0.55;

/** Cells to a side of a tile: a part is traced in a tile only if it comes near one of its cells. */
const TILE = 4;

/**
 * How steeply a part's edge can change across the figure, at most: an edge measured at a tile's
 * middle is within this times the distance of the edge at any of its cells (the planet's tilted
 * ring, the steepest, is 2.4). A rough part (a tilted circle drawn by `ellipseAt`, whose edge jumps
 * at its middle) is measured at every cell instead.
 */
const SLOPE = 3;

/** A band of tiles across the figure: which parts come near each tile, and which tiles any part comes near. */
interface Band {
  near: Uint8Array;
  touched: Uint8Array;
}

/**
 * Marks, for the band of rows from `row` (`high` of them), the parts that come within `within` of a
 * cell of each tile: past that a part can neither cover a cell nor light its glow. A smooth part
 * is measured at the tile's middle, with room for its slope; a rough one is traced wherever a
 * smooth one is, and else asked at every cell.
 */
const markBand = (
  band: Band,
  parts: readonly Part[],
  rough: ReadonlySet<Part>,
  row: number,
  high: number,
  n: number,
  seconds: number,
  within: number
): void => {
  const cell = 2 / n;
  const reach = cell / 2;
  const y = 1 - ((row + high / 2) / n) * 2;
  for (let tile = 0; tile < band.touched.length; tile += 1) {
    const left = tile * TILE;
    const wide = Math.min(TILE, n - left);
    const x = ((left + wide / 2) / n) * 2 - 1;
    const far = within + SLOPE * (Math.hypot(wide, high) / 2) * cell;
    let touched = 0;
    for (const [index, part] of parts.entries()) {
      const near =
        !rough.has(part) && hitOf(part, x, y, seconds, reach).edge <= far
          ? 1
          : 0;
      band.near[tile * parts.length + index] = near;
      touched = Math.max(touched, near);
    }
    for (const [index, part] of parts.entries()) {
      if (!rough.has(part)) {
        continue;
      }
      let near = touched;
      for (let at = 0; at < wide * high && near === 0; at += 1) {
        const across = left + (at % wide);
        const down = row + Math.floor(at / wide);
        near =
          hitOf(
            part,
            ((across + 0.5) / n) * 2 - 1,
            1 - ((down + 0.5) / n) * 2,
            seconds,
            reach
          ).edge <= within
            ? 1
            : 0;
      }
      band.near[tile * parts.length + index] = near;
      touched = Math.max(touched, near);
    }
    band.touched[tile] = touched;
  }
};

/** What a cell sees: the part in front covering it (if any), and the nearest edge of any. */
interface Seen {
  front: Hit | undefined;
  part: Part | undefined;
  nearest: number;
}

/** Fills `seen` for the cell at (x, y), asking only the parts marked near its tile (`near` from `at`). */
const frontAt = (
  seen: Seen,
  parts: readonly Part[],
  near: Uint8Array,
  at: number,
  x: number,
  y: number,
  threshold: number,
  seconds: number,
  cell: number
): Seen => {
  seen.front = undefined;
  seen.part = undefined;
  seen.nearest = 9;
  for (const [index, part] of parts.entries()) {
    if (near[at + index] === 0) {
      continue;
    }
    const hit = hitOf(part, x, y, seconds, cell / 2);
    seen.nearest = Math.min(seen.nearest, hit.edge);
    const covered = clamp(0.5 - hit.edge / cell) > threshold;
    if (covered && (seen.front === undefined || hit.depth > seen.front.depth)) {
      seen.front = hit;
      seen.part = part;
    }
  }
  return seen;
};

/**
 * An alive orb's light this frame: brighter, with more of a rim and a glow, as loud as the voice it
 * follows; asleep, it breathes slowly, its light rising and falling.
 */
const aliveNow = (body: Body): Pose => {
  if (!body.alive) {
    return body.now;
  }
  const { now, voice } = body;
  const sleep = body.state === "asleep" ? 1 : 0;
  const breath = sleep * 0.07 * Math.sin((body.since * TAU) / 5.5);
  return {
    ...now,
    key: now.key * (1 + 0.18 * voice + breath),
    gloss: now.gloss + 0.15 * voice,
    rim: now.rim + 0.12 * voice,
    glow: now.glow + 0.16 * voice,
  };
};

/** Writes the codes of rows `from` to `to` for `parts` in this body's pose: any scene, in the figures' light. */
const paintScene = (
  body: Body,
  parts: readonly Part[],
  lean: Lean,
  n: number,
  out: Uint8Array,
  from: number,
  to: number
): void => {
  // The main agent breathes in its sleep: its light rising and falling, slowly.
  const breathing = body.eye && body.blinks && body.state === "asleep";
  const now = breathing
    ? { ...body.now, key: body.now.key * (1 + 0.1 * breathOf(body.life)) }
    : aliveNow(body);
  const drift = 0.04 + 0.5 * now.wander;
  const az = now.az + drift * Math.sin(body.seconds * 0.55) + lean.x * 0.45;
  const el =
    now.el + drift * 0.5 * Math.sin(body.seconds * 0.8 + 1) + lean.y * 0.3;
  const light = {
    x: Math.cos(el) * Math.sin(az),
    y: Math.sin(el),
    z: Math.cos(el) * Math.cos(az),
  };
  // A cell, in figure units: an edge softer than a cell moves one cell at a time.
  const cell = 2 / n;
  // A part covers a cell only well inside half a cell of its edge: past that only its edge matters.
  const reach = cell / 2;
  // How far out a part can matter to a cell: covering it within half a cell, or lighting its glow.
  const within = Math.max(
    reach,
    GLOW_FADE * Math.log(Math.max(1, (now.glow * GLOW_GAIN) / GLOW_FLOOR))
  );
  const tiles = Math.ceil(n / TILE);
  const band: Band = {
    near: new Uint8Array(tiles * parts.length),
    touched: new Uint8Array(tiles),
  };
  const rough = new Set(
    parts.filter((part) => part.kind === "drawn" && part.rough === true)
  );
  const sight: Seen = { front: undefined, part: undefined, nearest: 9 };
  const gaze = gazeOf(body);
  const orb =
    (body.eye || body.alive) && body.shape === "orb" ? parts[0] : undefined;
  for (let row = from; row < to; row += 1) {
    if ((row - from) % TILE === 0) {
      markBand(
        band,
        parts,
        rough,
        row,
        Math.min(TILE, to - row),
        n,
        body.seconds,
        within
      );
    }
    for (let column = 0; column < n; column += 1) {
      const tile = Math.floor(column / TILE);
      if (band.touched[tile] === 0) {
        // No part comes near: night.
        out[row * n + column] = 0;
        continue;
      }
      const x = ((column + 0.5) / n) * 2 - 1;
      const y = 1 - ((row + 0.5) / n) * 2;
      const threshold = thresholdAt(column, row);
      const {
        front,
        part: frontPart,
        nearest,
      } = frontAt(
        sight,
        parts,
        band.near,
        tile * parts.length,
        x,
        y,
        threshold,
        body.seconds,
        cell
      );
      const at = row * n + column;
      if (front === undefined) {
        // The glow round it: a few dim dots fading into the night, nothing beyond.
        const glow = now.glow * Math.exp(-Math.max(0, nearest) / GLOW_FADE);
        const level = Math.floor(glow * GLOW_GAIN + threshold - GLOW_FLOOR);
        out[at] = level >= 1 ? Math.min(level, 2) + 1 : 0;
        continue;
      }
      front.surface?.();
      // Its outline catches the rim light too, so a solid lit from behind still has an edge.
      const outline = now.rim * clamp(1 + front.edge / (cell * 2));
      const shone = lit(now, light, front) * (front.tone ?? 1) + outline;
      let value = shone;
      if (orb?.kind === "sphere" && (body.eye || frontPart !== orb)) {
        value = mainLight(
          orb,
          frontPart === orb,
          front,
          gaze,
          x,
          y,
          shone,
          cell
        );
      }
      const level = clamp(Math.floor(value * 5 + threshold - 0.15), 0, 5);
      out[at] = level + 1;
    }
  }
};

/** Writes the cells' codes for this frame into `out`, `n` cells across: every row, or rows `from` to `to`. */
export const paintBody = (
  body: Body,
  lean: Lean,
  n: number,
  out: Uint8Array,
  from = 0,
  to = n
): void => {
  paintScene(body, partsOf(body), lean, n, out, from, to);
};

/** A pose's still: the picture with reduced motion and the server's. */
export const paintStill = (
  state: FigureState,
  shape: FigureShape,
  n: number,
  out: Uint8Array,
  eye = false
): void => {
  const body = bodyOf(state, shape, 1, eye);
  // A still picture never blinks or looks about: open (or shut, asleep), looking out.
  body.blinks = false;
  paintBody(body, { x: 0, y: 0 }, n, out);
};
