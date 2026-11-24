import { BAYER_MATRIX, DITHER_LEVELS } from "@grasp-os/ui/lib/utils";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";

import type { Locale } from "../i18n.ts";
import { colourAt, flags } from "./flags.ts";
import type { Flag } from "./flags.ts";

// A language's flag in its own colours, drawn cell by cell on a canvas
// with the system's one dither (Damsko's 4x4 Bayer matrix) between each
// colour and its shade, the light falling across a flag that waves. It
// lies over the whole card it stands in: whole at the far edge, its cells
// thinning out by the same dither over a long run toward the name, so the
// name stands clear and the flag has no hard edge; the card's own corner,
// read from the page, clips it. At rest it is still. While Stephen is on
// the card (`lit`) it lives: the flag waves and comes a little closer to
// the name. Under reduced motion it stays still.

const styles = stylex.create({
  // Over the whole card, under its words, never in the way of its press.
  cover: {
    position: "absolute",
    inset: 0,
    display: "block",
    pointerEvents: "none",
  },
  canvas: {
    display: "block",
    width: "100%",
    height: "100%",
    imageRendering: "pixelated",
  },
});

/** A cell's threshold in the system's dither, 0 to 1. */
const bayerAt = (x: number, y: number): number =>
  ((BAYER_MATRIX[y % 4]?.[x % 4] ?? 0) + 0.5) / DITHER_LEVELS;

/** A colour of the flag's own, a third of the way to black: its shade. */
const shadeOf = (hex: string): string => {
  const part = (at: number) =>
    Math.round(Number.parseInt(hex.slice(at, at + 2), 16) * 0.68);
  return `rgb(${part(1)}, ${part(3)}, ${part(5)})`;
};

/** How big a cell is, in CSS pixels. */
const cell = 4;

/** Where the flag starts to show, in CSS pixels from the name's side: well clear of the longest name. */
const clearOfName = 200;

/** How much closer to the name it comes while Stephen is on the card, in CSS pixels. */
const drawnIn = 48;

/** How far, in cells, a row's start wanders, so the first cells never line up in a column. */
const wander = 10;

/** A number from 0 to 1 for a row, always the same for the same row. */
const rowNoise = (y: number): number => {
  const value = Math.sin(y * 12.9898 + 78.233) * 43_758.5453;
  return value - Math.floor(value);
};

/**
 * How much of the flag stands `at` pixels across: none beside the name
 * (from `clear`), all of it where the flag itself begins (`whole`), eased
 * over the whole run between, so it thins out slowly.
 */
const presence = (at: number, whole: number, clear: number): number => {
  const end = Math.max(clear + cell * 12, whole);
  const t = Math.min(1, Math.max(0, (at - clear) / (end - clear)));
  // Slow at first: a few cells, far apart, before the flag gathers.
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/** What the drawing needs each frame: how much Stephen is on the card, and how far the flag has waved. */
interface Life {
  level: number;
  wave: number;
}

interface Grid {
  columns: number;
  rows: number;
}

/** The flag's own cells, thinning out toward the name. */
const drawFlag = (
  context: CanvasRenderingContext2D,
  flag: Flag,
  { columns, rows }: Grid,
  { level, wave }: Life
) => {
  const flagColumns = Math.min(columns, Math.round(rows * flag.aspect));
  const flagStart = columns - flagColumns;
  const clear = clearOfName - drawnIn * level;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      // Each row starts a little earlier or later, so the fade has no edge.
      const shifted = x + 0.5 - rowNoise(y) * wander;
      if (
        bayerAt(x + 2, y + 1) >=
        presence(shifted * cell, flagStart * cell, clear)
      ) {
        continue;
      }
      const along = (x - flagStart + 0.5) / flagColumns;
      // Under the fade, toward the name: the flag's own edge, or its first colour alone.
      const under = along < 0 && flag.under === "field";
      const u = Math.max(0, along);
      // Waving: the flag rises and falls across, its light with it.
      const phase = u * Math.PI * 2.4 + 0.5 - wave * 3.2;
      const v = Math.min(
        1,
        Math.max(0, (y + 0.5) / rows + Math.sin(phase) * 0.05)
      );
      const light =
        0.55 + 0.35 * Math.cos(phase) - 0.15 * ((x + y) / (columns + rows));
      const own = flag.real[under ? 0 : colourAt(flag.shape, u, v)] ?? "#000";
      context.fillStyle = bayerAt(x, y) > light ? shadeOf(own) : own;
      context.fillRect(x * cell, y * cell, cell, cell);
    }
  }
};

export const FlagPicture = ({
  locale,
  lit = false,
}: {
  locale: Locale;
  /** Stephen is on the card. */
  lit?: boolean;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wanted = useRef(0);
  const wake = useRef<(() => void) | null>(null);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (element === null || context === null || context === undefined) {
      return () => {
        // Nothing drawn.
      };
    }
    const flag = flags[locale];
    const still = matchMedia("(prefers-reduced-motion: reduce)");
    const life: Life = { level: 0, wave: 0 };
    let frame = 0;
    let last = 0;
    const paint = () => {
      const { width, height } = element.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio, 2);
      const wide = Math.round(width * ratio);
      const high = Math.round(height * ratio);
      // Only when its size changed: setting a canvas's size empties it and takes time.
      if (element.width !== wide || element.height !== high) {
        element.width = wide;
        element.height = high;
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const grid: Grid = {
        columns: Math.ceil(width / cell),
        rows: Math.ceil(height / cell),
      };
      // The card's own corner clips the picture, smoothly, as the card's edge does.
      const card = element.closest("button");
      const corner =
        card === null
          ? 0
          : Number(
              getComputedStyle(card).borderTopRightRadius.replace("px", "")
            );
      context.save();
      if (Number.isFinite(corner)) {
        context.beginPath();
        context.roundRect(0, 0, width, height, corner);
        context.clip();
      }
      drawFlag(context, flag, grid, life);
      context.restore();
    };
    const step = (now: number) => {
      const elapsed = Math.min(now - last, 64);
      last = now;
      // Halfway there every 80 ms.
      life.level =
        wanted.current + (life.level - wanted.current) * 0.5 ** (elapsed / 80);
      life.wave += (elapsed / 1000) * life.level;
      const settled = wanted.current === 0 && Math.abs(life.level) < 0.004;
      if (settled) {
        life.level = 0;
      }
      paint();
      frame = settled ? 0 : requestAnimationFrame(step);
    };
    wake.current = () => {
      if (frame !== 0 || still.matches) {
        return;
      }
      last = performance.now();
      frame = requestAnimationFrame(step);
    };
    paint();
    wake.current();
    const resized = new ResizeObserver(paint);
    resized.observe(element);
    return () => {
      resized.disconnect();
      cancelAnimationFrame(frame);
      wake.current = null;
    };
  }, [locale]);
  useEffect(() => {
    wanted.current = lit ? 1 : 0;
    wake.current?.();
  }, [lit]);
  return (
    <span {...stylex.props(styles.cover)}>
      <canvas
        aria-hidden="true"
        ref={canvas}
        {...stylex.props(styles.canvas)}
      />
    </span>
  );
};
