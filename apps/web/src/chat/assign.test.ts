import { describe, expect, it } from "vite-plus/test";

import { leastCostPairs } from "./assign.ts";
import { seeded } from "./sign-body.ts";

// Pairing rows with columns at the least summed cost (assign.ts), ported
// with the prototype's own tests of it.

/** Every way to give each row a column of its own, for a few rows: the cheapest, by trying them all. */
const cheapestByTrying = (
  rows: number,
  columns: number,
  cost: readonly number[]
): number => {
  let best = Number.POSITIVE_INFINITY;
  const used = Array.from({ length: columns }, () => false);
  const walk = (row: number, sum: number): void => {
    if (sum >= best) {
      return;
    }
    if (row === rows) {
      best = sum;
      return;
    }
    for (let column = 0; column < columns; column += 1) {
      if (used[column] === false) {
        used[column] = true;
        walk(row + 1, sum + (cost[row * columns + column] ?? 0));
        used[column] = false;
      }
    }
  };
  walk(0, 0);
  return best;
};

describe(leastCostPairs, () => {
  it("finds the cheapest pairing, as trying every pairing does", () => {
    const random = seeded(3);
    for (let round = 0; round < 60; round += 1) {
      const rows = 1 + Math.floor(random() * 6);
      const columns = rows + Math.floor(random() * 3);
      const cost = Array.from({ length: rows * columns }, () =>
        Math.round(random() * 100)
      );
      const pairs = [...leastCostPairs(rows, columns, cost)];
      expect(new Set(pairs).size).toBe(rows);
      const sum = pairs.reduce(
        (total, column, row) => total + (cost[row * columns + column] ?? 0),
        0
      );
      expect(sum).toBe(cheapestByTrying(rows, columns, cost));
    }
  });

  it("pairs points with the places nearest to them, without paths that cross", () => {
    // Four points on a line, and four places on a line beside it, given in
    // another order.
    const points = [0, 1, 2, 3];
    const places = [3.1, 0.1, 2.1, 1.1];
    const cost = points.flatMap((point) =>
      places.map((place) => (point - place) ** 2)
    );
    expect([...leastCostPairs(4, 4, cost)]).toStrictEqual([1, 3, 2, 0]);
  });

  it("refuses more rows than columns", () => {
    expect(() => leastCostPairs(3, 2, new Float32Array(6))).toThrow(
      "at least as many columns as rows"
    );
  });
});
