import { BAYER_MATRIX, DITHER_LEVELS } from "@grasp-os/ui/lib/utils";

import { wait } from "../core.ts";
import { readTones } from "./campaign/pixels.ts";

// The setup's end: Stephen hands the admin over to the platform. His light
// spreads from the button that was pressed until it holds the whole
// window, the platform is drawn under it, and it dissolves from the middle
// outward to show the platform, his light on the dissolving edge. Drawn on
// one canvas of its own on the document, outside React, so it lives on
// while the page under it changes from the setup to the platform. Cells
// as the field's are, in the light's own tones read from the page. Under
// reduced motion, or without a canvas, the page simply changes.

/** A cell's side in CSS pixels: the field's own grain. */
const CELL = 4;
/** How long the light takes to spread over the window, and to dissolve from it. */
const SPREAD_MS = 620;
const REVEAL_MS = 820;
/** How long the platform is given to draw itself under the light before it shows. */
const SETTLE_MS = 240;
/** How wide the dithered edge of the light is, as a part of the way across. */
const EDGE = 0.12;

const bayerAt = (x: number, y: number): number =>
  ((BAYER_MATRIX[y % 4]?.[x % 4] ?? 0) + 0.5) / DITHER_LEVELS;

/** A number from 0 to 1 for a cell, always the same: the edge is never a clean ring. */
const chance = (x: number, y: number): number => {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43_758.5453;
  return value - Math.floor(value);
};

const eased = (part: number): number => {
  const t = Math.min(1, Math.max(0, part));
  return t * t * (3 - 2 * t);
};

const frameAfter = async (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<number>();
  requestAnimationFrame(resolve);
  await promise;
};

interface Sweep {
  /** Where it starts, in CSS pixels. */
  from: readonly [number, number];
  /** How far its farthest cell is. */
  reach: number;
  /** 1 while the light spreads over the window, -1 while it dissolves from it. */
  way: 1 | -1;
}

/** Draws the light at `part` (0 to 1) of a sweep. */
const drawSweep = (
  context: CanvasRenderingContext2D,
  sweep: Sweep,
  part: number,
  tones: { ground: string; deep: string; edge: string }
) => {
  const width = window.innerWidth;
  const height = window.innerHeight;
  context.clearRect(0, 0, width, height);
  const columns = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  // The front goes past the farthest cell, so the whole window is held (or let go) at the end.
  const front = eased(part) * (1 + EDGE);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      const cx = x * CELL + CELL / 2;
      const cy = y * CELL + CELL / 2;
      const away =
        Math.hypot(cx - sweep.from[0], cy - sweep.from[1]) / sweep.reach;
      // How far past this cell the front is, its edge dithered and a little uneven.
      const past =
        (front - away + (chance(x, y) - 0.5) * 0.04) / EDGE - bayerAt(x, y);
      const held = sweep.way === 1 ? past > 0 : past <= 0;
      if (!held) {
        continue;
      }
      // His edge: a thin line of light, a cell or two deep.
      const onEdge = Math.abs(past) < 0.22;
      // Behind it, the page's own ground with a faint glow of him, densest where he began.
      const glow = 0.32 * Math.exp(-away * away * 2.2);
      let tone = tones.ground;
      if (onEdge) {
        tone = tones.edge;
      } else if (bayerAt(x + 1, y + 2) < glow) {
        tone = tones.deep;
      }
      context.fillStyle = tone;
      context.fillRect(x * CELL, y * CELL, CELL, CELL);
    }
  }
};

/** Runs a sweep over `ms`, a frame at a time; over once it has been drawn to its end. */
const run = async (
  context: CanvasRenderingContext2D,
  sweep: Sweep,
  ms: number,
  tones: Parameters<typeof drawSweep>[3]
): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const start = performance.now();
  const step = (now: number) => {
    const part = Math.min((now - start) / ms, 1);
    drawSweep(context, sweep, part, tones);
    if (part >= 1) {
      resolve(true);
      return;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  await promise;
};

const farthestFrom = (x: number, y: number): number =>
  Math.max(
    Math.hypot(x, y),
    Math.hypot(window.innerWidth - x, y),
    Math.hypot(x, window.innerHeight - y),
    Math.hypot(window.innerWidth - x, window.innerHeight - y)
  );

/**
 * Stephen hands the admin over to the platform: his light spreads from
 * `from` (the button pressed) over the window, `open` changes the page
 * under it (over once the platform is there), and the light dissolves
 * from the middle of the window outward.
 */
export const handOver = async (
  from: Element | null,
  open: () => Promise<void>
): Promise<void> => {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (still || context === null) {
    await open();
    return;
  }
  const ratio = Math.min(window.devicePixelRatio, 2);
  canvas.width = Math.round(window.innerWidth * ratio);
  canvas.height = Math.round(window.innerHeight * ratio);
  canvas.setAttribute("aria-hidden", "true");
  // Placed by hand: it outlives the page it starts on, so no page's styles can hold it.
  Object.assign(canvas.style, {
    position: "fixed",
    inset: "0",
    width: "100vw",
    height: "100vh",
    zIndex: "2147483647",
    pointerEvents: "auto",
    imageRendering: "pixelated",
  });
  document.body.append(canvas);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const read = readTones(document.body.firstElementChild ?? document.body);
  const dark =
    document.documentElement.dataset.mode === "dark" ||
    (document.documentElement.dataset.mode !== "light" &&
      matchMedia("(prefers-color-scheme: dark)").matches);
  const tones = {
    ground: read.background,
    deep: dark ? read.pine : read.sea,
    edge: read.mint,
  };
  try {
    const box = from?.getBoundingClientRect();
    const origin: readonly [number, number] =
      box === undefined
        ? [window.innerWidth / 2, window.innerHeight / 2]
        : [box.x + box.width / 2, box.y + box.height / 2];
    await run(
      context,
      { from: origin, reach: farthestFrom(...origin), way: 1 },
      SPREAD_MS,
      tones
    );
    await open();
    await frameAfter();
    await wait(SETTLE_MS);
    // The platform's own ground now, which may differ from the setup's.
    tones.ground = readTones(
      document.body.firstElementChild ?? document.body
    ).background;
    const middle: readonly [number, number] = [
      window.innerWidth / 2,
      window.innerHeight / 2,
    ];
    await run(
      context,
      { from: middle, reach: farthestFrom(...middle), way: -1 },
      REVEAL_MS,
      tones
    );
  } finally {
    canvas.remove();
  }
};
