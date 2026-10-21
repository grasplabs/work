import { describe, expect, it } from "vite-plus/test";

import {
  addWidget,
  differsFromDefault,
  missingWidgets,
  moveWidget,
  offeredWidgets,
  placeWidget,
  removeWidget,
  slotAt,
} from "./layout.ts";
import type { GridShape } from "./layout.ts";

// How a person changes the widget board's layout (layout.ts): moving,
// taking off and adding widgets, whether it is still as it began, and
// which place a dragged block is over.

/** The board as it begins for someone who isn't an admin. */
const defaultWidgets = offeredWidgets(false);

describe("the widgets offered", () => {
  it("offers admins what the models cost too, last", () => {
    expect(defaultWidgets).not.toContain("spend");
    expect(offeredWidgets(true)).toStrictEqual([...defaultWidgets, "spend"]);
  });
});

describe("moving a widget", () => {
  it("puts it in its new place, the ones between moving one over", () => {
    expect(placeWidget(defaultWidgets, "signals", 0)).toStrictEqual([
      "signals",
      "return",
      "goals",
      "teams",
      "workflows",
      "engines",
      "runs",
    ]);
    expect(placeWidget(defaultWidgets, "return", 2)).toStrictEqual([
      "goals",
      "teams",
      "return",
      "workflows",
      "engines",
      "runs",
      "signals",
    ]);
  });

  it("goes no further than either end", () => {
    expect(moveWidget(defaultWidgets, "return", -1)).toStrictEqual(
      defaultWidgets
    );
    expect(moveWidget(defaultWidgets, "runs", 5)).toStrictEqual([
      "return",
      "goals",
      "teams",
      "workflows",
      "engines",
      "signals",
      "runs",
    ]);
    expect(moveWidget(defaultWidgets, "teams", -2)).toStrictEqual([
      "teams",
      "return",
      "goals",
      "workflows",
      "engines",
      "runs",
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
    const without = removeWidget(defaultWidgets, "goals");
    expect(without).toStrictEqual([
      "return",
      "teams",
      "workflows",
      "engines",
      "runs",
      "signals",
    ]);
    expect(missingWidgets(without, defaultWidgets)).toStrictEqual(["goals"]);
    const again = addWidget(without, "goals");
    expect(again).toStrictEqual([
      "return",
      "teams",
      "workflows",
      "engines",
      "runs",
      "signals",
      "goals",
    ]);
    expect(addWidget(again, "goals")).toStrictEqual(again);
    expect(missingWidgets(again, defaultWidgets)).toStrictEqual([]);
  });

  it("tells a board other than it began: another order, or fewer", () => {
    expect(differsFromDefault(defaultWidgets, defaultWidgets)).toBeFalsy();
    expect(
      differsFromDefault(moveWidget(defaultWidgets, "runs", 1), defaultWidgets)
    ).toBeTruthy();
    expect(
      differsFromDefault(removeWidget(defaultWidgets, "runs"), defaultWidgets)
    ).toBeTruthy();
    expect(differsFromDefault([], defaultWidgets)).toBeTruthy();
    expect(missingWidgets([], defaultWidgets)).toStrictEqual(defaultWidgets);
  });

  it("puts what a board saved before the newer widgets were there beside them", () => {
    const saved = ["workflows", "engines", "runs", "signals"] as const;
    expect(differsFromDefault(saved, defaultWidgets)).toBeTruthy();
    expect(missingWidgets(saved, defaultWidgets)).toStrictEqual([
      "return",
      "goals",
      "teams",
    ]);
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
