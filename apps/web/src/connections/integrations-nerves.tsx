import { useEffect, useRef } from "react";

import {
  ALPHAS,
  bucketOf,
  HEATS,
  LOOK,
  MORPH_S,
  palette,
  SPREAD_S,
} from "../brain/dot-ink.ts";
import { dotShape, PITCH } from "../brain/dot-shapes.ts";
import { seeded } from "../brain/reveal-motion.ts";

// The life in the Integrations banner, ported one to one from the
// prototype (grasplabs/prototype, packages/grasp:
// components/integrations-nerves.tsx). The numbers, the seeds and the order
// the random numbers are drawn in are the prototype's, so the fibres lie
// where they lie there.

const TAU = Math.PI * 2;
/** How many fibres the brain takes at most: a connection past that gets none. */
export const LINES = 25;
/** How large the brain is at most, in pixels, and how much of the banner's height it may take. */
const BRAIN = { most: 168, share: 0.98 };
/** How far the brain turns to either side, and how slowly. */
const TURN = { far: 0.3, speed: 0.33 };
/** A fibre, thick or thin: the room between its dots, how large they are, and how bold it prints at least and at most. */
const THICK = { gap: 5.5, dot: 0.95, ink: [0.2, 0.36] } as const;
const THIN = { gap: 4, dot: 0.6, ink: [0.14, 0.26] } as const;
/** How fast a fibre's dots creep towards the brain in pixels a second, how long it takes to grow in and to draw back, how far beyond the edge it starts, how far it bends off the straight line in its own length, and how far it sways, in pixels. */
const FIBRE = {
  creep: 9,
  grow: 1.8,
  leave: 0.9,
  beyond: 16,
  bend: 0.2,
  sway: 7,
};
/** The brain as the fibres meet it: half its width and height, in its size. A fibre fades out as it nears that, between these shares of it, so its end only touches the brain's edge. */
const INSIDE = { across: 0.39, high: 0.3, fade: [0.94, 1.4] } as const;
/** A signal: how long a fibre waits between two at least and at most, how fast one runs in pixels a second, and how far its warmth reaches at least and at most. */
const SIGNAL = {
  wait: [0.5, 5],
  speed: [130, 320],
  reach: [10, 24],
} as const;
/** Where a signal comes in, the brain warms: this far around, in the brain's size, for this long. */
const GLOW = { around: 0.3, seconds: 1 };
/**
 * A fibre for an app that was just connected, made to catch the eye: how long it waits once it can
 * be seen, how long it takes to grow in, how long its bright head is in pixels, how many sparks
 * fly around the head and how far, how long it stays warm after it touched, and how wide and how
 * long the brain lights up where it did.
 */
const ARRIVE = {
  wait: 0.45,
  grow: 2.6,
  head: 46,
  sparks: 9,
  scatter: 22,
  cool: 2.4,
  around: 0.75,
  seconds: 2.2,
};
/** A fibre whose app needs signing in again: it beats twice and rests, this often in seconds; how much larger its dots are; and how near the pointer has to come to have it in hand, in pixels. */
const HELP = { every: 1.7, swell: 1.7, near: 14 };
/** How far from the pointer dots swell and warm. */
const NEAR = 70;

/** A connection as the banner draws it: a fibre into the brain. */
export interface NerveLine {
  id: string;
  /** It needs someone to sign in again: its fibre glows whole, and leads to the app. */
  attention: boolean;
}

/** Where on the banner a fibre was taken in hand, in pixels from its top left. */
export interface NervePlace {
  x: number;
  y: number;
}

type Edge = "left" | "right" | "top" | "bottom";

/** A place a fibre can take, the same in every size of banner: which edge it starts beyond and how far along it, and everything that makes it its own. */
interface Slot {
  edge: Edge;
  /** Along the edge, 0 to 1; from above and below, how far out from the brain. */
  at: number;
  /** Left of the brain, or right of it. */
  left: boolean;
  thin: boolean;
  /** How it bends, how far off its aim it comes in, how deep it aims, how bold it prints, and its own place in time; each 0 to 1. */
  bend: number;
  back: number;
  aim: number;
  deep: number;
  ink: number;
  seed: number;
}

