import { describe, expect, it } from "vite-plus/test";

import { orderOf, placeIn, skip, stepFrom, turn, untouched } from "./pile.ts";
import type { Turned } from "./pile.ts";

// Going through the dashboard's pile (pile.ts): which card is on top, and
// where a skipped one goes.

const ids = ["a", "b", "c", "d"];

/** The card on top, after what the person did. */
const topOf = (waiting: readonly string[], turned: Turned) => {
  const order = orderOf(waiting, turned.skipped);
  return order[placeIn(order, turned.at)];
};

describe("the card on top", () => {
  it("begins at the first card, and stays with the item that is on top", () => {
    expect(placeIn(ids, null)).toBe(0);
    expect(placeIn(ids, { id: "c", index: 2 })).toBe(2);
    // One before it was dealt with: it is still the one on top.
    expect(placeIn(["a", "c", "d"], { id: "c", index: 2 })).toBe(1);
  });

  it("is the one that came after, once the item on top is dealt with", () => {
    expect(
      topOf(["a", "c", "d"], { at: { id: "b", index: 1 }, skipped: [] })
    ).toBe("c");
  });

  it("goes round to the first card when the last is dealt with, and is none when nothing waits", () => {
    expect(placeIn(["a", "b", "c"], { id: "d", index: 3 })).toBe(0);
    expect(placeIn([], { id: "a", index: 0 })).toBe(-1);
    expect(placeIn([], null)).toBe(-1);
  });
});

describe("the arrows", () => {
  it("go one card on or one back, and round at either end", () => {
    expect(stepFrom(4, 0, 1)).toBe(1);
    expect(stepFrom(4, 3, 1)).toBe(0);
    expect(stepFrom(4, 0, -1)).toBe(3);
    expect(stepFrom(1, 0, 1)).toBe(0);
    expect(stepFrom(0, 0, 1)).toBe(-1);
  });

  it("turn the pile without changing its order", () => {
    const on = turn(ids, untouched, 1);
    expect(topOf(ids, on)).toBe("b");
    expect(topOf(ids, turn(ids, on, -1))).toBe("a");
    expect(topOf(ids, turn(ids, untouched, -1))).toBe("d");
    expect(orderOf(ids, on.skipped)).toStrictEqual(ids);
  });
});

describe("skipping", () => {
  it("puts the card at the back, and the one after it comes up in its place", () => {
    const at = turn(ids, untouched, 1);
    const skipped = skip(ids, at);
    expect(orderOf(ids, skipped.skipped)).toStrictEqual(["a", "c", "d", "b"]);
    expect(topOf(ids, skipped)).toBe("c");
    expect(skipped.at?.index).toBe(1);
  });

  it("brings the first card up when the last one is skipped", () => {
    const last = turn(ids, untouched, -1);
    const skipped = skip(ids, last);
    expect(topOf(ids, skipped)).toBe("a");
    expect(orderOf(ids, skipped.skipped)).toStrictEqual(ids);
  });

  it("keeps the cards skipped at the back in the order they were skipped, a card skipped again last", () => {
    let turned = skip(ids, untouched);
    turned = skip(ids, turned);
    expect(orderOf(ids, turned.skipped)).toStrictEqual(["c", "d", "a", "b"]);
    turned = skip(ids, { ...turned, at: { id: "a", index: 2 } });
    expect(orderOf(ids, turned.skipped)).toStrictEqual(["c", "d", "b", "a"]);
  });

  it("forgets a skipped card once it no longer waits", () => {
    const turned = skip(ids, untouched);
    expect(orderOf(["b", "c"], turned.skipped)).toStrictEqual(["b", "c"]);
    expect(skip(["b", "c"], turned).skipped).toStrictEqual(["b"]);
  });

  it("does nothing with one card, or none", () => {
    expect(skip(["a"], untouched)).toBe(untouched);
    expect(skip([], untouched)).toBe(untouched);
  });
});
