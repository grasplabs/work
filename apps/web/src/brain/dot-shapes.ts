/**
 * The shapes of the onboarding brain. Each is a surface, written as a signed distance field, and
 * scanned from the front on a regular grid, the way a depth camera would: rows of dots that bend
 * with the surface, so the brain reads as dithered print that happens to be a person, a team or a
 * laptop. Every shape is printed on the same spacing, `PITCH`, so no figure is denser than
 * another, and has the same number of points, in scan order, so one can flow into the next top
 * to bottom: the ones a figure does not need wait on it unseen. Pure numbers, no DOM, computed
 * once per shape and kept.
 */

import type { Interviewer } from "@grasp-os/shared/onboarding";

import { CLAIRE_CELLS } from "./claire-portrait.ts";
import { PORTRAIT_CELLS, PORTRAIT_SIZE } from "./portrait-data.ts";

/**
 * The distance between neighbouring dots, in figure units (a figure spans -1 to 1): wide enough
 * that every dot stands apart, even the darkest, as in print with air in it. A dot's size carries
 * the shading, small where the light falls and larger in shadow, but never bigger than the gap.
 */
export const PITCH = 0.033;

/** Points every figure has, seen or waiting, so any one can flow into any other: more than the largest needs. */
export const POINTS = 4800;

const sphere = (x: number, y: number, z: number, r: number): number =>
  Math.hypot(x, y, z) - r;

/** An ellipsoid's distance, close enough to march by. */
const ellipsoid = (
  x: number,
  y: number,
  z: number,
  a: number,
  b: number,
  c: number
): number => {
  const k0 = Math.hypot(x / a, y / b, z / c);
  const k1 = Math.hypot(x / (a * a), y / (b * b), z / (c * c));
  return k1 === 0 ? -Math.min(a, b, c) : (k0 * (k0 - 1)) / k1;
};

const capsule = (
  x: number,
  y: number,
  z: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  r: number
): number => {
  const px = x - ax;
  const py = y - ay;
  const pz = z - az;
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const h = Math.min(
    Math.max((px * dx + py * dy + pz * dz) / (dx * dx + dy * dy + dz * dz), 0),
    1
  );
  return Math.hypot(px - dx * h, py - dy * h, pz - dz * h) - r;
};

/** A soft union: two surfaces blend where they meet, as skin does. */
const smin = (a: number, b: number, k: number): number => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - (h * h * k) / 4;
};

const smax = (a: number, b: number, k: number): number => -smin(-a, -b, k);

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const x = Math.min(Math.max((value - edge0) / (edge1 - edge0), 0), 1);
  return x * x * (3 - 2 * x);
};

/**
 * A person from the chest up, facing +z, about two units from chin to crown, drawn to the classic
 * proportions: eyes halfway down the head and one eye apart, the face in thirds from hairline to
 * brow to the base of the nose to the chin, ears between brow and nose, and the mouth a third of
 * the way from nose to chin. Short hair, a neck with its muscles, shoulders and a round collar.
 */
const head = (x: number, y: number, z: number): number => {
  const ax = Math.abs(x);
  // The skull, and the face below and in front of it: wide at the cheekbones, narrowing to the chin.
  let d = ellipsoid(x, y - 0.38, z + 0.14, 0.64, 0.8, 0.86);
  d = smin(d, ellipsoid(x, y + 0.02, z - 0.14, 0.58, 0.52, 0.56), 0.22);
  d = smin(d, ellipsoid(x, y + 0.4, z - 0.16, 0.44, 0.4, 0.5), 0.22);
  d = smin(d, ellipsoid(x, y + 0.68, z - 0.44, 0.19, 0.14, 0.2), 0.16);
  // Cheekbones and the corners of the jaw.
  d = smin(d, ellipsoid(ax - 0.34, y - 0.02, z - 0.46, 0.17, 0.1, 0.14), 0.12);
  d = smin(d, ellipsoid(ax - 0.4, y + 0.44, z - 0.02, 0.12, 0.2, 0.3), 0.18);
  // The brow, the sockets under it and the eyes in them, with a lid over each.
  d = smin(d, capsule(ax, y, z, 0.05, 0.32, 0.66, 0.36, 0.3, 0.58, 0.07), 0.1);
  d = smax(d, -ellipsoid(ax - 0.25, y - 0.19, z - 0.72, 0.15, 0.1, 0.12), 0.07);
  d = smin(d, sphere(ax - 0.25, y - 0.19, z - 0.55, 0.11), 0.02);
  d = smin(d, ellipsoid(ax - 0.25, y - 0.235, z - 0.6, 0.12, 0.04, 0.07), 0.03);
  // The nose: a bridge running down to a round tip, wings either side, nostrils under it.
  d = smin(d, capsule(x, y, z, 0, 0.2, 0.7, 0, -0.14, 0.9, 0.045), 0.08);
  d = smin(d, sphere(x, y + 0.17, z - 0.86, 0.075), 0.06);
  d = smin(d, sphere(ax - 0.085, y + 0.21, z - 0.75, 0.055), 0.05);
  d = smax(
    d,
    -ellipsoid(ax - 0.045, y + 0.26, z - 0.8, 0.025, 0.015, 0.03),
    0.01
  );
  // Lips, parted by a fine line, and the chin below them.
  d = smin(d, ellipsoid(x, y + 0.37, z - 0.76, 0.2, 0.045, 0.06), 0.05);
  d = smin(d, ellipsoid(x, y + 0.47, z - 0.73, 0.17, 0.05, 0.06), 0.05);
  d = smax(
    d,
    -capsule(x, y, z, -0.19, -0.42, 0.8, 0.19, -0.42, 0.8, 0.012),
    0.012
  );
  d = smin(d, ellipsoid(x, y + 0.66, z - 0.6, 0.17, 0.11, 0.12), 0.1);
  // Ears, each with a hollow.
  const ear = smax(
    ellipsoid(ax - 0.66, y - 0.05, z + 0.08, 0.07, 0.22, 0.13),
    -sphere(ax - 0.74, y - 0.06, z + 0.06, 0.1),
    0.02
  );
  d = smin(d, ear, 0.05);
  // Short hair over the top and the back, lower at the back than at the brow, with a fine grain.
  const hairline = 0.28 + 0.56 * smoothstep(-0.35, 0.62, z);
  let hair = smax(
    ellipsoid(x, y - 0.41, z + 0.15, 0.68, 0.84, 0.9),
    hairline - y,
    0.06
  );
  hair += 0.005 * Math.sin(x * 58 + y * 17) * Math.sin(z * 47 - y * 9);
  d = smin(d, hair, 0.02);
  // The neck and its two muscles, from behind the ears to the breastbone.
  d = smin(d, capsule(x, y, z, 0, -0.5, -0.12, 0, -1.35, -0.1, 0.29), 0.16);
  d = smin(
    d,
    capsule(ax, y, z, 0.42, -0.2, -0.12, 0.07, -1.28, 0.18, 0.065),
    0.1
  );
  // Shoulders sloping from the neck, the chest, and a round collar where the neck meets it.
  d = smin(
    d,
    capsule(ax, y, z, 0.18, -1.2, -0.18, 1.12, -1.62, -0.14, 0.25),
    0.28
  );
  d = smin(d, ellipsoid(x, y + 1.9, z + 0.12, 1.42, 0.55, 0.6), 0.3);
  const collar =
    Math.hypot(Math.hypot(x, (z + 0.06) * 1.15) - 0.38, y + 1.3) - 0.045;
  return smin(d, collar, 0.05);
};

