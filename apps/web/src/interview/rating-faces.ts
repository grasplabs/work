import { BAYER_MATRIX, DITHER_LEVELS } from "@grasp-os/ui/lib/utils";

// The five rating faces, in the system's own dither: a round head lit from
// the top left, cut into a 20 × 20 grid of cells and set in the brand's
// seven stops (night, ink, pine, mint, sea, lime, paper) by the 4 × 4 Bayer
// matrix, the same way an agent's mark is (agents/figure/mark-field.ts). The
// better the mood, the more light: a bad one is a dim pine, a great one
// glows lime and paper. The eyes, brows and mouth are drawn cell by cell in
// night, so each face reads at a glance, with a sea tear on the sad one and
// lime cheeks on the happy ones.
//
// Each head is kept in three lights: as it rests, lit (the pointer on it, or
// chosen) and a glint that runs over it once when it is chosen; and with a
// fade, the cells that give way to the page when another one is chosen (all
// but those round its features, so it still reads). A pine rim holds its
// edge on a light page. Every light and the fade are kept per pass of the
// dither, so the page can bring one in a sixteenth at a time: the dots fill
// in. Pure numbers, computed once.

export const faceMoods = [
  "worried",
  "unsure",
  "level",
  "pleased",
  "laughing",
] as const;
export type FaceMood = (typeof faceMoods)[number];

/** Cells a side. */
export const FACE_CELLS = 20;

/** How many stops the light has, and the brightest. */
const STOPS = 7;
const TOP = STOPS - 1;

// The features, a row of cells per line from the top: `#` night, `o` lime
// (a tear, cheeks), `t` mint (a tongue). Rows not written are all head.
const features: Record<FaceMood, readonly string[]> = {
  worried: [
    "",
    "",
    "",
    "",
    "",
    "......##....##......",
    "....##........##....",
    "",
    "......##....##......",
    "......##....##......",
    ".....o..............",
    ".....o..............",
    "",
    "........####........",
    ".......#....#.......",
    "......#......#......",
  ],
  unsure: [
    "",
    "",
    "",
    "",
    "",
    "............###.....",
    "",
    "",
    "......##....##......",
    "......##....##......",
    "",
    "",
    "",
    "",
    ".......##...##......",
    "......#..###..#.....",
  ],
  level: [
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "......##....##......",
    "......##....##......",
    "",
    "",
    "",
    "",
    ".......######.......",
  ],
  pleased: [
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "......##....##......",
    "......##....##......",
    "......##....##......",
    "",
    "...oo..........oo...",
    ".....#........#.....",
    "......#......#......",
    ".......######.......",
  ],
  laughing: [
    "",
    "",
    "",
    "",
    "",
    "",
    "......##....##......",
    ".....#..#..#..#.....",
    "",
    "",
    "...oo..........oo...",
    ".....##########.....",
    ".....##########.....",
    "......########......",
    ".......#tttt#.......",
    "........####........",
  ],
};

/** The stops a head's light runs between, darkest to brightest, by mood. */
const keys: Record<FaceMood, readonly [number, number]> = {
  worried: [2.5, 3.7],
  unsure: [2.7, 4.1],
  level: [2.9, 4.6],
  pleased: [3.1, 5.2],
  laughing: [3.3, 6],
};

/** The lights a head is kept in. */
export const faceLights = ["rest", "lit", "glint"] as const;
export type FaceLight = (typeof faceLights)[number];

/** How far each light moves a head's key, in stops. */
const lights: Record<FaceLight, number> = {
  rest: 0,
  lit: 0.8,
  glint: 2,
};

/** How large the head is, as a share of the grid. */
const RADIUS = 0.475;

/** Where the light comes from: the top left, towards the viewer. */
const towards = (() => {
  const [x, y, z] = [-0.5, -0.7, 0.75];
  const length = Math.hypot(x, y, z);
  return { x: x / length, y: y / length, z: z / length };
})();

/** Whether a cell is in the head. */
const within = (x: number, y: number) => {
  const dx = ((x + 0.5) / FACE_CELLS - 0.5) / RADIUS;
  const dy = ((y + 0.5) / FACE_CELLS - 0.5) / RADIUS;
  return dx * dx + dy * dy <= 1;
};

/** One cell as an SVG path. */
const cell = (x: number, y: number) => `M${x} ${y}h1v1h-1z`;

/** One face: `heads[light][pass][stop]`, `fade[pass]`, its rim and its features, each an SVG path. */
export interface DitherFace {
  heads: Record<FaceLight, string[][]>;
  fade: string[];
  rim: string;
  ink: string;
  glow: string;
  tongue: string;
}

const draw = (mood: FaceMood): DitherFace => {
  const [low, high] = keys[mood];
  const empty = () =>
    Array.from({ length: DITHER_LEVELS }, () =>
      Array.from({ length: STOPS }, () => "")
    );
  const heads: Record<FaceLight, string[][]> = {
    rest: empty(),
    lit: empty(),
    glint: empty(),
  };
  const fade = Array.from({ length: DITHER_LEVELS }, () => "");
  const drawn = { rim: "", ink: "", glow: "", tongue: "" };
  const marked = (x: number, y: number) => {
    const mark = features[mood][y]?.[x];
    return mark !== undefined && mark !== ".";
  };
  for (let y = 0; y < FACE_CELLS; y += 1) {
    for (let x = 0; x < FACE_CELLS; x += 1) {
      const dx = ((x + 0.5) / FACE_CELLS - 0.5) / RADIUS;
      const dy = ((y + 0.5) / FACE_CELLS - 0.5) / RADIUS;
      const inside = dx * dx + dy * dy;
      const mark = features[mood][y]?.[x];
      const edge = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ].some(([nx = 0, ny = 0]) => !within(nx, ny));
      const nearMark = [-1, 0, 1].some((ox) =>
        [-1, 0, 1].some((oy) => marked(x + ox, y + oy))
      );
      if (inside <= 1 && edge) {
        drawn.rim += cell(x, y);
      } else if (inside <= 1 && mark === "#") {
        drawn.ink += cell(x, y);
      } else if (inside <= 1 && mark === "o") {
        drawn.glow += cell(x, y);
      } else if (inside <= 1 && mark === "t") {
        drawn.tongue += cell(x, y);
      } else if (inside <= 1) {
        const dz = Math.sqrt(1 - inside);
        const lit = Math.max(
          0,
          dx * towards.x + dy * towards.y + dz * towards.z
        );
        const share = 0.05 + 0.95 * lit ** 1.4;
        const threshold = BAYER_MATRIX[y % 4]?.[x % 4] ?? 0;
        if (!nearMark) {
          fade[threshold] += cell(x, y);
        }
        for (const light of faceLights) {
          const level = Math.min(
            TOP,
            Math.max(0, low + lights[light] + (high - low) * share)
          );
          const base = Math.floor(level);
          const up = (level - base) * DITHER_LEVELS > threshold + 0.5;
          const stop = Math.min(TOP, base + (up ? 1 : 0));
          const pass = heads[light][threshold];
          if (pass !== undefined) {
            pass[stop] += cell(x, y);
          }
        }
      }
    }
  }
  return { heads, fade, ...drawn };
};

/** Every face, drawn once. */
export const ditherFaces: Record<FaceMood, DitherFace> = {
  worried: draw("worried"),
  unsure: draw("unsure"),
  level: draw("level"),
  pleased: draw("pleased"),
  laughing: draw("laughing"),
};
