import { useLayoutEffect, useRef } from "react";

import { ALPHAS, bucketOf, HEATS, lightness, palette, rgb } from "./dot-ink.ts";
import type { BrainDots } from "./dot-ink.ts";
import {
  clamp01,
  easeInCubic,
  easeInQuad,
  easeOut,
  glide,
  pairAlongCurve,
  seeded,
} from "./reveal-motion.ts";
import { sampleTargets, sketchTargets } from "./reveal-targets.ts";

// Dots that build a page, ported from the prototype (grasplabs/prototype,
// packages/grasp: components/dots-build.tsx). Here it builds a note's page
// out of the atlas's dots (note-reveal.tsx).

const TAU = Math.PI * 2;

/**
 * Seconds from when the page is on screen underneath and read; until then the dots hold still
 * where they were handed over, as rendering the page and reading it would stall any motion.
 * Then gathering in and heating up.
 */
const CHARGE = 0.65;
/**
 * The page is given this long to show underneath before it is read anyway. Once it shows, the
 * clock waits for STEADY frames in a row that each come within STEADY_MS: it has stopped rendering.
 */
const PATIENCE_MS = 3000;
const STEADY = 4;
const STEADY_MS = 40;
/**
 * Then one sweep per dot: out fast past its place on the page, turning as it goes, and settling
 * into it; the middle first, the edges up to SPREAD later. SWING is how far past its place it
 * swings out, LOOSE how loosely, as a share of the screen, and SWIRL how far it turns.
 */
const FLY = 1.6;
const SPREAD = 0.5;
const SWING = 1.35;
const LOOSE = 0.08;
const SWIRL = 0.55;
/** Dissolving into the page from where the dots were, one cell of dots at a time. */
const DISSOLVE_AT = CHARGE + FLY + 0.2;
const DISSOLVE = 1.25;
const RIPPLE = 0.45;
const JITTER = 0.12;
const CELL = 16;
/** How long a landed dot takes to melt into what it drew, once the dissolve has passed it. */
const FADE = 0.3;
const END = DISSOLVE_AT + DISSOLVE + RIPPLE + JITTER + FADE + 0.05;
/** Charged: gathered in by this share and turned by this much, where the burst starts. */
const GATHER = 0.12;
const TURN = 0.35;
/**
 * The other way there, `flow`: nothing gathers or turns first. The dots leave from where they are,
 * one after another over SPAN, the top of the page first, each in one sweep of FLIGHT through the
 * middle of the page and out to its place. The page opens behind them as they land, top down, a
 * cell taking SOFT to open and a landed dot MELT to melt into what it drew.
 */
const SPAN = 1;
const FLIGHT = 1.15;
const SOFT = 0.6;
const MELT = 0.4;
const OPENS_AT = FLIGHT * 0.9;
const FLOW_OPEN = OPENS_AT + SPAN + JITTER + SOFT;
const FLOW_END = Math.max(FLOW_OPEN + MELT, SPAN + 0.1 + FLIGHT + MELT) + 0.05;

const at = (values: ArrayLike<number>, index: number): number =>
  values[index] ?? 0;

/** Dots in a soft disc, for when there are none on screen to take over. */
const disc = (x: number, y: number): BrainDots => {
  const count = 3200;
  const random = seeded(3);
  const dots: BrainDots = {
    count,
    x: new Float32Array(count),
    y: new Float32Array(count),
    r: new Float32Array(count).fill(1.6),
    alpha: new Float32Array(count).fill(0.8),
    heat: new Float32Array(count),
    middle: { x, y },
  };
  for (let index = 0; index < count; index += 1) {
    const angle = random() * TAU;
    const distance = Math.sqrt(random()) * 170;
    dots.x[index] = x + Math.cos(angle) * distance;
    dots.y[index] = y + Math.sin(angle) * distance;
  }
  return dots;
};

interface Settings {
  root: (layer: HTMLCanvasElement) => Element;
  ready: (layer: HTMLCanvasElement) => boolean;
  onArrive?: () => void;
  onEnd: () => void;
  pace: number;
  sketch: boolean;
}

/** Where each dot goes and when, once the page is read. */
interface Course {
  swingX: Float32Array;
  swingY: Float32Array;
  toX: Float32Array;
  toY: Float32Array;
  toR: Float32Array;
  toA: Float32Array;
  wait: Float32Array;
  gone: Float32Array;
  spare: Uint8Array;
}