/** Which figure the brain takes, and for the org, what is known of it. */
export type ShapeKey =
  | { kind: "head" }

  /** Whoever holds an interview, talking and listening: Stephen, unless it says Claire. */
  | { kind: "listen"; who?: Interviewer }
  | { kind: "pair" }
  | { kind: "crowd" }
  | { kind: "sheets" }
  | { kind: "laptop" }
  | { kind: "brain" }

  /**
   * The company brain and the places where documents live, a nerve to each: whole once it is
   * connected, in dashes before. `beyond` is how many more nerves the brain has, to what was
   * connected on other steps: they come in from beyond the picture, between the places.
   */
  | { kind: "hub"; linked: boolean[]; beyond?: number }

  /** The company brain with `count` places around it, each with its nerve, each its own group, so each can fill with ink on its own. */
  | { kind: "spokes"; count: number }
  | {
      kind: "org";
      /** Team sizes, largest first; a team not known yet is 0, a small node on a nerve still in dashes. */
      teams: number[];
      /** Leads known: their dots glow. */
      leads: boolean;
      /** How many more nerves the brain has, to what was connected on other steps: they come in from beyond the picture, between the teams. */
      beyond?: number;
    };

/** How a shape's hotspots move: a voice, two voices taking turns, a sweep, a steady glow. */
export type Activity = "none" | "speak" | "alternate" | "sweep" | "steady";

export interface DotShape {
  /** x, y, z per point, fitted into -1..1. */
  position: Float32Array;
  /** How lit each point is: 0 at an edge turned away from the light, 1 facing it. */
  tone: Float32Array;
  /** How large its dot is printed, 0 to 1: large in shadow, small in light, small again at a turning edge. */
  ink: Float32Array;
  /** 1 for a point of the figure, 0 for one it does not need, which waits on it unseen. */
  presence: Float32Array;
  /** Where each voice comes from, x and y per channel: its first hotspot, the mouth; the middle if it has none. */
  voice: Float32Array;
  /** How strongly a point takes part in the shape's hotspots, 0 to 1. */
  hot: Float32Array;
  /** Which voice a point belongs to, for two heads taking turns. */
  channel: Uint8Array;
  /** The team a point belongs to in the org; CORE for the brain in the middle of its nerves, NONE elsewhere. */
  group: Uint8Array;
  /** Which nerve a point is part of, the place at its end included; NONE elsewhere. */
  nerve: Uint8Array;
  /** How far along its nerve a point is: from the place, 0, to the middle of the brain, 1. */
  along: Float32Array;
  /** The nerves of the figure, if it has any. */
  nerves: Nerve[];
  activity: Activity;
}

/**
 * A nerve between the brain and a place: where it meets the brain's edge, in the figure, how far
 * along the nerve that is, and the group whose ink says whether it is connected.
 */
export interface Nerve {
  x: number;
  y: number;
  along: number;
  group: number;
}

export const NONE = 255;

/** The company brain in the middle of its nerves: as inked as the brain is full. */
export const CORE = 254;

/** A nerve from the brain to a place that is known: a made connection. */
export const LINK = 252;

/** A connection still to make, and where it goes: always grey. */
export const OPEN = 251;

export const shapeId = (key: ShapeKey): string => {
  if (key.kind === "org") {
    return `org:${key.teams.join(",")}:${key.leads ? 1 : 0}:${key.beyond ?? 0}`;
  }
  if (key.kind === "hub") {
    return `hub:${key.linked.map(Number).join("")}:${key.beyond ?? 0}`;
  }
  if (key.kind === "spokes") {
    return `spokes:${key.count}`;
  }
  if (key.kind === "listen" && key.who && key.who !== "stephen") {
    return `listen:${key.who}`;
  }
  return key.kind;
};

const cache = new Map<string, DotShape>();

const roundBox = (
  x: number,
  y: number,
  z: number,
  hx: number,
  hy: number,
  hz: number,
  r: number
): number => {
  const qx = Math.abs(x) - hx + r;
  const qy = Math.abs(y) - hy + r;
  const qz = Math.abs(z) - hz + r;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
  return outside + Math.min(Math.max(qx, qy, qz), 0) - r;
};

/** A head placed in the world: moved, turned about y, and scaled. Far away it only costs a sphere. */
const placedHead = (
  cx: number,
  cy: number,
  cz: number,
  turn: number,
  scale: number
): Field => {
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  return (x, y, z) => {
    const px = (x - cx) / scale;
    const py = (y - cy) / scale;
    const pz = (z - cz) / scale;
    const bound = sphere(px, py + 0.35, pz, 1.9);
    if (bound > 0.25) {
      return bound * scale;
    }
    return head(cos * px - sin * pz, py, sin * px + cos * pz) * scale;
  };
};

/** Where a head's mouth and ear are once placed, for its hotspots. */
const headSpot = (
  cx: number,
  cy: number,
  cz: number,
  turn: number,
  scale: number,
  lx: number,
  ly: number,
  lz: number
): [number, number, number] => {
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  // The inverse of the turn in placedHead.
  return [
    cx + (cos * lx + sin * lz) * scale,
    cy + ly * scale,
    cz + (-sin * lx + cos * lz) * scale,
  ];
};

const MOUTH: [number, number, number] = [0, -0.42, 0.78];

/** How the brain is seen, as a figure of its own and in the middle of its nerves: a little from the side, leaning toward you so its top shows. */
const BRAIN_VIEW = { turn: -0.55, tilt: 0.38 };

/** How far a ray may trust the brain's surface per step: its folds make its distances run short. */
const BRAIN_TRUST = 0.55;

/** The brain's folds at a point on it: 0 in the bottom of a groove, up to 1 either way on the ridges between them. */
const brainFolds = (x: number, y: number, z: number): number =>
  Math.sin(x * 11 + Math.sin(z * 5) * 1.6) *
  Math.sin(z * 10 + Math.sin(y * 6) * 1.4) *
  Math.sin(y * 12 + x * 3);

/**
 * The brain, as a surface: two halves with the fissure between them and folds winding over them,
 * the cerebellum under the back and the stem below. Its front is towards +z.
 */
const brainField = (x: number, y: number, z: number): number => {
  let d = smin(
    ellipsoid(x + 0.34, y - 0.05, z, 0.6, 0.6, 0.88),
    ellipsoid(x - 0.34, y - 0.05, z, 0.6, 0.6, 0.88),
    0.1
  );
  // The fissure between the halves.
  d = smax(d, -roundBox(x, y - 0.55, z, 0.03, 0.5, 1.1, 0.02), 0.06);
  // The folds: ridges and grooves winding over the whole surface.
  d += 0.05 * Math.abs(brainFolds(x, y, z)) - 0.02;
  d = smin(d, ellipsoid(x, y + 0.48, z + 0.6, 0.42, 0.22, 0.26), 0.12);
  return smin(d, capsule(x, y, z, 0, -0.4, -0.22, 0, -0.95, -0.3, 0.13), 0.12);
};

