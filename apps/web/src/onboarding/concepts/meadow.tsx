// oxlint-disable no-bitwise, unicorn/prefer-math-trunc, no-inline-comments, complexity, no-use-before-define, no-unused-expressions, jsx-a11y/prefer-tag-over-role -- a concept's verbatim port of Damsko's site drawing (its seeded random, its painter), held by Damsko's own lint there; not for merging
"use client";

import { colors, font, media, space } from "@grasp-os/ui/lib/tokens.stylex";
// The meadow, after the website's footer: one metaphor for what Grasp does, told as a slow loop in pixels.
// Transformation does not happen at once; it grows.
//
// 1. "Transformation starts small." Night. One seed drifts down and settles in the ground.
// 2. "First, a single flower." A stem rises, leaves open, a bud forms, the flower opens.
// 3. "Then it grows, one small step at a time." A soft gust blows the flower's seeds across the
//    field; each lands, waits a moment, and grows in its own time: flowers and grasses.
// 4. "Until it reaches your whole organisation." The new flowers release seeds of their own, the
//    gaps fill, and the meadow sways in the wind. It holds; dusk falls; it begins again with one seed.
//
// The same chapters, timings, grid (6px a pixel, 4 when the box is under 760px wide), seeded random
// (mulberry32, seed 11) and drawing as the website, cell by cell, on ONE 2D canvas, about fifteen
// frames a second, only while it is on screen and the tab is visible. Left out, on purpose:
// - The website's sky is a live WebGL shader (domain-warped "silk" noise). Here the
//   sky is the night drawn on the same canvas: its stars are the shader's own (the same hash on the
//   same cells, the same twinkle), and its dawn is the shader's formula (rising from the horizon,
//   dithered with the same 4x4 Bayer matrix to the palette's stops) over a lighter silk (the
//   shader's fbm and one level of its warp, on a lattice of seeded values, worked out each half
//   second), and at under half the website's strength, so it stays subtle.
// - The website's lavender and violet (two colours outside the seven stops) become their nearest
//   mixes of the stops: lavender is paper at 80%, violet paper at 60%. Every other colour of the
//   website is one of the stops, or a stop at an alpha (the website's palette is these seven).
// - The website fades the top 30% of the picture with a CSS mask; here each cell is faded in the
//   drawing (the same linear ramp), so the canvas and the still drawing cannot differ.
//
// Everything is drawn through a small painter (one call: a rectangle of cells in a stop, at an
// alpha), which the canvas and the still drawing for the one-file book (an SVG of rects) both
// implement. The words are real text over the picture, one line a chapter (content.ts).
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";

// Ported for the setup's concepts from Damsko's own site (grasplabs/damsko
// at 09b93f6, site/brand/meadow.tsx), unchanged in its drawing: the
// campaign's picture on the plan, from the first people to the whole
// company. Its four lines are the website's.

/** The meadow's name, as an image. */
const meadowLabel = "A meadow growing from one seed";

/** The meadow's four chapters, one line each, as the website's footer says them. */
const meadowLines = [
  "Transformation starts small.",
  "First, a single flower.",
  "Then it grows, one small step at a time.",
  "Until it reaches your whole organisation.",
];

const s = stylex.create({
  canvas: {
    position: "absolute",
    inset: 0,
    display: "block",
    width: "100%",
    height: "100%",
    imageRendering: "pixelated",
  },
  still: {
    position: "absolute",
    inset: 0,
    display: "block",
    width: "100%",
    height: "100%",
    shapeRendering: "crispEdges",
  },
  // The chapter, at the foot on the right (the first flower stands left of the middle); on a narrow
  // box, in the dark of the sky at the left, as the website sets it on a phone. One at a time,
  // crossfading.
  lines: {
    position: "absolute",
    insetBlockStart: { default: "auto", [media.maxMd]: "30%" },
    insetBlockEnd: { default: space["8"], [media.maxMd]: "auto" },
    insetInlineEnd: {
      default: space["8"],
      [media.maxMd]: space["5"],
    },
    insetInlineStart: { default: "auto", [media.maxMd]: space["5"] },
    display: "grid",
    justifyItems: { default: "end", [media.maxMd]: "start" },
    margin: 0,
    textAlign: { default: "end", [media.maxMd]: "start" },
    fontFamily: font.serif,
    fontWeight: font.weightNormal,
    fontSize: { default: font.headingSm, [media.maxMd]: font.textLg },
    lineHeight: {
      default: font.headingSmLine,
      [media.maxMd]: font.textLgLine,
    },
    color: `color-mix(in oklch, ${colors.brandPaper} 78%, transparent)`,
    pointerEvents: "none",
  },
  line: {
    gridArea: "1 / 1",
    opacity: 0,
    transitionProperty: "opacity",
    transitionDuration: "900ms",
    transitionTimingFunction: "ease",
  },
  on: { opacity: 1 },
  // The seven stops, for the still drawing's cells.
  paper: { fill: colors.brandPaper },
  lime: { fill: colors.brandLime },
  sea: { fill: colors.brandSea },
  mint: { fill: colors.brandMint },
  pine: { fill: colors.brandPine },
  ink: { fill: colors.brandInk },
  night: { fill: colors.brandNight },
});

