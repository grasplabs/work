import { LIGHT } from "../atlas-map.ts";
import { seeded } from "../reveal-motion.ts";

// The neurons the dive into Grasp's thinking prints, from one set of
// designs (grasplabs/prototype `lib/neuron-library.ts`): `DESIGNS` of each
// kind, a cell (a soma, its first dendrite up and longest, the rest round
// it, a twig or two each), a small cell (three short branches, for
// something said), and a crowned cell (its dendrites over its upper half
// only, so its name stands clear under it). A design is kept only if it is
// balanced and its branches stand apart, and a note always gets the same
// one (`designFor`). How large, how fine it is printed and whether it is
// hollow are the caller's; how lit and warm, the drawing's. And the nerves
// between them: a thread Grasp tries, and a nerve of what it found.

/* oxlint-disable no-bitwise, unicorn/prefer-code-point -- a string hash is 32-bit arithmetic on UTF-16 units, as the prototype's: codePointAt would change its numbers */

/** How many designs there are of each kind. */
export const DESIGNS = 30;

export type NeuronKind = "cell" | "small" | "crowned";

/** One line of dots along a curve from one point, bowing through another, to a third, tapering from `from` to `to`. */
export interface Curve {
  x1: number;
  y1: number;
  cx: number;
  cy: number;
  x2: number;
  y2: number;
  from: number;
  to: number;
}

/** A design: how its soma's outline swells and dips, and its dendrites, in its own radius from its middle, y up. */
export interface NeuronDesign {
  kind: NeuronKind;
  index: number;
  lean: number;
  sway: number;
  dendrites: Curve[];
}

/** The point a line between two points bows through: off its middle, sideways, by a share of its length. */
const bowed = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  bow: number
): [number, number] => [
  (x1 + x2) / 2 - (y2 - y1) * bow,
  (y1 + y2) / 2 + (x2 - x1) * bow,
];

/** How long a curve is, about. */
const curveLength = (curve: Curve): number =>
  Math.hypot(curve.cx - curve.x1, curve.cy - curve.y1) +
  Math.hypot(curve.x2 - curve.cx, curve.y2 - curve.cy);

/** The angle a branch leaves the soma at: the first up, the rest round it; crowned, over its upper half only. */
const branchAngle = (
  kind: NeuronKind,
  branch: number,
  branches: number,
  random: () => number
): number => {
  if (branch === 0 && kind !== "small") {
    return Math.PI / 2 + (random() - 0.5) * 0.5;
  }
  if (kind === "crowned") {
    return (
      Math.PI * 0.1 +
      ((branch - 1) / Math.max(branches - 2, 1)) * Math.PI * 0.8 +
      (random() - 0.5) * 0.3
    );
  }
  return (
    (branch / branches) * Math.PI * 2 + Math.PI / 2 + (random() - 0.5) * 0.8
  );
};

/** A twig off a branch, part of the way along it. */
const twigOf = (
  branch: Curve,
  angle: number,
  bend: number,
  length: number,
  random: () => number
): Curve => {
  const off = 0.35 + random() * 0.4;
  const tx =
    (1 - off) * (1 - off) * branch.x1 +
    2 * off * (1 - off) * branch.cx +
    off * off * branch.x2;
  const ty =
    (1 - off) * (1 - off) * branch.y1 +
    2 * off * (1 - off) * branch.cy +
    off * off * branch.y2;
  const away =
    angle + bend * off + (random() < 0.5 ? -1 : 1) * (0.5 + random() * 0.5);
  const reach = length * (0.3 + random() * 0.35);
  const ex = tx + Math.cos(away) * reach;
  const ey = ty + Math.sin(away) * reach;
  const [bx, by] = bowed(tx, ty, ex, ey, (random() - 0.5) * 0.6);
  return {
    x1: tx,
    y1: ty,
    cx: bx,
    cy: by,
    x2: ex,
    y2: ey,
    from: 0.5,
    to: 0.08,
  };
};

