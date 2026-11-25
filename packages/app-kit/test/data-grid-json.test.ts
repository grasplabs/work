import { v } from "@grasp-os/runtime/app";
import { describe, expect, it } from "vite-plus/test";

import { shownCell } from "../src/internal/data-grid-cells.ts";
import { dataGridTexts } from "../src/internal/data-grid-text.ts";

// Any JSON in a grid's cell (pure logic): read as the kinds it holds, so a
// vendor's custom fields show what they say instead of an empty cell.

const shown = (value: unknown): string =>
  shownCell(value, v.json().descriptor, dataGridTexts.en, "en");

describe("any JSON in a cell", () => {
  it("shows a list's items and an object's fields, at every depth", () => {
    expect([
      shown({ stage: "won", probability: 90, tags: ["hot", "eu"] }),
      shown([1, true, "three"]),
      shown([{ a: 1, b: 2 }, { a: 3 }]),
      shown("plain"),
      shown(null),
    ]).toStrictEqual([
      "stage: won, probability: 90, tags: hot, eu",
      "1, Yes, three",
      "a: 1, b: 2; a: 3",
      "plain",
      "",
    ]);
  });
});
