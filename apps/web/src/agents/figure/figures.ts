import type { Drawn, Hit, Sphere } from "./solid.ts";
import {
  TAU,
  clamp,
  ellipseAt,
  missed,
  noise,
  onSegment,
  sphereHit,
  tube,
} from "./solid.ts";

/** A silhouette: the signed distance from a point to its edge, below 0 inside. */
type Shape = (x: number, y: number) => number;

/** What a later figure is made of. */
export type FigurePart = Sphere | Drawn;

// ---- Silhouettes.

const circle =
  (cx: number, cy: number, r: number): Shape =>
  (x, y) =>
    Math.hypot(x - cx, y - cy) - r;

const ellipse =
  (cx: number, cy: number, a: number, b: number): Shape =>
  (x, y) =>
    (Math.hypot((x - cx) / a, (y - cy) / b) - 1) * Math.min(a, b);

/** A rod along a run of points, its radius running from `ra` at the first to `rb` at the last. */
const path =
  (
    points: readonly (readonly [number, number])[],
    ra: number,
    rb = ra
  ): Shape =>
  (x, y) => {
    let best = 9;
    const last = points.length - 1;
    for (let index = 0; index < last; index += 1) {
      const from = points[index];
      const to = points[index + 1];
      const near = onSegment(
        x,
        y,
        from?.[0] ?? 0,
        from?.[1] ?? 0,
        to?.[0] ?? 0,
        to?.[1] ?? 0
      );
      best = Math.min(
        best,
        near.d - (ra + ((rb - ra) * (index + near.along)) / last)
      );
    }
    return best;
  };

/** The distance to a convex polygon whose corners run anticlockwise. */
const polygonEdge = (
  corners: readonly (readonly [number, number])[],
  x: number,
  y: number
): number => {
  let best = -9;
  for (let index = 0; index < corners.length; index += 1) {
    const from = corners[index];
    const to = corners[(index + 1) % corners.length];
    const ax = from?.[0] ?? 0;
    const ay = from?.[1] ?? 0;
    const bx = to?.[0] ?? 0;
    const by = to?.[1] ?? 0;
    const length = Math.hypot(bx - ax, by - ay) || 1;
    best = Math.max(
      best,
      ((x - ax) * (by - ay) - (y - ay) * (bx - ax)) / length
    );
  }
  return best;
};

/** A convex polygon, its corners given either way round. */
const polygon = (given: readonly (readonly [number, number])[]): Shape => {
  let area = 0;
  for (let index = 0; index < given.length; index += 1) {
    const [ax, ay] = given[index] ?? [0, 0];
    const [bx, by] = given[(index + 1) % given.length] ?? [0, 0];
    area += ax * by - bx * ay;
  }
  const corners = area < 0 ? given.toReversed() : given;
  return (x, y) => polygonEdge(corners, x, y);
};

/** A box, centred, half its width and height, its corners rounded by `round`. */
const box =
  (cx: number, cy: number, wide: number, high: number, round = 0): Shape =>
  (x, y) => {
    const qx = Math.abs(x - cx) - wide + round;
    const qy = Math.abs(y - cy) - high + round;
    return (
      Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
      Math.min(Math.max(qx, qy), 0) -
      round
    );
  };

/** A smooth union: the shapes flow into one another over `k`. */
const blend =
  (k: number, ...shapes: Shape[]): Shape =>
  (x, y) => {
    let d = shapes[0]?.(x, y) ?? 9;
    for (let index = 1; index < shapes.length; index += 1) {
      const other = shapes[index]?.(x, y) ?? 9;
      const h = clamp(0.5 + (0.5 * (other - d)) / k);
      d = other * (1 - h) + d * h - k * h * (1 - h);
    }
    return d;
  };

const union =
  (...shapes: Shape[]): Shape =>
  (x, y) => {
    let d = Infinity;
    for (const shape of shapes) {
      d = Math.min(d, shape(x, y));
    }
    return d;
  };
const cut =
  (shape: Shape, away: Shape): Shape =>
  (x, y) =>
    Math.max(shape(x, y), -away(x, y));
const meet =
  (...shapes: Shape[]): Shape =>
  (x, y) => {
    let d = -Infinity;
    for (const shape of shapes) {
      d = Math.max(d, shape(x, y));
    }
    return d;
  };

