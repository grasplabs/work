// Where a dither fill's bands start and end, along any direction: from the value's end (most lit)
// to the floor (least lit). Each inner edge sits on a cell's edge in the drawing's own grid, so no
// cell is cut in half and no seam shows where two levels meet. Pure, so it is tested
// (scripts/chart-layout.test.ts).
import { LEVELS } from "./dither";

/**
 * The LEVELS + 1 edges of a fill from `lit` (the value) to `floor`, either way round: `lit` may
 * stand above, below, left or right of `floor`. The first and last are exact; the rest snap to
 * the pitch.
 */
export const ditherEdges = (
  lit: number,
  floor: number,
  pitch: number
): number[] =>
  Array.from({ length: LEVELS + 1 }, (_, index) => {
    if (index === 0) {
      return lit;
    }
    if (index === LEVELS) {
      return floor;
    }
    return Math.round((lit + (index * (floor - lit)) / LEVELS) / pitch) * pitch;
  });