/** In the same frame as Stephen: the figure shows the middle of the photo's square, head to chest. */
const CROP = { x: 0.5, y: 0.47, half: 0.45 };

/** Every person drawn from a photo, by name: the interviewers. */
const PORTRAITS = {
  stephen: {
    cells: PORTRAIT_CELLS,
    size: PORTRAIT_SIZE,
    crop: CROP,
    mouth: [-0.03, -0.13, 0.36],
    ear: [0.42, 0.09, 0.12],
  },
  // Claire has no photo of her own yet: until she has, she is drawn from a stand-in portrait (`claire-portrait.ts`), printed a little darker so her face reads as large as an interviewer is shown.
  claire: {
    cells: CLAIRE_CELLS,
    size: 180,
    crop: CROP,
    mouth: [-0.02, -0.08, 0.36],
    ear: [0.31, -0.06, 0.12],
    gamma: 1.9,
  },
} satisfies Record<string, Portrait>;

/** Which portrait each interviewer is drawn from. */
const INTERVIEWER_PORTRAITS: Record<Interviewer, keyof typeof PORTRAITS> = {
  stephen: "stephen",
  claire: "claire",
};

/** Where Stephen listens: his ear on the head, and how far its warmth reaches, in the figure's units. */
export const HEAD_EAR = { at: PORTRAITS.stephen.ear, radius: 0.13 };

const decoded = new Map<Portrait, Uint8Array>();

const portraitCells = (portrait: Portrait): Uint8Array => {
  let grid = decoded.get(portrait);
  if (!grid) {
    grid = Uint8Array.from(
      atob(portrait.cells),
      (char) => char.codePointAt(0) ?? 0
    );
    decoded.set(portrait, grid);
  }
  return grid;
};

/** How far a point of the portrait stands out towards you: the head rounded, the chest a little. */
const portraitDepth = (x: number, y: number): number => {
  const skull = 1 - (x / 0.5) ** 2 - ((y - 0.2) / 0.74) ** 2;
  const chest = 1 - (x / 1.15) ** 2;
  return Math.max(
    0.4 * Math.sqrt(Math.max(skull, 0)),
    y < -0.3 ? 0.12 * Math.sqrt(Math.max(chest, 0)) : 0
  );
};

const portraitHits = (portrait: Portrait, pitch = PITCH): Hit[] => {
  const grid = portraitCells(portrait);
  const n = portrait.size;
  const { crop } = portrait;
  // Grid cells to figure units and back, through the crop.
  const toX = (gx: number) => (gx / n - crop.x) / crop.half;
  const toY = (gy: number) => (crop.y - gy / n) / crop.half;
  let subject = 0;
  for (let gy = 0; gy < n; gy += 1) {
    for (let gx = 0; gx < n; gx += 1) {
      if (
        (grid[gy * n + gx] ?? 0) > 0 &&
        Math.abs(toX(gx + 0.5)) <= 1 &&
        Math.abs(toY(gy + 0.5)) <= 1
      ) {
        subject += 1;
      }
    }
  }
  // Rows one pitch apart, every other row half a step over.
  const step = pitch * n * crop.half;
  const cell = (gx: number, gy: number): number =>
    grid[
      Math.min(n - 1, Math.max(0, Math.floor(gy))) * n +
        Math.min(n - 1, Math.max(0, Math.floor(gx)))
    ] ?? 0;
  // Background reads as the light grey it was, so edges do not darken.
  const bright = (gx: number, gy: number) => {
    const value = cell(gx, gy);
    return value > 0 ? (value - 1) / 254 : 0.86;
  };
  const sample = (gx: number, gy: number) => {
    const x0 = Math.floor(gx - 0.5);
    const y0 = Math.floor(gy - 0.5);
    const fx = gx - 0.5 - x0;
    const fy = gy - 0.5 - y0;
    const top = bright(x0, y0) * (1 - fx) + bright(x0 + 1, y0) * fx;
    const bottom = bright(x0, y0 + 1) * (1 - fx) + bright(x0 + 1, y0 + 1) * fx;
    return top * (1 - fy) + bottom * fy;
  };
  const hits: Hit[] = [];
  let row = 0;
  for (let gy = step / 2; gy < n; gy += step, row += 1) {
    for (let gx = step / 2 + (row % 2 ? step / 2 : 0); gx < n; gx += step) {
      const x = toX(gx);
      const y = toY(gy);
      if (cell(gx, gy) === 0 || Math.abs(x) > 1 || Math.abs(y) > 1) {
        continue;
      }
      const lum = sample(gx, gy) ** (portrait.gamma ?? 1);
      // A little more contrast in the light, so a face's features read as well as its hair.
      const dark = Math.min(1, Math.max(0, (0.86 - lum) / 0.66));
      hits.push({
        x,
        y,
        z: portraitDepth(x, y),
        tone: 0.3 + 0.7 * lum,
        ink: 0.06 + 0.94 * dark ** 0.95,
      });
    }
  }
  return hits;
};

/**
 * The person, from the portrait photo: dots in printed rows over the figure, each as large as the
 * photo is dark there, so hair, brows, eyes and the shirt come out bold and lit skin fine. Talking,
 * the mouth warms; listening, the ear too. The shirt fades out towards the bottom and the sides.
 */
const portraitPlan = (
  listening: boolean,
  portrait: Portrait = PORTRAITS.stephen
): Plan => ({
  hits: (pitch) => portraitHits(portrait, pitch),
  box: [-1, 1, -1, 1, -1, 1],
  spots: listening
    ? [
        { at: portrait.mouth, radius: 0.12, channel: 0 },
        { at: portrait.ear, radius: HEAD_EAR.radius, channel: 0 },
      ]
    : [{ at: portrait.mouth, radius: 0.11, channel: 0 }],
  fade: (x, y) =>
    smoothstep(-1, -0.5, y) * (1 - smoothstep(0.7, 1, Math.abs(x))),
  activity: "speak",
  turn: 0,
});

/**
 * The company brain in the middle of its nerves: how large it is against the brain as a figure of
 * its own, and how far up it stands, so that its body rather than its stem is in the middle.
 */
const CORE_BRAIN = {
  scale: 0.58,
  lift: 0.1,
  groove: 0.22,
  fissure: 0.07,
  ridge: 0.8,
  bold: 1.7,
};

/** How far from the middle the places stand that the brain connects to: further to the sides than above and below, as the brain is wider than it is high. */
const PLACES_AT = { across: 0.92, high: 0.88 };

/**
 * A nerve that goes on beyond the picture, to something connected on an earlier step: how far out
 * it starts, well outside the picture, so only its way in shows; how thin it is against a nerve
 * to a place; and between which distances from the middle it thins out to nothing.
 */
const BEYOND = { at: 1.45, thin: 0.8, whole: 0.6, gone: 1 };