/** A design grown from a seed. */
const growDesign = (
  kind: NeuronKind,
  seed: number
): Omit<NeuronDesign, "index"> => {
  const random = seeded(seed);
  const small = kind === "small";
  const dendrites: Curve[] = [];
  const branches = small ? 3 : 4 + Math.floor(random() * 3);
  for (let branch = 0; branch < branches; branch += 1) {
    const apical = branch === 0 && !small;
    const angle = branchAngle(kind, branch, branches, random);
    const length = apical ? 1.25 + random() * 0.5 : 0.6 + random() * 0.7;
    const bend = (random() - 0.5) * (apical ? 0.5 : 1.1);
    const x1 = Math.cos(angle) * 0.96;
    const y1 = Math.sin(angle) * 0.96;
    const x2 = Math.cos(angle + bend) * (1 + length);
    const y2 = Math.sin(angle + bend) * (1 + length);
    const [cx, cy] = bowed(x1, y1, x2, y2, (random() - 0.5) * 0.5);
    const curve = { x1, y1, cx, cy, x2, y2, from: 0.9, to: 0.1 };
    dendrites.push(curve);
    const twigs = small ? 0 : 1 + Math.floor(random() * 2);
    for (let twig = 0; twig < twigs; twig += 1) {
      dendrites.push(twigOf(curve, angle, bend, length, random));
    }
  }
  return {
    kind,
    lean: random() * Math.PI * 2,
    sway: random() * Math.PI * 2,
    dendrites,
  };
};

/** Whether a design is good enough to keep: balanced, within a neuron's room, nothing far over its name, its branches apart. */
const wellMade = (design: Omit<NeuronDesign, "index">): boolean => {
  const ends = design.dendrites.map((each) => [each.x2, each.y2] as const);
  let across = 0;
  for (const [x] of ends) {
    across += x;
  }
  if (Math.abs(across / Math.max(ends.length, 1)) > 0.45) {
    return false;
  }
  if (ends.some(([x, y]) => Math.hypot(x, y) > 2.6)) {
    return false;
  }
  const lowest = Math.min(
    ...design.dendrites.flatMap((each) => [each.y1, each.cy, each.y2])
  );
  if (lowest < (design.kind === "crowned" ? -0.25 : -1.7)) {
    return false;
  }
  const starts = design.dendrites
    .filter((each) => each.from > 0.6)
    .map((each) => Math.atan2(each.y1, each.x1))
    .toSorted((a, b) => a - b);
  const gaps = starts.map((angle, at) =>
    at === 0
      ? angle - (starts.at(-1) ?? 0) + Math.PI * 2
      : angle - (starts[at - 1] ?? 0)
  );
  return Math.min(...gaps) > (design.kind === "crowned" ? 0.28 : 0.42);
};

const library = new Map<NeuronKind, NeuronDesign[]>();

const kindSeed: Record<NeuronKind, number> = {
  cell: 0,
  small: 13,
  crowned: 29,
};

/** The designs of a kind: the first `DESIGNS` grown that are well made, the same every time. */
export const designsOf = (kind: NeuronKind): NeuronDesign[] => {
  const known = library.get(kind);
  if (known !== undefined) {
    return known;
  }
  const found: NeuronDesign[] = [];
  for (let seed = 1; found.length < DESIGNS && seed < 5000; seed += 1) {
    const design = growDesign(kind, seed * 7919 + kindSeed[kind]);
    if (wellMade(design)) {
      found.push({ ...design, index: found.length });
    }
  }
  library.set(kind, found);
  return found;
};

/** A small stable number for a string. */
const hash = (text: string): number => {
  let value = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    value = Math.imul(value ^ text.charCodeAt(index), 16_777_619);
  }
  return Math.abs(value);
};

/** The kind a neuron is drawn as: something said a small cell; one whose name stands under it crowned; else a cell. */
export const neuronKind = (neuron: {
  kind: string;
  crown?: boolean;
}): NeuronKind => {
  if (neuron.kind === "gap" || neuron.kind === "statement") {
    return "small";
  }
  return neuron.crown === true ? "crowned" : "cell";
};

/** The design a neuron is drawn with: of its kind, by its id, so a note always looks the same. */
export const designFor = (id: string, kind: NeuronKind): NeuronDesign => {
  const designs = designsOf(kind);
  const design = designs[hash(id) % designs.length];
  if (design === undefined) {
    throw new Error("No neuron designs were grown");
  }
  return design;
};

/** A design's dendrites, placed at a soma at x, y of radius r. */
export const placed = (
  design: NeuronDesign,
  x: number,
  y: number,
  r: number
): Curve[] =>
  design.dendrites.map((each) => ({
    ...each,
    x1: x + each.x1 * r,
    y1: y + each.y1 * r,
    cx: x + each.cx * r,
    cy: y + each.cy * r,
    x2: x + each.x2 * r,
    y2: y + each.y2 * r,
  }));

/** A soma that is still waiting is hollow: only this much of it, from its rim in, is printed. */
const RIM = 0.34;

/**
 * A soma in `many` dots: the half of a sphere that faces you, spread
 * evenly so they gather at the rim, shaded as print, its outline swelling
 * a little as a cell's does; still waiting, only its rim. Each in the
 * soma's radius from its middle, y up, with its ink and tone.
 */