/** A star's silhouette: `points` points, from `inner` to `outer`. */
const star =
  (
    cx: number,
    cy: number,
    points: number,
    inner: number,
    outer: number,
    turn = 0
  ): Shape =>
  (x, y) => {
    const angle = Math.atan2(y - cy, x - cx) - turn;
    const wedge = TAU / points;
    const into =
      Math.abs((((angle % wedge) + wedge) % wedge) - wedge / 2) / (wedge / 2);
    return (
      (Math.hypot(x - cx, y - cy) - (inner + (outer - inner) * into ** 2.2)) *
      0.8
    );
  };

// ---- Bodies.

interface Soft {
  /** How far in from its edge it rounds to its full height: small for a crisp edge. */
  round: number;
  /** Its height above the others: what is nearer is drawn over. */
  depth?: number;
  /** Its stuff at a point: darker below 1, glowing above. */
  tone?: (x: number, y: number) => number;
}

const STEP = 0.004;

/** A silhouette inflated into a rounded solid: its edge leans out, its middle faces you. */
const soft = (shape: Shape, { round, depth = 0, tone }: Soft): Drawn => ({
  kind: "drawn",
  hit: (x: number, y: number, reach: number): Hit => {
    const d = shape(x, y);
    if (d > reach) {
      return missed(d);
    }
    const rise = clamp(-d / round);
    const out = 1 - rise;
    const hit: Hit = {
      edge: d,
      depth: depth + rise * round,
      nx: 0,
      ny: 0,
      nz: 1,
      grain: 0.5,
      // Its surface is worked out only where it is the one in front.
      surface: () => {
        const gx = shape(x + STEP, y) - shape(x - STEP, y);
        const gy = shape(x, y + STEP) - shape(x, y - STEP);
        const length = Math.hypot(gx, gy) || 1;
        hit.nx = (gx / length) * out;
        hit.ny = (gy / length) * out;
        hit.nz = Math.sqrt(Math.max(0, 1 - out ** 4));
        hit.tone = tone?.(x, y) ?? 1;
      },
    };
    return hit;
  },
});

const sphere = (
  x: number,
  y: number,
  r: number,
  z = 0,
  silk = false
): Sphere => ({ kind: "sphere", x, y, z, r, silk });

/** A thin ring on a tilted circle about (cx, cy), its near half in front. */
const hoop = (
  big: number,
  tilt: number,
  thick: number,
  cx: number,
  cy: number,
  lift: number
): Drawn => ({
  kind: "drawn",
  rough: true,
  hit: (x: number, y: number, reach: number): Hit => {
    const ring = ellipseAt(x - cx, y - cy, big, tilt, 0);
    return tube(
      ring.d,
      ring.gx,
      ring.gy,
      thick,
      ring.near + lift,
      reach,
      noise(ring.d * 30, 2.1)
    );
  },
});

const drawn = (
  hit: (x: number, y: number, reach: number) => Hit,
  rough = false
): Drawn => ({ kind: "drawn", hit, rough });

// ---- The first round's four.

/** A doughnut tipped toward you: the hole shows the night. */
const torusHit = (
  x: number,
  y: number,
  size: number,
  turn: number,
  reach: number
): Hit => {
  const ring = ellipseAt(x, y, 0.56 * size, 1, turn);
  return tube(ring.d, ring.gx, ring.gy, 0.24 * size, ring.near * 0.6, reach);
};

/** Where the craters sit on the crater orb, in its radius: across, up, and how wide. */
const CRATERS = [
  [-0.32, 0.3, 0.24],
  [0.36, 0.12, 0.18],
  [0.02, -0.4, 0.2],
  [-0.5, -0.22, 0.12],
  [0.3, 0.52, 0.11],
] as const;

/** A plain orb with shallow craters: each catches the light on its far wall. */
const craterHit = (
  x: number,
  y: number,
  size: number,
  spin: number,
  reach: number
): Hit => {
  const r = 0.74 * size;
  const surface = sphereHit(
    { kind: "sphere", x: 0, y: 0, z: 0, r, silk: false },
    x,
    y,
    0,
    reach
  );
  if (surface.edge > 0) {
    return surface;
  }
  const u = x / r;
  const v = y / r;
  let { nx, ny } = surface;
  for (const [cu, cv, wide] of CRATERS) {
    const du = u - (cu + spin);
    const dv = v - cv;
    const from = Math.hypot(du, dv) / wide;
    if (from < 1) {
      // Its bowl: the walls face its middle, steeper toward the rim.
      nx -= (du / wide) * 0.9;
      ny -= (dv / wide) * 0.9;
    } else if (from < 1.25) {
      // Its lip, raised a little.
      nx += (du / wide) * 0.4;
      ny += (dv / wide) * 0.4;
    }
  }
  return {
    ...surface,
    nx,
    ny,
    grain: 0.5 + 0.12 * (noise(u * 5 + 3, v * 5 + 9) - 0.5),
  };
};