/**
 * A nerve: how thick it is where it leaves a place and where it reaches the brain, how far each
 * bends off the straight line, as a share of its length and by turns to either side so no two
 * neighbours run alike, how many straight pieces its bend is made of, and how many of the
 * figure's points are kept for a nerve and its place.
 */
const NERVE = {
  tip: 0.027,
  root: 0.05,
  bows: [
    0.13, -0.17, 0.1, -0.12, 0.18, -0.09, 0.15, -0.14, 0.11, -0.16, 0.12, -0.1,
  ],
  pieces: 10,
  room: 96,
};

/** The room a brain with its nerves is scanned in, and how many rays across: the spacing every figure is printed on. */
const NETWORK_BOX: Plan["box"] = [-1.05, 1.05, -1.05, 1.05, -0.6, 0.6];

const NETWORK_COLUMNS = Math.round(2 / PITCH);

/** The brain in the middle of its nerves as it is seen, ray by ray: scanned the first time and kept, as it is the same in every such figure. */
let coreRays: (Hit | null)[] | null = null;

const BRAIN_COS = Math.cos(BRAIN_VIEW.turn);

const BRAIN_SIN = Math.sin(BRAIN_VIEW.turn);

const BRAIN_LEAN_COS = Math.cos(BRAIN_VIEW.tilt);

const BRAIN_LEAN_SIN = Math.sin(BRAIN_VIEW.tilt);

/** Where a point of the figure is on the brain in its middle: the brain is small there, and seen as the brain itself is, so the lean is undone, then the turn, as a view does. */
const onCoreBrain = (
  x: number,
  y: number,
  z: number
): [number, number, number] => {
  const px = x / CORE_BRAIN.scale;
  const py = (y - CORE_BRAIN.lift) / CORE_BRAIN.scale;
  const pz = z / CORE_BRAIN.scale;
  const ly = BRAIN_LEAN_COS * py + BRAIN_LEAN_SIN * pz;
  const lz = -BRAIN_LEAN_SIN * py + BRAIN_LEAN_COS * pz;
  return [BRAIN_COS * px - BRAIN_SIN * lz, ly, BRAIN_SIN * px + BRAIN_COS * lz];
};

/** The brain as it stands in the middle of its nerves, as a surface. */
const coreBrain = (x: number, y: number, z: number): number => {
  const [bx, by, bz] = onCoreBrain(x, y, z);
  return brainField(bx, by, bz) * CORE_BRAIN.scale;
};

/** From a place to the middle of the brain, bending off the straight line by `bow` of its length. */
const nervePath = (fromX: number, fromY: number, bow: number): NervePath => {
  const toX = 0;
  const toY = CORE_BRAIN.lift;
  const length = Math.hypot(toX - fromX, toY - fromY);
  const cx = (fromX + toX) / 2 - (toY - fromY) * bow;
  const cy = (fromY + toY) / 2 + (toX - fromX) * bow;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let piece = 0; piece <= NERVE.pieces; piece += 1) {
    const t = piece / NERVE.pieces;
    xs.push((1 - t) ** 2 * fromX + 2 * (1 - t) * t * cx + t * t * toX);
    ys.push((1 - t) ** 2 * fromY + 2 * (1 - t) * t * cy + t * t * toY);
  }
  return { xs, ys, length };
};

/** How far along a nerve the point of it nearest to a point is, from its place, 0, to the middle of the brain, 1. */
const nerveAlong = (path: NervePath, x: number, y: number): number => {
  let best = Infinity;
  let along = 0;
  for (let piece = 0; piece < NERVE.pieces; piece += 1) {
    const ax = path.xs[piece] ?? 0;
    const ay = path.ys[piece] ?? 0;
    const sx = (path.xs[piece + 1] ?? 0) - ax;
    const sy = (path.ys[piece + 1] ?? 0) - ay;
    const h = Math.min(
      Math.max(((x - ax) * sx + (y - ay) * sy) / (sx * sx + sy * sy), 0),
      1
    );
    const d = (x - ax - sx * h) ** 2 + (y - ay - sy * h) ** 2;
    if (d < best) {
      best = d;
      along = (piece + h) / NERVE.pieces;
    }
  }
  return along;
};

const DASH = 0.11;

/** A nerve as a surface: a fibre along its way, thin at its place and thicker towards the brain, `thick` times as thick as a nerve is; one still to connect only in dashes. */
const nerveDistance = (
  path: NervePath,
  known: boolean,
  thick: number,
  x: number,
  y: number,
  z: number
): number => {
  const along = nerveAlong(path, x, y);
  if (!known && (along * path.length) % DASH > DASH * 0.45) {
    return Infinity;
  }
  const at = along * NERVE.pieces;
  const piece = Math.min(Math.floor(at), NERVE.pieces - 1);
  const h = at - piece;
  const px =
    (path.xs[piece] ?? 0) +
    ((path.xs[piece + 1] ?? 0) - (path.xs[piece] ?? 0)) * h;
  const py =
    (path.ys[piece] ?? 0) +
    ((path.ys[piece + 1] ?? 0) - (path.ys[piece] ?? 0)) * h;
  return (
    Math.hypot(x - px, y - py, z) -
    (NERVE.tip + (NERVE.root - NERVE.tip) * along ** 1.5) * thick
  );
};

const normalize = (
  x: number,
  y: number,
  z: number
): [number, number, number] => {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
};

// ---- Scanning --------------------------------------------------------------------------------

const LIGHT = normalize(-0.45, 0.6, 0.66);

/** The same, ray by ray in scan order: where each meets the surface, or null where it meets nothing. So two surfaces scanned on the same grid can be laid over each other. */
const rays = (
  field: Field,
  box: Plan["box"],
  columns: number,
  trust = 0.8
): (Hit | null)[] => {
  const [x0, x1, y0, y1, z0, z1] = box;
  const step = (x1 - x0) / columns;
  const rows = Math.round((y1 - y0) / step);
  const hits: (Hit | null)[] = [];
  const e = 0.0015;
  for (let row = 0; row < rows; row += 1) {
    const y = y1 - (row + 0.5) * step;
    // Every other row sits half a step over, so the dots pack like print.
    const offset = row % 2 === 0 ? 0 : step / 2;
    for (let column = 0; column < columns; column += 1) {
      const x = x0 + (column + 0.5) * step + offset;
      let z = z1;
      let met: Hit | null = null;
      for (let march = 0; march < 72 && z > z0; march += 1) {
        const d = field(x, y, z);
        if (d < e) {
          const nx = field(x + e, y, z) - field(x - e, y, z);
          const ny = field(x, y + e, z) - field(x, y - e, z);
          const nz = field(x, y, z + e) - field(x, y, z - e);
          const [ux, uy, uz] = normalize(nx, ny, nz);
          const lit = Math.max(
            ux * LIGHT[0] + uy * LIGHT[1] + uz * LIGHT[2],
            0
          );
          // Turned away from the viewer, a surface thins out, as the edge of a sphere does.
          const facing = Math.sqrt(Math.max(uz, 0));
          // Halftone: fine dots where the light falls, bold ones in shadow.
          const shadow = (1 - lit) ** 1.4;
          met = {
            x,
            y,
            z,
            tone: (0.25 + 0.75 * lit) * (0.3 + 0.7 * facing),
            ink: (0.08 + 0.92 * shadow) * (0.5 + 0.5 * facing),
          };
          break;
        }
        z -= Math.max(d * trust, e);
      }
      hits.push(met);
    }
  }
  return hits;
};

