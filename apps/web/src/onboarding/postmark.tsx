import { colors } from "@grasp-os/ui/lib/tokens.stylex";
import { BAYER_MATRIX, DITHER_LEVELS } from "@grasp-os/ui/lib/utils";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";

// The team step's letter carries a postmark of the day the interviews
// start: the day of the month in large pixel digits in a worn ring, with the wavy lines of a cancellation running off
// toward the words and thinning out there, cell by cell in the system's
// one dither, as the welcome's cards draw their flags (flag-picture.tsx).
// In the brand's mint, a little turned. Another day chosen, it is stamped
// again: the ink comes in over 200 ms, in the dither's order; under
// reduced motion at once.

const styles = stylex.create({
  // As wide as the room beside it allows, up to its own width: on a phone the cancellation is shorter.
  canvas: {
    display: "block",
    flexGrow: 1,
    flexShrink: 1,
    minWidth: "7rem",
    maxWidth: "13rem",
    height: "6.5rem",
    color: colors.chart1,
    imageRendering: "pixelated",
  },
});

/** A cell's side in CSS pixels: the flags' own. */
const cell = 4;

const bayerAt = (x: number, y: number): number =>
  ((BAYER_MATRIX[((y % 4) + 4) % 4]?.[((x % 4) + 4) % 4] ?? 0) + 0.5) /
  DITHER_LEVELS;

const chance = (x: number, y: number): number => {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43_758.5453;
  return value - Math.floor(value);
};

/** Digits three cells wide and five high. */
const digits: Record<string, string[]> = {
  "0": ["###", "#.#", "#.#", "#.#", "###"],
  "1": [".#.", "##.", ".#.", ".#.", "###"],
  "2": ["###", "..#", "###", "#..", "###"],
  "3": ["###", "..#", ".##", "..#", "###"],
  "4": ["#.#", "#.#", "###", "..#", "..#"],
  "5": ["###", "#..", "###", "..#", "###"],
  "6": ["###", "#..", "###", "#.#", "###"],
  "7": ["###", "..#", ".#.", ".#.", ".#."],
  "8": ["###", "#.#", "###", "#.#", "###"],
  "9": ["###", "#.#", "###", "..#", "###"],
};

/** Which cells of `text` in the pixel digits are inked, `scale` cells to a pixel, from its top left. */
const inked = (text: string, scale: number): Set<string> => {
  const cells = new Set<string>();
  let left = 0;
  for (const glyph of text) {
    const rows = digits[glyph] ?? [];
    const wide = rows[0]?.length ?? 0;
    for (const [row, line] of rows.entries()) {
      for (let at = 0; at < line.length; at += 1) {
        if (line.charAt(at) === "#") {
          for (let dy = 0; dy < scale; dy += 1) {
            for (let dx = 0; dx < scale; dx += 1) {
              cells.add(`${left + at * scale + dx},${row * scale + dy}`);
            }
          }
        }
      }
    }
    left += (wide + 1) * scale;
  }
  return cells;
};

/** How wide `text` is in cells. */
const widthOf = (text: string, scale: number): number =>
  Array.from(text, (glyph) => glyph).reduce(
    (sum, glyph) => sum + ((digits[glyph]?.[0]?.length ?? 0) + 1) * scale,
    -scale
  );

/** The ring's radius and the turn of the whole mark. */
const radius = 11.5;
const turn = 0;

/** Whether the mark has ink at (x, y), in cells from the canvas's top left. */
const markAt = (
  x: number,
  y: number,
  middle: { x: number; y: number },
  writing: Set<string>,
  origin: { x: number; y: number }
): boolean => {
  // Into the mark's own turned frame.
  const dx = x + 0.5 - middle.x;
  const dy = y + 0.5 - middle.y;
  const u = dx * Math.cos(-turn) - dy * Math.sin(-turn);
  const v = dx * Math.sin(-turn) + dy * Math.cos(-turn);
  const far = Math.hypot(u, v);
  // The ring, two cells thick, worn in places.
  if (far > radius - 1.6 && far < radius + 0.4) {
    return chance(x, y) > 0.06;
  }
  if (far <= radius - 1.6) {
    const at = `${Math.round(u + middle.x - origin.x - 0.5)},${Math.round(v + middle.y - origin.y - 0.5)}`;
    return writing.has(at);
  }
  return false;
};