/** A comet's tail: a tapering rod from its head, away from the light, thinning to nothing. */
const tailHit = (
  x: number,
  y: number,
  size: number,
  hx: number,
  hy: number,
  reach: number
): Hit => {
  const near = onSegment(x, y, hx, hy, hx - 0.86 * size, hy - 0.62 * size);
  const a = 0.3 * size * (1 - near.along) ** 1.3 + 0.01;
  const hit = tube(
    near.d,
    near.ox,
    near.oy,
    a,
    -0.4,
    reach,
    0.5 - 0.5 * near.along
  );
  return { ...hit, edge: hit.edge + near.along * 0.05 };
};

/** One of the orbit's two thin rings round its small core. */
const orbitRing = (
  x: number,
  y: number,
  size: number,
  tilt: number,
  turn: number,
  reach: number
): Hit => {
  const ring = ellipseAt(x, y, 0.8 * size, tilt, turn);
  return tube(
    ring.d,
    ring.gx,
    ring.gy,
    0.055 * size,
    ring.near,
    reach,
    noise(ring.d * 30, 2.1)
  );
};

const crescent = (turn: number): FigurePart[] => [
  soft(
    cut(circle(0, 0, 0.78), circle(0.36 + 0.02 * Math.sin(turn), 0.2, 0.66)),
    { round: 0.34 }
  ),
];

const eclipse = (): FigurePart[] => [
  soft(circle(0, 0, 0.74), { round: 0.1, depth: -0.2, tone: () => 1.3 }),
  soft(circle(0.16, 0.1, 0.56), { round: 0.42, tone: () => 0.22 }),
];

const littleSun = (turn: number): FigurePart[] => [
  sphere(0, 0, 0.46, 0.2, true),
  soft(star(0, 0, 10, 0.5, 0.84, turn * 0.1), {
    round: 0.12,
    depth: -0.2,
    tone: () => 1.15,
  }),
];

const jellyfish = (turn: number): FigurePart[] => {
  const sway = (offset: number) => 0.06 * Math.sin(turn * 0.8 + offset);
  const tentacle = (x: number, offset: number) =>
    path(
      [
        [x, -0.06],
        [x + sway(offset), -0.32],
        [x - sway(offset + 1), -0.56],
        [x + sway(offset + 2), -0.8],
      ],
      0.06,
      0.02
    );
  return [
    soft(
      meet(ellipse(0, 0, 0.62, 0.58), (_x, y) => -0.04 - y),
      { round: 0.4, depth: 0.1 }
    ),
    soft(
      union(
        tentacle(-0.36, 0),
        tentacle(-0.12, 1.5),
        tentacle(0.12, 3),
        tentacle(0.36, 4.5)
      ),
      {
        round: 0.05,
        depth: -0.1,
        tone: () => 0.85,
      }
    ),
  ];
};

/** The mushroom cap's three pale spots: across, up, and how wide. */
const SPOTS = [
  [-0.3, 0.3, 0.1],
  [0.24, 0.42, 0.08],
  [0.02, 0.18, 0.07],
] as const;

const mushroom = (): FigurePart[] => [
  soft(
    meet(ellipse(0, 0.02, 0.8, 0.62), (_x, y) => -y + 0.02),
    {
      round: 0.36,
      depth: 0.1,
      tone: (x, y) =>
        SPOTS.some(([sx, sy, r]) => Math.hypot(x - sx, y - sy) < r) ? 1.3 : 1,
    }
  ),
  soft(box(0, -0.36, 0.2, 0.42, 0.18), { round: 0.18 }),
];

const rainCloud = (turn: number): FigurePart[] => [
  soft(
    blend(
      0.12,
      circle(-0.34, 0.16, 0.28),
      circle(0.02, 0.32, 0.36),
      circle(0.36, 0.12, 0.26),
      box(0, 0.02, 0.6, 0.14, 0.14)
    ),
    {
      round: 0.3,
      depth: 0.1,
    }
  ),
  soft(
    blend(
      0.1,
      circle(0.04, -0.58, 0.14),
      polygon([
        [0.04, -0.28 + 0.02 * Math.sin(turn)],
        [-0.09, -0.54],
        [0.17, -0.54],
      ])
    ),
    { round: 0.12, tone: () => 1.1 }
  ),
];