// ---- The palette: the seven stops of the light, each colour of the website one of them at an alpha
// (over the night, which is where it is drawn).

type Tone = "paper" | "lime" | "sea" | "mint" | "pine" | "ink" | "night";
interface Ink {
  tone: Tone;
  alpha: number;
}
const ink = (tone: Tone, alpha = 1): Ink => ({ tone, alpha });

// The website's colours (its RGB in the comment) as the stops.
const GROUND = ink("ink", 0.4); // 5,30,23
const SOIL = ink("ink"); // 9,46,37
const GRASS = ink("pine", 0.8); // 14,78,63
const STEM = ink("mint", 0.55); // 22,128,98
const LEAF = ink("mint", 0.8); // 33,180,130
const MINT = ink("mint"); // 33,222,164
const SEA = ink("sea"); // 159,236,196
const LIME = ink("lime"); // 217,249,173
const WHITE = ink("paper"); // 243,251,236
const LAVENDER = ink("paper", 0.8); // 206,192,250, the nearest mix of the stops
const VIOLET = ink("paper", 0.6); // 158,136,232, the nearest mix of the stops
const GOLD = ink("lime"); // 246,226,132
const STAR = ink("paper"); // the shader's star, 0.95,0.99,0.93
/** The dawn's stops, as the shader's palette steps them: night, then ink, pine, mint, sea, lime, paper. */
const DAWN_STOPS: readonly Tone[] = [
  "night",
  "ink",
  "pine",
  "mint",
  "sea",
  "lime",
  "paper",
];

// ---- The painter: everything is drawn as rectangles of cells, each a stop at an alpha.

interface Painter {
  rect: (
    x: number,
    y: number,
    w: number,
    h: number,
    tone: Tone,
    alpha: number
  ) => void;
}
/** One cell (or a w by h block) in a colour, at an alpha. */
const put = (
  p: Painter,
  x: number,
  y: number,
  colour: Ink,
  alpha = 1,
  w = 1,
  h = 1
) => {
  p.rect(x, y, w, h, colour.tone, colour.alpha * alpha);
};

// ---- The story: the chapters in milliseconds from the start of a loop, as the website has them.

interface Plant {
  /** The flower's shape: a daisy, a tulip, a spike of small blooms, or a white puff. */
  bloom: "daisy" | "tulip" | "spike" | "puff";
  from: number;
  gen: number;
  ground: number;
  heart: Ink;
  kind: "flower" | "grass";
  lands: number;
  petal: Ink;
  phase: number;
  /** When its seed is released, from where, and when it lands and starts to grow (ms). */
  release: number;
  tall: number;
  x: number;
}

// Each shape in its own colours (the arrays keep the website's lengths: the seeded random picks from them).
const COLOURS: Record<Plant["bloom"], { petals: Ink[]; hearts: Ink[] }> = {
  daisy: { hearts: [GOLD, MINT], petals: [WHITE, LIME, LAVENDER] },
  puff: { hearts: [SEA], petals: [WHITE] },
  spike: { hearts: [LAVENDER], petals: [VIOLET, LAVENDER, MINT] },
  tulip: { hearts: [WHITE], petals: [LAVENDER, VIOLET, SEA, LIME] },
};
const BLOOMS: Plant["bloom"][] = [
  "daisy",
  "tulip",
  "spike",
  "daisy",
  "puff",
  "tulip",
];

const FALL = 2600;
const GROW = 6500;
const FIRST_WIND = FALL + GROW + 400;
const FLIGHT = 3600;
const SECOND_WIND = FIRST_WIND + 11_000;
// Seeds leave a flower this far apart; the last one has landed and opened by FULL.
const STAGGER = 320;
const STAGGER_LAST = 180;
const THIRD_COUNT = 22;
const FULL =
  SECOND_WIND + THIRD_COUNT * STAGGER_LAST + FLIGHT + 600 + 500 + GROW * 0.8;
const DUSK = FULL + 9000;
const CYCLE = DUSK + 3000;
const FRAME = 1000 / 15;
const FIRST = 1;
const SECOND = 6;
const THIRD = THIRD_COUNT;
/** The meadow at its fullest: what reduced motion and the one-file book show. */
const FULLEST = FULL + 2000;
/** The dawn's strength: the website's 0.66 at under half, so it stays subtle (ink, and a little pine). */
const DAWN = 0.28;
/** The still drawing's grid: the first wall's exhibit at 1440 by 900, in cells of 6px. */
const STILL_COLUMNS = 176;
const STILL_ROWS = 128;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (v: number) => {
  const k = clamp01(v);
  return k * k * (3 - 2 * k);
};
const smoothstep = (from: number, to: number, v: number) =>
  smooth((v - from) / (to - from));
const fract = (v: number) => v - Math.floor(v);

