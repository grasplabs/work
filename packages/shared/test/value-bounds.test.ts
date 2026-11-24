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

  it("looks into what an error carries, listed or not", () => {
    const aggregate = new AggregateError([], "m");
    // As Cap'n Web sets it: an own property `Object.keys` doesn't list.
    aggregate.errors = [nested(40)];
    expect({
      details: passedBound(
        [Object.assign(new Error("deep"), { details: nested(40) })],
        roomy
      ),
      errors: passedBound([aggregate], roomy),
      cause: passedBound([new Error("m", { cause: nested(40) })], roomy),
    }).toStrictEqual({ details: "depth", errors: "depth", cause: "depth" });
  });

  it("refuses a stream, a request or a response, which would carry what it streams unchecked", () => {
    expect(
      [
        new ReadableStream(),
        new WritableStream(),
        new Request("https://example.com"),
        new Response("x"),
      ].map((value) => passedBound([value], roomy))
    ).toStrictEqual(["kind", "kind", "kind", "kind"]);
  });

  it("lets an error through as deep as a leaf may be, counting its name and message at its own level", () => {
    const bare = new Error("deep");
    expect({
      atDepth: passedBound([nested(32, bare)], roomy),
      withDetails: passedBound(
        [nested(31, Object.assign(new Error("deep"), { code: "x" }))],
        roomy
      ),
      // "Error" and "deep", and one for the error itself: its stack isn't
      // counted, whatever the runtime made up.
      size: passedBound([bare], { depth: 32, size: 10 }),
      pastSize: passedBound([bare], { depth: 32, size: 9 }),
    }).toStrictEqual({
      atDepth: undefined,
      withDetails: undefined,
      size: undefined,
      pastSize: "size",
    });
  });

  it("refuses an object of a kind it can't measure, wherever it is held", () => {
    class Invoice {
      total = 1;
    }
    // What a value sent as `__proto__` makes of an object.
    const inherited: unknown = Object.setPrototypeOf({}, { k: nested(200) });
    const inheritsAnArray: unknown = Object.setPrototypeOf({}, ["a"]);
    const inheritsAnError: unknown = Object.setPrototypeOf(
      {},
      Object.assign(new Error("x"), { details: nested(200) })
    );
    const arrayInheritsAnArray: unknown = Object.setPrototypeOf([], [1]);
    expect({
      inherited: passedBound([inherited], roomy),
      deeper: passedBound([{ a: [inherited] }], roomy),
      inheritsAnArray: passedBound([inheritsAnArray], roomy),
      inheritsAnError: passedBound([inheritsAnError], roomy),
      arrayInheritsAnArray: passedBound([arrayInheritsAnArray], roomy),
      instance: passedBound([new Invoice()], roomy),
      leaves: passedBound(
        [new Date(0), new Uint8Array(2), new ArrayBuffer(2), new Map(), null],
        roomy
      ),
    }).toStrictEqual({
      inherited: "kind",
      deeper: "kind",
      inheritsAnArray: "kind",
      inheritsAnError: "kind",
      arrayInheritsAnArray: "kind",
      instance: "kind",
      leaves: undefined,
    });
  });

  it("walks keys every object has, held as its own", () => {
    expect({
      toJSON: passedBound([{ toJSON: nested(32) }], roomy),
      constructorKey: passedBound([{ constructor: nested(32) }], roomy),
    }).toStrictEqual({ toJSON: "depth", constructorKey: "depth" });
  });

  it("counts strings, keys and bytes toward the size, and every value held", () => {
    const bounds = { depth: 32, size: 100 };
    expect({
      // One for the value, 99 for its text.
      fits: passedBound(["x".repeat(99)], bounds),
      past: passedBound(["x".repeat(100)], bounds),
      key: passedBound([{ ["k".repeat(99)]: 1 }], bounds),
      bytes: passedBound([new Uint8Array(100)], bounds),
      buffer: passedBound([new ArrayBuffer(100)], bounds),
      together: passedBound(["x".repeat(60), "x".repeat(60)], bounds),
    }).toStrictEqual({
      fits: undefined,
      past: "size",
      key: "size",
      bytes: "size",
      buffer: "size",
      together: "size",
    });
  });

  it("counts a value held many times as often as it is held", () => {
    // 2^30 copies of it, as written out, in 30 arrays.
    expect(passedBound([doubled("x", 30)], roomy)).toBe("size");
  });

  it("stops reading a wide value once past the size, not after reading all of it", () => {
    const wide = new Map<number, number>();
    for (let key = 0; key < 1_000_000; key += 1) {
      wide.set(key, key);
    }
    // Counts the entries the walk reads, through the map's own iterator.
    let read = 0;
    const entries = wide.entries();
    Object.defineProperty(wide, Symbol.iterator, {
      value: () => ({
        next: () => {
          read += 1;
          return entries.next();
        },
      }),
    });
    const passed = passedBound([wide], { depth: 32, size: 1000 });
    expect({ passed, readAboutTheBound: read <= 1000 }).toStrictEqual({
      passed: "size",
      readAboutTheBound: true,
    });
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
