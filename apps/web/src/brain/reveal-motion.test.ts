import { describe, expect, it } from "vite-plus/test";

import { curveIndex, pairAlongCurve } from "./reveal-motion.ts";

describe(curveIndex, () => {
  it("visits every cell once, each step to a neighbouring cell", () => {
    const order = 3;
    const n = 2 ** order;
    const cells: [number, number][] = [];
    for (let x = 0; x < n; x += 1) {
      for (let y = 0; y < n; y += 1) {
        cells[curveIndex((x + 0.5) / n, (y + 0.5) / n, order)] = [x, y];
      }
    }
    expect(cells.filter(Boolean)).toHaveLength(n * n);
    for (let at = 1; at < cells.length; at += 1) {
      const [ax = 0, ay = 0] = cells[at - 1] ?? [];
      const [bx = 0, by = 0] = cells[at] ?? [];
      expect(Math.abs(ax - bx) + Math.abs(ay - by)).toBe(1);
    }
  });
});

/** A square of points, `size` a side, `scale` apart, from `offset`. */
const grid = (size: number, scale: number, offset: number) => {
  const x: number[] = [];
  const y: number[] = [];
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      x.push(offset + column * scale);
      y.push(offset + row * scale);
    }
  }
  return { x, y };
};

describe(pairAlongCurve, () => {
  it("gives every target one dot when there are as many of each", () => {
    const pairs = pairAlongCurve(grid(8, 1, 0), grid(8, 30, 100));
    expect([...pairs].toSorted((a, b) => a - b)).toStrictEqual(
      Array.from({ length: 64 }, (_, at) => at)
    );
  });

  it("keeps a dot in the same part of the picture as it grows", () => {
    const dots = grid(8, 1, 0);
    const targets = grid(8, 30, 100);
    const pairs = pairAlongCurve(dots, targets);
    for (const [at, pair] of pairs.entries()) {
      const left = (dots.x[at] ?? 0) < 4;
      const top = (dots.y[at] ?? 0) < 4;
      expect((targets.x[pair] ?? 0) < 100 + 4 * 30).toBe(left);
      expect((targets.y[pair] ?? 0) < 100 + 4 * 30).toBe(top);
    }
  });

  it("leaves the spare dots unmatched when there are fewer targets", () => {
    const pairs = pairAlongCurve(grid(8, 1, 0), grid(4, 10, 0));
    expect(pairs.filter((pair) => pair >= 0)).toHaveLength(16);
    expect(new Set(pairs.filter((pair) => pair >= 0)).size).toBe(16);
    expect(pairs.filter((pair) => pair < 0)).toHaveLength(48);
  });

  it("uses as many targets as there are dots when there are more targets", () => {
    const pairs = pairAlongCurve(grid(4, 1, 0), grid(8, 10, 0));
    expect(new Set(pairs).size).toBe(16);
    expect(pairs.every((pair) => pair >= 0)).toBeTruthy();
  });
});
