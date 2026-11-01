// Grasp's thinking as a dive into the brain (grasplabs/prototype
// `lib/dive-scene.ts`): the camera flies in through the brain's surface and
// comes to rest inside, the shape of the thinking on a plane in front of
// it. Pure: the camera, where a pixel of the shape's own layout stands in
// the world so that, at rest, it is seen exactly there, and the room the
// shape has. Printed by dive-print.ts, drawn by dive.tsx.

export type Vec3 = [number, number, number];

/** A camera: where it is, what it looks at and its lens, top to bottom in degrees. */
export interface Pose {
  eye: Vec3;
  look: Vec3;
  fov: number;
}

/** A screen to draw on, in CSS pixels. */
export interface Screen {
  width: number;
  height: number;
}

/**
 * The dive: the camera flies in for `flight` ms, once (work still going
 * on, so longer than a control's motion); the dive comes and goes in
 * `fade`; then it rests inside, still, `depth` in front of the shape, so
 * the names stay where they can be read.
 */
const CENTRE: Vec3 = [0, -0.12, 0];
const EYE: Vec3 = [0, 0.05, 0.44];

export const DIVE = {
  flight: 2000,
  fade: 280,
  fov: { outside: 34, inside: 50 },
  outside: { distance: 4.5, yaw: 30, pitch: 11 },
  centre: CENTRE,
  eye: EYE,
  depth: 0.62,
  near: 0.01,
  far: 14,
};

/** The camera at rest inside the brain, the shape `depth` in front of it. */
export const REST: Pose = {
  eye: DIVE.eye,
  look: [DIVE.eye[0], DIVE.eye[1], DIVE.eye[2] - DIVE.depth],
  fov: DIVE.fov.inside,
};

/** The atlas's own measures the dive keeps to: a map's room in steps, the room under the top, and how much the chat's drawer must leave. */
export const ROOM = { step: 16, under: 16, besideDrawer: 300 };

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const mix = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3): Vec3 => scale(a, 1 / (Math.hypot(...a) || 1));

/** 0 before `from`, 1 after `to`, and smoothly between. */
export const smooth = (from: number, to: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)));
  return t * t * (3 - 2 * t);
};

/** Eased in and out: slow off, quick on the way, slow in. */
export const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

const curve = (a: Vec3, b: Vec3, c: Vec3, d: Vec3, t: number): Vec3 => {
  const u = 1 - t;
  return add(
    add(scale(a, u * u * u), scale(b, 3 * u * u * t)),
    add(scale(c, 3 * u * t * t), scale(d, t * t * t))
  );
};

/** How far the brain reaches either side of its middle, with a little room. */
const BRAIN_HALF_WIDTH = 1.15;

/** Where the camera starts: outside, the brain whole in front of it, a little from the side and above. */
const outside = (aspect: number): Vec3 => {
  const yaw = (DIVE.outside.yaw * Math.PI) / 180;
  const pitch = (DIVE.outside.pitch * Math.PI) / 180;
  const across = Math.tan((DIVE.fov.outside * Math.PI) / 360) * aspect;
  const distance = Math.max(DIVE.outside.distance, BRAIN_HALF_WIDTH / across);
  return add(
    DIVE.centre,
    scale(
      [
        Math.sin(yaw) * Math.cos(pitch),
        Math.sin(pitch),
        Math.cos(yaw) * Math.cos(pitch),
      ],
      distance
    )
  );
};

/**
 * The camera on its way in, `progress` 0 to 1 of the flight: from outside
 * it swings round to the brow and goes in through it, the lens widening as
 * it does; with how far inside it is, 0 to 1.
 */
export const flightPose = (
  progress: number,
  aspect: number
): Pose & { inside: number } => {
  const e = easeInOut(Math.min(1, Math.max(0, progress)));
  const start = outside(aspect);
  const eye = curve(
    start,
    [start[0] * 0.3, start[1] * 0.45 + 0.1, Math.max(2.5, start[2] * 0.55)],
    [0, 0.12, 1.3],
    REST.eye,
    e
  );
  return {
    eye,
    look: mix(DIVE.centre, REST.look, smooth(0.2, 0.85, e)),
    fov:
      DIVE.fov.outside +
      (DIVE.fov.inside - DIVE.fov.outside) * smooth(0.35, 1, e),
    inside: smooth(0.5, 0.78, e),
  };
};

/** A camera's right, up and forward. */
const basis = (pose: Pose): { right: Vec3; up: Vec3; forward: Vec3 } => {
  const forward = unit(sub(pose.look, pose.eye));
  const right = unit(cross(forward, [0, 1, 0]));
  return { right, up: cross(right, forward), forward };
};

/** Pixels per world unit, a world unit away from the lens, on a screen this high. */
export const focal = (fov: number, height: number): number =>
  height / 2 / Math.tan((fov * Math.PI) / 360);

