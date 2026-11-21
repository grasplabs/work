import { BAYER, LEVELS } from "../dither/dither";

/** The four compositions a mark can take. */
export const agentMarkCompositions = [
  "rise",
  "orb",
  "horizon",
  "beam",
] as const;
export type AgentMarkComposition = (typeof agentMarkCompositions)[number];

/** The three grounds a mark can stand on: the night, dusk (a pine ground, lifted), or mint (by day). */
export const agentMarkGrounds = ["night", "dusk", "mint"] as const;
export type AgentMarkGround = (typeof agentMarkGrounds)[number];

/** How many stops the light has: night, ink, pine, mint, sea, lime, paper. */
export const STOPS = 7;
const TOP = STOPS - 1;

// The hash and the seeded random work in 32-bit integers, bit for bit as the study drew them, so a
// name keeps its tile: their bitwise operators are the point, and nowhere else in the file.
/* oxlint-disable no-bitwise, operator-assignment, unicorn/prefer-math-trunc -- a hash and a seeded random, in 32-bit integers */
/** FNV-1a: the name as a 32-bit number. */
const hashOf = (text: string): number => {
  let hash = 0x81_1c_9d_c5;
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  return hash >>> 0;
};

/** Mulberry32: numbers from 0 to 1, the same ones every time for the same seed. */
const randomFrom = (seed: number) => {
  let state = seed;
  return (): number => {
    state = (state + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/* oxlint-enable no-bitwise, operator-assignment, unicorn/prefer-math-trunc */

const clamp = (value: number) => Math.min(1, Math.max(0, value));

type Field = (u: number, v: number) => number;

// Light rising from low in the tile: a dawn.
const rise = (random: () => number): Field => {
  const x = 0.2 + 0.6 * random();
  const y = 0.82 + 0.3 * random();
  const reach = 0.78 + 0.3 * random();
  return (u, v) => {
    const away = Math.hypot(u - x, (v - y) * 1.15) / reach;
    return clamp(1.04 - away) ** 1.25;
  };
};

// A lit sphere on the night, with a faint halo.
const orb = (random: () => number): Field => {
  const cx = 0.38 + 0.24 * random();
  const cy = 0.38 + 0.24 * random();
  const radius = 0.25 + 0.09 * random();
  const turn = (random() - 0.5) * 1.6;
  const lx = Math.cos(-2.3 + turn);
  const ly = Math.sin(-2.3 + turn);
  const lz = 0.7;
  const length = Math.hypot(lx, ly, lz);
  return (u, v) => {
    const dx = (u - cx) / radius;
    const dy = (v - cy) / radius;
    const inside = dx * dx + dy * dy;
    if (inside <= 1) {
      const dz = Math.sqrt(1 - inside);
      const lit = Math.max(0, (dx * lx + dy * ly + dz * lz) / length);
      return 0.22 + 0.8 * lit ** 1.2;
    }
    const edge = Math.sqrt(inside) - 1;
    return 0.05 + 0.16 * (1 - v) + 0.14 * Math.exp(-((edge / 0.5) ** 2));
  };
};

// A horizon: a sky brightening down to a line of hills, the land dark under it.
const horizon = (random: () => number): Field => {
  const line = 0.5 + 0.16 * random();
  const swell = 0.04 + 0.06 * random();
  const hills = 0.55 + 0.7 * random();
  const phase = random() * Math.PI * 2;
  return (u, v) => {
    const at = line + swell * Math.sin(u * hills * Math.PI * 2 + phase);
    if (v < at) {
      return 0.2 + 0.82 * (v / at) ** 1.8;
    }
    const below = (v - at) / (1 - at);
    return (
      0.06 + 0.2 * (1 - below) + 0.42 * Math.exp(-(((v - at) / 0.045) ** 2))
    );
  };
};

// A beam of light across the tile.
const beam = (random: () => number): Field => {
  const angle =
    (0.35 + 0.5 * random()) * (random() < 0.5 ? 1 : -1) + Math.PI / 2;
  const offset = (random() - 0.5) * 0.24;
  const width = 0.16 + 0.1 * random();
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  return (u, v) => {
    const away = (u - 0.5) * cos + (v - 0.5) * sin - offset;
    return 0.05 + 0.08 * v + 0.92 * Math.exp(-((away / width) ** 2));
  };
};

const fieldOf: Record<AgentMarkComposition, (random: () => number) => Field> = {
  rise,
  orb,
  horizon,
  beam,
};

/** The composition a name takes when none is pinned. */
export const compositionOf = (name: string): AgentMarkComposition =>
  agentMarkCompositions[hashOf(name) % agentMarkCompositions.length] ?? "rise";

// How the field is set in the stops on each ground: the night (the light through to paper), dusk
// (a pine ground, lifted), or mint (a mint ground, the light in lime and paper).
const keys: Record<AgentMarkGround, (level: number) => number> = {
  night: (level) => level * TOP,
  dusk: (level) => 1.6 + level * (TOP - 1.6),
  mint: (level) => 2.85 + level * (TOP - 2.85),
};
// The study's four keys, in its order: a name with no ground pinned stands where it always did.
const named: readonly AgentMarkGround[] = ["night", "dusk", "night", "mint"];

/** The ground a name takes when none is pinned. */
export const groundOf = (name: string): AgentMarkGround => {
  // oxlint-disable-next-line no-bitwise -- the study's own choice of ground, from the hash's bits
  const pick = (hashOf(name) >>> 3) % named.length;
  return named[pick] ?? "night";
};

/** The cells of a mark: `paths[pass][stop]`, an SVG path for the cells of that stop that arrive on that pass of the dither. */
export const markCells = (
  name: string,
  composition: AgentMarkComposition,
  ground: AgentMarkGround,
  cells: number
): string[][] => {
  const seed = hashOf(`${name}:${composition}`);
  const field = fieldOf[composition](randomFrom(seed));
  const key = keys[ground];
  const paths: string[][] = Array.from({ length: LEVELS }, () =>
    Array.from({ length: STOPS }, () => "")
  );
  for (let y = 0; y < cells; y += 1) {
    for (let x = 0; x < cells; x += 1) {
      const level = Math.min(
        TOP,
        Math.max(0, key(clamp(field((x + 0.5) / cells, (y + 0.5) / cells))))
      );
      const base = Math.floor(level);
      const threshold = BAYER[y % 4]?.[x % 4] ?? 0;
      const lit = (level - base) * LEVELS > threshold + 0.5;
      const stop = Math.min(TOP, base + (lit ? 1 : 0));
      // A cell arrives on its threshold's pass: each pass brings a sixteenth of the tile.
      const row = paths[threshold];
      if (row !== undefined) {
        row[stop] += `M${x} ${y}h1v1h-1z`;
      }
    }
  }
  return paths;
};
