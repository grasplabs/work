// The stuff every figure's bodies are made of (body.ts and figures.ts): the clamp, hash and noise
// they share, what a cell sees of a body (a Hit), a lit sphere, and the round tube, tilted circle
// and segment the later shapes are drawn from. Pure numbers: no DOM here.

export const TAU = Math.PI * 2;
export const clamp = (value: number, low = 0, high = 1) =>
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

/** A lit sphere: centre, depth and radius. */
export interface Sphere {
  kind: "sphere";
  x: number;
  y: number;
  z: number;
  r: number;
  /** Silk drifting over it: Stephen's own. */
  silk: boolean;
  /** How far its silk has turned round it, an angle; left out, the silk only drifts. */
  spin?: number;
}

/**
 * Any other body: what a cell sees of it, worked out by its own drawing (below). Past `reach`
 * outside its edge the cell can't be covered by it, so only the edge matters: `missed`.
 */
export interface Drawn {
  kind: "drawn";
  hit: (x: number, y: number, reach: number) => Hit;
  /** Its edge is no smooth distance (a tilted circle's jumps at its middle): body.ts never skips a tile on its middle's word. */
  rough?: boolean;
}

/** What a cell sees of one part: how far inside its edge, its depth, and its surface. */
export interface Hit {
  /** Signed distance to the edge, in figure units: below 0 inside. */
  edge: number;
  depth: number;
  nx: number;
  ny: number;
  nz: number;
  /** A drifting texture on the surface, 0 to 1, 0.5 for none. */
  grain: number;
  /** How much of the light it takes, 1 when left out: below 1 a darker stuff, above a glowing one. */
  tone?: number;
  /** Fills in its normal and tone, left out until the cell shows it: only its edge and depth come first. */
  surface?: () => void;
}

/** Too far outside a part for it to matter to the cell. */
export const missed = (edge: number): Hit => ({
  edge,
  depth: -9,
  nx: 0,
  ny: 0,
  nz: 1,
  grain: 0.5,
});

export const sphereHit = (
  part: Sphere,
  x: number,
  y: number,
  seconds: number,
  reach: number
): Hit => {
  const dx = (x - part.x) / part.r;
  const dy = (y - part.y) / part.r;
  const q = dx * dx + dy * dy;
  const edge = (Math.sqrt(q) - 1) * part.r;
  if (q >= 1.2 || edge > reach) {
    return missed(edge);
  }
  const nz = Math.sqrt(1 - Math.min(q, 0.999));
  let grain = 0.5;
  if (part.silk) {
    // Turning, its silk is read by longitude, so it goes round the sphere instead of sliding across it.
    const across =
      part.spin === undefined
        ? dx
        : Math.atan2(dx, Math.sqrt(Math.max(0, 1 - Math.min(q, 0.999)))) +
          part.spin;
    const warp = noise(across * 1.4 + 7, dy * 2.2 + seconds * 0.03);
    grain = noise(
      across * 1.3 + seconds * 0.06 + warp * 1.3 + 40,
      dy * 4.2 + warp * 1.6 + 40
    );
  }
  return { edge, depth: part.z + nz * part.r, nx: dx, ny: dy, nz, grain };
};

/**
 * A round tube along a curve, from a signed distance `d` to its middle line and the way out from
 * it (gx, gy): its cross-section a half circle of radius `a`, so it is lit as a solid rod.
 */
export const tube = (
  d: number,
  gx: number,
  gy: number,
  a: number,
  depth: number,
  reach: number,
  grain = 0.5
): Hit => {
  const edge = Math.abs(d) - a;
  if (edge > reach) {
    return missed(edge);
  }
  const across = clamp(d / a, -1, 1);
  const length = Math.hypot(gx, gy) || 1;
  return {
    edge,
    depth: depth + Math.sqrt(1 - across * across) * a,
    nx: (gx / length) * across,
    ny: (gy / length) * across,
    nz: Math.sqrt(1 - Math.min(0.999, across * across)),
    grain,
  };
};

/** A tilted circle of radius `big` as it looks on screen: the signed distance to it, and the way out. */
export const ellipseAt = (
  x: number,
  y: number,
  big: number,
  tilt: number,
  turn: number
) => {
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const u = x * cos + y * sin;
  const squash = Math.cos(tilt);
  const v = -x * sin + y * cos;
  const radius = Math.hypot(u, v / squash) || 1e-6;
  // The gradient of `radius` on screen, so the distance is near true all round.
  const gu = u / radius;
  const gv = v / (squash * squash * radius);
  const steep = Math.hypot(gu, gv) || 1;
  return {
    d: (radius - big) / steep,
    gx: gu * cos - gv * sin,
    gy: gu * sin + gv * cos,
    // Its near half (below, as it tips toward you) passes in front.
    near: (-v / squash / big) * Math.sin(tilt) * big,
  };
};

/** The nearest point of a segment, and how far along it (0 to 1). */
export const onSegment = (
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
) => {
  const dx = bx - ax;
  const dy = by - ay;
  const along = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy));
  const px = ax + dx * along;
  const py = ay + dy * along;
  return { along, ox: x - px, oy: y - py, d: Math.hypot(x - px, y - py) };
};
