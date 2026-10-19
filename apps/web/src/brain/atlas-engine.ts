import {
  atlasBody,
  atlasCount,
  AXON,
  DENDRITE,
  LIGHT,
  OPEN_MARK,
  RESTING,
  regionSides,
  SOMA,
  SURFACE,
  SYNAPSE,
  turnPoint,
  WAITING,
} from "./atlas-map.ts";
import type { AtlasDots, MapFrame, NeuronMap, Turn } from "./atlas-map.ts";
import { isRegion, REGION_IDS } from "./brain-atlas.ts";
import type { RegionId } from "./brain-atlas.ts";
import { ALPHAS, HEATS, palette, rgb } from "./dot-ink.ts";
import type { BrainDots } from "./dot-ink.ts";
import { pairAlongCurve, seeded } from "./reveal-motion.ts";

/**
 * The atlas's drawing: the company brain in 3D in dots, or a region's map of neurons, on a canvas,
 * with the camera, the pointer and the names pinned over it. Ported from the drawing inside the
 * prototype's atlas (grasplabs/prototype, packages/grasp: components/knowledge/brain-atlas.tsx),
 * number for number; it is cut into steps here so each stays readable. The component around it
 * (atlas-canvas.tsx) hands it what the view asks for, each render, through `latest`.
 */

/** What the atlas shows: the whole brain, a region, narrowed or not to one of its folders, or one note in it (a note, a folder of them, or an open question). */
export interface AtlasView {
  region?: RegionId;
  /** The folder the region is narrowed to, by its path in the vault. */
  group?: string;
  note?: string;
}

/** What the buttons beside the atlas can ask of it: closer or further by a factor, or back to how the view puts it. */
export interface AtlasControls {
  zoom: (factor: number) => void;
  reset: () => void;
}

/** What the pointer is over: a region of the brain, a neuron of a map, a way out of it, or a region on the small brain. */
export interface Over {
  region?: RegionId;
  neuron?: number;
  exit?: number;
  mini?: RegionId | "whole";
}

export interface Target {
  key: string;
  /** The brain turns with the camera; a map is laid flat, facing you. */
  turning: boolean;
  dots: AtlasDots;
  marks: Uint8Array;
}

/** Where a region's map opens: where the region is once turned to face you. */
export interface AtlasFrame extends MapFrame {
  turn: Turn;
}

/** What the view asks for now, as the component last rendered it. */
export interface AtlasLive {
  target: Target;
  frame: AtlasFrame | null;
  map: NeuronMap | null;
  pins: { x: number; y: number }[];
  chosen: number;
  diving: number;
  litNeurons: number[];
  litRegions: Set<number>;
  thinking: boolean;
  hovered: Over;
  under: Over;
  pointed?: RegionId;
  spotted: number;
  reduce: boolean;
  level: number;
  centre: number;
  scale: number;
  onGo: (view: AtlasView) => void;
  onDived: (dots: BrainDots) => void;
  choose: (index: number) => void;
  view: AtlasView;
  signals: RegionId[][];
  miniX: number;
}

const TAU = Math.PI * 2;
/** How long dots take to flow into a new figure, and how much later the last one leaves. */
const MORPH_S = 1.1;
const SPREAD_S = 0.4;
/** Going into a region, the brain first turns to face it, for at most this long. */
const TURN_S = 0.7;
/** How far the pointer may be from a dot or a soma to count as over it, in pixels. */
const NEAR = 14;
/** The camera's distance, for perspective: nearer parts of the brain print a little larger; and the nearest anything is drawn as, when the spine swings towards you. */
const DISTANCE = 3.6;
const NEAREST = 1;
/** Seen whole, the brain sits a little above the middle of the room it has, so its spine has room to run on down, into the chat. */
const WHOLE = { x: 0, y: -0.25, zoom: 1 };
/** The brain sways a little either side of rest while left alone, by this much, taking this long. */
const SWAY = 0.32;
const SWAY_S = 48;
/** The brain fires: a pulse sets off this often, takes this long from one region to the next, and warms dots this near it. */
const PULSE_EVERY_S = 1.7;
const PULSE_LEG_S = 0.85;
const PULSE_REACH = 0.2;
/** While a question is being answered, it runs up the spine this often. */
const THINK_EVERY_S = 0.8;
/** The way up the spine, for what a source brought in and for a question being answered: from below any view, along its bow, to the stem. */
const SPINE_UP: [number, number, number][] = [
  [0, -2.5, -0.3],
  [0, -1.6, -0.385],
];
/** The small brain that says where you are, inside a region: how far down it sits (across, it is in the middle of the legend), and its size in pixels per unit. */
export const MINI = { y: 60, scale: 46, near: 9 };
/**
 * Going into a note: the camera goes in on its neuron until the soma takes this share of the
 * canvas's smaller side, for this long; then its dots are handed over, at least this many, to
 * build the note's page.
 */
const DIVE = { fill: 0.26, seconds: 0.5, dots: 5200 };

const at = (values: ArrayLike<number>, index: number): number =>
  values[index] ?? 0;

/** Every colour a dot can have: the brain's ink and warmth, and one row in the attention colour. */
const inks = (element: HTMLElement): string[] => {
  const styles = palette(element);
  const [r, g, b] = rgb(
    getComputedStyle(element).getPropertyValue("--status-attention").trim() ||
      "#d0561c"
  );
  for (let a = 0; a < ALPHAS; a += 1) {
    styles.push(`rgba(${r}, ${g}, ${b}, ${(a / (ALPHAS - 1)).toFixed(3)})`);
  }
  return styles;
};

/** An ease in and out, cubic: slow to leave, slow to land. */
const easeInOut = (t: number): number => {
  if (t <= 0) {
    return 0;
  }
  if (t >= 1) {
    return 1;
  }
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
};

/** Per dot: where it flew from, and where it is going. */
interface Course {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  pitch: Float32Array;
  ink: Float32Array;
  tone: Float32Array;
  presence: Float32Array;
}

/** Per dot: what it is, before and after a morph. */
interface Kind {
  owner: Int16Array;
  other: Int16Array;
  role: Uint8Array;
  mark: Uint8Array;
  along: Float32Array;
}

const courseOf = (count: number): Course => ({
  x: new Float32Array(count),
  y: new Float32Array(count),
  z: new Float32Array(count),
  pitch: new Float32Array(count),
  ink: new Float32Array(count),
  tone: new Float32Array(count),
  presence: new Float32Array(count),
});

const kindOf = (count: number): Kind => ({
  owner: new Int16Array(count),
  other: new Int16Array(count),
  role: new Uint8Array(count),
  mark: new Uint8Array(count),
  along: new Float32Array(count),
});

/** What is lit in a frame, and how. */
interface Lighting {
  inMap: boolean;
  into: number;
  liftedIndex: number;
  focus: Set<number>;
  wired: Set<number>;
  wayOut: number;
  pointedAt: number;
  spotMark: number;
  litParts: Set<number> | null;
  dimming: boolean;
  breathe: number;
  sparks: [number, number, number, number][];
}

/** What one dot draws in a frame, before it is shaded. */
interface Drawn {
  role: number;
  owner: number;
  other: number;
  mark: number;
  along: number;
  goal: number;
}

/** A neuron's place on screen, for the pointer and its name. */
interface Placed {
  x: number[];
  y: number[];
  r: number[];
}