/**
 * The company brain with the places it connects to in a circle around it, and a nerve to each:
 * whole and grown into the brain to a place that is known, in dashes to one still to come. Every
 * nerve bends its own way. `groupFor` says which group a place and its nerve belong to, for
 * their ink; the brain itself is `CORE`.
 */
const networkPlan = (
  places: Node[],
  groupFor: (index: number, part: "node" | "line") => number,
  beyond = 0
): Plan & { at: { x: number; y: number }[] } => {
  const turn = (2 * Math.PI) / places.length;
  const at = places.map((_, index) => {
    const angle = -Math.PI / 2 + index * turn;
    return {
      x: Math.cos(angle) * PLACES_AT.across,
      y: -Math.sin(angle) * PLACES_AT.high,
    };
  });
  // A nerve that goes on beyond the picture comes in halfway between two places: every other gap in turn, and each in a gap of its own whatever their number, so one more leaves the others where they are.
  for (let fibre = 0; fibre < beyond; fibre += 1) {
    const gap =
      (fibre * 2 +
        (places.length % 2 === 0
          ? Math.floor((fibre * 2) / places.length)
          : 0)) %
      places.length;
    const angle = -Math.PI / 2 + (gap + 0.5) * turn;
    at.push({
      x: Math.cos(angle) * BEYOND.at,
      y: -Math.sin(angle) * BEYOND.at,
    });
  }
  // A nerve from beyond the picture has no place at its end here: it is a made connection, and that is all that shows of it.
  const nodes = [
    ...places,
    ...Array.from({ length: beyond }, () => ({ r: 0, known: true })),
  ];
  const groupAt = (index: number, part: "node" | "line") =>
    index < places.length ? groupFor(index, part) : LINK;
  // Each nerve starts at the side of its place that faces the brain.
  const strands = at.map(({ x, y }, index) => {
    const node = nodes[index] ?? { r: 0, known: true };
    const far = Math.hypot(x, y - CORE_BRAIN.lift);
    const near = node.r * 0.6;
    const path = nervePath(
      x - (x / far) * near,
      y - ((y - CORE_BRAIN.lift) / far) * near,
      (NERVE.bows[(index * 5) % NERVE.bows.length] ?? 0) *
        (index < places.length ? 1 : 0.7)
    );
    return { x, y, ...node, path, place: index < places.length };
  });
  const paths = strands.map(({ path }) => path);
  // Where each nerve meets the brain's edge: a signal that runs along it comes in there.
  const ends = paths.map((path) => {
    for (let step = 0; step <= 100; step += 1) {
      const t = step / 100;
      const piece = Math.min(Math.floor(t * NERVE.pieces), NERVE.pieces - 1);
      const h = t * NERVE.pieces - piece;
      const x =
        (path.xs[piece] ?? 0) +
        ((path.xs[piece + 1] ?? 0) - (path.xs[piece] ?? 0)) * h;
      const y =
        (path.ys[piece] ?? 0) +
        ((path.ys[piece + 1] ?? 0) - (path.ys[piece] ?? 0)) * h;
      if (coreBrain(x, y, 0) < 0) {
        return { x, y, along: t };
      }
    }
    return { x: 0, y: CORE_BRAIN.lift, along: 1 };
  });
  const nodeDistance = (
    x: number,
    y: number,
    z: number,
    strand: (typeof strands)[number]
  ) =>
    strand.place ? sphere(x - strand.x, y - strand.y, z, strand.r) : Infinity;
  const lineDistance = (
    x: number,
    y: number,
    z: number,
    strand: (typeof strands)[number]
  ) =>
    nerveDistance(
      strand.path,
      strand.known,
      strand.place ? 1 : BEYOND.thin,
      x,
      y,
      z
    );
  /** Which part of the figure a point is nearest to: the brain, a place or its nerve. */
  const nearest = (
    x: number,
    y: number,
    z: number
  ): { index: number; part: "core" | "node" | "line" } => {
    let best = coreBrain(x, y, z);
    let found: { index: number; part: "core" | "node" | "line" } = {
      index: -1,
      part: "core",
    };
    for (const [index, strand] of strands.entries()) {
      const d = nodeDistance(x, y, z, strand);
      if (d < best) {
        best = d;
        found = { index, part: "node" };
      }
      const line = lineDistance(x, y, z, strand);
      if (line < best) {
        best = line;
        found = { index, part: "line" };
      }
    }
    return found;
  };
  const groupOf = (x: number, y: number, z: number) => {
    const { index, part } = nearest(x, y, z);
    return part === "core" ? CORE : groupAt(index, part);
  };
  /** The nerves and their places, without the brain. */
  const around = (x: number, y: number, z: number) => {
    let d = Infinity;
    for (const strand of strands) {
      d = Math.min(
        d,
        nodeDistance(x, y, z, strand),
        lineDistance(x, y, z, strand)
      );
    }
    return d;
  };
  return {
    at: at.slice(0, places.length),
    field: (x, y, z) => Math.min(coreBrain(x, y, z), around(x, y, z)),
    // The brain is scanned once, for every figure it stands in the middle of; the nerves and their places are laid around it, and end where the brain begins.
    parts: () => {
      coreRays ??= rays(coreBrain, NETWORK_BOX, NETWORK_COLUMNS, BRAIN_TRUST);
      const rest = rays(around, NETWORK_BOX, NETWORK_COLUMNS);
      const brain: Hit[] = [];
      const own: Hit[][] = nodes.map(() => []);
      for (const [ray, hit] of coreRays.entries()) {
        if (hit) {
          brain.push(hit);
        } else if (rest[ray]) {
          own[nearest(rest[ray].x, rest[ray].y, rest[ray].z).index]?.push(
            rest[ray]
          );
        }
      }
      return [
        { hits: brain, room: brain.length },
        ...own.map((hits) => ({ hits, room: NERVE.room })),
      ];
    },
    box: NETWORK_BOX,
    groupOf,
    nerveOf: (x, y, z) => {
      const { index, part } = nearest(x, y, z);
      if (part === "core") {
        return null;
      }
      return {
        nerve: index,
        along:
          part === "node" || paths[index] === undefined
            ? 0
            : nerveAlong(paths[index], x, y),
      };
    },
    nerves: ends.map((end, index) => ({
      x: end.x,
      y: end.y,
      along: end.along,
      group: groupAt(index, "line"),
    })),
    // A nerve from beyond the picture thins out towards the edge, as something that goes on.
    fade:
      beyond === 0
        ? undefined
        : (x, y, z) => {
            const { index, part } = nearest(x, y, z);
            return part === "line" && index >= places.length
              ? smoothstep(BEYOND.gone, BEYOND.whole, Math.hypot(x, y))
              : 1;
          },
    print: (x, y, z) => {
      const group = groupOf(x, y, z);
      // Small as it is here, the brain is printed by its folds: bold in the grooves and along the fissure, light on the ridges, so it reads as a brain at a glance.
      if (group === CORE) {
        const [bx, by, bz] = onCoreBrain(x, y, z);
        const groove =
          1 - Math.min(Math.abs(brainFolds(bx, by, bz)) / CORE_BRAIN.groove, 1);
        const fissure =
          by > 0 ? 1 - Math.min(Math.abs(bx) / CORE_BRAIN.fissure, 1) : 0;
        return (
          CORE_BRAIN.ridge +
          (CORE_BRAIN.bold - CORE_BRAIN.ridge) * Math.max(groove, fissure)
        );
      }
      // What is still to connect is printed bolder, so it reads as a place to go rather than dust.
      const open = group === OPEN || places[group]?.known === false;
      return open ? 1.7 : 1;
    },
    activity: "none",
    turn: 0,
    step: BRAIN_TRUST,
  };
};

