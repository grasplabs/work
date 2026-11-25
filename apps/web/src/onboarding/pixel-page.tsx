import { BAYER_MATRIX, DITHER_LEVELS } from "@grasp-os/ui/lib/utils";

import type { Kind } from "./document-pages.tsx";
import { colourOf } from "./document-pages.tsx";
import { keysOf } from "./pixel-cursor.tsx";

// A small pixel page of a kind of file, as the documents step draws them
// (document-pages.tsx): its paper in the kind's colour, what is written on
// it, its folded corner and its edge. The visitors toss it
// (document-visitors.tsx), and each document shared wears one
// (document-shelf.tsx), filling in cell by cell, in the system's one
// dither, as it is sent: `filled` from 0 (only its outline, pale) to 1.

/** What each kind of page has written on it, a character a cell: paper (.), ink (#), its folded corner (/), its edge (_). */
const pageCells: Record<Kind, string[]> = {
  pdf: [
    "......//",
    ".####./",
    "........_",
    ".#######_",
    "........_",
    ".######._",
    "........_",
    ".#######_",
    "........_",
    ".####...._",
    "_________",
  ],
  word: [
    "......//",
    ".#####./",
    "........_",
    ".#######_",
    "........_",
    ".#.####._",
    "........_",
    ".#.#####_",
    "........_",
    ".######._",
    "_________",
  ],
  sheet: [
    "......//",
    "######./",
    "#.#.#.#._",
    "#######._",
    "#.#.#.#._",
    "#######._",
    "#.#.#.#._",
    "#######._",
    "#.#.#.#._",
    "........_",
    "_________",
  ],
  slides: [
    "............",
    ".######.....",
    "............",
    "........#...",
    "..#.....#...",
    "..#..#..#...",
    "..#..#..#.#.",
    "..#..#..#.#.",
    "____________",
  ],
  text: [
    "......//",
    ".####../",
    "........_",
    ".######._",
    "...####._",
    ".#####.._",
    "...#####_",
    ".####..._",
    "........_",
    ".###....._",
    "_________",
  ],
};

/** The page's paper, ink, fold and edge, in its kind's colour; `pale` the same, barely there. */
export const mix = (hex: string, toward: number, amount: number): string => {
  const part = (at: number) => {
    const own = Number.parseInt(hex.slice(at, at + 2), 16);
    return Math.round(own + (toward - own) * amount);
  };
  return `rgb(${String(part(1))}, ${String(part(3))}, ${String(part(5))})`;
};

/** A cell's place in the dither, 0 to 1: the order the cells fill in. */
const rankAt = (x: number, y: number): number =>
  ((BAYER_MATRIX[y % 4]?.[x % 4] ?? 0) + 0.5) / DITHER_LEVELS;

/**
 * A page of `kind`, `cell` CSS pixels to a cell, filled as far as `filled`
 * (0 to 1): the cells past it in the dither stay pale, so it fills in
 * evenly all over, the way the page dithers in.
 */
export const PixelPage = ({
  kind,
  cell = 3,
  filled = 1,
}: {
  kind: Kind;
  cell?: number;
  filled?: number;
}) => {
  const cells = pageCells[kind];
  const colour = colourOf[kind];
  const wide = Math.max(...cells.map((row) => row.length));
  const fills: Record<string, string> = {
    ".": colour,
    "#": mix(colour, 255, 0.72),
    "/": mix(colour, 255, 0.35),
    _: mix(colour, 0, 0.3),
  };
  const pale = mix(colour, 255, 0.82);
  // Rows fill a little ahead toward the foot, so the page fills from the bottom up as well as all over.
  const high = cells.length;
  return (
    <svg
      aria-hidden="true"
      height={high * cell}
      shapeRendering="crispEdges"
      width={wide * cell}
    >
      {cells.flatMap((row, y) =>
        keysOf(row).map((mark, x) => {
          const due = rankAt(x, y) * 0.6 + (1 - y / high) * 0.4;
          return (
            <rect
              fill={due < filled ? (fills[mark] ?? colour) : pale}
              height={cell}
              key={`${String(x)},${String(y)}`}
              width={cell}
              x={x * cell}
              y={y * cell}
            />
          );
        })
      )}
    </svg>
  );
};
