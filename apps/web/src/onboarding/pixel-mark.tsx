import type { IconData } from "@grasp-os/ui/lib/icons";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";

import { bayerAt } from "./campaign/pixels.ts";

// A brand's mark as the brand book draws pictures: in exact pixels, a
// cell for every twelfth of the mark, each cell in the brand's own colour
// where it lies (a part that follows the ink stays in the ink). Not yet
// chosen, every cell is a speck, the mark there but light; chosen, it
// fills in, cell after cell in the system's dither order, over a quarter
// of a second. Under reduced motion it is
// simply there. Drawn as an SVG of cells, so Stephen, coming to the row,
// reads this very picture and draws it large across the row's free side
// (field/marks.ts). Decoration: the row's words name the place.

const styles = stylex.create({
  mark: {
    display: "block",
    flexShrink: 0,
    width: "2.25rem",
    height: "2.25rem",
  },
});

/** How many cells across and down. */
const CELLS = 12;

/** How much of the mark stands whole before it is chosen: none, every cell a speck. */
const GHOST = 0;

/** A cell's speck, before the mark is chosen: its shape is there, light. */
const SPECK = 0.5;

/** How long it takes to fill in, in ms. */
const FILL_MS = 240;

/** A colour that stands for the ink while the mark is read. */
const INK = "rgb(1, 2, 3)";

interface Cell {
  x: number;
  y: number;
  fill: string;
}

const read = new WeakMap<IconData, Cell[]>();

const numbersIn = /-?[\d.]+/gu;

/** A cell's square, a little less than the cell: the pixels stand apart, as the brand draws them. */
const SQUARE = 0.86;

/** The transform a brand mark's part carries: "translate(x y) scale(s)", or none. */
const placeOf = (transform: unknown): [number, number, number] => {
  if (typeof transform !== "string") {
    return [0, 0, 1];
  }
  const numbers = transform.match(numbersIn)?.map(Number) ?? [];
  const [x = 0, y = 0, scale = 1] = numbers;
  return [x, y, scale];
};

/** The mark as cells, read once: which are lit, and in which colour. None where nothing can draw. */
const cellsOf = (icon: IconData): Cell[] => {
  const known = read.get(icon);
  if (known !== undefined) {
    return known;
  }
  // Drawn on a server (a test), there is nothing to read the mark with.
  if (typeof document === "undefined") {
    return [];
  }
  const scale = 8;
  const side = CELLS * scale;
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) {
    return [];
  }
  for (const [, part] of icon) {
    const { d, fill, transform } = part;
    if (typeof d !== "string") {
      continue;
    }
    const [x, y, s] = placeOf(transform);
    context.setTransform(
      (side / 24) * s,
      0,
      0,
      (side / 24) * s,
      (side / 24) * x,
      (side / 24) * y
    );
    context.fillStyle =
      typeof fill !== "string" || fill === "currentColor" ? INK : fill;
    // A canvas's fill, not an array's: bound, so it reads as the canvas call it is.
    const paint = context.fill.bind(context);
    paint(new Path2D(d));
  }
  const { data } = context.getImageData(0, 0, side, side);
  const cells: Cell[] = [];
  for (let y = 0; y < CELLS; y += 1) {
    for (let x = 0; x < CELLS; x += 1) {
      // The colour that covers most of the cell, if enough of it is covered.
      const counts = new Map<string, number>();
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const at = ((y * scale + dy) * side + x * scale + dx) * 4;
          if ((data[at + 3] ?? 0) > 200) {
            const colour = `rgb(${data[at]}, ${data[at + 1]}, ${data[at + 2]})`;
            counts.set(colour, (counts.get(colour) ?? 0) + 1);
          }
        }
      }
      const [best] = [...counts.entries()].toSorted((a, b) => b[1] - a[1]);
      if (best !== undefined && best[1] > scale * scale * 0.4) {
        cells.push({ x, y, fill: best[0] === INK ? "currentColor" : best[0] });
      }
    }
  }
  read.set(icon, cells);
  return cells;
};

/** How much of the mark stands, eased toward `whole` (1) or the ghost. */
const usePresence = (whole: boolean): number => {
  const target = whole ? 1 : GHOST;
  const [presence, setPresence] = useState(target);
  const from = useRef(target);
  // Drawn on a server (a test) there is no motion to ask about: it stands still.
  const still =
    typeof matchMedia !== "function" ||
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  useEffect(() => {
    if (still) {
      from.current = target;
      return () => {
        // Nothing moving.
      };
    }
    const start = from.current;
    const begun = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - begun) / FILL_MS);
      const next = start + (target - start) * (1 - (1 - t) ** 3);
      from.current = next;
      setPresence(next);
      if (t < 1) {
        frame = requestAnimationFrame(step);
      }
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [still, target]);
  return still ? target : presence;
};

export const PixelMark = ({
  icon,
  whole,
}: {
  icon: IconData;
  /** The place is chosen: the mark stands whole. */
  whole: boolean;
}) => {
  const presence = usePresence(whole);
  const cells = cellsOf(icon);
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${CELLS} ${CELLS}`}
      {...stylex.props(styles.mark)}
    >
      {cells.map(({ x, y, fill }) => {
        // Whole once the filling passes the cell's place in the dither, a speck till then.
        const side = bayerAt(x, y) < presence ? SQUARE : SPECK;
        return (
          <rect
            fill={fill}
            height={side}
            key={`${x}-${y}`}
            width={side}
            x={x + (1 - side) / 2}
            y={y + (1 - side) / 2}
          />
        );
      })}
    </svg>
  );
};
