// order.ts `byBytes` against what it stands for: SQLite's BINARY order,
// by UTF-8 bytes, as TextEncoder writes them (a lone surrogate as U+FFFD).
// Over every pair of a set of awkward strings, it must give the same sign.
import { describe, expect, it } from "vite-plus/test";

import { byBytes } from "../src/order.ts";

const encoder = new TextEncoder();

/** The order by UTF-8 bytes, encoded: what `byBytes` must agree with. */
const byEncodedBytes = (a: string, b: string): number => {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
};

const awkward = [
  "",
  "a",
  "ab",
  "abc",
  "b",
  "é",
  "é",
  "😀",
  "😀a",
  "￿",
  "�",
  "\u0000",
  "a\u0000",
  "\uD800",
  "\uDFFF",
  "\uD800x",
  "x\uDC00",
  "😀\uD800",
  "\u{10FFFF}",
  "߿",
  "ࠀ",
  ...Array.from({ length: 40 }, () => crypto.randomUUID()),
];

describe("ordering text as SQLite does", () => {
  it("orders every pair as their UTF-8 bytes do, without encoding them", () => {
    const disagreeing = awkward.flatMap((a) =>
      awkward
        .filter(
          (b) => Math.sign(byBytes(a, b)) !== Math.sign(byEncodedBytes(a, b))
        )
        .map((b) => [a, b])
    );

    expect(disagreeing).toStrictEqual([]);
  });
});