/** A small seeded random (mulberry32), so the meadow is the same every time: the website's own. */
const seeded = (seed: number) => {
  let state = seed;
  return () => {
    state = (state + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/** The shader's hash, in 32-bit floats as the GPU computes it: where the stars are. */
const hash = (x: number, y: number) => {
  const f = Math.fround;
  let px = f(fract(f(f(x) * f(123.34))));
  let py = f(fract(f(f(y) * f(456.21))));
  const dot = f(f(px * f(px + f(45.32))) + f(py * f(py + f(45.32))));
  px = f(px + dot);
  py = f(py + dot);
  return f(fract(f(px * py)));
};

/** The shader's 4x4 Bayer dither, at a cell (x from the left, y from the bottom, as gl_FragCoord). */
const bayer2 = (x: number, y: number) => fract(x / 2 + y * y * 0.75);
const bayer4 = (x: number, y: number) =>
  bayer2(Math.floor(x / 2), Math.floor(y / 2)) * 0.25 + bayer2(x, y);

/** A small value noise in place of the shader's silk: a 64 by 64 lattice of seeded values, three octaves. */
const lattice = Array.from({ length: 64 * 64 }, seeded(7));
const wrap = (v: number) => ((v % 64) + 64) % 64;
const at = (x: number, y: number) => lattice[wrap(x) + wrap(y) * 64] ?? 0;
const valueNoise = (x: number, y: number) => {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const ux = smooth(x - ix);
  const uy = smooth(y - iy);
  const top = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * ux;
  const bottom = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * ux;
  return top + (bottom - top) * uy;
};
/** The shader's fbm, four octaves turned by its own matrix, so the shapes have no grid in them. */
const fbm = (x: number, y: number) => {
  let v = 0;
  let a = 0.5;
  let px = x;
  let py = y;
  for (let i = 0; i < 4; i += 1) {
    v += a * valueNoise(px, py);
    [px, py] = [1.6 * px - 1.2 * py, 1.2 * px + 1.6 * py];
    a *= 0.5;
  }
  return v;
};
/** The silk, simplified: the shader's domain warp, one level of it instead of two. */
const silk = (x: number, y: number, t: number) => {
  const qx = fbm(x, y + t * 0.05);
  const qy = fbm(x + 5.2 - t * 0.04, y + 1.3);
  return fbm(x + 3 * qx + 1.7 + t * 0.06, y + 3 * qy + 9.2);
};

/** The generation of the nth plant: the first flower, the second wave, the rest. */
const generationOf = (n: number, first: number, second: number): number => {
  if (n < first) {
    return 0;
  }
  return n < first + second ? 1 : 2;
};
/** How tall a plant grows, in cells: grass stays low, the first flower stands tallest. */
const tallOf = (
  kind: Plant["kind"],
  gen: number,
  random: () => number
): number => {
  if (kind === "grass") {
    return 4 + Math.floor(random() * 4);
  }
  if (gen === 0) {
    return 22;
  }
  return (gen === 1 ? 13 : 9) + Math.floor(random() * 6);
};

/** How windy it is at time t (0 to 1): two soft gusts, when the seeds fly. */
const windNow = (t: number) => {
  const gust = (from: number) =>
    smooth((t - from + 800) / 1200) *
    (1 - smooth((t - from - FLIGHT - 1200) / 2000));
  return Math.max(0.25, gust(FIRST_WIND), gust(SECOND_WIND));
};

// ---- The scene: everything that is fixed for a size of box, laid out once.

interface Star {
  x: number;
  y: number;
  h: number;
  /** How much of a star it is at this height: none near the field, full high up. */
  high: number;
}
interface Scene {
  W: number;
  H: number;
  horizon: number;
  groundAt: number[];
  soil: [number, number][];
  plants: Plant[];
  gusts: { y: number; offset: number; length: number }[];
  stars: Star[];
  /** The silk over the sky, one value a cell, and the half second it was worked out for (it drifts slowly). */
  silk: { at: number; cells: Float32Array };
}

/** The grid for a box: 6px a cell, 4 when it is narrow; at least 60 by 40 cells, as the website. */
const gridFor = (width: number, height: number) => {
  const P = width < 760 ? 4 : 6;
  return {
    W: Math.max(60, Math.ceil(width / P)),
    H: Math.max(40, Math.ceil(height / P)),
  };
};

/** The website's layout of the meadow, in its order: the order of the seeded random is what makes it the same. */
const sceneFor = (W: number, H: number): Scene => {
  const random = seeded(11);
  const horizon = Math.round(H * 0.78);

  // The ground: a gentle rise and fall, grass along its edge, a few specks of soil.
  const groundAt: number[] = [];
  for (let x = 0; x < W; x += 1) {
    groundAt.push(
      Math.round(
        horizon + Math.sin(x * 0.035 + 0.8) * 2.2 + Math.sin(x * 0.11) * 0.8
      )
    );
  }
  const soil: [number, number][] = [];
  for (let x = 0; x < W; x += 1) {
    const top = groundAt[x] ?? H;
    for (let y = top + 3; y < H; y += 3) {
      if (random() < 0.12) {
        soil.push([x, y]);
      }
    }
  }

  // Where every plant will grow, spread over the field, each generation filling the gaps; about
  // one in five a grass, the rest flowers.
  const total = FIRST + SECOND + THIRD;
  const margin = Math.round(W * 0.05);
  const slots = Array.from({ length: total }, (_, i) =>
    Math.round(
      margin + ((W - 2 * margin) * (i + 0.5 + (random() - 0.5) * 0.5)) / total
    )
  );
  let first = 0;
  for (const [i, x] of slots.entries()) {
    if (Math.abs(x - W * 0.46) < Math.abs((slots[first] ?? 0) - W * 0.46)) {
      first = i;
    }
  }
  const order = [first];
  // The first wind spreads the seeds wide; the second fills what is left.
  const rest = slots.map((_, i) => i).filter((i) => i !== first);
  const wide = rest.filter((_, k) => k % 3 === 1).slice(0, SECOND);
  const fill = rest.filter((i) => !wide.includes(i));
  order.push(...wide, ...fill);
  const plants: Plant[] = [];
  for (const [n, slot] of order.entries()) {
    const gen = generationOf(n, FIRST, SECOND);
    const x = slots[slot] ?? 0;
    const kind = gen > 0 && random() < 0.22 ? "grass" : "flower";
    const bloom =
      gen === 0
        ? "daisy"
        : (BLOOMS[Math.floor(random() * BLOOMS.length)] ?? "daisy");
    const colours = COLOURS[bloom];
    // Drawn from the seeded random in this order (heart, tall, petal, phase): the order is what
    // makes the meadow the same every time.
    const heart =
      gen === 0
        ? GOLD
        : (colours.hearts[Math.floor(random() * colours.hearts.length)] ??
          GOLD);
    const tall = tallOf(kind, gen, random);
    const petal =
      gen === 0
        ? WHITE
        : (colours.petals[Math.floor(random() * colours.petals.length)] ??
          LIME);
    const phase = random() * Math.PI * 2;
    plants.push({
      bloom,
      from: -1,
      gen,
      ground: groundAt[x] ?? horizon,
      heart,
      kind,
      lands: 0,
      petal,
      phase,
      release: 0,
      tall,
      x,
    });
  }
  // The seeds' journeys: the first falls from the sky; the second generation's come from the first
  // flower; the third's from the nearest flower of the second.
  for (const [n, plant] of plants.entries()) {
    if (plant.gen === 0) {
      plant.release = 0;
      plant.lands = FALL;
      continue;
    }
    let parent: Plant | undefined;
    for (const other of plants) {
      if (other.gen !== plant.gen - 1 || other.kind !== "flower") {
        continue;
      }
      if (
        !parent ||
        Math.abs(other.x - plant.x) < Math.abs(parent.x - plant.x)
      ) {
        parent = other;
      }
    }
    plant.from = parent ? plants.indexOf(parent) : 0;
    const index = n - (plant.gen === 1 ? FIRST : FIRST + SECOND);
    plant.release =
      plant.gen === 1
        ? FIRST_WIND + index * STAGGER
        : SECOND_WIND + index * STAGGER_LAST;
    plant.lands = plant.release + FLIGHT + random() * 600;
  }
  // Drawn in this order (y, offset, length), for the same reason.
  const gusts = Array.from({ length: 7 }, () => {
    const y = Math.round(H * (0.2 + random() * 0.45));
    const offset = random() * W;
    const length = 6 + Math.floor(random() * 10);
    return { length, offset, y };
  });

  // The stars: the shader's, one cell each, high up.
  const stars: Star[] = [];
  const low = 1 - horizon / H + 0.1;
  for (let y = 0; y < horizon; y += 1) {
    const up = H - 1 - y;
    const high = smoothstep(low, 0.9, (up + 0.5) / H);
    if (high <= 0) {
      continue;
    }
    for (let x = 0; x < W; x += 1) {
      const h = hash(x + 0.5, up + 0.5);
      if (h >= 0.992) {
        stars.push({ x, y, h, high });
      }
    }
  }
  return {
    W,
    H,
    horizon,
    groundAt,
    soil,
    plants,
    gusts,
    stars,
    silk: { at: -1, cells: new Float32Array(W * horizon) },
  };
};

// ---- The drawing.

/** The ground, which does not change: drawn once (on its own canvas when live). */
const paintLand = (p: Painter, scene: Scene) => {
  const { W, H, groundAt } = scene;
  for (let x = 0; x < W; x += 1) {
    const top = groundAt[x] ?? H;
    put(p, x, top, GROUND, 1, 1, H - top);
    put(p, x, top, GRASS);
    if (x % 3 === 0) {
      put(p, x, top - 1, GRASS);
    }
  }
  for (const [x, y] of scene.soil) {
    put(p, x, y, SOIL);
  }
};

/** How far a plant has grown (0 to 1) at time t. */
const grownOf = (plant: Plant, t: number) =>
  clamp01((t - plant.lands - 500) / (plant.gen === 0 ? GROW : GROW * 0.8));
/** The top of a plant's stem at time t, where its seeds leave from. */
const headOf = (plant: Plant, t: number) => ({
  x: plant.x,
  y: plant.ground - 1 - Math.round(plant.tall * smooth(grownOf(plant, t))),
});

const DAISY_RING: [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];
const DAISY_TIPS: [number, number][] = [
  [-2, 0],
  [2, 0],
  [0, -2],
  [0, 2],
];
const DAISY_SECOND: [number, number][] = [
  [-2, -1],
  [2, -1],
  [-2, 1],
  [2, 1],
  [-1, -2],
  [1, -2],
  [-1, 2],
  [1, 2],
];
const PUFF: [number, number][] = [
  [-2, 0],
  [2, 0],
  [0, -2],
  [0, 2],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
  [-2, -1],
  [2, -1],
  [-1, -2],
  [1, -2],
];

/** A bud, then the flower opening, in its own shape, at its head (hx, top). */
const paintBloom = (
  p: Painter,
  plant: Plant,
  hx: number,
  top: number,
  k: number,
  alpha: number
) => {
  const open = smooth((k - 0.82) / 0.18);
  const dot = (dx: number, dy: number, colour: Ink, a = 1) => {
    put(p, hx + dx, top + dy, colour, alpha * a);
  };
  if (open <= 0) {
    dot(0, 0, LEAF);
  } else if (plant.bloom === "daisy") {
    // A ring of petals round a golden heart; the first flower has a second ring, and a glow.
    for (const [dx, dy] of DAISY_RING) {
      dot(dx, dy, plant.petal, 0.35 + 0.65 * open);
    }
    if (open > 0.5) {
      for (const [dx, dy] of DAISY_TIPS) {
        dot(dx, dy, plant.petal, open);
      }
    }
    if (plant.gen === 0 && open > 0.7) {
      for (const [dx, dy] of DAISY_SECOND) {
        dot(dx, dy, plant.petal, 0.6 * open);
      }
      put(p, hx - 3, top - 3, GOLD, 0.18 * alpha * open, 7, 7);
    }
    dot(0, 0, plant.heart);
  } else if (plant.bloom === "tulip") {
    // A cup: two petals rising either side of a closed heart.
    dot(-1, 0, plant.petal);
    dot(1, 0, plant.petal);
    dot(0, 0, plant.petal, 0.85);
    dot(-1, -1, plant.petal, open);
    dot(1, -1, plant.petal, open);
    dot(0, -1, plant.heart, 0.5 * open);
    if (open > 0.6) {
      dot(-2, -2, plant.petal, 0.7);
      dot(2, -2, plant.petal, 0.7);
    }
    dot(0, 1, LEAF);
  } else if (plant.bloom === "spike") {
    // Small blooms up the top of the stem, alternating sides, opening upwards.
    const count = Math.round(5 * open);
    for (let i = 0; i < count; i += 1) {
      dot(i % 2 ? 1 : -1, i, plant.petal, 0.9);
      dot(0, i, plant.heart, 0.55);
    }
    dot(0, -1, plant.petal);
  } else {
    // A puff of seeds, white, ready for the next wind.
    for (const [i, [dx, dy]] of PUFF.entries()) {
      if (i / PUFF.length < open) {
        dot(dx, dy, plant.petal, 0.75);
      }
    }
    dot(0, 0, plant.heart);
  }
};

/** One plant, cell by cell: the seed in the ground, then the stem, the leaves and the flower. */
const paintPlant = (
  p: Painter,
  plant: Plant,
  t: number,
  time: number,
  still: boolean,
  alpha: number
) => {
  const k = grownOf(plant, t);
  if (k <= 0) {
    // The seed, resting in the ground.
    if (t >= plant.lands) {
      put(p, plant.x, plant.ground - 1, LIME, 0.8 * alpha);
    }
    return;
  }
  const height = Math.max(1, Math.round(plant.tall * smooth(k)));
  const sway = still
    ? 0
    : Math.sin(time / 1200 + plant.phase) * windNow(t) * 1.4;
  if (plant.kind === "grass") {
    for (const [blade, dx] of [-1, 0, 1].entries()) {
      const h = Math.max(1, height - (blade === 1 ? 0 : 1 + blade));
      for (let i = 0; i < h; i += 1) {
        const lean = Math.round(sway * (i / h) + dx * (i / h) * 0.8);
        put(
          p,
          plant.x + dx + lean,
          plant.ground - 1 - i,
          blade === 1 ? LEAF : STEM,
          alpha
        );
      }
    }
    return;
  }
  // Stem, bending a little with the wind towards its top.
  for (let i = 0; i < height; i += 1) {
    put(
      p,
      plant.x + Math.round(sway * (i / height)),
      plant.ground - 1 - i,
      STEM,
      alpha
    );
  }
  // Leaves, once it is a third grown.
  if (k > 0.35) {
    const y = plant.ground - 1 - Math.round(height * 0.4);
    put(p, plant.x - 1, y, LEAF, alpha);
    put(p, plant.x - 2, y - 1, LEAF, alpha);
    if (height > 6) {
      put(p, plant.x + 1, y - 2, LEAF, alpha);
      put(p, plant.x + 2, y - 3, LEAF, alpha);
    }
    if (height > 14) {
      const y2 = plant.ground - 1 - Math.round(height * 0.68);
      put(p, plant.x - 1, y2, LEAF, alpha);
      put(p, plant.x - 2, y2 - 1, LEAF, alpha);
    }
  }
  if (k > 0.75) {
    paintBloom(
      p,
      plant,
      plant.x + Math.round(sway),
      plant.ground - 1 - height,
      k,
      alpha
    );
  }
};

/** The sky over the night: the dawn rising from the horizon as the meadow grows, and the stars. */
const paintSky = (p: Painter, scene: Scene, dawn: number, seconds: number) => {
  const { W, H, horizon } = scene;
  if (dawn > 0.001) {
    // The silk moves slowly, so it is worked out again each half second, not each frame.
    const half = Math.floor(seconds * 2);
    if (scene.silk.at !== half) {
      scene.silk.at = half;
      for (let y = 0; y < horizon; y += 1) {
        for (let x = 0; x < W; x += 1) {
          scene.silk.cells[y * W + x] = smoothstep(
            0.3,
            0.78,
            silk((x + 0.5) / H, ((H - y - 0.5) / H) * 2.2, half / 2)
          );
        }
      }
    }
    for (let y = 0; y < horizon; y += 1) {
      const above = (horizon - y - 0.5) / H;
      const rise = Math.exp(-above * 3) * smoothstep(0, 0.12, above);
      // Below 0.05 the tone stays night (no dither): skip the row.
      if (0.02 + dawn * rise * DAWN < 0.05) {
        continue;
      }
      const up = H - 1 - y;
      let run = 0;
      let runLevel = 0;
      for (let x = 0; x <= W; x += 1) {
        let level = 0;
        if (x < W) {
          const silky = scene.silk.cells[y * W + x] ?? 0;
          const tone = 0.02 + dawn * rise * (0.45 + 0.55 * silky) * DAWN;
          level = Math.min(
            DAWN_STOPS.length - 1,
            Math.floor(tone * 6 + bayer4(x, up) * smoothstep(0.05, 0.14, tone))
          );
        }
        if (x === W || level !== runLevel) {
          if (runLevel > 0) {
            p.rect(x - run, y, run, 1, DAWN_STOPS[runLevel] ?? "night", 1);
          }
          run = 0;
          runLevel = level;
        }
        run += 1;
      }
    }
  }
  if (dawn < 1) {
    for (const star of scene.stars) {
      const twinkle =
        0.5 + 0.5 * Math.sin(seconds * (2 + star.h * 9) + star.h * 60);
      put(
        p,
        star.x,
        star.y,
        STAR,
        star.high * (1 - dawn) * (0.3 + 0.6 * twinkle)
      );
    }
  }
};

/**
 * The meadow at a moment: `time` is milliseconds since it began (the clock of the sway, the wind and
 * the stars), `still` draws its fullest moment without motion. `land` draws the ground (the canvas
 * keeps it drawn once). Returns the chapter line to show, or -1 at dusk.
 */
const paintMeadow = (
  painter: Painter,
  scene: Scene,
  time: number,
  still: boolean,
  land: () => void
): number => {
  const { W, H, horizon, groundAt, plants } = scene;
  // The website's mask: the top 30% of the picture fades into the night above it.
  const p: Painter = {
    rect: (x, y, w, h, tone, alpha) => {
      painter.rect(x, y, w, h, tone, alpha * clamp01((y + 0.5) / (H * 0.3)));
    },
  };
  const t = still ? FULLEST : time % CYCLE;
  const dusk = smooth((t - DUSK) / 2400);
  const alpha = 1 - dusk;
  const grown =
    plants.reduce((sum, plant) => sum + smooth(grownOf(plant, t)), 0) /
    Math.max(1, plants.length);
  const dawn = smooth(grown * 1.15) * (1 - dusk);

  painter.rect(0, 0, W, H, "night", 1);
  paintSky(p, scene, dawn, 30 + (still ? 0 : time / 1000));
  land();

  // The wind: soft dashed streaks drifting across the sky while it blows.
  const wind = still ? 0 : windNow(t);
  if (wind > 0.3) {
    for (const gust of scene.gusts) {
      const x = Math.round(((time * 0.045 + gust.offset) % (W + 40)) - 20);
      for (let i = 0; i < gust.length; i += 2) {
        put(
          p,
          x - i,
          gust.y + Math.round(Math.sin((x - i) * 0.1)),
          SEA,
          0.22 * (wind - 0.25) * (1 - i / gust.length)
        );
      }
    }
  }

  // A low carpet of grass that thickens as the meadow grows.
  for (let x = 0; x < W; x += 1) {
    const tuft = Math.floor(
      grown * 4 * (0.4 + 0.6 * Math.abs(Math.sin(x * 1.7) * Math.cos(x * 0.43)))
    );
    const ground = groundAt[x] ?? horizon;
    for (let i = 0; i < tuft; i += 1) {
      put(
        p,
        x,
        ground - 1 - i,
        i === tuft - 1 ? LEAF : GRASS,
        alpha * (0.6 + 0.4 * (i / Math.max(1, tuft)))
      );
    }
  }
  for (const plant of plants) {
    paintPlant(p, plant, t, time, still, alpha);
  }

  // Seeds in flight: the first falling from the sky, the others blown from a flower's head to where
  // they will grow, fluttering on the way.
  if (!still) {
    for (const plant of plants) {
      if (t < plant.release || t >= plant.lands) {
        continue;
      }
      const k = (t - plant.release) / (plant.lands - plant.release);
      const parent = plant.from >= 0 ? plants[plant.from] : undefined;
      const origin = parent
        ? headOf(parent, plant.release)
        : { x: plant.x - 6, y: Math.round(H * 0.18) };
      const e = smooth(k);
      const lift = parent ? Math.sin(Math.PI * k) * H * 0.22 : 0;
      const flutter = Math.sin(time / 260 + plant.phase) * (parent ? 1.5 : 2.5);
      const x = Math.round(origin.x + (plant.x - origin.x) * e + flutter);
      const y = Math.round(origin.y + (plant.ground - 1 - origin.y) * e - lift);
      put(p, x - 1, y, LIME, 0.35 * alpha);
      put(p, x, y, WHITE, alpha);
    }
  }

  // The quiet line: which chapter it is.
  const chapter = [FALL, FIRST_WIND, SECOND_WIND].filter(
    (end) => t >= end
  ).length;
  return dusk < 0.5 ? chapter : -1;
};

// ---- The two painters.

/** Paints on a 2D canvas, one fillRect a call; the colours are the stops read from the canvas's CSS. */
const canvasPainter = (
  view: CanvasRenderingContext2D,
  colours: Record<Tone, string>
): Painter => {
  let style = "";
  return {
    rect: (x, y, w, h, tone, alpha) => {
      if (alpha <= 0) {
        return;
      }
      const colour = colours[tone];
      if (colour !== style) {
        style = colour;
        view.fillStyle = colour;
      }
      view.globalAlpha = Math.min(1, alpha);
      view.fillRect(x, y, w, h);
    },
  };
};

interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
  tone: Tone;
  alpha: number;
}
/** Collects the cells for the still SVG, joining a cell to the one before it on its row when they match. */
const svgPainter = (cells: Cell[]): Painter => ({
  rect: (x, y, w, h, tone, raw) => {
    const alpha = Math.round(Math.min(1, raw) * 100) / 100;
    if (alpha <= 0) {
      return;
    }
    const last = cells.at(-1);
    if (
      last &&
      h === 1 &&
      last.h === 1 &&
      last.y === y &&
      last.x + last.w === x &&
      last.tone === tone &&
      last.alpha === alpha
    ) {
      last.w += w;
      return;
    }
    cells.push({ x, y, w, h, tone, alpha });
  },
});

interface Layer {
  tone: Tone;
  alpha: number;
  cells: Cell[];
}
/**
 * The still's cells as paths, one per colour (a stop at an alpha) where the painting order allows.
 * A cell joins the latest path of its colour only when no path from that one on already covers any
 * of its pixels; otherwise it starts a new path. So the picture is the canvas's exactly: the order
 * of every overlap is kept, and no path covers a pixel twice (a path fills a pixel once, where
 * separate squares would mix their alphas twice). Rows of touching cells become one run.
 */
const pathsOf = (cells: Cell[], W: number, H: number) => {
  const layers: Layer[] = [];
  const latest = new Map<string, number>();
  const top = new Int32Array(W * H).fill(-1);
  for (const cell of cells) {
    const x0 = Math.max(0, cell.x);
    const x1 = Math.min(W, cell.x + cell.w);
    const y0 = Math.max(0, cell.y);
    const y1 = Math.min(H, cell.y + cell.h);
    if (x0 >= x1 || y0 >= y1) {
      continue;
    }
    let below = -1;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        below = Math.max(below, top[y * W + x] ?? -1);
      }
    }
    const key = `${cell.tone} ${cell.alpha}`;
    let index = latest.get(key) ?? -1;
    if (index <= below) {
      index = layers.length;
      layers.push({ tone: cell.tone, alpha: cell.alpha, cells: [] });
      latest.set(key, index);
    }
    layers[index]?.cells.push({
      ...cell,
      x: x0,
      y: y0,
      w: x1 - x0,
      h: y1 - y0,
    });
    for (let y = y0; y < y1; y += 1) {
      top.fill(index, y * W + x0, y * W + x1);
    }
  }
  return layers.map(({ tone, alpha, cells: squares }) => {
    const sorted = squares.toSorted((a, b) => a.y - b.y || a.x - b.x);
    const runs: Cell[] = [];
    for (const cell of sorted) {
      const last = runs.at(-1);
      if (
        last &&
        cell.h === 1 &&
        last.h === 1 &&
        last.y === cell.y &&
        last.x + last.w === cell.x
      ) {
        last.w += cell.w;
      } else {
        runs.push({ ...cell });
      }
    }
    return {
      tone,
      alpha,
      d: runs.map((r) => `M${r.x} ${r.y}h${r.w}v${r.h}h${-r.w}z`).join(""),
    };
  });
};

