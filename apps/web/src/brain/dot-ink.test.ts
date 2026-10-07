import { describe, expect, it } from "vite-plus/test";

import {
  DOT_MOST,
  dotAlpha,
  dotShare,
  LOOK,
  patchAt,
  shimmerAt,
  swayAt,
  tideOut,
} from "./dot-ink.ts";

// How one dot of the brain prints and lives (dot-ink.ts): pure numbers.

/** Shares from 0 to 1 in tenths: every ink and every grain a dot can have, near enough. */
const SHARES = Array.from({ length: 11 }, (_, index) => index / 10);

describe("how a dot prints", () => {
  it("never prints a dot so large that it touches its neighbour", () => {
    for (const printed of SHARES) {
      for (const grain of SHARES) {
        for (const inked of [true, false]) {
          const share = dotShare(printed, inked, grain);
          expect(share).toBeGreaterThan(0);
          // Two neighbours, each half the spacing wide, would touch.
          expect(share).toBeLessThan(0.5);
          expect(share).toBeLessThanOrEqual(DOT_MOST);
        }
      }
    }
  });

  it("prints darker ink and a larger grain as a larger dot", () => {
    expect(dotShare(1, true, 0.3)).toBeGreaterThan(dotShare(0.2, true, 0.3));
    expect(dotShare(0.6, true, 0.9)).toBeGreaterThan(dotShare(0.6, true, 0.1));
  });

  it("prints a dot that is still grey smaller and fainter than an inked one", () => {
    for (const printed of SHARES) {
      expect(dotShare(printed, false, 0.3)).toBeLessThan(
        dotShare(printed, true, 0.3)
      );
      expect(dotAlpha(printed, 0.6, false)).toBeLessThan(
        dotAlpha(printed, 0.6, true)
      );
      expect(dotAlpha(printed, 0.6, false)).toBeLessThan(0.5);
      expect(dotAlpha(printed, 1, true)).toBeLessThanOrEqual(1);
    }
  });
});

describe("how a dot lives", () => {
  it("breathes a little and sways faintly, never more", () => {
    for (const now of [0, 1.7, 12.3, 480]) {
      for (const seed of SHARES) {
        expect(shimmerAt(seed, now)).toBeGreaterThanOrEqual(0.84);
        expect(shimmerAt(seed, now)).toBeLessThanOrEqual(1);
        // Far less than the distance to the next dot, so rows stay rows.
        expect(Math.abs(swayAt(0.4, seed, now))).toBeLessThan(0.01);
      }
    }
  });

  it("fades in patches that come and go, and shows all of itself when they have receded", () => {
    const out = Array.from({ length: 400 }, (_, index) => tideOut(index / 4));
    expect(Math.min(...out)).toBe(0);
    expect(Math.max(...out)).toBeCloseTo(LOOK.tide, 2);
    const places: [number, number][] = [
      [0, 0],
      [0.8, 0.8],
      [-0.5, -0.9],
    ];
    for (const [x, y] of places) {
      for (const now of [0, 9, 31, 200]) {
        expect(patchAt(x, y, now)).toBeGreaterThanOrEqual(0);
        expect(patchAt(x, y, now)).toBeLessThanOrEqual(1);
        // A voice lifts the patches: more shows, never less.
        expect(patchAt(x, y, now, 0.6)).toBeGreaterThanOrEqual(
          patchAt(x, y, now)
        );
      }
    }
  });
});
