// oxlint-disable max-classes-per-file -- the refused values include classes and subclasses of built-ins
import { describe, expect, test } from "vite-plus/test";

import {
  canonical,
  decode,
  encode,
  maxEncodedBytes,
  SerializationError,
} from "../src/codec.ts";

const roundTrip = (value: unknown): unknown => decode(encode(value));

describe("values the journal keeps come back equal and fresh", () => {
  test.each([
    ["a string", "text"],
    ["an empty string", ""],
    ["a number", 12.5],
    ["zero", 0],
    ["a boolean", false],
    ["null", null],
    ["undefined", undefined],
    ["a bigint", -12_345_678_901_234_567_890n],
    ["an array with a hole's undefined", [1, undefined, "x"]],
    ["nested objects", { a: { b: [{ c: 1 }] } }],
    ["a date", new Date("2026-10-07T12:00:00.000Z")],
    [
      "a map",
      new Map<unknown, unknown>([
        ["a", 1],
        [2, { b: true }],
      ]),
    ],
    ["a set", new Set([1, "a", null])],
    ["bytes", new Uint8Array([0, 127, 128, 255])],
    ["an array that looks like a tag", ["U"]],
    ["an object with a tag-like key", { "": ["O"], N: "NaN" }],
  ])("%s", (_, value) => {
    expect(roundTrip(value)).toStrictEqual(value);
  });

  test("special numbers keep their identity", () => {
    expect(roundTrip(Number.NaN)).toBeNaN();
    expect(roundTrip(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(roundTrip(Number.NEGATIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY);
    expect(Object.is(roundTrip(-0), -0)).toBeTruthy();
  });

  test("an invalid date stays invalid", () => {
    const decoded = roundTrip(new Date(Number.NaN));
    expect(decoded).toBeInstanceOf(Date);
    expect(
      decoded instanceof Date && Number.isNaN(decoded.getTime())
    ).toBeTruthy();
  });

  test("an ArrayBuffer comes back as an ArrayBuffer", () => {
    const decoded = roundTrip(new Uint8Array([1, 2, 3]).buffer);
    expect(decoded).toBeInstanceOf(ArrayBuffer);
    expect(
      decoded instanceof ArrayBuffer && [...new Uint8Array(decoded)]
    ).toStrictEqual([1, 2, 3]);
  });

  test("a key named __proto__ stays a key, not a prototype", () => {
    const value: unknown = JSON.parse('{"__proto__": {"polluted": true}}');
    const decoded = roundTrip(value);
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.keys(decoded ?? {})).toStrictEqual(["__proto__"]);
  });

  test("a value shared twice (not a cycle) is kept twice", () => {
    const shared = { n: 1 };
    expect(roundTrip([shared, shared])).toStrictEqual([{ n: 1 }, { n: 1 }]);
  });

  test("every decode is a new value", () => {
    const text = encode({ a: [1] });
    expect(decode(text)).not.toBe(decode(text));
  });
});

// What an override would have the codec keep instead.
const forgedEntries = function* forgedEntries(): Generator<[string, number]> {
  yield ["forged", 2];
};
const forgedItems = function* forgedItems(): Generator<string> {
  yield "forged";
};

describe("a built-in value's own overrides can't change what is kept", () => {
  test("a Date with its own getTime", () => {
    const date = new Date("2026-10-07T12:00:00.000Z");
    Object.defineProperty(date, "getTime", { value: () => 0 });
    expect(roundTrip(date)).toStrictEqual(new Date("2026-10-07T12:00:00.000Z"));
  });

  test("a Map with its own iterator, entries and forEach", () => {
    const map = new Map([["kept", 1]]);
    Object.defineProperty(map, Symbol.iterator, { value: forgedEntries });
    Object.defineProperty(map, "entries", { value: forgedEntries });
    Object.defineProperty(map, "forEach", { value: forgedEntries });
    expect(roundTrip(map)).toStrictEqual(new Map([["kept", 1]]));
  });

  test("a Set with its own iterator and values", () => {
    const set = new Set(["kept"]);
    Object.defineProperty(set, Symbol.iterator, { value: forgedItems });
    Object.defineProperty(set, "values", { value: forgedItems });
    expect(roundTrip(set)).toStrictEqual(new Set(["kept"]));
  });

  test("an array with its own iterator", () => {
    const array = ["kept"];
    Object.defineProperty(array, Symbol.iterator, { value: forgedItems });
    expect(roundTrip(array)).toStrictEqual(["kept"]);
  });
});

describe("canonical codec text", () => {
  test("is the same for plain objects whose keys come in another order, nested too", () => {
    expect(canonical(encode({ b: 1, a: { d: [{ f: 1, e: 2 }], c: 3 } }))).toBe(
      canonical(encode({ a: { c: 3, d: [{ e: 2, f: 1 }] }, b: 1 }))
    );
  });

  test("keeps the order of a Map's entries, a Set's items and an array's elements", () => {
    const pairs: [string, number][] = [
      ["a", 1],
      ["b", 2],
    ];
    expect(canonical(encode(new Map(pairs)))).not.toBe(
      canonical(encode(new Map(pairs.toReversed())))
    );
    expect(canonical(encode(new Set(["a", "b"])))).not.toBe(
      canonical(encode(new Set(["b", "a"])))
    );
    expect(canonical(encode(["a", "b"]))).not.toBe(
      canonical(encode(["b", "a"]))
    );
  });
});

describe("values the journal can't keep are refused", () => {
  class Money {
    readonly cents = 1;
  }

  test.each([
    ["a function", () => 1],
    ["a symbol", Symbol("s")],
    ["a class instance", new Money()],
    ["an error", new Error("boom")],
    ["a URL", new URL("https://example.com")],
    ["a promise", Promise.resolve(1)],
    ["another typed array", new Uint16Array(1)],
    // Subclasses: their own behaviour wouldn't come back from a decode.
    ["a Map subclass", new (class Ledger extends Map<string, number> {})()],
    ["a Set subclass", new (class Tags extends Set<string> {})()],
    ["a Date subclass", new (class Deadline extends Date {})(0)],
    ["an Array subclass", new (class Rows extends Array<number> {})()],
    ["a function inside an object", { nested: [{ fn: () => 1 }] }],
  ])("%s", (_, value) => {
    expect(() => encode(value)).toThrow(SerializationError);
  });

  test("a value that contains itself", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => encode(cyclic)).toThrow(/refers to itself/u);
  });

  test("a value larger than a step may return, measured on what is kept", () => {
    // Multibyte characters: their kept size is larger than their length.
    const text = "é".repeat(maxEncodedBytes / 2);
    expect(text.length).toBeLessThan(maxEncodedBytes);
    expect(() => encode(text)).toThrow(SerializationError);
    expect(() => encode("e".repeat(maxEncodedBytes - 100))).not.toThrow();
  });

  test("text from another codec version, rather than being misread", () => {
    expect(() => decode('[2, "x"]')).toThrow(/codec version 2/u);
    expect(() => decode('[1, ["Q"]]')).toThrow(/the tag "Q"/u);
  });
});