/** The four points of a curve, x and y each. */
type Curve = [number, number, number, number, number, number, number, number];

interface Fibre {
  id: string;
  /** Which of `SLOTS` it takes, and that place. */
  slot: number;
  place: Slot;
  attention: boolean;
  /** The four points of its curve as it lies at rest, from beyond the edge to inside the brain. */
  curve: Curve;
  length: number;
  /** Which way it sways, across its own line. */
  nx: number;
  ny: number;
  /** How far along it its end is: where it touches the brain. */
  end: number;
  /** When it began to grow in, and when it began to draw back, if it has. */
  born: number;
  leaving?: number;
  /** Its app was connected while the page was open: it arrives with a show. When it touched the brain, once it has. */
  fresh: boolean;
  touched?: number;
  /** When its next signal sets off. */
  next: number;
}

/** How a fibre is printed this frame, beside where it lies. */
interface Print {
  fibre: Fibre;
  grown: number;
  afterglow: number;
  running: { where: number; reach: number; strength: number }[];
}

interface Signal {
  fibre: Fibre;
  born: number;
  speed: number;
  reach: number;
  strength: number;
}

interface Glow {
  x: number;
  y: number;
  at: number;
  strength: number;
  around: number;
  seconds: number;
}

const between = ([least, most]: readonly [number, number], at: number) =>
  least + (most - least) * at;

const ease = (t: number): number => {
  if (t <= 0) {
    return 0;
  }
  if (t >= 1) {
    return 1;
  }
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
};

const fraction = (value: number) => value - Math.floor(value);

/** A point on a curve of four points, `t` of the way along. */
const along = (curve: Curve, t: number): [number, number] => {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [
    a * curve[0] + b * curve[2] + c * curve[4] + d * curve[6],
    a * curve[1] + b * curve[3] + c * curve[5] + d * curve[7],
  ];
};

/** The edge a fibre from above or below starts beyond, by its turn among them. */
const aboveOrBelow = (turn: number): Edge =>
  turn % 4 === 0 || turn % 4 === 3 ? "top" : "bottom";

/** The places, in the order they are taken: by turns left and right, most from the sides and two in five thin from above or below, so a few fibres already stand around the brain evenly and more fill in between. */
const placeSlots = (): Slot[] => {
  const chance = seeded(11);
  let sides = 0;
  let aboves = 0;
  return Array.from({ length: LINES }, (_, index): Slot => {
    const own = {
      bend: chance(),
      back: chance(),
      aim: chance(),
      deep: chance(),
      ink: chance(),
      seed: chance(),
    };
    if (index % 5 === 2 || index % 5 === 4) {
      const turn = aboves;
      aboves += 1;
      return {
        edge: aboveOrBelow(turn),
        left: turn % 2 === 0,
        at: fraction((turn + 0.5) * 0.618),
        thin: true,
        ...own,
      };
    }
    const turn = sides;
    sides += 1;
    return {
      edge: turn % 2 === 0 ? "left" : "right",
      left: turn % 2 === 0,
      at: fraction((Math.floor(turn / 2) + 0.5 + (turn % 2) * 0.31) * 0.618),
      thin: chance() < 0.3,
      ...own,
    };
  });
};
const SLOTS = placeSlots();

/** The first place no fibre takes. */
const firstFree = (fibres: readonly Fibre[]): number =>
  SLOTS.findIndex((_, index) => !fibres.some((fibre) => fibre.slot === index));

/** Where a fibre starts, beyond its edge of a banner `width` by `height` with a brain `size` across. */
const startOf = (
  slot: Slot,
  width: number,
  height: number,
  size: number
): [number, number] => {
  const cx = width / 2;
  const side = slot.left ? 1 : -1;
  // From above and below it starts well to the side of the brain, which leaves no room over it.
  const out = size * 0.75 + slot.at * Math.max(40, cx - 20 - size * 0.75);
  if (slot.edge === "left") {
    return [-FIBRE.beyond, height * (0.05 + 0.9 * slot.at)];
  }
  if (slot.edge === "right") {
    return [width + FIBRE.beyond, height * (0.05 + 0.9 * slot.at)];
  }
  return [
    cx - side * out,
    slot.edge === "top" ? -FIBRE.beyond : height + FIBRE.beyond,
  ];
};