/** Whether a dot is lit this frame: one of the kind the legend points at, the part of the brain lifted or lit, a neuron in focus with its synapses, or the fibres of what is pointed at. */
const glowsOf = (drawn: Drawn, light: Lighting): boolean => {
  const { role, owner, other, mark } = drawn;
  if (light.spotMark >= 0) {
    return (
      mark === light.spotMark &&
      (role === SURFACE || role === SOMA || role === DENDRITE)
    );
  }
  if (role === SURFACE) {
    if (light.liftedIndex >= 0) {
      return owner === light.liftedIndex;
    }
    return light.litParts !== null && light.litParts.has(owner);
  }
  if (role === SOMA || role === DENDRITE) {
    return light.focus.has(owner);
  }
  if (role === SYNAPSE) {
    return (
      light.focus.has(owner) &&
      light.focus.has(other) &&
      (light.pointedAt < 0 ||
        owner === light.pointedAt ||
        other === light.pointedAt)
    );
  }
  if (role === AXON) {
    return (
      light.wired.has(owner) ||
      (light.wayOut >= 0 && other === -2 - light.wayOut)
    );
  }
  return false;
};

/** How inked a dot is before it is lit or dimmed: by its mark and what it draws. */
const baseAlpha = (
  mark: number,
  role: number,
  ink: number,
  still: boolean,
  breathe: number
): number => {
  if (mark === OPEN_MARK) {
    // A patch on the brain pulses; a neuron keeps its shading, so it stays a sphere.
    if (role === SURFACE) {
      return still ? 0.85 : 0.55 + 0.4 * breathe;
    }
    return (0.5 + 0.45 * ink) * (still ? 1 : 0.82 + 0.18 * breathe);
  }
  if (mark === WAITING) {
    return role === SURFACE ? 0.58 : 0.42 + 0.3 * ink;
  }
  if (role === SURFACE || role === SOMA) {
    return 0.36 + 0.56 * ink;
  }
  return 0.26 + 0.5 * ink;
};

/** How much a dot steps back while something else is lit. */
const dimmedBy = (
  light: Lighting,
  role: number,
  attention: boolean
): number => {
  if (light.spotMark >= 0) {
    return 0.3;
  }
  if (role === SURFACE) {
    return 0.5;
  }
  return attention ? 0.75 : 0.4;
};

/** How bold a link that is not lit prints: faint while something else is lit; in a region, so it reads as connected; on the whole brain, where links are its folds, fainter. */
const linkAlpha = (light: Lighting): number => {
  if (light.dimming) {
    return 0.13;
  }
  return light.inMap ? 0.6 : 0.24;
};

/** A dot's size as a share of its spacing, by its mark, what it draws, its ink and its grain. */
const partOf = (
  waiting: boolean,
  role: number,
  ink: number,
  own: number
): number => {
  if (waiting) {
    return Math.min(0.42, (0.1 + 0.16 * ink) * own);
  }
  if (role === SURFACE || role === SOMA) {
    return Math.min(0.42, (0.095 + 0.25 * ink) * own);
  }
  return Math.min(0.42, (0.1 + 0.24 * ink) * own);
};

/** In a map: the note in hand or under the pointer with what it links to, what the story names, or every note that takes the way out pointed at. */
const focusOf = (
  state: AtlasLive,
  into: number,
  wayOut: number
): { focus: Set<number>; wired: Set<number> } => {
  const focus = new Set<number>();
  // Whose axons stand out: a note's, when it is pointed at or in hand.
  const wired = new Set<number>();
  if (!state.map) {
    return { focus, wired };
  }
  if (into >= 0) {
    focus.add(into);
    return { focus, wired };
  }
  for (const index of [state.chosen, state.hovered.neuron ?? -1]) {
    if (index < 0) {
      continue;
    }
    focus.add(index);
    wired.add(index);
    for (const [a, b] of state.map.synapses) {
      if (a === index) {
        focus.add(b);
      }
      if (b === index) {
        focus.add(a);
      }
    }
  }
  for (const index of state.litNeurons) {
    focus.add(index);
  }
  if (wayOut >= 0) {
    for (const index of state.map.exits[wayOut]?.from ?? []) {
      focus.add(index);
    }
  }
  return { focus, wired };
};

/** Region names that would overlap move apart, up and down, a few passes; and none runs off the canvas. */
const spread = (
  placed: {
    overlay: HTMLElement;
    x: number;
    y: number;
    width: number;
    height: number;
  }[],
  width: number,
  height: number
) => {
  for (let pass = 0; pass < 6; pass += 1) {
    for (const [index, one] of placed.entries()) {
      for (const other of placed.slice(index + 1)) {
        const overlapX =
          (one.width + other.width) / 2 + 6 - Math.abs(one.x - other.x);
        const overlapY =
          (one.height + other.height) / 2 + 4 - Math.abs(one.y - other.y);
        if (overlapX <= 0 || overlapY <= 0) {
          continue;
        }
        const push = overlapY / 2;
        const up = one.y <= other.y ? -1 : 1;
        one.y += up * push;
        other.y -= up * push;
      }
    }
  }
  for (const label of placed) {
    const lx = Math.min(
      Math.max(label.x, label.width / 2 + 6),
      Math.max(width - label.width / 2 - 6, label.width / 2 + 6)
    );
    const ly = Math.min(
      Math.max(label.y, label.height / 2 + 6),
      Math.max(height - label.height / 2 - 6, label.height / 2 + 6)
    );
    label.overlay.style.transform = `translate(${Math.round(lx)}px, ${Math.round(ly)}px)`;
  }
};

/**
 * Draws the atlas on `element` for as long as it is shown: the brain or a region's map as `latest`
 * asks for it each frame, flowing from one into the next; names placed over it in `overlays`; the
 * pointer turning, panning and zooming, and choosing. It says what the pointer is over through
 * `setUnder`. Gives back what the zoom buttons can ask, and how to stop it.
 */
