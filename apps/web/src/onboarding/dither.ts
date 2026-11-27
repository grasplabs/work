import { BAYER_MATRIX, DITHER_LEVELS } from "@grasp-os/ui/lib/utils";

// The brand's dither, as the setup's pictures draw it cell by cell: the
// field, the flags, the pages, the documents and the campaign's week.

/** A cell's threshold in the system's dither, 0 to 1; any whole number, negative too. */
export const bayerAt = (x: number, y: number): number =>
  ((BAYER_MATRIX[((y % 4) + 4) % 4]?.[((x % 4) + 4) % 4] ?? 0) + 0.5) /
  DITHER_LEVELS;

/** A number from 0 to 1, always the same for the same inputs: a little chance. */
export const chance = (x: number, y: number, seed: number): number => {
  const value = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43_758.5453;
  return value - Math.floor(value);
};