/** Lays a fibre in its place, in a banner `width` by `height` with a brain `size` across. */
const lay = (fibre: Fibre, width: number, height: number, size: number) => {
  const slot = fibre.place;
  const cx = width / 2;
  const cy = height / 2;
  const [x, y] = startOf(slot, width, height, size);
  // One from the side comes in as high on the brain as it started on the edge, so they do not all meet in one place.
  const high = ((y - cy) / cy) * 1.1;
  const fromSide = slot.edge === "left" || slot.edge === "right";
  let angle = Math.atan2((y - cy) / INSIDE.high, (x - cx) / INSIDE.across);
  if (fromSide) {
    angle = slot.left ? Math.PI - high : high;
  }
  angle += (slot.aim - 0.5) * (fromSide ? 0.4 : 0.9);
  const deep = 0.25 + 0.3 * slot.deep;
  const ex = cx + Math.cos(angle) * size * INSIDE.across * deep;
  const ey = cy + Math.sin(angle) * size * INSIDE.high * deep;
  const far = Math.hypot(ex - x, ey - y);
  const nx = -(ey - y) / far;
  const ny = (ex - x) / far;
  const first = (slot.bend - 0.5) * 2 * FIBRE.bend * far;
  // Now and then it bends back the other way: an S.
  const second = (slot.back < 0.4 ? -first : first) * (0.3 + 0.7 * slot.back);
  const curve: Curve = [
    x,
    y,
    x + (ex - x) * 0.33 + nx * first,
    y + (ey - y) * 0.33 + ny * first,
    x + (ex - x) * 0.7 + nx * second,
    y + (ey - y) * 0.7 + ny * second,
    ex,
    ey,
  ];
  let length = 0;
  let [px, py] = [x, y];
  for (let step = 1; step <= 24; step += 1) {
    const [qx, qy] = along(curve, step / 24);
    length += Math.hypot(qx - px, qy - py);
    px = qx;
    py = qy;
  }
  // It is aimed at a point inside the brain, and ends where it meets the brain's edge.
  const inside = (t: number) => {
    const [ix, iy] = along(curve, t);
    return Math.hypot(
      (ix - cx) / (size * INSIDE.across),
      (iy - cy) / (size * INSIDE.high)
    );
  };
  let end = 1;
  while (end > 0.5 && inside(end) < INSIDE.fade[0]) {
    end -= 0.01;
  }
  Object.assign(fibre, { curve, length, nx, ny, end });
};

/** How far a fibre has grown in, 0 to 1, at `age`: it grows in from the edge, and stays until its app is disconnected; then it draws back. */
const grownOf = (fibre: Fibre, age: number, still: boolean): number => {
  if (still) {
    return 1;
  }
  if (fibre.leaving !== undefined) {
    return 1 - ease((age - fibre.leaving) / FIBRE.leave);
  }
  const arriving = fibre.fresh;
  return ease((age - fibre.born) / (arriving ? ARRIVE.grow : FIBRE.grow));
};

/** How warm a fibre just connected still is, 0 to 1: whole until it touched the brain, then cooling. */
const afterglowOf = (fibre: Fibre, arriving: boolean, age: number): number => {
  if (!arriving || fibre.leaving !== undefined) {
    return 0;
  }
  if (fibre.touched === undefined) {
    return 1;
  }
  return Math.max(0, 1 - (age - fibre.touched) / ARRIVE.cool) ** 1.5;
};

/** How warm a fibre whose app needs signing in again is: it beats twice and rests; in hand it is at its warmest. */
const helpOf = (
  fibre: Fibre,
  held: string | null,
  age: number,
  still: boolean
): number => {
  if (!fibre.attention) {
    return 0;
  }
  if (fibre.id === held) {
    return 1;
  }
  const beat = still ? 0.5 : (age % HELP.every) / HELP.every;
  return (
    0.5 +
    0.5 *
      Math.max(
        Math.exp(-(((beat - 0.12) / 0.07) ** 2)),
        Math.exp(-(((beat - 0.34) / 0.07) ** 2)),
        still ? 0.6 : 0
      )
  );
};

