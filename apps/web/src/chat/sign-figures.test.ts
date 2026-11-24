import { describe, expect, it } from "vite-plus/test";

import { leastCostPairs } from "./assign.ts";
import {
  SIGN_FIGURES,
  SIGN_PITCH,
  signDots,
  signFigure,
  signSlots,
} from "./sign-figures.ts";
import type { SignFigure } from "./sign-figures.ts";

// The figures of Grasp's sign and where its dots go in each
// (sign-figures.ts): pure numbers, ported with the prototype's own tests of
// them.

const others = SIGN_FIGURES.filter((figure) => figure !== "head");
/** A place as a word, to tell places apart. */
const key = (x: number, y: number) => `${x.toFixed(4)},${y.toFixed(4)}`;
const at = (values: ArrayLike<number>, index: number): number =>
  values[index] ?? 0;
const slotsIn = (count: number) =>
  Array.from({ length: count }, (_, slot) => slot);

describe("the figures of the sign", () => {
  it.each(SIGN_FIGURES)(
    "are printed inside the square, on dots that stand apart (%s)",
    (figure) => {
      const dots = signFigure(figure);
      expect(dots.length).toBeGreaterThan(30);
      const widest = Math.max(
        ...dots.map((dot) => Math.max(Math.abs(dot.x), Math.abs(dot.y)))
      );
      expect(widest).toBeLessThanOrEqual(1.02);
      expect(dots.every((dot) => dot.ink > 0 && dot.ink <= 1)).toBeTruthy();
      expect(
        dots.every((dot) => dot.along >= 0 && dot.along <= 1)
      ).toBeTruthy();
      // No two dots of a figure nearer than a little under the spacing
      // they are printed on.
      let nearest = Number.POSITIVE_INFINITY;
      for (const [index, a] of dots.entries()) {
        for (const b of dots.slice(index + 1)) {
          nearest = Math.min(nearest, Math.hypot(a.x - b.x, a.y - b.y));
        }
      }
      expect(nearest).toBeGreaterThan(SIGN_PITCH * 0.8);
    }
  );

  it("have the head as the largest, so every figure can be made of its dots", () => {
    for (const figure of others) {
      expect(signFigure(figure).length).toBeLessThanOrEqual(signDots());
    }
  });

  it("draw the pen in two parts, its line first, and the lines of text one part each", () => {
    expect(new Set(signFigure("pen").map((dot) => dot.part))).toStrictEqual(
      new Set([0, 1])
    );
    expect(new Set(signFigure("lines").map((dot) => dot.part))).toStrictEqual(
      new Set([0, 1, 2, 3])
    );
    expect(new Set(signFigure("flow").map((dot) => dot.part))).toStrictEqual(
      new Set([0, 1, 2])
    );
  });
});

describe("where the dots go in a figure", () => {
  const homes = signFigure("head");
  const homeX = (slot: number) => homes[slot]?.x ?? 0;
  const homeY = (slot: number) => homes[slot]?.y ?? 0;
  const far = (figure: SignFigure, slot: number) => {
    const table = signSlots(figure);
    return (
      (at(table.x, slot) - homeX(slot)) ** 2 +
      (at(table.y, slot) - homeY(slot)) ** 2
    );
  };
  const shownIn = (figure: SignFigure) => {
    const table = signSlots(figure);
    return slotsIn(table.count).filter((slot) => table.shown[slot] === 1);
  };

  it.each(SIGN_FIGURES)(
    "gives every place of the figure exactly one dot that is seen, and puts the rest unseen on a place (%s)",
    (figure) => {
      const table = signSlots(figure);
      const places = signFigure(figure);
      expect(table.count).toBe(signDots());
      const seen = new Map<string, number>();
      const all = new Set(places.map((place) => key(place.x, place.y)));
      for (const slot of slotsIn(table.count)) {
        const place = key(at(table.x, slot), at(table.y, slot));
        expect(all.has(place)).toBeTruthy();
        if (table.shown[slot] === 1) {
          seen.set(place, (seen.get(place) ?? 0) + 1);
        }
      }
      expect(seen.size).toBe(places.length);
      expect([...seen.values()].every((count) => count === 1)).toBeTruthy();
    }
  );

  it("leaves the head as it is", () => {
    const table = signSlots("head");
    for (const [slot, home] of homes.entries()) {
      expect(at(table.x, slot)).toBeCloseTo(home.x, 5);
      expect(at(table.y, slot)).toBeCloseTo(home.y, 5);
      expect(table.shown[slot]).toBe(1);
    }
  });

  it.each(others)(
    "has no two dots that would travel less from the head by trading places: no paths cross (%s)",
    (figure) => {
      const table = signSlots(figure);
      const shown = shownIn(figure);
      for (const a of shown) {
        for (const b of shown.filter((other) => other > a)) {
          const kept = far(figure, a) + far(figure, b);
          const traded =
            (at(table.x, b) - homeX(a)) ** 2 +
            (at(table.y, b) - homeY(a)) ** 2 +
            (at(table.x, a) - homeX(b)) ** 2 +
            (at(table.y, a) - homeY(b)) ** 2;
          expect(kept).toBeLessThanOrEqual(traded + 1e-6);
        }
      }
    }
  );

  it.each(others)(
    "sends a dot the figure does not need to the place nearest its home (%s)",
    (figure) => {
      const table = signSlots(figure);
      const places = signFigure(figure);
      const unseen = slotsIn(table.count).filter(
        (slot) => table.shown[slot] === 0
      );
      for (const slot of unseen) {
        const nearest = Math.min(
          ...places.map(
            (place) =>
              (place.x - homeX(slot)) ** 2 + (place.y - homeY(slot)) ** 2
          )
        );
        expect(far(figure, slot)).toBeCloseTo(nearest, 5);
      }
    }
  );

  it.each(others)(
    "keeps the dots that are seen close to their homes: no dot crosses the sign (%s)",
    (figure) => {
      const longest = Math.max(
        ...shownIn(figure).map((slot) => Math.sqrt(far(figure, slot)))
      );
      // The square is 2 wide: the longest journey of a dot that is seen
      // stays well under half of it.
      expect(longest).toBeLessThan(0.9);
    }
  );

  it("from one figure into another, moves the dots that stay seen about as little as the best pairing of the two would", () => {
    for (const from of others) {
      for (const to of others.filter((figure) => figure !== from)) {
        const a = signSlots(from);
        const b = signSlots(to);
        const both = slotsIn(a.count).filter(
          (slot) => a.shown[slot] === 1 && b.shown[slot] === 1
        );
        const ours = both.reduce(
          (sum, slot) =>
            sum +
            (at(a.x, slot) - at(b.x, slot)) ** 2 +
            (at(a.y, slot) - at(b.y, slot)) ** 2,
          0
        );
        // The best any pairing of those same places could do.
        const cost = new Float32Array(both.length * both.length);
        for (const [row, start] of both.entries()) {
          for (const [column, end] of both.entries()) {
            cost[row * both.length + column] =
              (at(a.x, start) - at(b.x, end)) ** 2 +
              (at(a.y, start) - at(b.y, end)) ** 2;
          }
        }
        const pairs = [...leastCostPairs(both.length, both.length, cost)];
        const best = pairs.reduce(
          (sum, column, row) => sum + at(cost, row * both.length + column),
          0
        );
        expect(ours).toBeLessThanOrEqual(best * 1.6 + 0.2);
      }
    }
  });
});