export const runAtlas = (
  element: HTMLCanvasElement,
  cloud: AtlasDots,
  latest: { current: AtlasLive },
  overlays: Map<string, HTMLElement>,
  setUnder: (over: Over) => void
): { controls: AtlasControls; stop: () => void } | null => {
  const context = element.getContext("2d");
  if (!context) {
    return null;
  }
  const count = atlasCount();

  let styles = inks(element);
  const repaint = () => {
    styles = inks(element);
  };
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", repaint);
  const themes = new MutationObserver(repaint);
  themes.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme", "style"],
  });

  const random = seeded(41);
  const seed = Float32Array.from({ length: count }, () => random());
  const delay = Float32Array.from(seed, (value) => value * SPREAD_S);
  const grain = Float32Array.from({ length: count }, () => random() ** 2);

  // Where each dot is now, as seen; where it flew from; and where it is going: a dot of the turning brain, or of a flat map.
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const z = new Float32Array(count);
  const from = courseOf(count);
  const goal = { ...courseOf(count), index: new Int32Array(count) };
  const was = kindOf(count);
  const will = kindOf(count);
  // The ink, tone and presence each dot is drawn with now, for a morph to start from.
  const inkNow = new Float32Array(count);
  const toneNow = new Float32Array(count);
  const pitchNow = new Float32Array(count);
  const presenceNow = new Float32Array(count);
  let goalTurning = true;
  let wasTurning = true;
  let key = "";
  let morphAt = -1;
  let waitingFor: Target | null = null;
  let waitingSince = 0;
  let first = true;

  const turn: Turn = { ...RESTING };
  const cam = { x: 0, y: 0, zoom: 1 };
  const anchor = { x: 0, y: 0 };
  // The reader's own turning, panning and zooming, on top of where the view puts things; reset when the view changes.
  const user = { yaw: 0, pitch: 0, x: 0, y: 0, zoom: 1, view: "" };
  let idleSince = 0;
  // How long the brain has swayed in all: it holds where it is while it is pointed at, and goes on from there.
  let swayed = 0;
  // When the camera set off into a note, and whether its dots were handed over.
  let diveAt = -1;
  let handed = false;

  const sx = new Float32Array(count);
  const sy = new Float32Array(count);
  const radius = new Float32Array(count);
  const facing = new Float32Array(count);
  const bucket = new Uint16Array(count);
  // The ink each dot is drawn with now, and how swollen it is: both ease to what they should be, so what lights up fades in and what steps back fades out.
  const inked = new Float32Array(count);
  const swell = new Float32Array(count).fill(1);
  // Dots still waiting on the brain are drawn hollow: a ring instead of a dot.
  const hollow = new Uint8Array(count);
  const rings = new Uint32Array(count);
  const counts = new Uint32Array((HEATS + 1) * ALPHAS);
  const starts = new Uint32Array(counts.length);
  const order = new Uint32Array(count);
  const neurons: Placed = { x: [], y: [], r: [] };
  const leans: ({ x: number; y: number } | undefined)[] = [];

  const pointer = {
    x: 0,
    y: 0,
    down: false,
    dragged: false,
    startX: 0,
    startY: 0,
  };
  let then = -1;
  let raf = 0;

  // Pulses on their way, each along the regions a statement passes; and when the next sets off.
  const pulses: { points: [number, number, number][]; born: number }[] = [];
  let nextPulse = 0;
  let thought = false;
  let fired = 0;
  // The small brain: every few dots of the side that faces you at rest, where each sits and which region it is. Without its spine.
  const mini: { x: number; y: number; region: number }[] = [];
  for (let index = 0; index < atlasBody(); index += 3) {
    const { 2: nz } = turnPoint(
      at(cloud.nx, index),
      at(cloud.ny, index),
      at(cloud.nz, index),
      RESTING
    );
    if (nz < 0.15) {
      continue;
    }
    const [vx, vy] = turnPoint(
      at(cloud.x, index),
      at(cloud.y, index),
      at(cloud.z, index),
      RESTING
    );
    mini.push({ x: vx, y: vy, region: at(cloud.owner, index) });
  }

  // The turn the view wants: at rest with the reader's turning and a slow sway, or facing the open region.
  const wantedTurn = (time: number, since: number): Turn => {
    const { frame: place, reduce: still, hovered: over } = latest.current;
    if (place && (!goalTurning || waitingFor)) {
      return place.turn;
    }
    const resting =
      !(still || pointer.down || over.region) &&
      time - idleSince > 1.2 &&
      morphAt < 0;
    if (resting) {
      swayed += since;
    }
    const sway = still ? 0 : SWAY * Math.sin((swayed / SWAY_S) * TAU);
    return {
      yaw: RESTING.yaw + user.yaw + sway,
      pitch: Math.max(-0.9, Math.min(0.9, RESTING.pitch + user.pitch)),
    };
  };

  // The camera the view asks for: the whole brain, a region's map, a note in it, leaning towards what the story lights; or in on the note being opened.
  const wantedCamera = (side = 0): { x: number; y: number; zoom: number } => {
    const {
      frame: place,
      map: shown,
      chosen: focus,
      diving: into,
      litNeurons: lits,
      scale: unit,
    } = latest.current;
    if (!(place && shown) || goalTurning) {
      return WHOLE;
    }
    const diveNeuron = shown.neurons[into];
    if (diveNeuron && side > 0) {
      return {
        x: place.x + diveNeuron.x * place.reach,
        y: place.y + diveNeuron.y * place.reach,
        zoom: Math.min(
          (DIVE.fill * side) / (diveNeuron.r * place.reach * unit),
          place.zoom * 8
        ),
      };
    }
    const focused = shown.neurons[focus];
    if (focused) {
      return {
        x: place.x + focused.x * place.reach * 0.4,
        y: place.y + focused.y * place.reach * 0.4,
        zoom: place.zoom * 1.12,
      };
    }
    if (lits.length > 0) {
      const mx =
        lits.reduce((sum, index) => sum + (shown.neurons[index]?.x ?? 0), 0) /
        lits.length;
      const my =
        lits.reduce((sum, index) => sum + (shown.neurons[index]?.y ?? 0), 0) /
        lits.length;
      return {
        x: place.x + mx * place.reach * 0.12,
        y: place.y + my * place.reach * 0.12,
        zoom: place.zoom,
      };
    }
    return { x: place.x, y: place.y, zoom: place.zoom };
  };

  // Where a dot of the brain is, as seen now.
  const seenBrain = (index: number): [number, number, number] =>
    turnPoint(at(cloud.x, index), at(cloud.y, index), at(cloud.z, index), turn);

  /** The first figure gathers from a small cloud in the middle. */
  const gather = (index: number, next: Target, to: number) => {
    const angle = at(seed, index) * TAU * 13;
    const distance = Math.sqrt(at(grain, index)) * 0.3;
    from.x[index] = Math.cos(angle) * distance;
    from.y[index] = Math.sin(angle) * distance - 0.04;
    from.z[index] = 0;
    from.pitch[index] = at(next.dots.pitch, to);
    from.presence[index] = 0;
    was.owner[index] = at(next.dots.owner, to);
    was.role[index] = at(next.dots.role, to);
    was.mark[index] = at(next.marks, to);
  };

  /** A dot sets off from where it is now towards its place in the next figure. */
  const setOff = (index: number, next: Target, to: number) => {
    from.x[index] = at(x, index);
    from.y[index] = at(y, index);
    from.z[index] = at(z, index);
    from.pitch[index] = at(pitchNow, index);
    from.ink[index] = at(inkNow, index);
    from.tone[index] = at(toneNow, index);
    from.presence[index] = at(presenceNow, index);
    was.owner[index] = at(will.owner, index);
    was.other[index] = at(will.other, index);
    was.role[index] = at(will.role, index);
    was.mark[index] = at(will.mark, index);
    was.along[index] = at(will.along, index);
    goal.index[index] = to;
    goal.x[index] = at(next.dots.x, to);
    goal.y[index] = at(next.dots.y, to);
    goal.pitch[index] = at(next.dots.pitch, to);
    goal.ink[index] = at(next.dots.ink, to);
    goal.tone[index] = at(next.dots.tone, to);
    goal.presence[index] = at(next.dots.presence, to);
    will.owner[index] = at(next.dots.owner, to);
    will.other[index] = at(next.dots.other, to);
    will.role[index] = at(next.dots.role, to);
    will.mark[index] = at(next.marks, to);
    will.along[index] = at(next.dots.along, to);
  };

  const takeOn = (next: Target, time: number, still: boolean) => {
    // Where the dots go, as seen now, to pair them along a curve: the figure grows into the next rather than scrambling.
    const nextX = new Float32Array(count);
    const nextY = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      if (next.turning) {
        const [vx, vy] = seenBrain(index);
        nextX[index] = vx;
        nextY[index] = vy;
      } else {
        nextX[index] = at(next.dots.x, index);
        nextY[index] = at(next.dots.y, index);
      }
    }
    const pairs = first
      ? null
      : pairAlongCurve({ x, y }, { x: nextX, y: nextY });
    for (let index = 0; index < count; index += 1) {
      const to = pairs ? Math.max(at(pairs, index), 0) : index;
      setOff(index, next, to);
      if (first) {
        gather(index, next, to);
      }
    }
    wasTurning = first ? next.turning : goalTurning;
    goalTurning = next.turning;
    first = false;
    morphAt = still ? -1 : time;
  };

  // The dots on the canvas as they are drawn now, around a point, to hand over: at least DIVE.dots of them, the ones in view again and again, a little apart.
  const handOver = (
    width: number,
    height: number,
    middle: { x: number; y: number }
  ): BrainDots => {
    const seen: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const px = at(sx, index);
      const py = at(sy, index);
      const off = px < -24 || py < -24 || px > width + 24 || py > height + 24;
      if (at(bucket, index) === 0 || off) {
        continue;
      }
      seen.push(index);
    }
    const many = seen.length === 0 ? 0 : Math.max(seen.length, DIVE.dots);
    const dots: BrainDots = {
      count: many,
      x: new Float32Array(many),
      y: new Float32Array(many),
      r: new Float32Array(many),
      alpha: new Float32Array(many),
      heat: new Float32Array(many),
      middle,
    };
    const scatter = seeded(23);
    for (let place = 0; place < many; place += 1) {
      const index = at(seen, place % seen.length);
      const again = place >= seen.length;
      const r = at(radius, index);
      const row = Math.floor(at(bucket, index) / ALPHAS);
      dots.x[place] = at(sx, index) + (again ? (scatter() - 0.5) * r * 3 : 0);
      dots.y[place] = at(sy, index) + (again ? (scatter() - 0.5) * r * 3 : 0);
      dots.r[place] = r * (again ? 0.8 : 1);
      dots.alpha[place] = (at(bucket, index) % ALPHAS) / (ALPHAS - 1);
      // The attention colour hands over as warmth.
      dots.heat[place] = row >= HEATS ? 0.6 : row / (HEATS - 1);
    }
    return dots;
  };

  /** Into a region from the whole brain: the brain turns to face it first, then unfolds. */
  const follow = (state: AtlasLive, time: number, still: boolean) => {
    if (state.target.key === key || state.target.key === waitingFor?.key) {
      return;
    }
    if (!(state.target.turning || !goalTurning || first || still)) {
      waitingFor = state.target;
      waitingSince = time;
      return;
    }
    waitingFor = null;
    ({ key } = state.target);
    takeOn(state.target, time, still);
  };

  /** The brain turns towards what the view wants, the short way round; once it faces a region it is going into, it unfolds. */
  const turnTowards = (time: number, since: number, still: boolean) => {
    const wantTurn = wantedTurn(time, since);
    let yawTo = wantTurn.yaw;
    while (yawTo - turn.yaw > Math.PI) {
      yawTo -= TAU;
    }
    while (yawTo - turn.yaw < -Math.PI) {
      yawTo += TAU;
    }
    const turnEase = still
      ? 1
      : 1 - Math.exp(-since / (waitingFor ? 0.2 : 0.45));
    turn.yaw += (yawTo - turn.yaw) * turnEase;
    turn.pitch += (wantTurn.pitch - turn.pitch) * turnEase;
    if (!waitingFor) {
      return;
    }
    const faces =
      Math.abs(yawTo - turn.yaw) < 0.03 &&
      Math.abs(wantTurn.pitch - turn.pitch) < 0.03;
    if (faces || time - waitingSince > TURN_S) {
      ({ key } = waitingFor);
      takeOn(waitingFor, time, still);
      waitingFor = null;
    }
  };

  /** The camera eases to where the view wants it, with the reader's own panning and zooming on top, except while it goes in on a note. */
  const moveCamera = (
    state: AtlasLive,
    side: number,
    into: number,
    ease: number
  ) => {
    const want = wantedCamera(side);
    const mine = into >= 0 ? 0 : 1;
    cam.x += (want.x + user.x * mine - cam.x) * ease;
    cam.y += (want.y + user.y * mine - cam.y) * ease;
    cam.zoom += (want.zoom * (into >= 0 ? 1 : user.zoom) - cam.zoom) * ease;
    anchor.x += (state.centre - anchor.x) * (anchor.x === 0 ? 1 : ease);
    anchor.y += (state.level - anchor.y) * (anchor.y === 0 ? 1 : ease);
  };

  /** Where a pulse is along its way, on the half of a region that faces you. */
  const pulsePoint = (region: RegionId): [number, number, number] => {
    const halves = regionSides()[REGION_IDS.indexOf(region)] ?? [];
    const [side] = halves.toSorted(
      (a, b) =>
        turnPoint(b.nx, b.ny, b.nz, turn)[2] -
        turnPoint(a.nx, a.ny, a.nz, turn)[2]
    );
    return side ? [side.x, side.y, side.z] : [0, 0, 0];
  };

  /** Seen whole and at rest, the brain fires: a pulse sets off along the next statement's way. */
  const fire = (state: AtlasLive, time: number, still: boolean) => {
    const firing =
      goalTurning &&
      !waitingFor &&
      morphAt < 0 &&
      !still &&
      (state.thinking || state.signals.length > 0);
    // A question sets off at once, not when the next statement was due.
    if (state.thinking !== thought) {
      thought = state.thinking;
      nextPulse = time;
    }
    if (firing && state.thinking && time >= nextPulse) {
      // A question is being answered: it runs up the spine into the brain, again until the answer is there.
      nextPulse = time + THINK_EVERY_S;
      // The stem, where the sources are, is the last region.
      const stem = regionSides()[REGION_IDS.length - 1]?.[0];
      if (stem) {
        pulses.push({
          born: time,
          points: [...SPINE_UP, [stem.x, stem.y, stem.z]],
        });
      }
    } else if (firing && time >= nextPulse) {
      nextPulse = time + PULSE_EVERY_S;
      const path = state.signals[fired % state.signals.length] ?? [];
      fired += 1;
      const points = path.map((region) => pulsePoint(region));
      // What a source heard comes up the spine first.
      if (path[0] === "sources") {
        points.unshift(...SPINE_UP);
      }
      pulses.push({ born: time, points });
    }
    if (!firing) {
      pulses.length = 0;
    }
    while (
      pulses[0] &&
      time - pulses[0].born > (pulses[0].points.length - 1) * PULSE_LEG_S + 0.5
    ) {
      pulses.shift();
    }
  };

  /** Where each pulse is on the brain now, and how strong: it swells as it sets off and fades as it lands. */
  const sparksAt = (time: number): [number, number, number, number][] =>
    pulses.flatMap((pulse) => {
      const legs = pulse.points.length - 1;
      if (legs < 1) {
        return [];
      }
      const along = Math.min((time - pulse.born) / PULSE_LEG_S, legs);
      const leg = Math.min(Math.floor(along), legs - 1);
      const t = along - leg;
      const e = t * t * (3 - 2 * t);
      const a = pulse.points[leg] ?? [0, 0, 0];
      const b = pulse.points[leg + 1] ?? a;
      // Along the surface rather than through the brain: as far out as its two ends.
      const px = a[0] + (b[0] - a[0]) * e;
      const py = a[1] + (b[1] - a[1]) * e;
      const pz = a[2] + (b[2] - a[2]) * e;
      const out =
        (Math.hypot(...a) + (Math.hypot(...b) - Math.hypot(...a)) * e) /
        (Math.hypot(px, py, pz) || 1);
      const life =
        Math.min(1, (time - pulse.born) / 0.3) *
        Math.min(
          1,
          Math.max(0, legs * PULSE_LEG_S + 0.5 - (time - pulse.born)) / 0.5
        );
      return [[px * out, py * out, pz * out, life]];
    });

  /** How far each way out's pinned name is from where the camera shows the end of its fibres; nothing while the camera rests, or goes in on a note. */
  const leanOut = (
    state: AtlasLive,
    inMap: boolean,
    into: number,
    pixels: number
  ) => {
    leans.length = 0;
    if (!(inMap && state.map && state.frame) || into >= 0) {
      return;
    }
    const { frame } = state;
    for (const [index, exit] of state.map.exits.entries()) {
      const pin = state.pins[index];
      if (!pin) {
        continue;
      }
      leans[index] = {
        x:
          pin.x -
          (anchor.x + (frame.x + exit.x * frame.reach - cam.x) * pixels),
        y:
          pin.y -
          (anchor.y - (frame.y + exit.y * frame.reach - cam.y) * pixels),
      };
    }
  };

  /** What is lit this frame, and how. */
  const lightingOf = (
    state: AtlasLive,
    time: number,
    inMap: boolean,
    into: number
  ): Lighting => {
    const lifted =
      !inMap && !waitingFor
        ? (state.hovered.region ?? state.pointed)
        : undefined;
    const liftedIndex = lifted ? REGION_IDS.indexOf(lifted) : -1;
    const wayOut = inMap && into < 0 ? (state.hovered.exit ?? -1) : -1;
    const { focus, wired } = inMap
      ? focusOf(state, into, wayOut)
      : { focus: new Set<number>(), wired: new Set<number>() };
    const pointedAt = inMap ? (state.hovered.neuron ?? state.chosen) : -1;
    // The legend points at one kind of dot: those light up instead, wherever they are.
    const spotMark = into < 0 ? state.spotted : -1;
    // Seen whole with nothing pointed at, the parts that hold what is lit stand out.
    const litParts =
      !inMap && liftedIndex < 0 && spotMark < 0 ? state.litRegions : null;
    const dimming =
      focus.size > 0 ||
      liftedIndex >= 0 ||
      spotMark >= 0 ||
      (litParts !== null && litParts.size > 0);
    return {
      inMap,
      into,
      liftedIndex,
      focus,
      wired,
      wayOut,
      pointedAt,
      spotMark,
      litParts,
      dimming,
      breathe: 0.5 + 0.5 * Math.sin(time * 2.2),
      sparks: sparksAt(time),
    };
  };

  /** How far along its morph a dot is, 0 to 1. */
  const morphed = (index: number, time: number): number => {
    if (morphAt < 0) {
      return 1;
    }
    const t = (time - morphAt - at(delay, index)) / MORPH_S;
    return easeInOut(t);
  };

  /**
   * Where a dot goes now, and how it is shaded there: for the turning brain, its place as turned and
   * shaded as print, fine dots where the light falls, bold in shadow, thinning towards the edge.
   */
  const goalOf = (
    to: number,
    index: number
  ): [number, number, number, number, number, number] => {
    const gx = at(goal.x, index);
    const gy = at(goal.y, index);
    if (!goalTurning) {
      return [gx, gy, 0, at(goal.tone, index), at(goal.ink, index), 1];
    }
    const [vx, vy, vz] = turnPoint(
      at(cloud.x, to),
      at(cloud.y, to),
      at(cloud.z, to),
      turn
    );
    const [nx, ny, nz] = turnPoint(
      at(cloud.nx, to),
      at(cloud.ny, to),
      at(cloud.nz, to),
      turn
    );
    const light = Math.max(nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2], 0);
    const towards = Math.sqrt(Math.max(nz, 0));
    const tone = (0.25 + 0.75 * light) * (0.3 + 0.7 * towards);
    const ink = Math.max(
      (0.08 + 0.92 * (1 - light) ** 1.4) * (0.5 + 0.5 * towards),
      at(goal.ink, index)
    );
    return [vx, vy, vz, tone, ink, nz];
  };

  /** A dot moves along its morph towards its goal; gives back how much of it is there, as its face turns away. */
  const move = (index: number, e: number): number => {
    const to = at(goal.index, index);
    const [gx, gy, gz, gTone, gInk, face] = goalOf(to, index);
    const fx = at(from.x, index);
    const fy = at(from.y, index);
    const bend = Math.sin(Math.PI * e) * 0.05 * (at(seed, index) - 0.5);
    x[index] = fx + (gx - fx) * e - (gy - fy) * bend;
    y[index] = fy + (gy - fy) * e + (gx - fx) * bend;
    z[index] = at(from.z, index) + (gz - at(from.z, index)) * e;
    pitchNow[index] =
      at(from.pitch, index) +
      (at(goal.pitch, index) - at(from.pitch, index)) * e;
    inkNow[index] = at(from.ink, index) + (gInk - at(from.ink, index)) * e;
    toneNow[index] = at(from.tone, index) + (gTone - at(from.tone, index)) * e;
    presenceNow[index] =
      at(from.presence, index) +
      (at(goal.presence, index) - at(from.presence, index)) * e;
    // The far side of the brain never shows through: faces turned away fade out.
    const wasFace = wasTurning ? at(facing, index) : 1;
    const shownFace = goalTurning ? face : 1;
    const turnedAway = wasFace + (shownFace - wasFace) * e;
    if (goalTurning) {
      facing[index] = face;
    }
    return (
      at(presenceNow, index) *
      Math.min(Math.max((turnedAway + 0.08) / 0.3, 0), 1)
    );
  };

  /** What a dot draws: before its morph is half way, what it was; after, what it will be. */
  const drawnAs = (index: number, e: number): Drawn => {
    const kind = e >= 0.5 ? will : was;
    return {
      role: at(kind.role, index),
      owner: at(kind.owner, index),
      other: at(kind.other, index),
      mark: at(kind.mark, index),
      along: at(kind.along, index),
      goal: at(goal.index, index),
    };
  };

  /** Where a dot is on screen; a fibre to a way out ends on its name, which is pinned: the further along it, the more it leans there, whatever the camera does. */
  const project = (
    index: number,
    drawn: Drawn,
    e: number,
    pixels: number,
    time: number,
    still: boolean
  ): number => {
    const perspective = DISTANCE / Math.max(DISTANCE - at(z, index), NEAREST);
    sx[index] =
      anchor.x +
      (at(x, index) * perspective - cam.x) * pixels +
      (still ? 0 : 0.6 * Math.sin(time * 1.3 + at(y, index) * 9));
    sy[index] = anchor.y - (at(y, index) * perspective - cam.y) * pixels;
    if (drawn.role === AXON && drawn.other <= -2) {
      const lean = leans[-2 - drawn.other];
      if (lean) {
        sx[index] = at(sx, index) + lean.x * drawn.along * e;
        sy[index] = at(sy, index) + lean.y * drawn.along * e;
      }
    }
    return perspective;
  };

  /** A pulse passing warms the dots near it. */
  const warmth = (to: number, sparks: Lighting["sparks"]): number => {
    let heat = -1;
    for (const [px, py, pz, life] of sparks) {
      const d2 =
        (at(cloud.x, to) - px) ** 2 +
        (at(cloud.y, to) - py) ** 2 +
        (at(cloud.z, to) - pz) ** 2;
      if (d2 > PULSE_REACH * PULSE_REACH * 4) {
        continue;
      }
      heat = Math.max(heat, life * Math.exp(-d2 / (PULSE_REACH * PULSE_REACH)));
    }
    return heat;
  };

  /** How inked and how warm a dot is, lit, dimmed, or neither: lit dots swell, the rest step back while something is lit. */
  const shade = (
    drawn: Drawn,
    ink: number,
    glow: boolean,
    light: Lighting,
    time: number,
    still: boolean
  ): [number, number] => {
    const { role, mark, along } = drawn;
    const attention = mark === OPEN_MARK;
    let alpha = baseAlpha(mark, role, ink, still, light.breathe);
    let heat = 0;
    const fibre = role === AXON || role === SYNAPSE;
    if (glow) {
      // Lit is bolder ink, never a colour: the attention colour alone says something is open. Only a signal on its way along a fibre is warm.
      alpha = Math.max(alpha, role === SURFACE ? 0.7 : 0.5 + 0.45 * ink);
      if (!(attention || still) && fibre) {
        heat = 0.9 * Math.exp(-(((along - ((time * 0.6) % 1.4)) / 0.08) ** 2));
      }
    } else if (fibre) {
      // Every link is always there, so a region reads as connected; lighter while another is pointed at, and on the whole brain, where they are its folds.
      alpha *= linkAlpha(light);
    } else if (light.dimming) {
      alpha *= dimmedBy(light, role, attention);
    }
    if (
      light.sparks.length > 0 &&
      role === SURFACE &&
      !attention &&
      mark !== WAITING
    ) {
      const warm = warmth(drawn.goal, light.sparks);
      if (warm >= 0) {
        heat = Math.max(heat, warm);
        alpha = Math.max(alpha, 0.35 + 0.5 * warm);
      }
    }
    return [alpha, heat];
  };

  /** One dot this frame: where it is, how large, and the colour it prints in. Gives back that colour's bucket. */
  const place = (
    index: number,
    e: number,
    time: number,
    still: boolean,
    pixels: number,
    fade: number,
    light: Lighting
  ): number => {
    const there = move(index, e);
    const drawn = drawnAs(index, e);
    hollow[index] = 0;
    if (there < 0.02) {
      inked[index] = 0;
      return 0;
    }
    const perspective = project(index, drawn, e, pixels, time, still);
    const glow = glowsOf(drawn, light);
    const ink = at(inkNow, index);
    const [alpha, heat] = shade(drawn, ink, glow, light, time, still);
    inked[index] =
      at(inked, index) + (alpha * Math.min(there, 1) - at(inked, index)) * fade;
    swell[index] =
      at(swell, index) + ((glow ? 1.25 : 1) - at(swell, index)) * fade;
    const shown = at(inked, index);
    const own = 0.55 + 0.9 * at(grain, index);
    const print = at(pitchNow, index) * pixels * perspective;
    const waiting = drawn.mark === WAITING;
    if (waiting && drawn.role === SURFACE) {
      // Hollow: a ring the same size everywhere, so what is still waiting reads at a glance.
      hollow[index] = 1;
      radius[index] = Math.max(1.6, print * 0.3) * at(swell, index);
    } else {
      radius[index] =
        print * partOf(waiting, drawn.role, ink, own) * at(swell, index);
    }
    const a = Math.min(
      ALPHAS - 1,
      Math.max(0, Math.round(shown * (ALPHAS - 1)))
    );
    const row =
      drawn.mark === OPEN_MARK
        ? HEATS
        : Math.min(HEATS - 1, Math.round(heat * (HEATS - 1)));
    return a === 0 ? 0 : row * ALPHAS + a;
  };

  /** The dots of one colour, from `k` in the order; gives back where the next colour starts. */
  const paintBucket = (b: number, start: number, many: number): number => {
    let ringed = 0;
    const style = styles[b] ?? "transparent";
    context.fillStyle = style;
    context.beginPath();
    const end = start + many;
    for (let k = start; k < end; k += 1) {
      const index = at(order, k);
      const r = at(radius, index);
      const px = at(sx, index);
      const py = at(sy, index);
      if (at(hollow, index) === 1) {
        rings[ringed] = index;
        ringed += 1;
      } else if (r < 0.7) {
        context.rect(px - r, py - r, r * 2, r * 2);
      } else {
        context.moveTo(px + r, py);
        context.arc(px, py, r, 0, TAU);
      }
    }
    context.fill();
    if (ringed === 0) {
      return end;
    }
    context.strokeStyle = style;
    context.beginPath();
    for (let ring = 0; ring < ringed; ring += 1) {
      const index = at(rings, ring);
      context.moveTo(at(sx, index) + at(radius, index), at(sy, index));
      context.arc(at(sx, index), at(sy, index), at(radius, index), 0, TAU);
    }
    context.stroke();
    return end;
  };

  /** Every dot, one path per colour; hollow ones as rings. */
  const paint = (width: number, height: number) => {
    context.clearRect(0, 0, width, height);
    let offset = 0;
    for (let b = 0; b < counts.length; b += 1) {
      starts[b] = offset;
      offset += at(counts, b);
    }
    for (let index = 0; index < count; index += 1) {
      const b = at(bucket, index);
      order[at(starts, b)] = index;
      starts[b] = at(starts, b) + 1;
    }
    context.lineWidth = 1;
    let k = 0;
    for (let b = 0; b < counts.length; b += 1) {
      const many = at(counts, b);
      if (many > 0 && b % ALPHAS === 0) {
        k += many;
      } else if (many > 0) {
        k = paintBucket(b, k, many);
      }
    }
  };

  /** Where the neurons are on screen, for the pointer and their names. */
  const placeNeurons = (state: AtlasLive, inMap: boolean, pixels: number) => {
    neurons.x.length = 0;
    neurons.y.length = 0;
    neurons.r.length = 0;
    if (!(inMap && state.map && state.frame)) {
      return;
    }
    const { frame } = state;
    for (const neuron of state.map.neurons) {
      neurons.x.push(
        anchor.x + (frame.x + neuron.x * frame.reach - cam.x) * pixels
      );
      neurons.y.push(
        anchor.y - (frame.y + neuron.y * frame.reach - cam.y) * pixels
      );
      neurons.r.push(neuron.r * frame.reach * pixels);
    }
  };

  /** Inside a region, the small brain: the region you are in dark, the one under the pointer warmer, the rest faint. */
  const paintMini = (state: AtlasLive, map: NeuronMap, wayOut: number) => {
    const here = REGION_IDS.indexOf(map.region);
    const { mini: onMini } = state.hovered;
    let pointedRegion = -1;
    if (onMini && onMini !== "whole") {
      pointedRegion = REGION_IDS.indexOf(onMini);
    } else if (wayOut >= 0) {
      pointedRegion = REGION_IDS.indexOf(
        map.exits[wayOut]?.region ?? map.region
      );
    }
    // Darker too: the other parts that hold what is lit, as when an answer drew on them.
    const marked = (region: number) =>
      region === pointedRegion || state.litRegions.has(region);
    const layers: [string, (region: number) => boolean][] = [
      [styles[4] ?? "", (region) => region !== here && !marked(region)],
      [styles[8] ?? "", (region) => marked(region) && region !== here],
      [styles[ALPHAS - 1] ?? "", (region) => region === here],
    ];
    for (const [style, pick] of layers) {
      context.fillStyle = style;
      context.beginPath();
      for (const dot of mini) {
        if (!pick(dot.region)) {
          continue;
        }
        const mx = state.miniX + dot.x * MINI.scale;
        const my = MINI.y - dot.y * MINI.scale;
        context.moveTo(mx + 1, my);
        context.arc(mx, my, 1, 0, TAU);
      }
      context.fill();
    }
  };

  /** Where a region's name sits: over the side of it that faces you most, a little off its surface. */
  const regionLabel = (id: RegionId, pixels: number): [number, number] => {
    const index = REGION_IDS.indexOf(id);
    let best = -Infinity;
    let lx = 0;
    let ly = 0;
    for (const side of regionSides()[index] ?? []) {
      const { 2: nz } = turnPoint(side.nx, side.ny, side.nz, turn);
      if (nz <= best) {
        continue;
      }
      best = nz;
      const [vx, vy, vz] = turnPoint(
        side.x + side.nx * 0.14,
        side.y + side.ny * 0.14,
        side.z + side.nz * 0.14,
        turn
      );
      const perspective = DISTANCE / Math.max(DISTANCE - vz, NEAREST);
      lx = anchor.x + (vx * perspective - cam.x) * pixels;
      ly = anchor.y - (vy * perspective - cam.y) * pixels;
    }
    return [lx, ly];
  };

  /** Where one name over the canvas goes, and whether it shows. */
  const overlayAt = (
    id: string,
    overlay: HTMLElement,
    state: AtlasLive,
    inMap: boolean,
    ready: boolean,
    pixels: number
  ): [number, number, boolean] => {
    if (id.startsWith("region:")) {
      if (!goalTurning || waitingFor) {
        return [0, 0, false];
      }
      const region = id.slice(7);
      if (!isRegion(region)) {
        return [0, 0, false];
      }
      const [lx, ly] = regionLabel(region, pixels);
      return [lx, ly, ready];
    }
    if (!inMap) {
      return [0, 0, false];
    }
    if (id.startsWith("neuron:") && state.frame) {
      const index = Number(id.slice(7));
      // An open question says what it asks only when pointed at: until then its colour says enough, and in hand its card does.
      const asks =
        overlay.dataset.quiet !== "true" ||
        (state.hovered.neuron === index && state.chosen !== index);
      return [
        neurons.x[index] ?? 0,
        (neurons.y[index] ?? 0) + (neurons.r[index] ?? 0) + 7,
        ready && asks,
      ];
    }
    if (id.startsWith("exit:")) {
      // A way out stays where it is pinned, whatever the camera does.
      const pin = state.pins[Number(id.slice(5))];
      return pin ? [pin.x, pin.y, ready] : [0, 0, false];
    }
    const group = state.map?.groups[Number(id.slice(6))];
    if (id.startsWith("group:") && state.frame && group) {
      return [
        anchor.x +
          (state.frame.x + group.x * state.frame.reach - cam.x) * pixels,
        anchor.y -
          (state.frame.y + group.y * state.frame.reach - cam.y) * pixels,
        ready,
      ];
    }
    return [0, 0, false];
  };

  /** Names follow what they name, on the side of the brain that faces you; they show once the figure has come together, and step aside while the camera goes in on a note. */
  const placeOverlays = (
    state: AtlasLive,
    inMap: boolean,
    ready: boolean,
    pixels: number,
    width: number,
    height: number
  ) => {
    const placed: {
      overlay: HTMLElement;
      x: number;
      y: number;
      width: number;
      height: number;
    }[] = [];
    for (const [id, overlay] of overlays) {
      const [lx, ly, shown] = overlayAt(
        id,
        overlay,
        state,
        inMap,
        ready,
        pixels
      );
      overlay.dataset.shown = shown ? "true" : "false";
      if (id.startsWith("region:") && shown) {
        placed.push({
          overlay,
          x: lx,
          y: ly,
          width: overlay.firstElementChild?.clientWidth ?? 80,
          height: overlay.firstElementChild?.clientHeight ?? 24,
        });
      } else {
        overlay.style.transform = `translate(${Math.round(lx)}px, ${Math.round(ly)}px)`;
      }
    }
    spread(placed, width, height);
  };

  /** The canvas takes the size it is shown at, sharp on a dense screen. */
  const fit = (width: number, height: number) => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (
      element.width !== Math.round(width * dpr) ||
      element.height !== Math.round(height * dpr)
    ) {
      element.width = Math.round(width * dpr);
      element.height = Math.round(height * dpr);
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  /** A new view lets go of the reader's own panning and zooming. */
  const viewChanged = (view: AtlasView) => {
    const viewKey = `${view.region ?? ""}|${view.note ?? ""}`;
    if (user.view === viewKey) {
      return;
    }
    user.view = viewKey;
    user.x = 0;
    user.y = 0;
    user.zoom = 1;
  };

  /** When the camera set off into a note; nothing while it goes in on none. */
  const diving = (into: number, time: number) => {
    if (into < 0) {
      diveAt = -1;
      handed = false;
    } else if (diveAt < 0) {
      diveAt = time;
    }
  };

  /** Every dot this frame, counted by colour; once every morph has settled, the figure rests. */
  const placeAll = (
    time: number,
    still: boolean,
    pixels: number,
    fade: number,
    light: Lighting
  ) => {
    let settled = true;
    counts.fill(0);
    for (let index = 0; index < count; index += 1) {
      const e = morphed(index, time);
      if (e < 1) {
        settled = false;
      }
      const b = place(index, e, time, still, pixels, fade, light);
      bucket[index] = b;
      counts[b] = at(counts, b) + 1;
    }
    if (settled && morphAt >= 0) {
      morphAt = -1;
      wasTurning = goalTurning;
      idleSince = time;
    }
  };

  /** The camera is in on the note: its dots are handed over, once. */
  const handOverOnce = (
    state: AtlasLive,
    into: number,
    time: number,
    width: number,
    height: number
  ) => {
    if (into < 0 || handed || time - diveAt < DIVE.seconds) {
      return;
    }
    handed = true;
    state.onDived(
      handOver(width, height, {
        x: neurons.x[into] ?? width / 2,
        y: neurons.y[into] ?? height / 2,
      })
    );
  };

  const draw = (ms: number) => {
    raf = requestAnimationFrame(draw);
    const time = ms / 1000;
    const since = then < 0 ? 1 / 60 : Math.min(time - then, 0.1);
    then = time;
    const state = latest.current;
    const still = state.reduce;
    const width = element.clientWidth;
    const height = element.clientHeight;
    if (width === 0 || height === 0) {
      return;
    }
    fit(width, height);
    viewChanged(state.view);
    follow(state, time, still);

    const inMap = !goalTurning && Boolean(state.map && state.frame);
    const into = inMap ? state.diving : -1;
    diving(into, time);

    const ease = still ? 1 : 1 - Math.exp(-since / (into >= 0 ? 0.13 : 0.38));
    const fade = still ? 1 : 1 - Math.exp(-since / 0.16);
    turnTowards(time, since, still);
    moveCamera(state, Math.min(width, height), into, ease);
    const pixels = state.scale * cam.zoom;

    fire(state, time, still);
    const light = lightingOf(state, time, inMap, into);
    leanOut(state, inMap, into, pixels);

    placeAll(time, still, pixels, fade, light);
    paint(width, height);
    placeNeurons(state, inMap, pixels);
    handOverOnce(state, into, time, width, height);
    const ready = (morphAt < 0 || time - morphAt > MORPH_S * 0.75) && into < 0;
    if (inMap && ready && state.map) {
      paintMini(state, state.map, light.wayOut);
    }
    placeOverlays(state, inMap, ready, pixels, width, height);
  };
  raf = requestAnimationFrame(draw);

  /** On the small brain: the region under the pointer, or the whole brain beside it. */
  const overMini = (px: number, py: number, miniX: number): Over => {
    let nearest = -1;
    let distance = MINI.near * MINI.near;
    for (const [index, dot] of mini.entries()) {
      const d =
        (miniX + dot.x * MINI.scale - px) ** 2 +
        (MINI.y - dot.y * MINI.scale - py) ** 2;
      if (d < distance) {
        distance = d;
        nearest = index;
      }
    }
    const region = mini[nearest]?.region;
    return {
      mini: region === undefined ? "whole" : (REGION_IDS[region] ?? "whole"),
    };
  };

  // The pointer: what it is over; dragging turns the brain, or pans a map; scrolling zooms around it.
  const over = (px: number, py: number): Over => {
    const state = latest.current;
    if (!goalTurning && state.map) {
      for (const [index, nx] of neurons.x.entries()) {
        const near =
          Math.hypot(nx - px, (neurons.y[index] ?? 0) - py) <=
          (neurons.r[index] ?? 0) + NEAR * 0.5;
        if (near) {
          return { neuron: index };
        }
      }
      const onMini =
        Math.abs(px - state.miniX) < MINI.scale * 1.5 &&
        Math.abs(py - MINI.y) < MINI.scale * 1.2;
      return onMini ? overMini(px, py, state.miniX) : {};
    }
    let best = -1;
    let distance = NEAR * NEAR;
    for (let index = 0; index < count; index += 1) {
      const hidden =
        at(bucket, index) === 0 ||
        at(will.role, index) !== SURFACE ||
        at(facing, index) < 0.1;
      if (hidden) {
        continue;
      }
      const d = (at(sx, index) - px) ** 2 + (at(sy, index) - py) ** 2;
      if (d < distance) {
        distance = d;
        best = index;
      }
    }
    const region = best >= 0 ? REGION_IDS[at(will.owner, best)] : undefined;
    return region ? { region } : {};
  };

  /** Dragging turns the brain, as if by hand; or pans a map. */
  const drag = (dx: number, dy: number) => {
    if (goalTurning) {
      user.yaw += dx * 0.008;
      user.pitch += dy * 0.006;
      turn.yaw += dx * 0.008;
      turn.pitch = Math.max(-0.9, Math.min(0.9, turn.pitch + dy * 0.006));
      return;
    }
    const scaled = latest.current.scale * cam.zoom;
    user.x -= dx / scaled;
    user.y += dy / scaled;
    cam.x -= dx / scaled;
    cam.y += dy / scaled;
  };

  const cursorFor = (found: Over): string => {
    if (pointer.dragged) {
      return "grabbing";
    }
    return found.region || found.neuron !== undefined || found.mini
      ? "pointer"
      : "grab";
  };

  const onMove = (event: PointerEvent) => {
    const bounds = element.getBoundingClientRect();
    const px = event.clientX - bounds.left;
    const py = event.clientY - bounds.top;
    if (pointer.down) {
      if (Math.hypot(px - pointer.startX, py - pointer.startY) > 4) {
        pointer.dragged = true;
      }
      if (pointer.dragged) {
        drag(px - pointer.x, py - pointer.y);
      }
    }
    pointer.x = px;
    pointer.y = py;
    idleSince = performance.now() / 1000;
    const found = pointer.dragged ? {} : over(px, py);
    const current = latest.current.under;
    const changed =
      found.region !== current.region ||
      found.neuron !== current.neuron ||
      found.mini !== current.mini;
    if (changed) {
      setUnder(found);
    }
    element.style.cursor = cursorFor(found);
  };

  const onDown = (event: PointerEvent) => {
    const bounds = element.getBoundingClientRect();
    pointer.down = true;
    pointer.dragged = false;
    pointer.startX = event.clientX - bounds.left;
    pointer.startY = event.clientY - bounds.top;
    pointer.x = pointer.startX;
    pointer.y = pointer.startY;
    element.setPointerCapture(event.pointerId);
  };

  /** A click: a region goes in, a neuron is chosen; on the small brain, another part goes there, and the part you are in, or the brain beside its parts, goes back to the whole. */
  const click = () => {
    const state = latest.current;
    if (state.diving >= 0) {
      return;
    }
    const found = over(pointer.x, pointer.y);
    if (found.region) {
      state.onGo({ region: found.region });
    } else if (found.neuron !== undefined) {
      state.choose(found.neuron);
    } else if (
      found.mini !== undefined &&
      (found.mini === "whole" || found.mini === state.view.region)
    ) {
      state.onGo({});
    } else if (found.mini !== undefined) {
      state.onGo({ region: found.mini });
    } else if (state.view.note !== undefined) {
      state.onGo({ region: state.view.region });
    }
  };

  const onUp = (event: PointerEvent) => {
    if (!pointer.down) {
      return;
    }
    pointer.down = false;
    element.releasePointerCapture(event.pointerId);
    idleSince = performance.now() / 1000;
    if (!pointer.dragged) {
      click();
    }
  };

  const onLeave = () => {
    if (!pointer.down) {
      setUnder({});
    }
  };

  /** The zoom the reader may take, around what the view puts: a little out, a little more in. */
  const zoomed = (factor: number): { base: number; next: number } => {
    const base = wantedCamera().zoom;
    return {
      base,
      next: Math.min(Math.max(cam.zoom * factor, base * 0.6), base * 2.2),
    };
  };

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const state = latest.current;
    if (state.diving >= 0) {
      return;
    }
    const bounds = element.getBoundingClientRect();
    const px = event.clientX - bounds.left;
    const py = event.clientY - bounds.top;
    const { base, next } = zoomed(Math.exp(-event.deltaY * 0.0015));
    // Keep the point under the pointer where it is.
    const scaled = state.scale * cam.zoom;
    const wx = cam.x + (px - anchor.x) / scaled;
    const wy = cam.y - (py - anchor.y) / scaled;
    const after = state.scale * next;
    const nx = wx - (px - anchor.x) / after;
    const ny = wy + (py - anchor.y) / after;
    user.x += nx - cam.x;
    user.y += ny - cam.y;
    user.zoom *= next / cam.zoom;
    cam.x = nx;
    cam.y = ny;
    cam.zoom = next;
    idleSince = performance.now() / 1000;
    // Far enough out of a region, it is left; far enough into a part of the brain, it opens.
    if (state.view.region && next < base * 0.72) {
      state.onGo({});
      return;
    }
    if (!state.view.region && next > base * 1.7) {
      const found = over(px, py);
      if (found.region) {
        state.onGo({ region: found.region });
      }
    }
  };

  const controls: AtlasControls = {
    zoom: (factor) => {
      const { base, next } = zoomed(factor);
      user.zoom *= next / cam.zoom;
      idleSince = performance.now() / 1000;
      if (latest.current.view.region && next < base * 0.72) {
        latest.current.onGo({});
      }
    },
    reset: () => {
      user.x = 0;
      user.y = 0;
      user.zoom = 1;
      user.yaw = 0;
      user.pitch = 0;
    },
  };
  element.addEventListener("pointermove", onMove);
  element.addEventListener("pointerdown", onDown);
  element.addEventListener("pointerup", onUp);
  element.addEventListener("pointerleave", onLeave);
  element.addEventListener("wheel", onWheel, { passive: false });

  return {
    controls,
    stop: () => {
      cancelAnimationFrame(raf);
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerdown", onDown);
      element.removeEventListener("pointerup", onUp);
      element.removeEventListener("pointerleave", onLeave);
      element.removeEventListener("wheel", onWheel);
      themes.disconnect();
      media.removeEventListener("change", repaint);
    },
  };
};