/** A place not known yet, as a small node; and the dashes of a nerve still to connect. */
const GHOST = 0.06;

/** The teams around the brain, each as large as it is: a team not known yet is a small open place. */
const orgPlan = (teams: number[], leads: boolean, beyond = 0): Plan => {
  const largest = Math.max(...teams, 1);
  const nodes = teams.map((people) => ({
    known: people > 0,
    r: people === 0 ? GHOST : 0.055 + 0.085 * Math.sqrt(people / largest),
  }));
  // A made connection is inked; one still to make is grey, with its team.
  const network = networkPlan(
    nodes,
    (index, part) =>
      part === "line" && nodes[index]?.known === true ? LINK : index,
    beyond
  );
  return {
    ...network,
    // A known lead is the top of their team's cluster.
    spots: leads
      ? network.at.flatMap(({ x, y }, index): Spot[] => {
          const node = nodes[index];
          return node?.known === true
            ? [
                {
                  at: [x, y + node.r * 0.62, node.r * 0.6],
                  radius: Math.max(node.r * 0.55, 0.06),
                  channel: 0,
                },
              ]
            : [];
        })
      : [],
    activity: leads ? "steady" : "none",
  };
};

/**
 * Every place drawn whole, with its line, one group per place: the figure stays as it is while
 * the places fill with ink one by one, by their group's level, rather than changing shape.
 */
const spokesPlan = (count: number): Plan => {
  const nodes = Array.from({ length: count }, () => ({ known: true, r: 0.12 }));
  return networkPlan(nodes, (index) => index);
};

/** The places where documents live: a connected one is inked, line and all; the rest wait, grey and dashed. */
const hubPlan = (linked: boolean[], beyond = 0): Plan => {
  const nodes = linked.map((known) => ({ known, r: known ? 0.11 : GHOST }));
  return networkPlan(
    nodes,
    (index) => (linked[index] === true ? LINK : OPEN),
    beyond
  );
};

/** The tab on the back of the folder, left of middle, as half sizes. */
const FOLDER_TAB = { x: -0.46, w: 0.2, h: 0.08 };

/** How far a point is outside a rectangle centred on the origin, flat; negative inside. */
const rect = (x: number, y: number, hx: number, hy: number): number => {
  const qx = Math.abs(x) - hx;
  const qy = Math.abs(y) - hy;
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0)
  );
};

const plan = (key: ShapeKey): Plan => {
  switch (key.kind) {
    case "head": {
      return portraitPlan(false);
    }
    case "listen": {
      return portraitPlan(
        true,
        PORTRAITS[INTERVIEWER_PORTRAITS[key.who ?? "stephen"]]
      );
    }
    case "pair": {
      const left = placedHead(-0.98, 0, 0, 0.62, 0.92);
      const right = placedHead(0.98, 0, 0, -0.62, 0.92);
      return {
        field: (x, y, z) => Math.min(left(x, y, z), right(x, y, z)),
        box: [-2.5, 2.5, -1.95, 1.2, -1.3, 1.4],
        spots: [
          {
            at: headSpot(-0.98, 0, 0, 0.62, 0.92, ...MOUTH),
            radius: 0.24,
            channel: 0,
          },
          {
            at: headSpot(0.98, 0, 0, -0.62, 0.92, ...MOUTH),
            radius: 0.24,
            channel: 1,
          },
        ],
        fade: (_x, y) => smoothstep(-1.95, -1.35, y),
        activity: "alternate",
        turn: 0,
      };
    }
    case "crowd": {
      const people: [number, number, number, number, number][] = [
        [-1.9, -0.28, -0.6, 0.35, 0.62],
        [-0.98, -0.1, -0.2, 0.18, 0.74],
        [0, 0, 0.1, 0, 0.8],
        [1, -0.14, -0.25, -0.2, 0.72],
        [1.92, -0.3, -0.6, -0.36, 0.6],
      ];
      const heads = people.map(([x, y, z, turn, scale]) =>
        placedHead(x, y, z, turn, scale)
      );
      return {
        field: (x, y, z) => {
          let d = Infinity;
          for (const each of heads) {
            d = Math.min(d, each(x, y, z));
          }
          return d;
        },
        box: [-3.1, 3.1, -1.75, 0.95, -1.5, 1.4],
        fade: (_x, y) => smoothstep(-1.75, -1.2, y),
        activity: "none",
        turn: 0,
      };
    }
    case "sheets": {
      // One folder, as its icon: the back with its tab, two papers sticking out, and the front flap over them.
      const back: FolderPart = {
        kind: "back",
        x: 0,
        y: 0,
        z: -0.16,
        w: 0.74,
        h: 0.5,
      };
      const parts: FolderPart[] = [
        back,
        { kind: "paper", x: 0.1, y: 0.2, z: -0.08, w: 0.56, h: 0.46 },
        { kind: "paper", x: 0.18, y: 0.12, z: -0.02, w: 0.52, h: 0.46 },
        { kind: "front", x: 0, y: -0.17, z: 0.06, w: 0.76, h: 0.34 },
      ];
      const outline = (part: FolderPart, x: number, y: number) => {
        const px = x - part.x;
        const py = y - part.y;
        const body = rect(px, py, part.w, part.h);
        return part.kind === "back"
          ? Math.min(
              body,
              rect(
                px - FOLDER_TAB.x,
                py - part.h - FOLDER_TAB.h,
                FOLDER_TAB.w,
                FOLDER_TAB.h + 0.02
              )
            )
          : body;
      };
      const partDistance = (
        part: FolderPart,
        x: number,
        y: number,
        z: number
      ) => Math.max(outline(part, x, y), Math.abs(z - part.z) - 0.012) - 0.02;
      return {
        field: (x, y, z) => {
          let d = Infinity;
          for (const part of parts) {
            d = Math.min(d, partDistance(part, x, y, z));
          }
          return d;
        },
        box: [-1, 1, -1, 1, -0.7, 0.7],
        // Drawn by its edges, bold, so it reads as a folder: inside it is bare, but for lines of text on the papers.
        print: (x, y, z) => {
          let part = back;
          let best = Infinity;
          for (const each of parts) {
            const d = partDistance(each, x, y, z);
            if (d < best) {
              best = d;
              part = each;
            }
          }
          if (outline(part, x, y) > -0.07) {
            return 2.4;
          }
          if (part.kind !== "paper") {
            return 0;
          }
          const px = x - part.x;
          return Math.abs(px) < part.w - 0.16 &&
            Math.sin((y - part.y) * 30) > 0.55
            ? 1
            : 0;
        },
        activity: "none",
        turn: 0.2,
      };
    }
    case "laptop": {
      const hinge = -0.46;
      // Negative leans the top of the screen back, away from you.
      const tilt = -0.28;
      const cos = Math.cos(tilt);
      const sin = Math.sin(tilt);
      return {
        field: (x, y, z) => {
          const base = roundBox(x, y + 0.62, z - 0.18, 1.02, 0.035, 0.66, 0.03);
          // The screen, hinged at the back of the base and leaning back a little.
          const py = y + 0.6;
          const pz = z - hinge;
          const screen = roundBox(
            x,
            cos * py + sin * pz - 0.66,
            -sin * py + cos * pz,
            1,
            0.66,
            0.025,
            0.035
          );
          return Math.min(base, screen);
        },
        box: [-1.35, 1.35, -1.1, 1.1, -1.3, 1.3],
        spots: [{ at: [0, 0.03, -0.64], radius: 0.95, channel: 0 }],
        activity: "sweep",
        turn: -0.32,
        tilt: 0.42,
      };
    }
    case "brain": {
      return {
        field: brainField,
        box: [-1.2, 1.2, -1.15, 1, -1.2, 1.2],
        spots: [{ at: [0, 0.1, 0.1], radius: 0.75, channel: 0 }],
        activity: "steady",
        ...BRAIN_VIEW,
        step: BRAIN_TRUST,
      };
    }
    case "org": {
      return orgPlan(key.teams, key.leads, key.beyond);
    }
    case "hub": {
      return hubPlan(key.linked, key.beyond);
    }
    case "spokes": {
      return spokesPlan(key.count);
    }
    default: {
      return key satisfies never;
    }
  }
};