// ---- The parts.

/** The chapter lines, one shown at a time (-1: none), as real text over the picture. */
const Lines = ({ shown }: { shown: number }) => (
  <p aria-live="off" {...stylex.props(s.lines)}>
    {meadowLines.map((line, index) => (
      <span
        key={line}
        aria-hidden={index !== shown}
        {...stylex.props(s.line, index === shown && s.on)}
      >
        {line}
      </span>
    ))}
  </p>
);

/** The meadow at its fullest, still, for the one-file book: the same drawing, as squares in an SVG. */
const MeadowStill = ({ words = true }: { words?: boolean }) => {
  const scene = sceneFor(STILL_COLUMNS, STILL_ROWS);
  const cells: Cell[] = [];
  const painter = svgPainter(cells);
  const shown = paintMeadow(painter, scene, 0, true, () => {
    paintLand(painter, scene);
  });
  const paths = pathsOf(cells, scene.W, scene.H);
  return (
    <>
      <svg
        viewBox={`0 0 ${scene.W} ${scene.H}`}
        preserveAspectRatio="xMidYMax slice"
        role="img"
        aria-label={meadowLabel}
        {...stylex.props(s.still)}
      >
        {paths.map((path, index) => (
          // A fixed drawing: each path keyed by its place in the painting order.
          <path
            key={index}
            d={path.d}
            fillOpacity={path.alpha < 1 ? path.alpha : undefined}
            {...stylex.props(s[path.tone])}
          />
        ))}
      </svg>
      {words && <Lines shown={shown} />}
    </>
  );
};

