// An agent's figure: Damsko's Stephen (grasplabs/ui `site/study/stephen/`, Ruben's pick of 16
// November), lit and dithered the way Stephen is, in a shape of its own. A shape is a small scene
// of lit bodies, not one ball pressed flat: a single orb with silk (Stephen's own), three orbs
// circling one another, a pair in orbit, a swarm on three tilted rings, a bevelled triangle that
// turns, a cut crystal, a planet with its ring. Every body is a height over the cell grid, so each
// has a true normal: a key light with wrap, a rim from behind, a gloss where the light glances off,
// and a glow round the whole that fades into the night it stands on. Each cell's light is set
// through Bayer's ordered dither (`grasp/dither`) into five steps, so the edges move a cell at a
// time. A state is a pose of the lighting and the motion: asleep lit from behind and slow, idle,
// listening turned to you and quicker, thinking with the light wandering and the bodies hurrying,
// done bright. Pure numbers: no DOM here.
//
// BUILDER: Stephen is still a study in the library, not an installed part. This is its lighting
// and dither given `shape` and `palette`; when the library ships Stephen with those, this folder
// goes.
import { BAYER } from "../../grasp/dither/dither.ts";

/** The poses a figure takes here. */
export const figureStates = [
  "asleep",
  "idle",
  "listening",
  "thinking",
  "done",
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
] as const;
type Param = (typeof PARAMS)[number];
type Pose = Record<Param, number>;

const poses: Record<FigureState, Pose> = {
  asleep: {
    key: 0.55,
    az: -2.3,
    el: 0.3,
    wrap: 0,
    gloss: 0.1,
    rim: 0.3,
    glow: 0.04,
    speed: 0.15,
    spread: 0.86,
    size: 0.92,
    wander: 0,
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
  },
};

const TAU = Math.PI * 2;
const clamp = (value: number, low = 0, high = 1) =>
  Math.min(high, Math.max(low, value));

/** A steady hash, 0 to 1. */
export const hash = (a: number, b: number): number => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43_758.5453;
  return s - Math.floor(s);
};

/** The value noise's lattice: steady values read by table, no sine per frame. */
const LATTICE = 256;
const lattice = (() => {
  const values = new Float32Array(LATTICE * LATTICE);
  for (let index = 0; index < values.length; index += 1) {
    values[index] = hash(index % LATTICE, Math.floor(index / LATTICE));
  }
  return values;
})();
const wrapped = (value: number) => ((value % LATTICE) + LATTICE) % LATTICE;

/** Value noise, 0 to 1. */
export const noise = (x: number, y: number): number => {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = lattice[wrapped(iy) * LATTICE + wrapped(ix)] ?? 0;
  const b = lattice[wrapped(iy) * LATTICE + wrapped(ix + 1)] ?? 0;
  const c = lattice[wrapped(iy + 1) * LATTICE + wrapped(ix)] ?? 0;
  const d = lattice[wrapped(iy + 1) * LATTICE + wrapped(ix + 1)] ?? 0;
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
};

/** A cell's Bayer threshold, 0 to 1. */
export const thresholdAt = (column: number, row: number): number =>
  ((BAYER[row % 4]?.[column % 4] ?? 8) + 0.5) / 16;

/** The codes a cell can hold: nothing, the ground, or one of five lights (2 to 6). */
export const CODES = 7;

/** Two smoothing stages: a change of pose leaves with no jolt and never overshoots. */
const TAU_MORPH = 0.2;
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
}

export const bodyOf = (
  state: FigureState,
  shape: FigureShape,
  seed = 1
): Body => ({
  now: { ...poses[state] },
  stage: { ...poses[state] },
  goal: poses[state],
  travel: seed * 1.37,
  seconds: seed * 2.1,
  state,
  shape,
});

/** A new pose or shape, from wherever the numbers are now. */
export const setPose = (
  body: Body,
  state: FigureState,
  shape: FigureShape = body.shape
): void => {
  body.state = state;
  body.shape = shape;
  body.goal = poses[state];
};

export const stepBody = (body: Body, dt: number): void => {
  const { now, stage, goal } = body;
  const k = 1 - Math.exp(-dt / TAU_MORPH);
  for (const key of PARAMS) {
    const target = key === "az" ? nearestAngle(stage.az, goal.az) : goal[key];
    stage[key] += (target - stage[key]) * k;
    now[key] += (stage[key] - now[key]) * k;
  }
  body.seconds += dt;
  body.travel += dt * 0.32 * now.speed;
};

/** Where the pointer leans, -1 to 1 each way. */
export interface Lean {
  x: number;
  y: number;
}

// ---- The bodies a shape is made of.

/** A lit sphere: centre, depth and radius. */
interface Sphere {
  kind: "sphere";
  x: number;
  y: number;
  z: number;
  r: number;
  /** Silk drifting over it: Stephen's own. */
  silk: boolean;
}

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

type Part = Sphere | Solid | Ring;

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