/** Marches one ray per grid point from the front, and keeps where each ray meets the surface. */
const scan = (
  field: Field,
  box: Plan["box"],
  columns: number,
  trust = 0.8
): Hit[] => rays(field, box, columns, trust).filter((hit) => hit !== null);

/** A point turned the other way, so hotspots written for an unturned figure land where it is. */
const turnPoint = (
  turn: number,
  [x, y, z]: [number, number, number]
): [number, number, number] => {
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  return [cos * x + sin * z, y, -sin * x + cos * z];
};

/** A figure as it is seen, turned and leaning: its surface from there, and the way between where a point is seen and where it is on the figure. */
const viewOf = (
  p: Plan
): {
  field: Field | null;
  local: (x: number, y: number, z: number) => [number, number, number];
  seen: (point: [number, number, number]) => [number, number, number];
} => {
  const cos = Math.cos(p.turn);
  const sin = Math.sin(p.turn);
  const tilt = p.tilt ?? 0;
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  // From where a point is seen to where it is on the figure: undo the lean, then the turn.
  const local = (x: number, y: number, z: number): [number, number, number] => {
    const ly = ct * y + st * z;
    const lz = -st * y + ct * z;
    return [cos * x - sin * lz, ly, sin * x + cos * lz];
  };
  const surface = p.field;
  let field: Field | null = null;
  if (surface) {
    field =
      p.turn === 0 && tilt === 0
        ? surface
        : (x, y, z) => surface(...local(x, y, z));
  }
  // And back: where a hotspot written on the figure is seen.
  const seen = ([x, y, z]: [number, number, number]): [
    number,
    number,
    number,
  ] => {
    const [tx, ty, tz] = turnPoint(p.turn, [x, y, z]);
    return [tx, ct * ty - st * tz, st * ty + ct * tz];
  };
  return { field, local, seen };
};

/** The hits a figure is printed from: in parts, or scanned from its surface, or taken from its portrait. */
const hitsOf = (p: Plan, field: Field | null, columns: number): Hit[] => {
  if (field) {
    return scan(field, p.box, columns, p.step);
  }
  return p.hits?.() ?? [];
};

/**
 * Which hit each point is, and whether it is one the figure shows. Without parts: more hits than
 * points is an even pick of them; fewer, and the rest wait unseen on the ones there are. In
 * parts, each part has its own stretch of the points; what it does not need waits unseen on its
 * own dots, and a part with nothing to show, and every point left over, on the first part's.
 */
const pick = (
  hits: Hit[],
  parts: { hits: Hit[]; room: number }[] | undefined
): { picked: (Hit | undefined)[]; showing: Uint8Array } => {
  const showing = new Uint8Array(POINTS);
  if (!parts) {
    const picked = Array.from({ length: POINTS }, (_, index) =>
      hits.length >= POINTS
        ? hits[Math.floor((index * hits.length) / POINTS)]
        : hits[index % Math.max(hits.length, 1)]
    );
    showing.fill(1, 0, Math.min(hits.length, POINTS));
    return { picked, showing };
  }
  const picked: (Hit | undefined)[] = Array.from({ length: POINTS });
  const first = parts[0]?.hits ?? [];
  let at = 0;
  for (const { hits: own, room } of parts) {
    const from = own.length > 0 ? own : first;
    for (let each = 0; each < room && at < POINTS; each += 1) {
      picked[at] =
        from.length > room
          ? from[Math.floor((each * from.length) / room)]
          : from[each % Math.max(from.length, 1)];
      showing[at] = own.length > room || each < own.length ? 1 : 0;
      at += 1;
    }
  }
  for (; at < POINTS; at += 1) {
    picked[at] = first[at % Math.max(first.length, 1)];
  }
  return { picked, showing };
};

/** How strongly a point takes part in the hotspots, and the voice of the one it is nearest. */
const hotAt = (
  spots: Spot[],
  x: number,
  y: number,
  z: number
): { heat: number; voice: number } => {
  let heat = 0;
  let voice = 0;
  for (const spot of spots) {
    const d2 =
      (x - spot.at[0]) ** 2 + (y - spot.at[1]) ** 2 + (z - spot.at[2]) ** 2;
    const weight = Math.exp(-d2 / (spot.radius * spot.radius));
    if (weight > heat) {
      heat = weight;
      voice = spot.channel;
    }
  }
  return { heat: heat < 0.02 ? 0 : heat, voice };
};