/**
 * Plays the build on `element` until it ends, then calls `onEnd`; the function it gives back
 * stops it.
 */
const play = (
  element: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  from: BrainDots | null,
  flow: boolean,
  latest: { current: Settings }
): (() => void) => {
  const width = element.clientWidth;
  const height = element.clientHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  element.width = Math.round(width * dpr);
  element.height = Math.round(height * dpr);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  const styles = palette(element);
  const background = rgb(
    getComputedStyle(element).getPropertyValue("--background").trim() ||
      "#fcfcfb"
  );
  const ground = `rgb(${background.join(", ")})`;

  const brain = from ?? disc(width / 2, height / 2);
  const { count, middle } = brain;
  const random = seeded(5);
  const gauss = () =>
    Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(TAU * random());
  // Each dot's own chance: which way it bends, how it trembles, when the dissolve takes it.
  const seed = Float32Array.from({ length: count }, () => random());
  // Where the burst starts: the brain, gathered in and turned.
  const startX = new Float32Array(count);
  const startY = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const dx = (at(brain.x, index) - middle.x) * (1 - GATHER);
    const dy = (at(brain.y, index) - middle.y) * (1 - GATHER);
    startX[index] = middle.x + dx * Math.cos(TURN) - dy * Math.sin(TURN);
    startY[index] = middle.y + dx * Math.sin(TURN) + dy * Math.cos(TURN);
  }
  // How far out it swings, where it lands, how large and dark it is there, how much longer it takes, and when the dissolve takes it.
  const course: Course = {
    swingX: new Float32Array(count),
    swingY: new Float32Array(count),
    toX: new Float32Array(count),
    toY: new Float32Array(count),
    toR: new Float32Array(count),
    toA: new Float32Array(count),
    wait: new Float32Array(count),
    gone: new Float32Array(count).fill(Infinity),
    // A dot with nothing to land on flies off into the room and fades there.
    spare: new Uint8Array(count),
  };
  const { swingX, swingY, toX, toY, toR, toA, wait, gone, spare } = course;

  // The dissolve: a grid of cells, each opening as a dot grows until they meet, from the brain outwards.
  const farthest = Math.max(
    Math.hypot(middle.x, middle.y),
    Math.hypot(width - middle.x, middle.y),
    Math.hypot(middle.x, height - middle.y),
    Math.hypot(width - middle.x, height - middle.y)
  );
  const speed = farthest / DISSOLVE;
  const columns = Math.ceil(width / CELL) + 1;
  const rows = Math.ceil(height / CELL) + 1;
  const opens = new Float32Array(columns * rows);
  for (let cell = 0; cell < opens.length; cell += 1) {
    const away = Math.hypot(
      (cell % columns) * CELL - middle.x,
      Math.floor(cell / columns) * CELL - middle.y
    );
    opens[cell] = DISSOLVE_AT + away / speed + (random() - 0.5) * 2 * JITTER;
  }
  const open = DISSOLVE_AT + DISSOLVE + JITTER + RIPPLE;

  const measureFlow = (
    targets: ReturnType<typeof sampleTargets>,
    pairs: Int32Array,
    reach: number
  ) => {
    // What is built, as a box: the stream passes through its middle, and it appears from its top down.
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (let to = 0; to < targets.count; to += 1) {
      left = Math.min(left, at(targets.x, to));
      right = Math.max(right, at(targets.x, to));
      top = Math.min(top, at(targets.y, to));
      bottom = Math.max(bottom, at(targets.y, to));
    }
    const centreX = targets.count ? (left + right) / 2 : width / 2;
    const centreY = targets.count ? (top + bottom) / 2 : height / 2;
    const tall = Math.max(bottom - top, 1);
    const rank = (px: number, py: number) =>
      clamp01(
        0.75 * clamp01((py - top) / tall) +
          0.25 * clamp01(Math.hypot(px - middle.x, py - middle.y) / farthest)
      );
    for (let cell = 0; cell < opens.length; cell += 1) {
      opens[cell] =
        OPENS_AT +
        rank((cell % columns) * CELL, Math.floor(cell / columns) * CELL) *
          SPAN +
        (random() - 0.5) * 2 * JITTER;
    }
    for (let index = 0; index < count; index += 1) {
      const to = at(pairs, index);
      const bx = at(brain.x, index);
      const by = at(brain.y, index);
      if (to < 0) {
        spare[index] = 1;
        const angle = random() * TAU;
        const distance = reach * (0.04 + random() * 0.08);
        swingX[index] = bx + Math.cos(angle) * distance;
        swingY[index] = by + Math.sin(angle) * distance;
        continue;
      }
      const tx = at(targets.x, to);
      const ty = at(targets.y, to);
      toX[index] = tx;
      toY[index] = ty;
      toR[index] = at(targets.r, to);
      toA[index] = 0.35 + 0.6 * at(targets.tone, to);
      swingX[index] =
        bx +
        (centreX - bx) * 0.62 +
        (tx - centreX) * 0.22 +
        gauss() * reach * 0.02;
      swingY[index] =
        by +
        (centreY - by) * 0.62 +
        (ty - centreY) * 0.22 +
        gauss() * reach * 0.02;
      const far = rank(tx, ty);
      wait[index] = far ** 1.4 * SPAN + at(seed, index) * 0.1;
      gone[index] =
        OPENS_AT +
        far * SPAN +
        (at(seed, index) - 0.5) * 2 * JITTER +
        SOFT * 0.5;
    }
  };

  const measure = () => {
    const place = element.getBoundingClientRect();
    let targets = sampleTargets(latest.current.root(element), {
      width,
      height,
      origin: { x: place.left, y: place.top },
      skip: element,
      ground: lightness(background),
      budget: count,
    });
    if (targets.count < 150 && latest.current.sketch) {
      targets = sketchTargets(width, height, count);
    }
    const pairs = pairAlongCurve(brain, targets);
    const reach = Math.min(width, height);
    if (flow) {
      measureFlow(targets, pairs, reach);
      return;
    }
    for (let index = 0; index < count; index += 1) {
      const to = at(pairs, index);
      if (to < 0) {
        spare[index] = 1;
        const angle = random() * TAU;
        const distance = reach * (0.35 + random() * 0.45);
        swingX[index] = middle.x + Math.cos(angle) * distance;
        swingY[index] = middle.y + Math.sin(angle) * distance;
        continue;
      }
      const tx = at(targets.x, to);
      const ty = at(targets.y, to);
      toX[index] = tx;
      toY[index] = ty;
      toR[index] = at(targets.r, to);
      toA[index] = 0.35 + 0.6 * at(targets.tone, to);
      // Out past where it lands, loosely: the page, blown up and blurred.
      swingX[index] =
        middle.x + (tx - middle.x) * SWING + gauss() * reach * LOOSE;
      swingY[index] =
        middle.y + (ty - middle.y) * SWING + gauss() * reach * LOOSE;
      const away = Math.hypot(tx - middle.x, ty - middle.y);
      wait[index] = (away / farthest) * SPREAD;
      gone[index] =
        DISSOLVE_AT +
        away / speed +
        (at(seed, index) - 0.5) * 2 * JITTER +
        RIPPLE * 0.4;
    }
  };

  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const r = new Float32Array(count);
  const bucket = new Uint16Array(count);
  const counts = new Uint32Array(ALPHAS * HEATS);
  const starts = new Uint32Array(ALPHAS * HEATS);
  const order = new Uint32Array(count);
  let heard = false;
  const handed = performance.now();
  // Whether the page shows underneath, how many steady frames since, and when the clock started, once it was read.
  let shown = false;
  let steady = 0;
  let last = -1;
  let began = -1;
  let frame = 0;

  /** Where one dot is at `time`, how large, how inked and how warm. */
  const dotAt = (
    index: number,
    time: number
  ): [number, number, number, number, number] => {
    const bx = at(brain.x, index);
    const by = at(brain.y, index);
    const br = at(brain.r, index);
    const ba = at(brain.alpha, index);
    const bh = at(brain.heat, index);
    const sx = at(swingX, index);
    const sy = at(swingY, index);
    if (flow && at(spare, index) === 1) {
      // Nowhere to go: it loosens from where it was and fades.
      const u = clamp01(time / 0.9);
      return [
        bx + (sx - bx) * glide(u),
        by + (sy - by) * glide(u),
        br * (1 - 0.4 * u),
        ba * (1 - clamp01(u * 1.4)),
        bh,
      ];
    }
    if (flow) {
      // Where it was until its turn; then one sweep through the middle of the page and out to its place.
      const e =
        began < 0 ? 0 : glide(clamp01((time - at(wait, index)) / FLIGHT));
      const leaving = (1 - e) * (1 - e);
      const through = 2 * e * (1 - e);
      const onto = e * e;
      // It melts into what it drew once it has landed and the page has opened under it.
      const melted = clamp01(
        Math.min(
          time - at(gone, index),
          time - at(wait, index) - FLIGHT + 0.2
        ) / MELT
      );
      return [
        leaving * bx + through * sx + onto * at(toX, index),
        leaving * by + through * sy + onto * at(toY, index),
        (leaving * br + through * 1.6 + onto * at(toR, index)) *
          (1 - 0.4 * melted),
        (leaving * ba + through * 0.85 + onto * at(toA, index)) * (1 - melted),
        leaving * bh + through * 1.2,
      ];
    }
    if (time < CHARGE) {
      // Gathering in, turning and heating up, with a tremble as it charges.
      const s = easeInCubic(clamp01(time / CHARGE));
      const dx = (bx - middle.x) * (1 - GATHER * s);
      const dy = (by - middle.y) * (1 - GATHER * s);
      const angle = TURN * s;
      const tremble = Math.sin(time * 47 + at(seed, index) * 90) * 0.7 * s;
      return [
        middle.x + dx * Math.cos(angle) - dy * Math.sin(angle) + tremble,
        middle.y + dx * Math.sin(angle) + dy * Math.cos(angle) - tremble,
        br * (1 + 0.15 * s),
        ba + (0.9 - ba) * s,
        bh + (0.85 - bh) * s,
      ];
    }
    const fromX = at(startX, index);
    const fromY = at(startY, index);
    if (at(spare, index) === 1) {
      // Nothing to land on: off into the room, fading as it goes.
      const u = clamp01((time - CHARGE) / FLY);
      const e = easeOut(u);
      return [
        fromX + (sx - fromX) * e,
        fromY + (sy - fromY) * e,
        br * 1.15 * (1 - 0.5 * u),
        0.9 * (1 - clamp01(u * 1.6)),
        0.85 * (1 - u),
      ];
    }
    // One sweep along a curve through the swing: out fast, turning, settling onto its place and cooling to ink.
    const u = clamp01((time - CHARGE) / (FLY + at(wait, index)));
    const e = easeOut(u);
    const leaving = (1 - e) * (1 - e);
    const through = 2 * e * (1 - e);
    const onto = e * e;
    const vx =
      leaving * fromX + through * sx + onto * at(toX, index) - middle.x;
    const vy =
      leaving * fromY + through * sy + onto * at(toY, index) - middle.y;
    const swirl = SWIRL * Math.sin(Math.PI * e);
    // Then it melts into what it drew, once the dissolve has passed it.
    const melted = clamp01((time - at(gone, index)) / FADE);
    return [
      middle.x + vx * Math.cos(swirl) - vy * Math.sin(swirl),
      middle.y + vx * Math.sin(swirl) + vy * Math.cos(swirl),
      (leaving * br * 1.15 + through * 1.8 + onto * at(toR, index)) *
        (1 - 0.4 * melted),
      (leaving * 0.9 + through * 0.95 + onto * at(toA, index)) * (1 - melted),
      0.85 * (1 - e) ** 1.5,
    ];
  };

  /** The page's own background, until the dissolve has opened every cell of it. */
  const cover = (time: number) => {
    if (time >= (flow ? FLOW_OPEN : open)) {
      return;
    }
    context.fillStyle = ground;
    context.fillRect(0, 0, width, height);
    if (time <= (flow ? OPENS_AT : DISSOLVE_AT) - JITTER) {
      return;
    }
    context.globalCompositeOperation = "destination-out";
    context.beginPath();
    for (let cell = 0; cell < opens.length; cell += 1) {
      const opened = (time - at(opens, cell)) / (flow ? SOFT : RIPPLE);
      if (opened <= 0) {
        continue;
      }
      const radius = CELL * 0.75 * easeInQuad(Math.min(opened, 1));
      const cx = (cell % columns) * CELL;
      const cy = Math.floor(cell / columns) * CELL;
      context.moveTo(cx + radius, cy);
      context.arc(cx, cy, radius, 0, TAU);
    }
    context.fill();
    context.globalCompositeOperation = "source-over";
  };

  /** One path per colour, as the brain draws. */
  const print = () => {
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
    let k = 0;
    for (let b = 0; b < counts.length; b += 1) {
      const many = at(counts, b);
      if (many === 0) {
        continue;
      }
      if (b % ALPHAS === 0) {
        k += many;
        continue;
      }
      context.fillStyle = styles[b] ?? "transparent";
      context.beginPath();
      for (const end = k + many; k < end; k += 1) {
        const index = at(order, k);
        const size = at(r, index);
        const px = at(x, index);
        const py = at(y, index);
        if (size < 0.75) {
          context.rect(px - size, py - size, size * 2, size * 2);
        } else {
          context.moveTo(px + size, py);
          context.arc(px, py, size, 0, TAU);
        }
      }
      context.fill();
    }
  };

  const draw = (ms: number) => {
    if (began < 0) {
      shown ||= latest.current.ready(element);
      steady = shown && last >= 0 && ms - last < STEADY_MS ? steady + 1 : 0;
      last = ms;
      if (steady >= STEADY || ms - handed >= PATIENCE_MS) {
        measure();
        began = performance.now();
      }
    }
    const time =
      began < 0 ? 0 : Math.max(0, (ms - began) / 1000) / latest.current.pace;
    if (!heard && time >= (flow ? OPENS_AT : DISSOLVE_AT)) {
      heard = true;
      latest.current.onArrive?.();
    }
    counts.fill(0);
    for (let index = 0; index < count; index += 1) {
      const [px, py, size, ink, warmth] = dotAt(index, time);
      x[index] = px;
      y[index] = py;
      r[index] = size;
      const b = bucketOf(ink, warmth);
      bucket[index] = b;
      counts[b] = at(counts, b) + 1;
    }

    context.globalCompositeOperation = "source-over";
    context.clearRect(0, 0, width, height);
    cover(time);
    print();

    if (began < 0 || time < (flow ? FLOW_END : END)) {
      frame = requestAnimationFrame(draw);
    } else {
      latest.current.onEnd();
    }
  };
  // The first frame before the page paints, so the dots never blink at the hand-over.
  // It queues the frames after it itself, so the one `frame` held is always the next.
  draw(began);
  return () => {
    cancelAnimationFrame(frame);
  };
};

