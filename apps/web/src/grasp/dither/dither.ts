/** The ordered-dither thresholds, 0 to 15: a cell is lit while the level is above its number. */
export const BAYER: readonly (readonly number[])[] = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/** How many levels the dither has, and so how many bands a fill is cut into. */
export const LEVELS = 16;

export type DitherTexture = "pixels" | "dots";

/**
 * A cell's pitch and the square drawn in it, per texture, in CSS pixels:
 *   pixels  2px cells that fill their square, chunky
 *   dots    1px squares on a 3px pitch, fine
 */
export const GEOMETRY: Record<
  DitherTexture,
  { pitch: number; square: number }
> = {
  pixels: { pitch: 2, square: 2 },
  dots: { pitch: 3, square: 1 },
};
