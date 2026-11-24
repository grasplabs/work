import { describe, expect, it } from "vite-plus/test";

import { scanStructuralNodes } from "../src/rpc-accounting.ts";

// The scan bounds a message's node count from its text, before it is parsed,
// so JSON.parse can't allocate millions of nodes a later check would catch
// too late. For that to be safe, the scan must never count fewer nodes than
// JSON.parse would make: it may over-count (whitespace, duplicate keys), but
// never under-count. This checks that against random and adversarial JSON.

const UNLIMITED = Number.POSITIVE_INFINITY;

/** Every value JSON.parse allocates, keys counted as the scan counts them. */
const parsedNodes = (value: unknown): number => {
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + parsedNodes(item), 1);
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).reduce<number>(
      // One node for the key's string, plus the value's nodes.
      (sum, [, item]) => sum + 1 + parsedNodes(item),
      1
    );
  }
  return 1;
};

/** A small deterministic PRNG, so the fuzz is the same run to run. */
const mulberry32 = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state += 1;
    const value = Math.sin(state) * 10_000;
    return value - Math.floor(value);
  };
};

// U+2028/U+2029 are line separators; build them so the source stays one line.
const LINE_SEPARATORS = String.fromCodePoint(0x20_28, 0x20_29);
const RANDOM_STRINGS = [
  "",
  "plain",
  'has "quotes" and , commas',
  "brackets ][ braces }{ and : colons",
  'back\\slash and \\" escaped',
  `unicode ${LINE_SEPARATORS} and null ${String.fromCodePoint(0)}`,
  "emoji 😀 and 𝕊 surrogate pairs",
  "   whitespace\tand\nnewlines\r",
];

const randomValue = (random: () => number, depth: number): unknown => {
  const choice = random();
  if (depth <= 0 || choice < 0.4) {
    const leaf = random();
    if (leaf < 0.3) {
      return RANDOM_STRINGS[Math.floor(random() * RANDOM_STRINGS.length)];
    }
    if (leaf < 0.5) {
      return Math.floor((random() - 0.5) * 1e9);
    }
    if (leaf < 0.6) {
      return (random() - 0.5) * 1e6;
    }
    if (leaf < 0.75) {
      return random() < 0.5;
    }
    return null;
  }
  const size = Math.floor(random() * 6);
  if (choice < 0.7) {
    return Array.from({ length: size }, () => randomValue(random, depth - 1));
  }
  const object: Record<string, unknown> = {};
  for (let i = 0; i < size; i += 1) {
    const key = RANDOM_STRINGS[Math.floor(random() * RANDOM_STRINGS.length)];
    object[`${key}${i}`] = randomValue(random, depth - 1);
  }
  return object;
};

describe("the structural node scan", () => {
  it("never counts fewer nodes than JSON.parse makes, over fuzzed JSON", () => {
    const random = mulberry32(0x9e_37_79_b9);
    let worstSlack = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3000; run += 1) {
      const value = randomValue(random, 5);
      const raw = JSON.stringify(value);
      if (raw === undefined) {
        continue;
      }
      const scanned = scanStructuralNodes(raw, UNLIMITED);
      const actual = parsedNodes(value);
      // SAFETY: an under-count would let a flood through; must never happen.
      expect(scanned).toBeGreaterThanOrEqual(actual);
      worstSlack = Math.min(worstSlack, scanned - actual);
    }
    // Tight on compact JSON: the scan matches the parsed node count exactly.
    expect(worstSlack).toBe(0);
  });

  it("is never below the parsed node count on adversarial JSON", () => {
    const cases: unknown[] = [
      0,
      -12.5e3,
      true,
      false,
      null,
      "",
      '][}{,:" all structural chars inside a string',
      'escaped \\" quote and \\\\ backslash',
      `${String.fromCodePoint(0, 0x1f)}${LINE_SEPARATORS} control and line separators`,
      "tail emoji 😀😀😀",
      [],
      {},
      [[], [[]], [[[]]]],
      { a: { b: { c: [1, 2, { d: null }] } } },
      Array.from({ length: 50 }, (_v, i) => ({ [`k${i}`]: i })),
      { "weird]key,with:chars": [1, "two", false] },
    ];
    for (const value of cases) {
      const raw = JSON.stringify(value);
      expect(scanStructuralNodes(raw, UNLIMITED)).toBeGreaterThanOrEqual(
        parsedNodes(value)
      );
    }
  });

  it("stops counting once past the limit", () => {
    const raw = JSON.stringify(Array.from({ length: 1000 }, (_v, i) => i));
    expect(scanStructuralNodes(raw, 10)).toBeGreaterThan(10);
    expect(scanStructuralNodes(raw, 10)).toBeLessThan(40);
  });
});