/** The meadow, live: one 2D canvas at the grid's size, scaled up crisp. */
const MeadowLive = ({ words = true }: { words?: boolean }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const canvas = ref.current;
    const view = canvas?.getContext("2d");
    if (!canvas || !view) {
      return () => {
        // Nothing was started.
      };
    }
    const style = getComputedStyle(canvas);
    const colourOf = (tone: Tone) =>
      style.getPropertyValue(`--damsko-brand-${tone}`).trim();
    const colours: Record<Tone, string> = {
      paper: colourOf("paper"),
      lime: colourOf("lime"),
      sea: colourOf("sea"),
      mint: colourOf("mint"),
      pine: colourOf("pine"),
      ink: colourOf("ink"),
      night: colourOf("night"),
    };
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let scene: Scene | null = null;
    let land: HTMLCanvasElement | null = null;
    let line = 0;
    let begun = -1;

    const build = () => {
      const box = canvas.getBoundingClientRect();
      const { W, H } = gridFor(box.width, box.height);
      if (scene?.W === W && scene.H === H) {
        return false;
      }
      scene = sceneFor(W, H);
      canvas.width = W;
      canvas.height = H;
      land = document.createElement("canvas");
      land.width = W;
      land.height = H;
      const landView = land.getContext("2d");
      if (landView) {
        paintLand(canvasPainter(landView, colours), scene);
      }
      return true;
    };
    const draw = (time: number) => {
      if (!scene) {
        return;
      }
      view.clearRect(0, 0, scene.W, scene.H);
      const next = paintMeadow(
        canvasPainter(view, colours),
        scene,
        time,
        still,
        () => {
          if (!land) {
            return;
          }
          view.globalAlpha = 1;
          view.drawImage(land, 0, 0);
        }
      );
      if (next !== line) {
        line = next;
        setShown(next);
      }
    };
    const clock = () => (begun < 0 ? 0 : performance.now() - begun);

    let frame = 0;
    let last = Number.NEGATIVE_INFINITY;
    let seen = false;
    const tick = (now: number) => {
      frame = 0;
      if (now - last >= FRAME) {
        last = now;
        draw(clock());
      }
      run();
    };
    const run = () => {
      if (!still && seen && !document.hidden && frame === 0) {
        frame = requestAnimationFrame(tick);
      }
    };
    const pause = () => {
      cancelAnimationFrame(frame);
      frame = 0;
    };
    const watch = new IntersectionObserver(([entry]) => {
      seen = entry?.isIntersecting === true;
      // It starts from its seed the first time it is seen, and keeps its own time after.
      if (seen && begun < 0) {
        begun = performance.now();
      }
      if (seen) {
        run();
      } else {
        pause();
      }
    });
    const onVisibility = () => {
      document.hidden ? pause() : run();
    };
    const resize = new ResizeObserver(() => {
      if (build()) {
        draw(clock());
      }
    });

    build();
    draw(0);
    watch.observe(canvas);
    resize.observe(canvas);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      pause();
      watch.disconnect();
      resize.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return (
    <>
      <canvas
        ref={ref}
        role="img"
        aria-label={meadowLabel}
        {...stylex.props(s.canvas)}
      />
      {words && <Lines shown={shown} />}
    </>
  );
};

/**
 * The meadow: one seed, then a single flower, then the field, in pixels on the night; a loop of about
 * 46 seconds, about fifteen frames a second, only while it is seen. With reduced motion, the whole
 * meadow, still; in the one-file book, the same drawing as an SVG.
 */
/** The meadow; `words` false leaves its four lines out, for a ground that carries words of its own. */
export const Meadow = ({
  words = true,
  still = false,
}: {
  words?: boolean;
  /** The whole meadow, drawn once: for a place where nothing should move. */
  still?: boolean;
}) => (still ? <MeadowStill words={words} /> : <MeadowLive words={words} />);