/** What the drawing reads from the page each frame. */
interface Latest {
  lines: NerveLine[];
  onHold: (id: string | null, at?: NervePlace) => void;
  onOpen: (id: string) => void;
}

/** One printed dot of the brain, and what it has of its own. */
interface BrainDot {
  x: number;
  y: number;
  z: number;
  ink: number;
  tone: number;
  seed: number;
  grain: number;
  delay: number;
  lift: number;
  fx: number;
  fy: number;
  fz: number;
}

/** The brain, and of its points only the ones it prints; each with its own grain, delay, lift and place in the cloud it gathers from. */
const brainDots = (): BrainDot[] => {
  const shape = dotShape({ kind: "brain" });
  const random = seeded(7);
  const dots: BrainDot[] = [];
  for (const [index, presence] of shape.presence.entries()) {
    if (presence > 0) {
      const angle = random() * TAU;
      const far = Math.sqrt(random()) * 0.4;
      dots.push({
        x: shape.position[index * 3] ?? 0,
        y: shape.position[index * 3 + 1] ?? 0,
        z: shape.position[index * 3 + 2] ?? 0,
        ink: shape.ink[index] ?? 0,
        tone: shape.tone[index] ?? 0,
        seed: random(),
        grain: random() ** 2,
        delay: random() * SPREAD_S,
        lift: 0.12 + random() * 0.4,
        fx: Math.cos(angle) * far,
        fy: Math.sin(angle) * far,
        fz: (random() - 0.5) * 0.3,
      });
    }
  }
  return dots;
};