export const somaDots = (
  design: NeuronDesign,
  many: number,
  waiting: boolean,
  put: (x: number, y: number, ink: number, tone: number) => void
): void => {
  const printed = waiting ? Math.round(many * RIM) : many;
  for (let at = 0; at < printed; at += 1) {
    const nz = (at + 0.5) / many;
    const ring = Math.sqrt(1 - nz * nz);
    const angle = at * 2.399963;
    const nx = Math.cos(angle) * ring;
    const ny = Math.sin(angle) * ring;
    const uneven =
      1 +
      0.07 * Math.sin(3 * angle + design.lean) +
      0.04 * Math.sin(5 * angle + design.sway);
    const light = Math.max(nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2], 0);
    const towards = Math.sqrt(nz);
    put(
      nx * uneven,
      ny * uneven,
      (0.08 + 0.92 * (1 - light) ** 1.4) * (0.5 + 0.5 * towards),
      (0.25 + 0.75 * light) * (0.3 + 0.7 * towards)
    );
  }
};

/** How many dots a soma of radius r takes, printed `step` apart: as many as its face holds, at most `most`. */
export const somaCount = (r: number, step: number, most = 720): number =>
  Math.min(most, Math.round(((2 * Math.PI * r * r) / (step * step)) * 0.8));

/** A dendrite in dots `step` apart, tapering. Each dot: where, its ink, its tone, and how far along. */
export const curveDots = (
  curve: Curve,
  step: number,
  put: (x: number, y: number, ink: number, tone: number, along: number) => void
): void => {
  const many = Math.max(3, Math.round(curveLength(curve) / (step * 0.8)));
  for (let at = 1; at <= many; at += 1) {
    const along = at / many;
    const x =
      (1 - along) * (1 - along) * curve.x1 +
      2 * along * (1 - along) * curve.cx +
      along * along * curve.x2;
    const y =
      (1 - along) * (1 - along) * curve.y1 +
      2 * along * (1 - along) * curve.cy +
      along * along * curve.y2;
    put(x, y, curve.from + (curve.to - curve.from) * along, 0.6, along);
  }
};

/** What a printed dot is, for how it looks. */
export type PrintRole = "soma" | "strand";

/** How bold a printed dot is, for its ink, as the atlas prints a region; still waiting, fainter. */
export const printAlpha = (
  role: PrintRole,
  ink: number,
  waiting: boolean
): number => {
  if (waiting) {
    return 0.42 + 0.3 * ink;
  }
  return role === "strand" ? 0.26 + 0.5 * ink : 0.36 + 0.56 * ink;
};

/** How large a printed dot is, as a share of the spacing between dots, for its ink and its own grain (0.55 to 1.45). */
export const printPart = (
  role: PrintRole,
  ink: number,
  waiting: boolean,
  own: number
): number => {
  let part = role === "strand" ? 0.1 + 0.24 * ink : 0.095 + 0.25 * ink;
  if (waiting) {
    part = 0.1 + 0.16 * ink;
  }
  return Math.min(0.42, part * own);
};

/**
 * A nerve's times, in ms: a thread tried reaches in `tried`, waits `wait`
 * and pulls back in `back`; a nerve of the thinking grows in `nerve`; a
 * signal takes `signal` to run along one.
 */
export const NERVE = {
  tried: 650,
  wait: 250,
  back: 600,
  nerve: 1400,
  signal: 800,
};

/** A nerve at a moment: how far it has grown, how fresh it still is, where a signal runs (-1 none), and whether it is a thread tried. */
export interface NerveNow {
  reach: number;
  fresh: number;
  signal: number;
  tried: boolean;
}

/** A thread tried `age` ms after it set off: it reaches `share` of the way, waits and pulls back, and is gone after. */
const triedNow = (
  age: number,
  grow: number,
  share: number
): NerveNow | null => {
  if (age > grow + NERVE.wait + NERVE.back) {
    return null;
  }
  let reach = 1 - ((age - grow - NERVE.wait) / NERVE.back) ** 2;
  if (age < grow) {
    reach = 1 - (1 - age / grow) ** 3;
  } else if (age < grow + NERVE.wait) {
    reach = 1;
  }
  return {
    reach: share * reach,
    fresh: Math.max(0, 1 - Math.max(0, age - grow - NERVE.wait) / NERVE.back),
    signal: -1,
    tried: true,
  };
};

/**
 * A nerve `age` ms after it set off, `grow` long to reach: a thread tried
 * (`retracts`, the share of the way it reaches) reaches and pulls back; a
 * nerve stays lit, a signal running along it now and then. Nothing before
 * it sets off, and with less motion no thread tried and no signal.
 */