/**
 * A layer that takes dots over exactly where they are, on the page's own background, so what was
 * there can go and a page open underneath unseen; it holds them still, a breath, while the page
 * renders and is read off the screen. Then, the way `burst`, the dots gather and heat up, and
 * burst out past their places on the page, turning, so for a moment the page is there blown up
 * and blurred; they settle onto it, words and edges and icons, the middle first, cooling to ink;
 * the layer then dissolves from where the dots were, cell by cell like the dots it is made of, and
 * each dot melts into what it drew. The way `flow`, they stream out instead and lay the page down
 * from its top.
 *
 * The layer covers what its `className` makes it cover: the whole screen, or one part of it. The
 * dots are given in its own pixels.
 */
export const DotsBuild = ({
  from,
  className,
  label,
  pace = 1,
  way = "flow",
  sketch = false,
  root,
  ready,
  onArrive,
  onEnd,
}: {
  /** The dots to take over, where they are in this layer; without any, a soft disc in its middle. */
  from: BrainDots | null;
  /** Where the layer lies and what it covers. */
  className: string;
  /** What is happening, for a screen reader. */
  label: string;
  /** How long it all takes, as a share of the way into the platform: lower is quicker. */
  pace?: number;
  /** How the dots get there: a burst that settles, or a stream that lays the page down from the top. */
  way?: "burst" | "flow";
  /** When the page cannot be read, a rough page is drawn instead. */
  sketch?: boolean;
  /** The part of the page the dots build, given the layer. */
  root: (layer: HTMLCanvasElement) => Element;
  /** Whether that page shows underneath yet. */
  ready: (layer: HTMLCanvasElement) => boolean;
  /** The dissolve begins: the page is arriving. */
  onArrive?: () => void;
  onEnd: () => void;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef<Settings>({
    root,
    ready,
    onArrive,
    onEnd,
    pace,
    sketch,
  });
  useLayoutEffect(() => {
    latest.current = { root, ready, onArrive, onEnd, pace, sketch };
  });

  useLayoutEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    return element && context
      ? play(element, context, from, way === "flow", latest)
      : undefined;
  }, [from, way]);

  return (
    <>
      <canvas aria-hidden="true" className={className} ref={canvas} />
      <output className="sr-only">{label}</output>
    </>
  );
};