/** Runs the banner's drawing on `element`, until the function it gives back stops it; and a way to have it drawn again when it stands still. */
const animate = (
  element: HTMLCanvasElement,
  latest: { current: Latest }
): { stop: () => void; redraw: () => void } | undefined => {
  const context = element.getContext("2d");
  const host = element.parentElement;
  if (context === null || host === null) {
    return undefined;
  }
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let styles = palette(element);
  const themes = new MutationObserver(() => {
    styles = palette(element);
  });
  themes.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme", "style"],
  });

  const dots = brainDots();

  let width = 0;
  let height = 0;
  let size = 0;
  let fibres: Fibre[] = [];
  let known: NerveLine[] | undefined;
  let started = false;
  let signals: Signal[] = [];
  let glows: Glow[] = [];
  let visible = true;
  const watcher = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true;
  });
  watcher.observe(element);
  const pointer: { x: number; y: number; over?: string } = { x: -999, y: -999 };
  // The fibre in hand, and where on it its app is named.
  let held: string | null = null;

  /** Follows the connections: a new one takes the first free place and grows in, one that is gone draws back. */
  const follow = (age: number) => {
    const { lines: wanted } = latest.current;
    if (wanted === known) {
      return;
    }
    const first = !started;
    started = true;
    known = wanted;
    for (const fibre of fibres) {
      if (
        fibre.leaving === undefined &&
        !wanted.some((line) => line.id === fibre.id)
      ) {
        fibre.leaving = age;
      }
    }
    for (const line of wanted) {
      const there = fibres.find(
        (fibre) => fibre.id === line.id && fibre.leaving === undefined
      );
      if (there) {
        there.attention = line.attention;
        continue;
      }
      // A new one is for seeing: it waits while a dialog is over the page, as the one to sign in with is, or the banner is out of view.
      if (
        !first &&
        !still &&
        (!visible || document.querySelector('[role="dialog"]'))
      ) {
        known = undefined;
        continue;
      }
      const slot = firstFree(fibres);
      const place = SLOTS[slot];
      if (place === undefined) {
        continue;
      }
      // The ones there from the start grow in one after another.
      const born = first ? place.seed : age + ARRIVE.wait;
      const fibre: Fibre = {
        id: line.id,
        slot,
        place,
        attention: line.attention,
        curve: [0, 0, 0, 0, 0, 0, 0, 0],
        length: 1,
        nx: 0,
        ny: 0,
        end: 1,
        born,
        fresh: !first,
        next: born + FIBRE.grow + 0.4 + place.seed * 4,
      };
      lay(fibre, width, height, size);
      fibres.push(fibre);
    }
  };

  const build = () => {
    const box = host.getBoundingClientRect();
    ({ width, height } = box);
    size = Math.min(BRAIN.most, height * BRAIN.share);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    element.width = Math.round(width * dpr);
    element.height = Math.round(height * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    signals = [];
    glows = [];
    for (const fibre of fibres) {
      lay(fibre, width, height, size);
    }
  };
  build();

  const drawn: number[][] = Array.from({ length: ALPHAS * HEATS }, () => []);
  const put = (
    x: number,
    y: number,
    r: number,
    alpha: number,
    heat: number
  ) => {
    const near = Math.max(
      0,
      1 - Math.hypot(x - pointer.x, y - pointer.y) / NEAR
    );
    const bucket = bucketOf(
      Math.min(1, alpha + 0.3 * near),
      Math.max(heat, 0.5 * near * near)
    );
    if (bucket > 0) {
      drawn[bucket]?.push(x, y, r * (1 + 0.5 * near));
    }
  };

  // The fibre whose app needs signing in again nearest the pointer this frame, within reach, and the point on it nearest.
  let nearest: Fibre | undefined;
  let nearestAt = { x: 0, y: 0, far: HELP.near };

  /** Where a fibre lies now: it sways a little across its own line. */
  const swayed = (fibre: Fibre, age: number): Curve => {
    const { seed } = fibre.place;
    const first = still ? 0 : FIBRE.sway * Math.sin(age * 0.5 + seed * 40);
    const second = still
      ? 0
      : FIBRE.sway * 0.6 * Math.sin(age * 0.37 + seed * 90);
    const [x0, y0, x1, y1, x2, y2, x3, y3] = fibre.curve;
    return [
      x0,
      y0,
      x1 + fibre.nx * first,
      y1 + fibre.ny * first,
      x2 + fibre.nx * second,
      y2 + fibre.ny * second,
      x3,
      y3,
    ];
  };

  /** A fibre just connected comes in warm, with sparks around its head, and lights the brain up where it touches. */
  const arrive = (
    fibre: Fibre,
    curve: Curve,
    grown: number,
    age: number,
    now: number
  ) => {
    const whole = grown >= 1;
    if (whole && fibre.touched === undefined) {
      fibre.touched = age;
      fibre.next = age + 1.2;
      const [x, y] = along(fibre.curve, fibre.end);
      glows.push({
        x,
        y,
        at: now,
        strength: 1,
        around: ARRIVE.around,
        seconds: ARRIVE.seconds,
      });
    }
    if (!whole && grown > 0 && fibre.leaving === undefined) {
      // Sparks around its head as it comes.
      const [hx, hy] = along(curve, grown * fibre.end);
      for (let spark = 0; spark < ARRIVE.sparks; spark += 1) {
        const far = Math.random() ** 2 * ARRIVE.scatter;
        const angle = Math.random() * TAU;
        put(
          hx + Math.cos(angle) * far,
          hy + Math.sin(angle) * far,
          0.7 + Math.random() * 1.2,
          0.4 + 0.6 * Math.random(),
          0.6 + 0.4 * Math.random()
        );
      }
    }
  };

  /** A whole fibre sends a signal now and then, each in its own time. */
  const send = (fibre: Fibre, age: number, now: number) => {
    fibre.next = age + between(SIGNAL.wait, Math.random() ** 1.5);
    signals.push({
      fibre,
      born: now,
      speed: between(SIGNAL.speed, Math.random()),
      reach:
        between(SIGNAL.reach, Math.random()) * (fibre.place.thin ? 0.7 : 1),
      strength: 0.55 + 0.45 * Math.random(),
    });
  };

  /** How much of a fibre's dot at (x, y) shows: nearing the brain it fades out, so its end only touches the brain's edge. */
  const shownAt = (x: number, y: number): number => {
    const inside = Math.hypot(
      (x - width / 2) / (size * INSIDE.across),
      (y - height / 2) / (size * INSIDE.high)
    );
    return (
      Math.min(
        1,
        Math.max(
          0,
          (inside - INSIDE.fade[0]) / (INSIDE.fade[1] - INSIDE.fade[0])
        )
      ) ** 0.7
    );
  };

  /** A dot of a fibre whose app needs signing in again: it glows whole, and the one nearest the pointer is in reach. */
  const putHelp = (
    fibre: Fibre,
    x: number,
    y: number,
    shown: number,
    help: number
  ) => {
    const far = Math.hypot(x - pointer.x, y - pointer.y);
    if (far < nearestAt.far) {
      nearest = fibre;
      nearestAt = { x, y, far };
    }
    put(
      x,
      y,
      THICK.dot * (1 + (HELP.swell - 1) * help),
      (0.55 + 0.45 * help) * shown,
      help
    );
  };

  /** A dot of a fibre `t` of the way along it, at (x, y). */
  const putFibreDot = (
    { fibre, grown, afterglow, running }: Print,
    t: number,
    x: number,
    y: number,
    shown: number
  ) => {
    const kind = fibre.place.thin ? THIN : THICK;
    const whole = grown >= 1;
    const tipAt = grown * fibre.end;
    let heat = 0;
    for (const { where, reach, strength } of running) {
      heat = Math.max(
        heat,
        strength * Math.exp(-((((t - where) * fibre.length) / reach) ** 2))
      );
    }
    // The tip that is growing is bolder; on one just connected it is a bright head, with the rest warm behind it.
    const tip = grown < 1 && tipAt - t < 0.05 ? 0.4 : 0;
    const head =
      afterglow > 0 && !whole
        ? Math.exp(-((((tipAt - t) * fibre.length) / ARRIVE.head) ** 2))
        : 0;
    heat = Math.max(heat, afterglow * (0.62 + 0.38 * head));
    put(
      x,
      y,
      (kind.dot + (THICK.dot * 1.5 - kind.dot) * afterglow) *
        (1 + 0.9 * heat + 0.9 * head),
      (between(kind.ink, fibre.place.ink) + tip + 0.6 * heat) *
        (whole ? shown : Math.max(shown, head)),
      heat
    );
  };

  const drawFibre = (fibre: Fibre, age: number, now: number) => {
    const kind = fibre.place.thin ? THIN : THICK;
    const curve = swayed(fibre, age);
    // It grows in from the edge, and stays until its app is disconnected; then it draws back.
    const arriving = fibre.fresh && !still;
    const grown = grownOf(fibre, age, still);
    const whole = grown >= 1;
    const tipAt = grown * fibre.end;
    // Just connected, it comes in warm and lights the brain up where it touches; then it cools to a fibre like the others.
    if (arriving) {
      arrive(fibre, curve, grown, age, now);
    }
    const afterglow = afterglowOf(fibre, arriving, age);
    if (whole && !still && !fibre.attention && age > fibre.next) {
      send(fibre, age, now);
    }
    const running = signals
      .filter((signal) => signal.fibre === fibre)
      .map((signal) => ({
        where: ((now - signal.born) * signal.speed) / fibre.length,
        reach: signal.reach,
        strength: signal.strength,
      }));
    // One that needs help glows whole, and beats twice and rests; in hand it is at its warmest.
    const help = helpOf(fibre, held, age, still);
    const print: Print = { fibre, grown, afterglow, running };

    const many = Math.max(6, Math.round(fibre.length / kind.gap));
    const creep =
      whole && !still && !fibre.attention
        ? ((age * FIBRE.creep) / kind.gap) % 1
        : 0;
    for (let at = 0; at < many; at += 1) {
      const t = (at + creep) / many;
      if (t > tipAt) {
        break;
      }
      const [x, y] = along(curve, t);
      const shown = shownAt(x, y);
      if (fibre.attention) {
        putHelp(fibre, x, y, shown, help);
      } else {
        putFibreDot(print, t, x, y, shown);
      }
    }
  };

  /** Arrived: the brain warms where a signal came in. */
  const land = (now: number) => {
    for (let at = signals.length - 1; at >= 0; at -= 1) {
      const signal = signals[at];
      if (
        signal !== undefined &&
        ((now - signal.born) * signal.speed) / signal.fibre.length >=
          signal.fibre.end
      ) {
        signals.splice(at, 1);
        const [x, y] = along(signal.fibre.curve, signal.fibre.end);
        glows.push({
          x,
          y,
          at: now,
          strength: signal.strength,
          around: GLOW.around,
          seconds: GLOW.seconds,
        });
      }
    }
  };

  /** The one that needs help under the pointer is in hand; over its app's name it stays so. */
  const hold = () => {
    const { over } = pointer;
    const overHelp =
      over !== undefined &&
      fibres.some((fibre) => fibre.id === over && fibre.attention);
    const holding = nearest?.id ?? (overHelp ? over : null);
    if (holding !== held) {
      held = holding;
      host.classList.toggle("cursor-pointer", held !== null);
      latest.current.onHold(
        held,
        nearest ? { x: nearestAt.x, y: nearestAt.y } : undefined
      );
    }
  };

  /** How warm the brain is at (x, y) from the glows on it: each comes up fast and fades slowly. */
  const warmthAt = (x: number, y: number, now: number): number => {
    let heat = 0;
    for (const glow of glows) {
      const gone = (now - glow.at) / glow.seconds;
      const off = Math.hypot(x - glow.x, y - glow.y) / (size * glow.around);
      if (off < 2) {
        heat = Math.max(
          heat,
          glow.strength *
            Math.min(1, gone * 8) *
            (1 - gone) *
            Math.exp(-off * off)
        );
      }
    }
    return heat;
  };

  /** Where a dot of the brain is in the figure at `age`, and how it prints: while the brain gathers, on its way in from the cloud. */
  const gathered = (dot: BrainDot, age: number) => {
    const morphing = !still && age < MORPH_S + SPREAD_S;
    if (!morphing) {
      return { x: dot.x, y: dot.y, z: dot.z, printed: dot.ink };
    }
    const e = ease((age - dot.delay) / MORPH_S);
    return {
      x: dot.fx + (dot.x - dot.fx) * e,
      y: dot.fy + (dot.y - dot.fy) * e,
      z: dot.fz + (dot.z - dot.fz) * e + Math.sin(Math.PI * e) * dot.lift,
      printed: 0.4 + (dot.ink - 0.4) * e,
    };
  };

  /** The brain: seen from the front, turning a little, its dots sized by its shading. */
  const drawBrain = (age: number, now: number) => {
    const scale = size * 0.43 * LOOK.air;
    const gap = PITCH * scale;
    const turn = still ? 0 : TURN.far * Math.sin(age * TURN.speed);
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    for (const dot of dots) {
      const { x, y, z, printed } = gathered(dot, age);
      const rx = x * cos + z * sin;
      const rz = z * cos - x * sin;
      const perspective = 3.4 / (3.4 - rz);
      const sx = width / 2 + rx * perspective * scale;
      const sy = height / 2 - y * perspective * scale;
      const heat = warmthAt(sx, sy, now);
      let alpha = 0.58 + 0.32 * printed + 0.08 * dot.tone;
      if (!still) {
        alpha *= 0.9 + 0.1 * Math.sin(now * 1.4 + dot.seed * 60);
      }
      // What has turned to the back prints fainter.
      alpha *= 0.55 + 0.45 * Math.min(1, Math.max(0, rz * 2 + 1));
      if (heat > 0.12) {
        alpha = Math.max(alpha, 0.45 + 0.5 * heat);
      }
      const own = 1 - 0.55 * LOOK.variety + 1.3 * LOOK.variety * dot.grain;
      const share = Math.min(
        0.4,
        (LOOK.lightDot + (LOOK.darkDot - LOOK.lightDot) * printed) * own
      );
      put(sx, sy, gap * share * perspective * (1 + 0.3 * heat), alpha, heat);
    }
  };

  /** Prints what was put this frame: one fill per colour. */
  const paint = () => {
    context.clearRect(0, 0, width, height);
    for (const [bucket, list] of drawn.entries()) {
      if (list.length > 0) {
        context.fillStyle = styles[bucket] ?? "";
        context.beginPath();
        for (let at = 0; at < list.length; at += 3) {
          const x = list[at] ?? 0;
          const y = list[at + 1] ?? 0;
          const r = list[at + 2] ?? 0;
          context.moveTo(x + r, y);
          context.arc(x, y, r, 0, TAU);
        }
        context.fill();
      }
    }
  };

  let frame = 0;
  let born = -1;
  const draw = (ms: number) => {
    if (!still) {
      frame = requestAnimationFrame(draw);
    }
    if (!visible && !still) {
      return;
    }
    const now = ms / 1000;
    if (born < 0) {
      born = now;
    }
    const age = still ? 99 : now - born;
    for (const list of drawn) {
      list.length = 0;
    }
    glows = glows.filter((glow) => now - glow.at < glow.seconds);
    follow(age);
    fibres = fibres.filter(
      (fibre) =>
        fibre.leaving === undefined ||
        (!still && age - fibre.leaving < FIBRE.leave)
    );
    nearest = undefined;
    nearestAt = { x: 0, y: 0, far: HELP.near };
    for (const fibre of fibres) {
      drawFibre(fibre, age, now);
    }
    land(now);
    hold();
    drawBrain(age, now);
    paint();
  };

  frame = requestAnimationFrame(draw);

  const redraw = () => {
    if (still) {
      requestAnimationFrame(draw);
    }
  };
  const sizes = new ResizeObserver(() => {
    build();
    redraw();
  });
  sizes.observe(host);

  const onMove = (event: PointerEvent) => {
    const box = host.getBoundingClientRect();
    pointer.x = event.clientX - box.left;
    pointer.y = event.clientY - box.top;
    pointer.over =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-line]")?.dataset.line
        : undefined;
    redraw();
  };
  const onLeave = () => {
    pointer.x = -999;
    pointer.y = -999;
    pointer.over = undefined;
    redraw();
  };
  const onClick = (event: MouseEvent) => {
    // The app's name is a link of its own.
    if (
      held !== null &&
      !(event.target instanceof Element && event.target.closest("a"))
    ) {
      latest.current.onOpen(held);
    }
  };
  host.addEventListener("pointermove", onMove);
  host.addEventListener("pointerleave", onLeave);
  host.addEventListener("click", onClick);
  return {
    stop: () => {
      cancelAnimationFrame(frame);
      watcher.disconnect();
      sizes.disconnect();
      themes.disconnect();
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
      host.removeEventListener("click", onClick);
    },
    redraw,
  };
};