export const nerveNow = (
  age: number,
  grow: number,
  retracts: number | undefined,
  still: boolean
): NerveNow | null => {
  if (age < 0) {
    return null;
  }
  if (retracts !== undefined) {
    return still ? null : triedNow(age, grow, retracts);
  }
  return {
    reach: still ? 1 : 1 - (1 - Math.min(1, age / grow)) ** 3,
    fresh: 1,
    signal: still ? -1 : ((age - grow) / NERVE.signal) % 3,
    tried: false,
  };
};

/** A nerve's curve between two somas: from one's edge to the other's, bowing by `bow` of its length. */
export interface NerveCurve {
  x1: number;
  y1: number;
  cx: number;
  cy: number;
  x2: number;
  y2: number;
  dx: number;
  dy: number;
  length: number;
}

/** The curve a nerve runs along, between two somas. */
export const nerveCurve = (
  from: { x: number; y: number; r: number },
  to: { x: number; y: number; r: number },
  bow: number
): NerveCurve => {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const x1 = from.x + Math.cos(angle) * from.r;
  const y1 = from.y + Math.sin(angle) * from.r;
  const x2 = to.x - Math.cos(angle) * to.r;
  const y2 = to.y - Math.sin(angle) * to.r;
  const dx = x2 - x1;
  const dy = y2 - y1;
  return {
    x1,
    y1,
    cx: (x1 + x2) / 2 - dy * bow,
    cy: (y1 + y2) / 2 + dx * bow,
    x2,
    y2,
    dx,
    dy,
    length: Math.hypot(dx, dy),
  };
};

/** Where along a nerve's curve a share of the way is. */
const nervePoint = (curve: NerveCurve, along: number): [number, number] => {
  const u = 1 - along;
  return [
    u * u * curve.x1 + 2 * along * u * curve.cx + along * along * curve.x2,
    u * u * curve.y1 + 2 * along * u * curve.cy + along * along * curve.y2,
  ];
};

/** How warm and bold a nerve's dot is, `along` its way. */
const nerveLook = (
  now: NerveNow,
  along: number,
  settled: number
): { warmth: number; alpha: number; tip: number; passing: number } => {
  const { reach, fresh, signal, tried } = now;
  const tip =
    reach < 1 || tried ? Math.exp(-(((reach - along) / 0.05) ** 2)) : 0;
  const passing =
    signal >= 0 && signal <= 1.2
      ? Math.exp(-(((along - signal) / 0.06) ** 2))
      : 0;
  if (tried) {
    return {
      warmth: tip,
      alpha: 0.14 + 0.28 * fresh + 0.3 * tip,
      tip,
      passing,
    };
  }
  return {
    warmth: Math.max(tip, passing, 0.6 * fresh),
    alpha: settled + 0.55 * fresh + 0.3 * Math.max(tip, passing),
    tip,
    passing,
  };
};

/**
 * A nerve in dots `unit` apart, as far as it has grown: a thread tried a
 * single fine strand, warm at its tip; a nerve two beaded strands side by
 * side, warm while fresh and where a signal passes, ending in a small
 * terminal. Each dot: where, how large, how bold and how warm.
 */
export const nerveDots = (
  curve: NerveCurve,
  now: NerveNow,
  unit: number,
  settled: number,
  put: (
    x: number,
    y: number,
    radius: number,
    alpha: number,
    warmth: number
  ) => void
): void => {
  const { dx, dy, length } = curve;
  const many = Math.max(6, Math.round(length / (unit * 0.8)));
  for (let at = 1; at <= many && at / many <= now.reach; at += 1) {
    const along = at / many;
    const [px, py] = nervePoint(curve, along);
    const look = nerveLook(now, along, settled);
    const bead = 0.75 + 0.25 * Math.sin(at * 1.1);
    const size = now.tried
      ? 0.16
      : 0.24 + 0.16 * Math.max(look.tip, look.passing);
    put(
      px,
      py,
      unit * size * (1 + 0.25 * now.fresh),
      look.alpha * bead,
      look.warmth
    );
    if (!now.tried) {
      put(
        px - (dy / length) * unit * 1.15,
        py + (dx / length) * unit * 1.15,
        unit * 0.18,
        look.alpha * 0.6,
        look.warmth
      );
    }
  }
  if (now.reach >= 1 && !now.tried) {
    for (let bud = 0; bud < 6; bud += 1) {
      put(
        curve.x2 + Math.cos(bud * 1.047) * unit * 1.3,
        curve.y2 + Math.sin(bud * 1.047) * unit * 1.3,
        unit * 0.2,
        settled + 0.55 * now.fresh,
        0.6 * now.fresh
      );
    }
  }
};