/** The camera as a matrix for the screen, column by column as WebGL reads it. */
export const viewProjection = (pose: Pose, screen: Screen): Float32Array => {
  const { right, up, forward } = basis(pose);
  const f = 1 / Math.tan((pose.fov * Math.PI) / 360);
  const aspect = screen.width / Math.max(screen.height, 1);
  const a = (DIVE.far + DIVE.near) / (DIVE.near - DIVE.far);
  const b = (2 * DIVE.far * DIVE.near) / (DIVE.near - DIVE.far);
  const rows: [Vec3, number][] = [
    [right, -dot(right, pose.eye)],
    [up, -dot(up, pose.eye)],
    [scale(forward, -1), dot(forward, pose.eye)],
  ];
  const m = new Float32Array(16);
  for (let column = 0; column < 4; column += 1) {
    const of = (row: number): number => {
      const [axis, offset] = rows[row] ?? [[0, 0, 0], 0];
      return column < 3 ? (axis[column] ?? 0) : offset;
    };
    m[column * 4] = (f / aspect) * of(0);
    m[column * 4 + 1] = f * of(1);
    m[column * 4 + 2] = a * of(2) + (column === 3 ? b : 0);
    m[column * 4 + 3] = -of(2);
  }
  return m;
};

const at = (matrix: Float32Array, index: number): number => matrix[index] ?? 0;

/** Where a world point is seen on the screen, in CSS pixels from its top left, and how far in front of the lens it is. */
export const project = (
  point: Vec3,
  matrix: Float32Array,
  screen: Screen
): { x: number; y: number; depth: number } => {
  const [x, y, z] = point;
  const cx =
    at(matrix, 0) * x + at(matrix, 4) * y + at(matrix, 8) * z + at(matrix, 12);
  const cy =
    at(matrix, 1) * x + at(matrix, 5) * y + at(matrix, 9) * z + at(matrix, 13);
  const w =
    at(matrix, 3) * x + at(matrix, 7) * y + at(matrix, 11) * z + at(matrix, 15);
  const depth = Math.max(w, 1e-4);
  return {
    x: ((cx / depth + 1) / 2) * screen.width,
    y: ((1 - cy / depth) / 2) * screen.height,
    depth: w,
  };
};

/**
 * The world point the camera at rest sees at a place on the screen, `depth`
 * in front of it, give or take `nearer`; and how large a pixel is there.
 */
export const standing = (
  x: number,
  y: number,
  screen: Screen,
  nearer = 0
): { at: Vec3; pixel: number } => {
  const { right, up, forward } = basis(REST);
  const depth = DIVE.depth - nearer;
  const pixel = depth / focal(REST.fov, screen.height);
  const across = (x - screen.width / 2) * pixel;
  const down = (y - screen.height / 2) * pixel;
  return {
    at: add(
      add(REST.eye, scale(forward, depth)),
      add(scale(right, across), scale(up, -down))
    ),
    pixel,
  };
};

/** What the dive keeps clear, as the atlas does: a little along the top and the sides, the chat's bar along the bottom, its drawer at the right. */
export interface DiveClear {
  top: number;
  bottom: number;
  right: number;
}

/** The room the shape has, its middle in the dive's pixels: a little under the top, in whole steps, the drawer kept clear only where that leaves room. */
export const roomOf = (
  size: Screen,
  clear: DiveClear
): { x: number; y: number; width: number; height: number } => {
  const wide =
    size.width -
    (size.width - clear.right >= ROOM.besideDrawer ? clear.right : 0);
  const left = clear.top;
  const over = clear.top + ROOM.under;
  const across = Math.max(wide - 2 * left, ROOM.step);
  const down = Math.max(size.height - clear.bottom - over, ROOM.step);
  return {
    x: left + across / 2,
    y: over + down / 2,
    width: size.width === 0 ? 0 : Math.floor(across / ROOM.step) * ROOM.step,
    height: Math.floor(down / ROOM.step) * ROOM.step,
  };
};

/** The plane the shape stands on: where its top left pixel is in the world, a pixel across and down, and a pixel's size there. */
export interface Plane {
  width: number;
  height: number;
  origin: Vec3;
  across: Vec3;
  down: Vec3;
  pixel: number;
}

/** The plane for a screen, worked out once per size. */
export const planeOf = (screen: Screen): Plane => {
  const origin = standing(0, 0, screen);
  return {
    width: screen.width,
    height: screen.height,
    origin: origin.at,
    across: sub(standing(1, 0, screen).at, origin.at),
    down: sub(standing(0, 1, screen).at, origin.at),
    pixel: origin.pixel,
  };
};

/** The world point of a pixel of the plane. */
export const onPlane = (plane: Plane, x: number, y: number): Vec3 =>
  add(plane.origin, add(scale(plane.across, x), scale(plane.down, y)));
