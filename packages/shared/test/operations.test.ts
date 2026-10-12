import { describe, expect, test } from "vite-plus/test";

import { jsonWithin } from "../src/operations.ts";

// Reading a value as bounded JSON: pure, so unit tests.

const encoder = new TextEncoder();

describe(jsonWithin, () => {
  test("copies JSON and counts exactly the bytes of its text", () => {
    const value = {
      title: "Café ☕",
      rank: -1.5e-7,
      tags: ["a", "", null, true, false],
      nested: { empty: {}, list: [] },
    };
    expect(jsonWithin(value, 1000)).toStrictEqual({
      json: value,
      bytes: encoder.encode(JSON.stringify(value)).byteLength,
    });
  });

  test("stops at the limit, however large the rest", () => {
    const text = "x".repeat(10_000_000);
    expect(jsonWithin({ text }, 128)).toBe("too_large");
    expect(jsonWithin(["a".repeat(60), "b".repeat(60), "c"], 128)).toBe(
      "too_large"
    );
    const exact = { a: "b" };
    expect(jsonWithin(exact, JSON.stringify(exact).length)).toStrictEqual({
      json: exact,
      bytes: 9,
    });
  });

  test("refuses what isn't JSON", () => {
    // An array with a hole, as an array's length makes one.
    const holed: unknown[] = [1];
    holed.length = 3;
    expect(
      [undefined, Number.NaN, new Date(0), holed, { a: undefined }].map(
        (value) => jsonWithin(value, 1000)
      )
    ).toStrictEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});