/**
 * The life in the Integrations banner: the onboarding's brain in dots, small, in the middle, and
 * a nerve into it for every connected app, up to `LINES` of them. The brain gathers from a cloud
 * and keeps turning a little. Nothing about the fibres is even: they come in from beyond every
 * edge, thick ones from the sides and thin ones from above and below, each bent its own way,
 * swaying a little, and fade out as they reach the brain, so each only touches its edge. Their
 * dots creep inwards, and signals run along them as warmth, each fibre in its own time; where
 * one comes in, the brain warms for a moment. An app that gets connected grows a new fibre in
 * while the others stay where they are, and that is made to be seen: it waits until the banner
 * is in view with no dialog over the page, then comes in warm with a bright head and sparks
 * around it, lights up the brain where it touches, and cools to a fibre like the others. One
 * that is disconnected draws its fibre back. A fibre whose app needs signing in again glows
 * whole and beats, carries no signals, and is the one thing here to act on: with the pointer on
 * it, it is in hand (`onHold`), and a click opens its app (`onOpen`). Dots swell and warm under
 * the pointer. With less motion it all stands still.
 */
export const IntegrationsNerves = ({
  lines,
  onHold,
  onOpen,
}: {
  lines: NerveLine[];
  onHold: (id: string | null, at?: NervePlace) => void;
  onOpen: (id: string) => void;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  // What the drawing reads each frame, and a way to have it drawn again when it stands still.
  const latest = useRef<Latest>({ lines, onHold, onOpen });
  const redraw = useRef<(() => void) | null>(null);
  useEffect(() => {
    latest.current = { lines, onHold, onOpen };
    redraw.current?.();
  });

  useEffect(() => {
    const element = canvas.current;
    const started = element === null ? undefined : animate(element, latest);
    redraw.current = started?.redraw ?? null;
    return () => {
      started?.stop();
      redraw.current = null;
    };
  }, []);

  return (
    <canvas
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 size-full"
      ref={canvas}
    />
  );
};
