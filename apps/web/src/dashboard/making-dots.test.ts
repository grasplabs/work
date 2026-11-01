import { describe, expect, it } from "vite-plus/test";

import { MAKING_PASS, MAKING_REACH, makingLight } from "./making-dots.ts";

// The light that crosses a widget's dots while Grasp makes it
// (making-dots.ts): pure numbers.

const width = 400;

/** Where the light is brightest at `now`, among dots of an even grain. */
const brightestAt = (now: number): number => {
  let best = { x: 0, light: -1 };
  for (let x = 0; x <= width; x += 2) {
    const light = makingLight({ x, seed: 0.5 }, width, now);
    if (light > best.light) {
      best = { x, light };
    }
  }
  return best.x;
};

describe("the light over a widget being made", () => {
  it("crosses the block from left to right, and starts again", () => {
    const early = brightestAt(MAKING_PASS * 0.3);
    const later = brightestAt(MAKING_PASS * 0.7);
    expect(early).toBeLessThan(later);
    expect(brightestAt(MAKING_PASS * 1.3)).toBe(early);
  });

  it("lights only the dots near it, at most fully", () => {
    const now = MAKING_PASS / 2;
    const middle = brightestAt(now);
    const near = makingLight({ x: middle, seed: 0.5 }, width, now);
    const far = makingLight(
      { x: middle + MAKING_REACH * 2, seed: 0.5 },
      width,
      now
    );
    expect({ near: near > 0.9 && near <= 1, far }).toStrictEqual({
      near: true,
      far: 0,
    });
  });
});