/** The cancellation: three wavy lines from the ring toward the words, which thin out there. */
const waveAt = (
  x: number,
  y: number,
  middle: { x: number; y: number }
): number => {
  const start = middle.x - radius - 1;
  if (x >= start) {
    return 0;
  }
  for (const line of [-5, 0, 5]) {
    const wave = middle.y + line + Math.sin((x + line) * 0.55) * 1.4;
    if (Math.abs(y + 0.5 - wave) < 0.6) {
      // Whole by the ring, thinning out over the run away from it.
      return Math.max(0, 1 - (start - x) / (start - 1)) ** 1.2;
    }
  }
  return 0;
};

const draw = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  ink: string,
  { day }: { day: string },
  shown: number
) => {
  const columns = Math.floor(width / cell);
  const rows = Math.floor(height / cell);
  const middle = { x: columns - radius - 1.5, y: rows / 2 };
  const date = String(Number(day.slice(8, 10)));
  // The day large, in the ring's middle.
  const big = 2;
  const tall = 5 * big;
  const writing = new Set<string>();
  const dayLeft = Math.round((26 - widthOf(date, big)) / 2);
  for (const at of inked(date, big)) {
    const [x = 0, y = 0] = at.split(",").map(Number);
    writing.add(`${x + dayLeft},${y}`);
  }
  const origin = { x: middle.x - 13, y: middle.y - tall / 2 };
  context.fillStyle = ink;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      // Stamped: the ink arrives in the dither's order.
      if (bayerAt(x, y) >= shown) {
        continue;
      }
      if (markAt(x, y, middle, writing, origin)) {
        context.globalAlpha = 0.92;
        context.fillRect(x * cell, y * cell, cell, cell);
        continue;
      }
      const much = waveAt(x, y, middle);
      if (much <= 0 || bayerAt(x + 1, y + 2) >= much * 1.1) {
        continue;
      }
      const side = cell * (0.3 + 0.7 * Math.min(1, much / 0.7) ** 0.6);
      const inset = (cell - side) / 2;
      context.globalAlpha = 0.2 + 0.72 * Math.min(1, much / 0.7);
      context.fillRect(x * cell + inset, y * cell + inset, side, side);
    }
  }
  context.globalAlpha = 1;
};

/** How long a new stamp takes to come in. */
const stampMs = 200;

export const Postmark = ({ day }: { day: string }) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (element === null || context === null || context === undefined) {
      return () => {
        // Nothing drawn.
      };
    }
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let shown = still ? 1 : 0;
    const began = performance.now();
    const paint = () => {
      const { width, height } = element.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio, 2);
      const wide = Math.round(width * ratio);
      const high = Math.round(height * ratio);
      if (element.width !== wide || element.height !== high) {
        element.width = wide;
        element.height = high;
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      // The theme's own ink, resolved: never a copy of the palette.
      draw(
        context,
        width,
        height,
        getComputedStyle(element).color,
        { day },
        shown
      );
    };
    const step = (now: number) => {
      shown = Math.min(1, (now - began) / stampMs);
      paint();
      frame = shown < 1 ? requestAnimationFrame(step) : 0;
    };
    if (still) {
      paint();
    } else {
      frame = requestAnimationFrame(step);
    }
    const resized = new ResizeObserver(paint);
    resized.observe(element);
    const themed = new MutationObserver(paint);
    themed.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-mode", "style"],
    });
    const system = matchMedia("(prefers-color-scheme: dark)");
    system.addEventListener("change", paint);
    return () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
      themed.disconnect();
      system.removeEventListener("change", paint);
    };
  }, [day]);
  return (
    <canvas aria-hidden="true" ref={canvas} {...stylex.props(styles.canvas)} />
  );
};
