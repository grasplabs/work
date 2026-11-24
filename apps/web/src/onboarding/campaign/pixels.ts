// Concepts only: what the campaign's drawings share. The brand draws its
// pictures in exact pixels with dithered shading, in the seven stops of
// the light (Damsko's brand book); here on a canvas, each colour read from
// its token as the page resolves it (`getComputedStyle`), never a copy of
// the palette, so light and dark follow the page.
import { useEffect, useRef } from "react";
import type { RefObject } from "react";

/** The brand's stops, as Damsko's tokens name them. */
export type Stop = "paper" | "lime" | "sea" | "mint" | "pine" | "ink" | "night";

/** The page's own ground and its quiet edge, for drawings that sit on it. */
export type Ground =
  | "background"
  | "border"
  | "muted-foreground"
  | "foreground";

export type Tone = Stop | Ground;

const variable = (tone: Tone): string =>
  tone === "background" ||
  tone === "border" ||
  tone === "muted-foreground" ||
  tone === "foreground"
    ? `--damsko-${tone}`
    : `--damsko-brand-${tone}`;

/**
 * Every tone as the page resolves it now. A token may be `light-dark(…)`,
 * which a canvas can't read: each is resolved through the `color` of a
 * probe beside the canvas, where the page's light or dark applies.
 */
export const readTones = (element: Element): Record<Tone, string> => {
  const probe = document.createElement("span");
  probe.hidden = true;
  element.parentElement?.append(probe);
  const read = (tone: Tone): string => {
    probe.style.color = `var(${variable(tone)})`;
    return getComputedStyle(probe).color;
  };
  const resolved: Record<Tone, string> = {
    paper: read("paper"),
    lime: read("lime"),
    sea: read("sea"),
    mint: read("mint"),
    pine: read("pine"),
    ink: read("ink"),
    night: read("night"),
    background: read("background"),
    border: read("border"),
    "muted-foreground": read("muted-foreground"),
    foreground: read("foreground"),
  };
  probe.remove();
  return resolved;
};

/** The 4x4 Bayer matrix, as thresholds from 0 to 1: the brand's dither. */
const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
export const bayerAt = (x: number, y: number): number =>
  ((bayer[(x % 4) + (y % 4) * 4] ?? 0) + 0.5) / 16;

const fract = (value: number): number => value - Math.floor(value);

/** A number from 0 to 1 for a cell, always the same for the same cell. */
export const hash = (x: number, y: number, seed = 0): number =>
  fract(Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43_758.5453);

/** A seeded random sequence from 0 to 1 (Park and Miller's), the same for the same seed. */
export const seeded = (seed: number): (() => number) => {
  const modulus = 2_147_483_647;
  let state = (Math.abs(Math.floor(seed)) % (modulus - 1)) + 1;
  return () => {
    state = (state * 16_807) % modulus;
    return (state - 1) / (modulus - 1);
  };
};

/** Paints one cell of the grid. */
export type Put = (x: number, y: number, tone: Tone, alpha?: number) => void;

/**
 * A canvas drawn cell by cell: `draw` is given the grid's size and a way
 * to paint a cell, and runs again when the box resizes or the page turns
 * light or dark. It draws once; nothing moves.
 */
export const usePixels = (
  cell: number | ((width: number) => number),
  draw: (columns: number, rows: number, put: Put) => void
): RefObject<HTMLCanvasElement | null> => {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (element === null) {
      return () => {
        // Nothing drawn, nothing to stop.
      };
    }
    const paint = () => {
      const context = element.getContext("2d");
      if (context === null) {
        return;
      }
      const { width, height } = element.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio, 2);
      element.width = Math.round(width * ratio);
      element.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const tones = readTones(element);
      const size = typeof cell === "number" ? cell : cell(width);
      const columns = Math.floor(width / size);
      const rows = Math.floor(height / size);
      const left = (width - columns * size) / 2;
      const top = height - rows * size;
      draw(columns, rows, (x, y, tone, alpha = 1) => {
        context.globalAlpha = alpha;
        context.fillStyle = tones[tone];
        context.fillRect(left + x * size, top + y * size, size, size);
      });
      context.globalAlpha = 1;
    };
    paint();
    const resized = new ResizeObserver(paint);
    resized.observe(element);
    const modes = new MutationObserver(paint);
    modes.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-mode"],
    });
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", paint);
    return () => {
      resized.disconnect();
      modes.disconnect();
      scheme.removeEventListener("change", paint);
    };
  }, [cell, draw]);
  return canvas;
};
