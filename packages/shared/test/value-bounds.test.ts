import { describe, expect, it } from "vite-plus/test";

import { passedBound } from "../src/value-bounds.ts";

/** A value `depth` levels deep: arrays around a leaf, which is a level too. */
const nested = (depth: number, leaf: unknown = "bottom"): unknown => {
  let value = leaf;
  for (let level = 1; level < depth; level += 1) {
    value = [value];
  }
  return value;
};

/** `leaf` held twice in each of `levels` arrays: 2^levels times over. */
const doubled = (leaf: unknown, levels: number): unknown => {
  let value = leaf;
  for (let level = 0; level < levels; level += 1) {
    value = [value, value];
  }
  return value;
};

const roomy = { depth: 32, size: 1_000_000 };

describe("the bounds of a value", () => {
  it("lets a value as deep as the bound through, and refuses one level more", () => {
    expect({
      leaf: passedBound(["a"], roomy),
      atDepth: passedBound([nested(32)], roomy),
      // An empty array or object is a level of its own.
      emptyAtDepth: passedBound([nested(32, [])], roomy),
      emptyPast: passedBound([nested(33, [])], roomy),
      past: passedBound([nested(33)], roomy),
      inAnObject: passedBound([{ a: nested(32) }], roomy),
      // Each value counts from level 1.
      side: passedBound([nested(32), nested(32)], roomy),
    }).toStrictEqual({
      leaf: undefined,
      atDepth: undefined,
      emptyAtDepth: undefined,
      emptyPast: "depth",
      past: "depth",
      inAnObject: "depth",
      side: undefined,
    });
  });

  it("refuses a value nested far deeper than the call stack goes, quickly", () => {
    expect(passedBound([nested(1_000_000)], roomy)).toBe("depth");
  });

  it("looks into what an error carries", () => {
    const error = Object.assign(new Error("deep"), { details: nested(40) });
    expect(passedBound([error], roomy)).toBe("depth");
  });

  it("counts strings, keys and bytes toward the size, and every value held", () => {
    const bounds = { depth: 32, size: 100 };
    expect({
      // One for the value, 99 for its text.
      fits: passedBound(["x".repeat(99)], bounds),
      past: passedBound(["x".repeat(100)], bounds),
      key: passedBound([{ ["k".repeat(99)]: 1 }], bounds),
      bytes: passedBound([new Uint8Array(100)], bounds),
      together: passedBound(["x".repeat(60), "x".repeat(60)], bounds),
    }).toStrictEqual({
      fits: undefined,
      past: "size",
      key: "size",
      bytes: "size",
      together: "size",
    });
  });

  it("counts a value held many times as often as it is held", () => {
    // 2^30 copies of it, as written out, in 30 arrays.
    expect(passedBound([doubled("x", 30)], roomy)).toBe("size");
  });

  it("refuses a value that holds itself", () => {
    const loop: unknown[] = [];
    loop.push(loop);
    expect(passedBound([loop], roomy)).toBe("depth");
  });

  it("runs no getter of what it walks", () => {
    let read = false;
    const value = {
      get secret() {
        read = true;
        return nested(40);
      },
    };
    expect({ passed: passedBound([value], roomy), read }).toStrictEqual({
      passed: undefined,
      read: false,
    });
  });
});