/** The scene a shape is now, in the unit square (-1 to 1, y up). */
const partsOf = (body: Body): Part[] => {
  const { now, travel } = body;
  // Every scene a little over the unit, so it fills its square as Stephen fills his.
  const size = now.size * 1.12;
  const { spread } = now;
  const turn = travel * TAU;
  switch (body.shape) {
    case "orb": {
      return [{ kind: "sphere", x: 0, y: 0, z: 0, r: 0.74 * size, silk: true }];
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

/** What a cell sees of one part: how far inside its edge, its depth, and its surface. */
interface Hit {
  /** Signed distance to the edge, in figure units: below 0 inside. */
  edge: number;
  depth: number;
  nx: number;
  ny: number;
  nz: number;
  /** A drifting texture on the surface, 0 to 1, 0.5 for none. */
  grain: number;
}

/** Too far outside a part for it to matter to the cell. */
const missed = (edge: number): Hit => ({
  edge,
  depth: -9,
  nx: 0,
  ny: 0,
  nz: 1,
  grain: 0.5,
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

const sphereHit = (
  part: Sphere,
  x: number,
  y: number,
  seconds: number
): Hit => {
  const dx = (x - part.x) / part.r;
  const dy = (y - part.y) / part.r;
  const q = dx * dx + dy * dy;
  const edge = (Math.sqrt(q) - 1) * part.r;
  if (q >= 1.2) {
    return missed(edge);
  }
  const nz = Math.sqrt(1 - Math.min(q, 0.999));
  let grain = 0.5;
  if (part.silk) {
    const warp = noise(dx * 1.4 + 7, dy * 2.2 + seconds * 0.03);
    grain = noise(
      dx * 1.3 + seconds * 0.06 + warp * 1.3 + 40,
      dy * 4.2 + warp * 1.6 + 40
    );
  }
  return { edge, depth: part.z + nz * part.r, nx: dx, ny: dy, nz, grain };
};

const prismHit = (part: Solid, x: number, y: number): Hit => {
  const cos = Math.cos(part.turn);
  const sin = Math.sin(part.turn);
  const u = (x - part.x) * cos + (y - part.y) * sin;
  const v = -(x - part.x) * sin + (y - part.y) * cos;
  const edge = triangleEdge(u, v, part.r) - part.r * 0.1;
  if (edge > 0.2) {
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

const crystalHit = (part: Solid, x: number, y: number): Hit => {
  const cos = Math.cos(part.turn);
  const sin = Math.sin(part.turn);
  const u = (x - part.x) * cos + (y - part.y) * sin;
  const v = -(x - part.x) * sin + (y - part.y) * cos;
  const { edge, facet } = hexagon(u, v, part.r);
  if (edge > 0.2) {
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

const ringHit = (part: Ring, x: number, y: number): Hit => {
  const cos = Math.cos(part.turn);
  const sin = Math.sin(part.turn);
  const u = x * cos + y * sin;
  const v = (-x * sin + y * cos) / Math.cos(part.tilt);
  const radius = Math.hypot(u, v);
  const width = (part.outer - part.inner) / 2;
  const middle = (part.outer + part.inner) / 2;
  const edge = (Math.abs(radius - middle) - width) * Math.cos(part.tilt) * 2.4;
  if (edge > 0.2) {
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

const hitOf = (part: Part, x: number, y: number, seconds: number): Hit => {
  switch (part.kind) {
    case "sphere": {
      return sphereHit(part, x, y, seconds);
    }
    case "prism": {
      return prismHit(part, x, y);
    }
    case "crystal": {
      return crystalHit(part, x, y);
    }
    case "ring": {
      return ringHit(part, x, y);
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

/** Writes every cell's code for this frame into `out`, `n` cells across. */
export const paintBody = (
  body: Body,
  lean: Lean,
  n: number,
  out: Uint8Array
): void => {
  const { now } = body;
  const parts = partsOf(body);
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
  for (let row = 0; row < n; row += 1) {
    for (let column = 0; column < n; column += 1) {
      const x = ((column + 0.5) / n) * 2 - 1;
      const y = 1 - ((row + 0.5) / n) * 2;
      const threshold = thresholdAt(column, row);
      let front: Hit | undefined;
      let nearest = 9;
      for (const part of parts) {
        const hit = hitOf(part, x, y, body.seconds);
        nearest = Math.min(nearest, hit.edge);
        const covered = clamp(0.5 - hit.edge / cell) > threshold;
        if (covered && (front === undefined || hit.depth > front.depth)) {
          front = hit;
        }
      }
      const at = row * n + column;
      if (front === undefined) {
        // The glow round it: a few dim dots fading into the night, nothing beyond.
        const glow = now.glow * Math.exp(-Math.max(0, nearest) / 0.11);
        const level = Math.floor(glow * 2.6 + threshold - 0.55);
        out[at] = level >= 1 ? Math.min(level, 2) + 1 : 0;
        continue;
      }
      // Its outline catches the rim light too, so a solid lit from behind still has an edge.
      const outline = now.rim * clamp(1 + front.edge / (cell * 2));
      const level = clamp(
        Math.floor((lit(now, light, front) + outline) * 5 + threshold - 0.15),
        0,
        5
      );
      out[at] = level + 1;
    }
  }
};

/** A pose's still: the picture with reduced motion and the server's. */
export const paintStill = (
  state: FigureState,
  shape: FigureShape,
  n: number,
  out: Uint8Array
): void => {
  paintBody(bodyOf(state, shape), { x: 0, y: 0 }, n, out);
};
