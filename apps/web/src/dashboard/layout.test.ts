import { describe, expect, it } from "vite-plus/test";

import {
  addWidget,
  defaultWidgets,
  differsFromDefault,
  missingWidgets,
  moveWidget,
  placeWidget,
  removeWidget,
  slotAt,
} from "./layout.ts";
import type { GridShape } from "./layout.ts";

// How a person changes the widget board's layout (layout.ts): moving,
// taking off and adding widgets, whether it is still as it began, and
// which place a dragged block is over.

describe("moving a widget", () => {
  it("puts it in its new place, the ones between moving one over", () => {
    expect(placeWidget(defaultWidgets, "signals", 0)).toStrictEqual([
      "signals",
      "workflows",
      "engines",
      "runs",
    ]);
    expect(placeWidget(defaultWidgets, "workflows", 2)).toStrictEqual([
      "engines",
      "runs",
      "workflows",
      "signals",
    ]);
  });

  it("goes no further than either end", () => {
    expect(moveWidget(defaultWidgets, "workflows", -1)).toStrictEqual(
      defaultWidgets
    );
    expect(moveWidget(defaultWidgets, "runs", 5)).toStrictEqual([
      "workflows",
      "engines",
      "signals",
      "runs",
    ]);
    expect(moveWidget(defaultWidgets, "runs", -2)).toStrictEqual([
      "runs",
      "workflows",
      "engines",
      "signals",
    ]);
  });

  it("leaves the board as it is for a widget not on it", () => {
    const board = ["runs", "signals"] as const;
    expect(moveWidget(board, "engines", 1)).toStrictEqual(board);
  });
});

describe("taking off and adding widgets", () => {
  it("takes one off, and adds it back last, never twice", () => {
    const without = removeWidget(defaultWidgets, "engines");
    expect(without).toStrictEqual(["workflows", "runs", "signals"]);
    expect(missingWidgets(without)).toStrictEqual(["engines"]);
    const again = addWidget(without, "engines");
    expect(again).toStrictEqual(["workflows", "runs", "signals", "engines"]);
    expect(addWidget(again, "engines")).toStrictEqual(again);
    expect(missingWidgets(again)).toStrictEqual([]);
  });

  it("tells a board other than it began: another order, or fewer", () => {
    expect(differsFromDefault(defaultWidgets)).toBeFalsy();
    expect(
      differsFromDefault(moveWidget(defaultWidgets, "runs", 1))
    ).toBeTruthy();
    expect(
      differsFromDefault(removeWidget(defaultWidgets, "runs"))
    ).toBeTruthy();
    expect(differsFromDefault([])).toBeTruthy();
    expect(missingWidgets([])).toStrictEqual(defaultWidgets);
  });
});

describe("the place a point is over", () => {
  // Two columns of 100 by 50, 10 apart, three blocks.
  const shape: GridShape = {
    left: 0,
    top: 0,
    columns: 2,
    width: 100,
    height: 50,
    gap: 10,
    count: 3,
  };

  it("counts places as the blocks are, row by row", () => {
    expect(slotAt(shape, 50, 25)).toBe(0);
    expect(slotAt(shape, 150, 25)).toBe(1);
    expect(slotAt(shape, 50, 85)).toBe(2);
  });

  it("is the last block past it", () => {
    expect(slotAt(shape, 150, 85)).toBe(2);
  });

  it("is none between blocks or outside the grid", () => {
    expect(slotAt(shape, 105, 25)).toBeNull();
    expect(slotAt(shape, 50, 55)).toBeNull();
    expect(slotAt(shape, -5, 25)).toBeNull();
    expect(slotAt(shape, 50, 200)).toBeNull();
    expect(slotAt({ ...shape, count: 0 }, 50, 25)).toBeNull();
  });
});
