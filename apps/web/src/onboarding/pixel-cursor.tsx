import { useSyncExternalStore } from "react";

// The pixel cursor the setup's helpers point with, as colleagues' cursors
// move over a shared canvas: a stepped arrow in its own colour with a
// label under it, its corners stepped too. The documents step's visitors
// (document-visitors.tsx) and Stephen writing the team step's message
// (message-compose.tsx) draw it, and move it with these few helpers: a frame
// at a time, a hand's curve, nothing at all under reduced motion.

/** The arrow, a cell to each character: the outline (o), its colour (x). Its tip at the top left. */
export const arrowCells = [
  "o",
  "oo",
  "oxo",
  "oxxo",
  "oxxxo",
  "oxxxxo",
  "oxxxxxo",
  "oxxxxxxo",
  "oxxxxxxxo",
  "oxxxxxxxxo",
  "oxxxxxoooo",
  "oxxoxxo",
  "oxo.oxxo",
  "oo..oxxo",
  "o....oxxo",
  ".....oxxo",
  "......oo",
];

/** A cell's side in the arrow, in CSS pixels. */
export const arrowCell = 2;

/** A line's characters as a reader sees them, accents and all: what is typed a key at a time, or a drawing's cells. */
const segments = new Intl.Segmenter();
export const keysOf = (text: string): string[] =>
  Array.from(segments.segment(text), ({ segment }) => segment);

/** The arrow's cells, drawn into the visitor's own drawing. */
export const Arrow = () => (
  <>
    {arrowCells.flatMap((row, y) =>
      keysOf(row).map((mark, x) =>
        mark === "." ? null : (
          <rect
            fill={mark === "o" ? "white" : "currentColor"}
            height={arrowCell}
            key={`${String(x)},${String(y)}`}
            width={arrowCell}
            x={x * arrowCell}
            y={y * arrowCell}
          />
        )
      )
    )}
  </>
);

const stillQuery = "(prefers-reduced-motion: reduce)";

/** Whether the person asked for less motion, right now. */
export const isStill = (): boolean =>
  typeof matchMedia !== "function" || matchMedia(stillQuery).matches;

const onStill = (changed: () => void): (() => void) => {
  const query = matchMedia(stillQuery);
  query.addEventListener("change", changed);
  return () => {
    query.removeEventListener("change", changed);
  };
};

export const useStill = (): boolean =>
  useSyncExternalStore(
    onStill,
    () => matchMedia(stillQuery).matches,
    () => true
  );

export interface Point {
  x: number;
  y: number;
}

/** Runs `each` on every frame for `ms`, with how far along it is, 0 to 1. */
export const frames = async (
  ms: number,
  signal: AbortSignal,
  each: (t: number) => void
): Promise<void> => {
  // oxlint-disable-next-line promise/avoid-new -- requestAnimationFrame has no promise form
  await new Promise<void>((resolve, reject) => {
    const start = performance.now();
    let id = 0;
    const stop = () => {
      cancelAnimationFrame(id);
      reject(new Error("Gone"));
    };
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      each(t);
      if (t < 1) {
        id = requestAnimationFrame(tick);
      } else {
        signal.removeEventListener("abort", stop);
        resolve();
      }
    };
    if (signal.aborted) {
      stop();
      return;
    }
    signal.addEventListener("abort", stop, { once: true });
    id = requestAnimationFrame(tick);
  });
};

export const wait = async (ms: number, signal: AbortSignal): Promise<void> => {
  // oxlint-disable-next-line promise/avoid-new -- setTimeout has no promise form in browsers
  await new Promise<void>((resolve, reject) => {
    let id = 0;
    const stop = () => {
      clearTimeout(id);
      reject(new Error("Gone"));
    };
    id = window.setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    if (signal.aborted) {
      stop();
      return;
    }
    signal.addEventListener("abort", stop, { once: true });
  });
};

export const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
export const easeOut = (t: number): number => 1 - (1 - t) ** 3;
export const easeIn = (t: number): number => t * t * t;

export const bezier = (
  a: Point,
  b: Point,
  c: Point,
  d: Point,
  t: number
): Point => {
  const u = 1 - t;
  const at = (p: number, q: number, r: number, s: number) =>
    u * u * u * p + 3 * u * u * t * q + 3 * u * t * t * r + t * t * t * s;
  return { x: at(a.x, b.x, c.x, d.x), y: at(a.y, b.y, c.y, d.y) };
};

export const between = (low: number, high: number): number =>
  low + Math.random() * (high - low);
