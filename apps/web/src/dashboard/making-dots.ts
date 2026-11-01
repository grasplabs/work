import { PITCH } from "./pile-dots.ts";
import type { FieldDot } from "./pile-dots.ts";

// A widget while Grasp makes it, as the prototype's board draws one: the
// block stands as dots in the brain's print (the pile's field,
// pile-dots.ts), and a light crosses it from left to right, again and
// again, until the widget is there. Pure: how lit a dot is at a time; the
// canvas only prints that (`making-dots.tsx`).

/** How long the light takes to cross a block, in seconds. */
export const MAKING_PASS = 1.6;

/** How wide the light is, in pixels: dots this far from its middle are dark. */
export const MAKING_REACH = 48;

/**
 * How lit `dot` is at `now` (seconds), 0 to 1, on a block `width` wide:
 * most where the light stands, less the further it is, a little earlier
 * or later by the dot's own number, so the light has no hard edge.
 */
export const makingLight = (
  dot: Pick<FieldDot, "x" | "seed">,
  width: number,
  now: number
): number => {
  const share = (now % MAKING_PASS) / MAKING_PASS;
  // From just before the left edge to just past the right one.
  const middle = share * (width + 2 * MAKING_REACH) - MAKING_REACH;
  const off = Math.abs(dot.x + (dot.seed - 0.5) * 2 * PITCH - middle);
  return Math.max(0, 1 - off / MAKING_REACH);
};