const build = (key: ShapeKey): DotShape => {
  const p = plan(key);
  const [x0, x1, y0, y1] = p.box;
  const { field, local, seen } = viewOf(p);
  const spots = (p.spots ?? []).map((spot) => ({ ...spot, at: seen(spot.at) }));
  // One ray per pitch across the figure, so every figure is printed on the same spacing.
  const scale = 2 / Math.max(x1 - x0, y1 - y0);
  const parts = p.parts?.();
  const hits = parts
    ? []
    : hitsOf(p, field, Math.round(((x1 - x0) * scale) / PITCH));
  const { picked, showing } = pick(hits, parts);

  const position = new Float32Array(POINTS * 3);
  const tone = new Float32Array(POINTS);
  const ink = new Float32Array(POINTS);
  const presence = new Float32Array(POINTS);
  const hot = new Float32Array(POINTS);
  const channel = new Uint8Array(POINTS);
  const group = new Uint8Array(POINTS).fill(NONE);
  const nerve = new Uint8Array(POINTS).fill(NONE);
  const along = new Float32Array(POINTS);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;

  for (let index = 0; index < POINTS; index += 1) {
    const source = picked[index];
    if (!source) {
      continue;
    }
    const { x, y, z } = source;
    position[index * 3] = (x - cx) * scale;
    position[index * 3 + 1] = (y - cy) * scale;
    position[index * 3 + 2] = z * scale;
    // Fades and prints belong to the figure, so they are read where the point is on the unturned figure.
    const [lx, ly, lz] = local(x, y, z);
    const fade = p.fade?.(lx, ly, lz) ?? 1;
    const print = p.print?.(lx, ly, lz) ?? 1;
    // A print of 0 leaves the spot bare: the figure has no dot there, only its outline and marks.
    presence[index] = showing[index] === 1 && print > 0 ? 1 : 0;
    tone[index] = source.tone * fade * print;
    ink[index] = Math.min(1, source.ink * fade * print);
    const { heat, voice } = hotAt(spots, x, y, z);
    hot[index] = heat;
    channel[index] = voice;
    if (p.groupOf) {
      group[index] = p.groupOf(lx, ly, lz);
    }
    const on = p.nerveOf?.(lx, ly, lz);
    if (on) {
      nerve[index] = on.nerve;
      along[index] = on.along;
    }
  }
  const voice = new Float32Array(4);
  for (const channelOf of [0, 1]) {
    const mouth = spots.find((spot) => spot.channel === channelOf);
    if (!mouth) {
      continue;
    }
    voice[channelOf * 2] = (mouth.at[0] - cx) * scale;
    voice[channelOf * 2 + 1] = (mouth.at[1] - cy) * scale;
  }
  // Where a nerve meets the brain is given on the figure: here it is where that is printed.
  const nerves = (p.nerves ?? []).map((each) => ({
    ...each,
    x: (each.x - cx) * scale,
    y: (each.y - cy) * scale,
  }));
  return {
    position,
    tone,
    ink,
    presence,
    voice,
    hot,
    channel,
    group,
    nerve,
    along,
    nerves,
    activity: p.activity,
  };
};

/** The shape for a key, scanned the first time and kept. */
export const dotShape = (key: ShapeKey): DotShape => {
  const id = shapeId(key);
  let shape = cache.get(id);
  if (!shape) {
    shape = build(key);
    cache.set(id, shape);
  }
  return shape;
};

// ---- Distance fields ------------------------------------------------------------------------

type Field = (x: number, y: number, z: number) => number;

interface Spot {
  at: [number, number, number];
  radius: number;
  channel: number;
}

interface Plan {
  /** The surface, scanned from the front; or, for the person, `hits` taken from the portrait, on the brain's spacing unless another is asked for. */
  field?: Field;
  hits?: (pitch?: number) => Hit[];
  box: [number, number, number, number, number, number];
  spots?: Spot[];
  /** For the brain with its nerves: which team, place or nerve a surface point belongs to, or the brain itself. */
  groupOf?: (x: number, y: number, z: number) => number;
  /** Which nerve a surface point is part of, its place included, and how far along it, from the place, 0, to the brain, 1; none for the brain itself. */
  nerveOf?: (
    x: number,
    y: number,
    z: number
  ) => { nerve: number; along: number } | null;
  /** Each nerve: where it meets the brain's edge, how far along it that is, and the group whose ink says whether it is connected. */
  nerves?: Nerve[];
  /**
   * A figure in parts, in place of one scan of its surface: what is seen of each part, and how
   * many of the figure's points are kept for it. A part's dots then have a place of their own
   * among the points, the same whatever the other parts are, so when one part changes, a nerve
   * growing in, every other dot stays exactly where it is.
   */
  parts?: () => { hits: Hit[]; room: number }[];
  /** Dims part of a surface, e.g. the shoulders fading out at the bottom. */
  fade?: (x: number, y: number, z: number) => number;
  /** A pattern printed on the surface, e.g. lines of text on a page. */
  print?: (x: number, y: number, z: number) => number;
  activity: Activity;
  /** How far the figure is turned before it is scanned, in radians: a head in three-quarter view, a brain from the side. */
  turn: number;
  /** How far it leans toward you, so a laptop shows its keyboard and a brain its top. */
  tilt?: number;
  /** How far a ray may trust the field per step: less for a folded surface, whose distances run short. */
  step?: number;
}

/**
 * A person from a photo: its brightness grid, the part of the photo the figure shows (as
 * fractions of it, in close enough that the face leads), and where the mouth and the ear on the
 * right are in the figure, for their hotspots.
 */
interface Portrait {
  cells: string;
  size: number;
  crop: { x: number; y: number; half: number };
  mouth: [number, number, number];
  ear: [number, number, number];
  /** Above 1, the light parts of the photo print darker: for a face lit so evenly that its features would print too fine to read. */
  gamma?: number;
}

/** Where Stephen speaks: his mouth on the head. */
export const HEAD_MOUTH = { at: PORTRAITS.stephen.mouth };

/** One place the brain connects to: how large, and whether it is known or connected yet. */
interface Node {
  r: number;
  known: boolean;
}

/** A nerve's way from its place to the middle of the brain: the points it runs through, and how long it is. */
interface NervePath {
  xs: number[];
  ys: number[];
  length: number;
}

/** A flat part of the folder: its middle, depth and half width and height, in figure units. */
interface FolderPart {
  kind: "back" | "paper" | "front";
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
}

interface Hit {
  x: number;
  y: number;
  z: number;
  tone: number;
  ink: number;
}

/** A dot of a figure printed coarsely: where it is, fitted into -1..1, how lit it is and how large it prints. */
export interface CoarseDot {
  x: number;
  y: number;
  z: number;
  tone: number;
  ink: number;
}

/**
 * A figure on far fewer rows than the brain prints with, for print as small as an icon: the same
 * surface, `columns` dots across its box, seen from the same side unless another `view` is asked
 * for. Only the dots that are printed, in scan order.
 */
export const coarseScan = (
  key: ShapeKey,
  columns: number,
  view?: { turn: number; tilt?: number }
): CoarseDot[] => {
  const p = view ? { ...plan(key), ...view } : plan(key);
  const [x0, x1, y0, y1] = p.box;
  const { field, local } = viewOf(p);
  const scale = 2 / Math.max(x1 - x0, y1 - y0);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hits = field
    ? scan(field, p.box, columns, p.step)
    : (p.hits?.(2 / columns) ?? []);
  return hits.flatMap((hit) => {
    const [lx, ly, lz] = local(hit.x, hit.y, hit.z);
    const fade = p.fade?.(lx, ly, lz) ?? 1;
    const print = p.print?.(lx, ly, lz) ?? 1;
    if (print <= 0 || fade <= 0.02) {
      return [];
    }
    return [
      {
        x: (hit.x - cx) * scale,
        y: (hit.y - cy) * scale,
        z: hit.z * scale,
        tone: hit.tone * fade * print,
        ink: Math.min(1, hit.ink * fade * print),
      },
    ];
  });
};
