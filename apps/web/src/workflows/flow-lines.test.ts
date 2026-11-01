import { describe, expect, it } from "vite-plus/test";

import { flowWires, lines, route } from "./flow-lines.ts";
import type { Box, Placed } from "./flow-lines.ts";

// The lines between a drawing's blocks (prototype `lib/flow-lines.test.ts`):
// straight on a row, round at a turn, under a row to the next one, and
// between two frames side by side in the room between them.

const box = (
  left: number,
  top: number,
  width: number,
  height: number
): Box => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

const block = (
  id: string,
  at: Box,
  order: number,
  foot = at.bottom
): Placed => ({
  id,
  box: at,
  foot,
  order,
});

const find = (wires: { key: string; d: string }[], key: string): string =>
  wires.find((wire) => wire.key === key)?.d ?? "";

/** Every number of a path, as pairs. */
const points = (d: string): number[][] => {
  const numbers = (d.match(/-?\d+(?:\.\d+)?/gu) ?? []).map(Number);
  const pairs: number[][] = [];
  for (let index = 0; index < numbers.length; index += 2) {
    pairs.push(numbers.slice(index, index + 2));
  }
  return pairs;
};

describe(route, () => {
  it("is straight between two points and round at a turn", () => {
    expect(
      route([
        [0, 0],
        [100, 0],
      ])
    ).toBe("M 0 0 L 100 0");
    expect(
      route([
        [0, 0],
        [100, 0],
        [100, 100],
      ])
    ).toBe("M 0 0 L 84 0 Q 100 0 100 16 L 100 100");
  });

  it("is never rounder than its stretches have room for: a stretch between two turns is shared by both", () => {
    expect(
      route([
        [0, 0],
        [100, 0],
        [100, 20],
        [0, 20],
      ])
    ).toBe("M 0 0 L 90 0 Q 100 0 100 10 L 100 10 Q 100 20 90 20 L 0 20");
    expect(
      route([
        [0, 0],
        [12, 0],
        [12, 100],
      ])
    ).toBe("M 0 0 L 0 0 Q 12 0 12 12 L 12 100");
  });

  it("leaves out a point said twice, and is nothing for no points", () => {
    expect(
      route([
        [0, 0],
        [0, 0],
        [50, 0],
      ])
    ).toBe("M 0 0 L 50 0");
    expect(route([])).toBe("");
  });
});

describe(flowWires, () => {
  const first = block("a", box(0, 0, 100, 60), 0);
  const second = block("b", box(132, 10, 100, 40), 1, 60);

  it("draws a straight line between two blocks on one row, at the first one's middle", () => {
    const wires = flowWires([first, second]);
    expect(wires.map(({ key }) => key)).toStrictEqual(["to:b"]);
    expect(find(wires, "to:b")).toBe(
      `M ${100 + lines.gap} 30 L ${132 - lines.gap} 30`
    );
  });

  it("takes a line to the next row out of its row, under it, back to the start and down into the block", () => {
    const below = block("c", box(0, 108, 100, 60), 2);
    const through = points(find(flowWires([first, second, below]), "to:c"));
    expect(through.some(([, y]) => y === 60 + lines.under)).toBeTruthy();
    expect(through.some(([x]) => x === 0 - lines.lead)).toBeTruthy();
    expect(through.at(-1)).toStrictEqual([0 - lines.gap, 138]);
  });

  it("keeps the line back in the middle between two rows that stand close", () => {
    const near = block("c", box(0, 84, 100, 60), 2);
    const through = points(find(flowWires([first, second, near]), "to:c"));
    expect(through.some(([, y]) => y === 72)).toBeTruthy();
    expect(through.every(([, y]) => y !== 60 + lines.under)).toBeTruthy();
  });

  it("turns between two frames side by side in the room between them, not on the next frame's own edge", () => {
    const left = {
      ...block("a", box(40, 300, 100, 60), 0),
      frame: box(0, 0, 400, 400),
    };
    const right = {
      ...block("b", box(504, 40, 100, 60), 1),
      frame: box(456, 0, 400, 400),
    };
    const through = points(find(flowWires([left, right]), "to:b"));
    expect(through.some(([x]) => x === 428)).toBeTruthy();
    expect(through.every(([x]) => x !== 504 - lines.lead)).toBeTruthy();
  });
});
