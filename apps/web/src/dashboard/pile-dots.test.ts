import { describe, expect, it } from "vite-plus/test";

import {
  dotAt,
  FAREWELL,
  FAREWELL_ENDS,
  fieldOf,
  goesAt,
  PITCH,
} from "./pile-dots.ts";

// The dots the pile's last card goes as (pile-dots.ts): pure numbers.

describe("the card's dots", () => {
  it("fill a card at the print's spacing, the same dots every time", () => {
    const dots = fieldOf(600, 120);
    expect(dots.length).toBeGreaterThan((600 / PITCH) * (120 / PITCH) * 0.95);
    expect(
      dots.every((dot) => dot.x > 0 && dot.x < 600 && dot.y > 0 && dot.y < 120)
    ).toBeTruthy();
    expect(fieldOf(600, 120)).toStrictEqual(dots);
  });

  it("leave the card's round corners empty", () => {
    const dots = fieldOf(600, 120, [], 24);
    expect(dots.some((dot) => dot.x < 6 && dot.y < 6)).toBeFalsy();
    expect(
      dots.some((dot) => dot.x < 6 && dot.y > 50 && dot.y < 70)
    ).toBeTruthy();
  });

  it("print in ink only where something stood", () => {
    const dots = fieldOf(600, 120, [{ x: 24, y: 24, width: 200, height: 30 }]);
    const inked = dots.filter((dot) => dot.inked);
    expect(inked.length).toBeGreaterThan(0);
    expect(
      inked.every(
        (dot) => dot.x >= 24 && dot.x <= 224 && dot.y >= 24 && dot.y <= 54
      )
    ).toBeTruthy();
    expect(fieldOf(600, 120).some((dot) => dot.inked)).toBeFalsy();
  });
});

describe("the wave", () => {
  const width = 600;
  const dots = fieldOf(width, 120);

  it("runs from left to right: a dot on the left lets go before one on the right", () => {
    const average = (of: typeof dots) =>
      of.reduce((sum, dot) => sum + goesAt(dot, width), 0) / of.length;
    expect(average(dots.filter((dot) => dot.x < 60))).toBeLessThan(
      average(dots.filter((dot) => dot.x > 540))
    );
  });

  it("has every dot up before the first lets go, and every dot gone by the end", () => {
    for (const dot of dots) {
      expect(goesAt(dot, width)).toBeGreaterThanOrEqual(
        FAREWELL.up + FAREWELL.hold
      );
      expect(dotAt(dot, width, FAREWELL.up).there).toBe(1);
      expect(dotAt(dot, width, FAREWELL_ENDS).there).toBe(0);
    }
  });

  it("starts with nothing there, and moves a dot only once it has let go", () => {
    for (const dot of dots.slice(0, 200)) {
      expect(dotAt(dot, width, 0).there).toBe(0);
      const standing = dotAt(dot, width, goesAt(dot, width));
      expect(standing).toMatchObject({ there: 1, dx: 0, heat: 0 });
      expect(standing.dy).toBeCloseTo(0);
      const going = dotAt(dot, width, goesAt(dot, width) + FAREWELL.go / 4);
      expect(going.dy).toBeLessThan(0);
      expect(going.heat).toBeGreaterThan(0);
    }
  });
});
