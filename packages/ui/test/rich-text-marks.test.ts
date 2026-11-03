import { describe, expect, it } from "vite-plus/test";

import { applyMark } from "../src/internal/rich-text-marks.ts";

// What the rich text field's toolbar makes of the text: Markdown around
// the selection, and what it selects after, so the person types on.

describe("a rich text mark", () => {
  it("puts bold and italic around what is selected, and keeps it selected", () => {
    expect(applyMark("Ship it now", 5, 7, "bold")).toStrictEqual({
      text: "Ship **it** now",
      start: 7,
      end: 9,
    });
    expect(applyMark("Ship it now", 5, 7, "italic")).toStrictEqual({
      text: "Ship *it* now",
      start: 6,
      end: 8,
    });
  });

  it("leaves the spaces at the selection's edges outside the mark", () => {
    // A double-click takes the space after a word; `**it **` isn't bold.
    expect(applyMark("Ship it now", 5, 8, "bold").text).toBe("Ship **it** now");
  });

  it("makes each selected line an item, or the line the cursor is on", () => {
    expect(applyMark("Plan\nShip\nTell", 6, 12, "bullets").text).toBe(
      "Plan\n- Ship\n- Tell"
    );
    expect(applyMark("Plan\nShip", 7, 7, "numbers").text).toBe("Plan\n1. Ship");
  });
});