const lantern = (turn: number): FigurePart[] => {
  // Lit from inside: its panes glow between the dark ribs, the flame flickering a little.
  const flicker = 1.25 + 0.08 * Math.sin(turn * 3);
  return [
    soft(ellipse(0, -0.08, 0.42, 0.5), {
      round: 0.34,
      tone: (x) => (Math.abs(Math.cos(x * 9)) < 0.18 ? 0.7 : flicker),
    }),
    soft(box(0, 0.48, 0.24, 0.06, 0.04), {
      round: 0.05,
      depth: 0.2,
      tone: () => 0.7,
    }),
    soft(box(0, -0.62, 0.24, 0.06, 0.04), {
      round: 0.05,
      depth: 0.2,
      tone: () => 0.7,
    }),
    hoop(0.16, 0.2, 0.025, 0, 0.66, 0.3),
  ];
};

const bell = (turn: number): FigurePart[] => {
  const swing = 0.06 * Math.sin(turn * 0.6);
  const profile: Shape = (x, y) => {
    const u = x - swing * (0.6 - y);
    // Narrow at the crown, flaring to the lip.
    const along = clamp((0.56 - y) / 1.08);
    const half = 0.2 + 0.18 * along + 0.28 * along ** 3;
    return Math.max(Math.abs(u) - half, y - 0.56, -0.52 - y) * 0.85;
  };
  return [
    soft(blend(0.08, profile, circle(swing * 0.1, 0.56, 0.2)), {
      round: 0.3,
      depth: 0.1,
    }),
    sphere(swing * 1.4, -0.62, 0.11, -0.1),
    hoop(0.1, 0.1, 0.03, 0, 0.8, 0.2),
  ];
};

/** A figure drawn at size 1, scaled to the pose's size: its spheres and its drawn bodies alike. */
const scaled = (parts: readonly FigurePart[], k: number): FigurePart[] =>
  parts.map((part) =>
    part.kind === "sphere"
      ? { ...part, x: part.x * k, y: part.y * k, z: part.z * k, r: part.r * k }
      : drawn((x, y, reach) => {
          // Each hit is made fresh for its cell, so it is scaled in place.
          const hit = part.hit(x / k, y / k, reach / k);
          hit.edge *= k;
          hit.depth *= k;
          return hit;
        }, part.rough)
  );

/** The later figures. */
export type LaterShape =
  | "torus"
  | "crater"
  | "comet"
  | "orbit"
  | "crescent"
  | "eclipse"
  | "sun"
  | "jellyfish"
  | "mushroom"
  | "cloud"
  | "lantern"
  | "bell";

/** The later figures' parts, each at this size (the pose's, over the unit), spread and turn. */
export const laterParts: Record<
  LaterShape,
  (size: number, spread: number, turn: number) => FigurePart[]
> = {
  torus: (size, _spread, turn) => [
    drawn(
      (x, y, reach) =>
        torusHit(x, y, size, -0.3 + 0.08 * Math.sin(turn * 0.4), reach),
      true
    ),
  ],
  crater: (size, _spread, turn) => [
    drawn((x, y, reach) =>
      craterHit(x, y, size, 0.05 * Math.sin(turn * 0.3), reach)
    ),
  ],
  comet: (size, spread, turn) => {
    const hx = 0.32 * size * spread;
    const hy = 0.26 * size * spread + 0.03 * Math.sin(turn * 0.5);
    return [
      sphere(hx, hy, 0.34 * size, 0.2),
      drawn((x, y, reach) => tailHit(x, y, size, hx, hy, reach)),
    ];
  },
  orbit: (size, spread, turn) => [
    sphere(0, 0, 0.3 * size, 0, true),
    drawn(
      (x, y, reach) =>
        orbitRing(
          x,
          y,
          size * spread,
          1.2,
          0.55 + 0.05 * Math.sin(turn * 0.3),
          reach
        ),
      true
    ),
    drawn(
      (x, y, reach) =>
        orbitRing(
          x,
          y,
          size * spread,
          1.25,
          -0.6 + 0.05 * Math.sin(turn * 0.3 + 1),
          reach
        ),
      true
    ),
  ],
  crescent: (size, _spread, turn) => scaled(crescent(turn), size / 1.12),
  eclipse: (size) => scaled(eclipse(), size / 1.12),
  sun: (size, _spread, turn) => scaled(littleSun(turn), size / 1.12),
  jellyfish: (size, _spread, turn) => scaled(jellyfish(turn), size / 1.12),
  mushroom: (size) => scaled(mushroom(), size / 1.12),
  cloud: (size, _spread, turn) => scaled(rainCloud(turn), size / 1.12),
  lantern: (size, _spread, turn) => scaled(lantern(turn), size / 1.12),
  bell: (size, _spread, turn) => scaled(bell(turn), size / 1.12),
};
