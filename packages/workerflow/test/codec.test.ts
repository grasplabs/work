// oxlint-disable max-classes-per-file -- the refused values include classes and subclasses of built-ins
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vite-plus/test";

import {
  codecVersion,
  decode,
  encode,
  equivalent,
  maxEncodedBytes,
  maxNestingDepth,
  maxStoredTextBytes,
  SerializationError,
} from "../src/codec.ts";
import { namedError } from "../src/errors.ts";

const roundTrip = (value: unknown): unknown => decode(encode(value));

/** `depth` arrays, each holding the next, the last holding `core`. */
const nested = (depth: number, core: unknown = "core"): unknown => {
  let value: unknown = core;
  for (let level = 0; level < depth; level += 1) {
    value = [value];
  }
  return value;
};

/** A small seeded generator, so a failing case is the same every run. */
const seeded = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
};

/** A value of mixed kinds, nested as deep as `depth`, sharing some parts. */
const mixed = (
  random: () => number,
  depth: number,
  pool: object[]
): unknown => {
  const leaves: (() => unknown)[] = [
    () => {},
    () => null,
    () => 1n,
    () => Number.NaN,
    () => -0,
    () => "text",
    () => true,
    () => new Date(0),
    () => /x/gu,
    () => new Uint8Array([1, 2]),
    () => new Error("boom"),
    () => new Object(7),
  ];
  const pick = Math.floor(random() * 10);
  if (depth === 0 || pick < 3) {
    return leaves[Math.floor(random() * leaves.length)]?.();
  }
  if (pick === 3 && pool.length > 0) {
    // A part met before: shared, or, when it holds this one, cyclic.
    return pool[Math.floor(random() * pool.length)];
  }
  const size = Math.floor(random() * 4);
  // Pooled before its children are made: a child may refer back to it.
  const fill = (add: (child: unknown, index: number) => void): void => {
    for (let index = 0; index < size; index += 1) {
      add(mixed(random, depth - 1, pool), index);
    }
  };
  if (pick === 4) {
    const map = new Map<unknown, unknown>();
    pool.push(map);
    fill((child, index) => {
      map.set(index, child);
    });
    return map;
  }
  if (pick === 5) {
    const set = new Set<unknown>();
    pool.push(set);
    fill((child) => {
      set.add(child);
    });
    return set;
  }
  if (pick === 6) {
    const object: Record<string, unknown> = {};
    pool.push(object);
    fill((child, index) => {
      object[`k${index}`] = child;
    });
    return object;
  }
  const array: unknown[] = [];
  pool.push(array);
  fill((child) => {
    array.push(child);
  });
  // A hole now and then.
  array.length += Math.floor(random() * 2);
  return array;
};

/** An object that refers to itself. */
const loop = (name: string): Record<string, unknown> => {
  const value: Record<string, unknown> = { name };
  value.self = value;
  return value;
};

/** A ring of `length` objects, each pointing at the next; its first. */
const ring = (length: number): unknown[] => {
  const nodes: { index: number; next: unknown }[] = Array.from(
    { length },
    (_, index) => ({ index: index % 2, next: null })
  );
  for (const [index, node] of nodes.entries()) {
    node.next = nodes[(index + 1) % length];
  }
  return nodes.slice(0, 1);
};

/** Codec text of the current version holding `node` as it is. */
const codecText = (node: unknown): string =>
  JSON.stringify([codecVersion, node]);

/** An error with a code of its own, as Grasp's errors carry theirs. */
const coded = (name: string, message: string, code: unknown): Error => {
  const error = new Error(message);
  error.name = name;
  Object.defineProperty(error, "code", { value: code, enumerable: true });
  return error;
};

/** The error's own code, read as data. */
const ownCode = (error: Error): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  const code: unknown = descriptor?.value;
  return code;
};

/**
 * What an error value comes back as: its name, message and code. Anything
 * that isn't an error comes back as it is, and so fails to match.
 */
const partsOf = (value: unknown): unknown =>
  value instanceof Error
    ? { name: value.name, message: value.message, code: ownCode(value) }
    : value;

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
    ["a RegExp with its flags", /^a[b-d]+$/giu],
    [
      "a map",
      new Map<unknown, unknown>([
        ["a", 1],
        [2, { b: true }],
      ]),
    ],
    ["a set", new Set([1, "a", null])],
    ["bytes", new Uint8Array([0, 127, 128, 255])],
    ["signed bytes", new Int8Array([-128, -1, 0, 127])],
    ["clamped bytes", new Uint8ClampedArray([0, 255])],
    ["16-bit integers", new Int16Array([-32_768, 32_767])],
    ["unsigned 16-bit integers", new Uint16Array([0, 65_535])],
    ["32-bit integers", new Int32Array([-2_147_483_648, 2_147_483_647])],
    ["unsigned 32-bit integers", new Uint32Array([0, 4_294_967_295])],
    ["32-bit floats", new Float32Array([1.5, -0, Number.NaN])],
    ["64-bit floats", new Float64Array([Math.PI, Number.NEGATIVE_INFINITY])],
    ["64-bit bigints", new BigInt64Array([-(2n ** 63n), 2n ** 63n - 1n])],
    ["unsigned 64-bit bigints", new BigUint64Array([0n, 2n ** 64n - 1n])],
    ["a data view", new DataView(new Uint8Array([1, 2, 3]).buffer)],
    ["a boxed number", new Object(7)],
    ["a boxed string", new Object("seven")],
    ["a boxed boolean", new Object(false)],
    ["a boxed bigint", new Object(7n)],
    ["an array that looks like a tag", ["U"]],
    ["an array that looks like a reference", ["P", 0]],
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

  test("a view of part of a buffer keeps its whole buffer and where it sees, as structured clone does", () => {
    const whole = new Uint8Array([9, 9, 1, 2, 3, 9]);
    const decoded = roundTrip(whole.subarray(2, 5));
    expect(decoded).toStrictEqual(new Uint8Array([1, 2, 3]));
    expect(
      decoded instanceof Uint8Array && [
        decoded.byteOffset,
        [...new Uint8Array(decoded.buffer)],
      ]
    ).toStrictEqual([2, [9, 9, 1, 2, 3, 9]]);
  });

  test("a view and its own buffer, or two views of one buffer, stay one buffer", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const decoded = roundTrip({
      bytes,
      buffer: bytes.buffer,
      words: new Uint16Array(bytes.buffer, 2, 1),
      view: new DataView(bytes.buffer, 1, 2),
    });
    const part = (key: string): unknown =>
      decoded instanceof Object ? Reflect.get(decoded, key) : undefined;
    const [copy, buffer, words, view] = [
      "bytes",
      "buffer",
      "words",
      "view",
    ].map(part);
    expect(copy instanceof Uint8Array && copy.buffer).toBe(buffer);
    expect(words instanceof Uint16Array && words.buffer).toBe(buffer);
    expect(view instanceof DataView && view.buffer).toBe(buffer);
    expect(
      view instanceof DataView && [view.byteOffset, view.byteLength]
    ).toStrictEqual([1, 2]);
  });

  test("an array's holes stay holes", () => {
    // oxlint-disable-next-line no-sparse-arrays -- the hole is the point
    const decoded = roundTrip([1, , 3, , , 6, ,]);
    expect(Array.isArray(decoded) && decoded.length).toBe(7);
    expect(
      Array.isArray(decoded) &&
        [0, 1, 2, 3, 4, 5, 6].map((index) => Object.hasOwn(decoded, index))
    ).toStrictEqual([true, false, true, false, false, true, false]);
    // oxlint-disable-next-line no-sparse-arrays -- holes all the way
    const empty = [, , ,];
    expect(roundTrip(empty)).toStrictEqual(empty);
  });

  test("values nest as deep as the codec's limit, and no deeper", () => {
    expect(roundTrip(nested(maxNestingDepth))).toStrictEqual(
      nested(maxNestingDepth)
    );
    expect(() => encode(nested(maxNestingDepth + 1))).toThrow(
      /nests deeper than the 512 levels/u
    );
  });

  test("decodes at the limit whatever leaves and references sit there", () => {
    // Leaves of their own tags nest nothing, on either side.
    // The innermost array is the 512th level; its leaves add none.
    const leaves = nested(maxNestingDepth - 1, [undefined, 1n, Number.NaN]);
    expect(roundTrip(leaves)).toStrictEqual(leaves);
    expect(() => encode(nested(1, leaves))).toThrow(/nests deeper/u);
    // A reference at the deepest level refers back; it nests nothing.
    const shared = { at: "the bottom" };
    const twice = nested(maxNestingDepth - 2, [shared, shared]);
    expect(roundTrip(twice)).toStrictEqual(twice);
  });

  test("decodes every value it encodes, nested mixes of every kind", () => {
    const random = seeded(7);
    /** Each encoded value's text whose decode failed or came back other. */
    const lost: string[] = [];
    let kept = 0;
    for (let round = 0; round < 300; round += 1) {
      const depth = round % 10 === 0 ? maxNestingDepth - 2 : 12;
      const value =
        round % 10 === 0
          ? nested(depth, mixed(random, 1, []))
          : mixed(random, depth, []);
      let text: string | undefined;
      try {
        text = encode(value);
      } catch {
        // Refused: nothing to decode.
      }
      if (text !== undefined) {
        kept += 1;
        try {
          if (!equivalent(encode(decode(text)), text)) {
            lost.push(text);
          }
        } catch {
          lost.push(text);
        }
      }
    }
    expect(lost).toStrictEqual([]);
    // Most of them were kept: the property was tested, not skipped.
    expect(kept).toBeGreaterThan(250);
  });

  test("a RegExp keeps its source and flags, not where it last matched", () => {
    const pattern = /a/gu;
    pattern.lastIndex = 3;
    const decoded = roundTrip(pattern);
    expect(decoded).toBeInstanceOf(RegExp);
    expect(
      decoded instanceof RegExp && [
        decoded.source,
        decoded.flags,
        decoded.lastIndex,
      ]
    ).toStrictEqual(["a", "gu", 0]);
  });

  test("an error keeps its name, message and code, whatever its class", () => {
    class PaymentError extends Error {
      override readonly name = "PaymentError";
      readonly code = "payment.declined";
    }
    const decoded = roundTrip({
      plain: new Error("boom"),
      typed: new TypeError("bad type"),
      own: new PaymentError("The card was declined"),
      grasp: coded(
        "WorkflowError(workflow.invalid_input)",
        "No such input",
        "workflow.invalid_input"
      ),
    });

    const record =
      typeof decoded === "object" && decoded !== null ? decoded : {};
    expect(
      Object.fromEntries(
        Object.entries(record).map(([key, value]) => [key, partsOf(value)])
      )
    ).toStrictEqual({
      plain: { name: "Error", message: "boom", code: undefined },
      typed: { name: "TypeError", message: "bad type", code: undefined },
      own: {
        name: "PaymentError",
        message: "The card was declined",
        code: "payment.declined",
      },
      grasp: {
        name: "WorkflowError(workflow.invalid_input)",
        message: "No such input",
        code: "workflow.invalid_input",
      },
    });
  });

  test("an error keeps only a code of its own in the safe shape, and never calls a getter for it", () => {
    let called = false;
    const getter = new Error("getter");
    Object.defineProperty(getter, "code", {
      get: () => {
        called = true;
        return "workflow.invalid_input";
      },
    });
    const parent = coded("Error", "parent", "a.b");
    const inherited = new Error("inherited");
    Reflect.setPrototypeOf(inherited, parent);
    const decoded = roundTrip([
      coded("Error", "host", "ERR_INVALID_ARG_TYPE"),
      coded("Error", "object", { code: "a.b" }),
      coded("Error", "long", `a.${"b".repeat(200)}`),
      getter,
      inherited,
    ]);

    expect(Array.isArray(decoded) && decoded.map(partsOf)).toStrictEqual([
      { name: "Error", message: "host", code: undefined },
      { name: "Error", message: "object", code: undefined },
      { name: "Error", message: "long", code: undefined },
      { name: "Error", message: "getter", code: undefined },
      { name: "Error", message: "inherited", code: undefined },
    ]);
    expect(called).toBeFalsy();
  });

  test("a value shared twice is one value again, not two copies", () => {
    const shared = { n: 1 };
    const decoded = roundTrip([shared, shared, new Map([[shared, shared]])]);
    expect(decoded).toStrictEqual([
      { n: 1 },
      { n: 1 },
      new Map([[{ n: 1 }, { n: 1 }]]),
    ]);
    const parts: unknown[] = Array.isArray(decoded) ? decoded : [];
    const [first, second, map] = parts;
    expect(first).toBe(second);
    expect(map instanceof Map && [...map.entries()][0]).toStrictEqual([
      first,
      first,
    ]);
    expect(map instanceof Map && [...map.keys()][0]).toBe(first);
  });

  test("values that contain themselves come back containing themselves", () => {
    const object: Record<string, unknown> = { name: "loop" };
    object.self = object;
    const array: unknown[] = [];
    array.push(array);
    const map = new Map<string, unknown>();
    map.set("me", map);
    const set = new Set<unknown>();
    set.add(set);

    const decoded = roundTrip({ object, array, map, set });

    const part = (key: string): unknown =>
      decoded instanceof Object ? Reflect.get(decoded, key) : undefined;
    const [o, a, m, s] = ["object", "array", "map", "set"].map(part);
    expect(o).toMatchObject({ name: "loop" });
    expect(o instanceof Object && Reflect.get(o, "self")).toBe(o);
    expect(Array.isArray(a) && a[0]).toBe(a);
    expect(m instanceof Map && m.get("me")).toBe(m);
    expect(s instanceof Set && [...s][0]).toBe(s);
  });

  test("a value shared many times over stays as small as its parts", () => {
    // Forty levels of a pair of the level below: 2^40 leaves as a tree.
    let level: unknown = "leaf";
    for (let depth = 0; depth < 40; depth += 1) {
      level = [level, level];
    }
    const text = encode(level);
    expect(text.length).toBeLessThan(2000);
    expect(equivalent(text, text)).toBeTruthy();
  });

  test("a key named __proto__ stays a key, not a prototype", () => {
    const value: unknown = JSON.parse('{"__proto__": {"polluted": true}}');
    const decoded = roundTrip(value);
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.keys(decoded ?? {})).toStrictEqual(["__proto__"]);
  });

  test("every decode is a new value", () => {
    const text = encode({ a: [1], bytes: new Uint8Array([1]) });
    expect(decode(text)).not.toBe(decode(text));
    const first = decode(text);
    if (first instanceof Object && "bytes" in first) {
      const { bytes } = first;
      if (bytes instanceof Uint8Array) {
        bytes[0] = 9;
      }
    }
    expect(decode(text)).toStrictEqual({ a: [1], bytes: new Uint8Array([1]) });
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

  test("a Set with its own iterator, values and forEach", () => {
    const set = new Set(["kept"]);
    Object.defineProperty(set, Symbol.iterator, { value: forgedItems });
    Object.defineProperty(set, "values", { value: forgedItems });
    Object.defineProperty(set, "forEach", { value: forgedItems });
    expect(roundTrip(set)).toStrictEqual(new Set(["kept"]));
  });

  test("an array with its own iterator", () => {
    const array = ["kept"];
    Object.defineProperty(array, Symbol.iterator, { value: forgedItems });
    expect(roundTrip(array)).toStrictEqual(["kept"]);
  });

  test("a typed array with its own buffer, offset and length", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    Object.defineProperty(bytes, "buffer", {
      value: new Uint8Array([7, 7, 7, 7]).buffer,
    });
    Object.defineProperty(bytes, "byteOffset", { value: 1 });
    Object.defineProperty(bytes, "byteLength", { value: 1 });
    Object.defineProperty(bytes, "length", { value: 1 });
    expect(roundTrip(bytes)).toStrictEqual(new Uint8Array([1, 2, 3]));
  });

  test("a RegExp with its own source and flags", () => {
    const pattern = /kept/u;
    Object.defineProperty(pattern, "source", { value: "forged" });
    Object.defineProperty(pattern, "flags", { value: "g" });
    Object.defineProperty(pattern, "global", { value: true });
    const decoded = roundTrip(pattern);
    expect(
      decoded instanceof RegExp && [decoded.source, decoded.flags]
    ).toStrictEqual(["kept", "u"]);
  });

  test("a boxed number with its own valueOf", () => {
    const boxed = new Object(7);
    Object.defineProperty(boxed, "valueOf", { value: () => 8 });
    expect(Number(roundTrip(boxed))).toBe(7);
  });
});

describe("what structured clone keeps of a class, the codec keeps", () => {
  class Money {
    readonly cents = 1;
    readonly currency = "eur";

    get doubled(): number {
      return this.cents * 2;
    }
  }

  test("an instance of an author's class, as a plain object of its own data", () => {
    const decoded = roundTrip(new Money());
    expect(decoded).toStrictEqual({ cents: 1, currency: "eur" });
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  });

  test.each([
    [
      "a Map subclass",
      new (class Ledger extends Map<string, number> {})([["a", 1]]),
      new Map([["a", 1]]),
    ],
    [
      "a Set subclass",
      new (class Tags extends Set<string> {})(["a"]),
      new Set(["a"]),
    ],
    ["a Date subclass", new (class Deadline extends Date {})(0), new Date(0)],
    ["an Array subclass", class Rows extends Array<number> {}.of(1, 2), [1, 2]],
    [
      "a typed array subclass",
      new (class Samples extends Uint16Array {})([1]),
      new Uint16Array([1]),
    ],
    [
      "an Error subclass",
      new (class DeclinedError extends Error {
        override readonly name = "DeclinedError";
      })("no"),
      namedError("DeclinedError", "no"),
    ],
  ])("%s, as the built-in", (_, value, expected) => {
    const decoded = roundTrip(value);
    expect(Object.getPrototypeOf(decoded)).toBe(
      Object.getPrototypeOf(expected)
    );
    expect(decoded).toStrictEqual(expected);
  });

  test.each([
    ["Date", Object.create(Date.prototype)],
    ["Map", Object.create(Map.prototype)],
    ["typed array", Object.create(Uint8Array.prototype)],
    ["ArrayBuffer", Object.create(ArrayBuffer.prototype)],
    ["RegExp", Object.create(RegExp.prototype)],
    ["Error", Object.create(Error.prototype)],
  ])(
    "an object that only borrows the %s prototype, as a plain object",
    (_, value) => {
      const decoded = roundTrip(value);
      expect(decoded).toStrictEqual({});
      expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    }
  );
});

describe("values the journal can't keep are refused", () => {
  test.each([
    ["a function", () => 1],
    ["a symbol", Symbol("s")],
    ["a boxed symbol", new Object(Symbol("s"))],
    ["a URL", new URL("https://example.com")],
    ["a promise", Promise.resolve(1)],
    [
      "an author's subclass of a promise",
      new (class Later extends Promise<number> {})(() => {}),
    ],
    ["a WeakMap", new WeakMap()],
    ["a stream inside a value", { body: new ReadableStream() }],
    ["an RPC stub", env.RUNS.get(env.RUNS.idFromName("codec-test"))],
    ["an RPC stub's method", env.RUNS.get(env.RUNS.idFromName("codec")).status],
    ["an object holding a function", { held: { run: (): number => 1 } }],
    ["a function inside an object", { nested: [{ fn: () => 1 }] }],
  ])("%s", (_, value) => {
    expect(() => encode(value)).toThrow(SerializationError);
  });

  test("a value whose getter throws, as a SerializationError", () => {
    const value = {
      get broken(): never {
        throw new Error("no");
      },
    };
    expect(() => encode(value)).toThrow(SerializationError);
  });

  test("an error whose name can't be read", () => {
    const error = new Error("hidden");
    Object.defineProperty(error, "name", {
      get: () => {
        throw new Error("no");
      },
    });
    expect(() => encode(error)).toThrow(/name or message can't be read/u);
  });

  test("a string larger than a step may return, measured as structured clone keeps it", () => {
    // One byte a character when every character is Latin-1, two otherwise.
    expect(() => encode("e".repeat(maxEncodedBytes - 100))).not.toThrow();
    expect(() => encode("é".repeat(maxEncodedBytes + 1))).toThrow(
      /more than 1048576 bytes/u
    );
    expect(() => encode("€".repeat(maxEncodedBytes / 2))).toThrow(
      /more than 1048576 bytes/u
    );
    expect(() => encode("€".repeat(maxEncodedBytes / 2 - 100))).not.toThrow();
  });

  test("bytes larger than a step may return, measured on their length, not their base64", () => {
    // Its base64 is more than a mebibyte; the bytes are less.
    const bytes = new Uint8Array(800 * 1024);
    const text = encode(bytes);
    expect(text.length).toBeGreaterThan(maxEncodedBytes);
    expect(decode(text)).toStrictEqual(bytes);
    expect(() => encode(new Uint8Array(maxEncodedBytes))).toThrow(
      SerializationError
    );
    // Refused before any of its base64 is built.
    expect(() => encode(new Uint8Array(256 * 1024 * 1024))).toThrow(
      /more than \d+ bytes/u
    );
  });

  test("a string whose escaped text outgrows a journal value, with a clear error", () => {
    // Quotes escape to two characters each: kept, at twice the text.
    const quotes = '"'.repeat(600 * 1024);
    const text = encode(quotes);
    expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(
      maxEncodedBytes
    );
    expect(decode(text)).toBe(quotes);
    // A control character escapes to six: within the step limit, but its
    // text outgrows a journal value.
    expect(() => encode("\u0001".repeat(400 * 1024))).toThrow(
      new RegExp(
        `more than the ${maxStoredTextBytes} a journal value holds`,
        "u"
      )
    );
  });

  test.each([
    [
      "another codec version",
      JSON.stringify([codecVersion - 1, "x"]),
      /codec version/u,
    ],
    ["an unknown tag", codecText(["Q"]), /the tag "Q"/u],
    ["a reference to nothing yet", codecText(["A", ["P", 1]]), /reference/u],
    [
      "a view outside its buffer",
      codecText(["T", "Int16Array", ["R", "AQ=="], 0, 1]),
      /outside its buffer/u,
    ],
    [
      "bytes that aren't base64",
      codecText(["R", "not base64!"]),
      /base64 doesn't read/u,
    ],
    [
      "a stream result outside its step",
      codecText(["Z", 1, 0, 0, "0".repeat(64), "identity"]),
      /stream result outside its step/u,
    ],
  ])("text holding %s, rather than being misread", (_, text, error) => {
    expect(() => decode(text)).toThrow(error);
  });
});

describe("equivalent codec text", () => {
  test("holds for plain objects whose keys come in another order, nested too", () => {
    expect(
      equivalent(
        encode({ b: 1, a: { d: [{ f: 1, e: 2 }], c: 3 } }),
        encode({ a: { c: 3, d: [{ e: 2, f: 1 }] }, b: 1 })
      )
    ).toBeTruthy();
  });

  test("holds for the same sharing, whatever the key order; not for other sharing", () => {
    const first = { y: 1, x: 2 };
    const second = { x: 2, y: 1 };
    // Shared alike, keys in another order: the same value.
    expect(
      equivalent(
        encode({ b: first, a: first }),
        encode({ a: second, b: second })
      )
    ).toBeTruthy();
    // One shared object against two equal copies: which parts are one
    // object is part of the value.
    expect(
      equivalent(
        encode({ b: first, a: first }),
        encode({ a: { x: 2, y: 1 }, b: { y: 1, x: 2 } })
      )
    ).toBeFalsy();
  });

  test("tells rings of other lengths apart, exactly and without throwing", () => {
    const rings = (length: number): unknown[] =>
      Array.from({ length: 5 }, () => ring(length));
    expect(equivalent(encode(rings(499)), encode(rings(500)))).toBeFalsy();
    expect(equivalent(encode(rings(500)), encode(rings(500)))).toBeTruthy();
  });

  test("holds for two cyclic values of the same shape, and not for another shape", () => {
    expect(equivalent(encode(loop("a")), encode(loop("a")))).toBeTruthy();
    expect(equivalent(encode(loop("a")), encode(loop("b")))).toBeFalsy();
  });

  test("holds for an array of 300,000 items, which no spread of them could pass", () => {
    const items = Array.from({ length: 300_000 }, () => null);
    expect(equivalent(encode(items), encode([...items]))).toBeTruthy();
  });

  test("compares a self-linked value with a long chain without overflowing, and finds them different", () => {
    const self = loop("link");
    let chain: Record<string, unknown> = { name: "link", self: null };
    for (let link = 0; link < maxNestingDepth - 2; link += 1) {
      chain = { name: "link", self: chain };
    }
    expect(equivalent(encode(self), encode(chain))).toBeFalsy();
    expect(equivalent(encode(chain), encode(self))).toBeFalsy();
  });

  test("doesn't hold for other content", () => {
    expect(equivalent(encode({ a: 1 }), encode({ a: 2 }))).toBeFalsy();
    expect(equivalent(encode({ a: 1 }), encode({ a: 1, b: 1 }))).toBeFalsy();
    expect(
      equivalent(encode(new Uint8Array([1])), encode(new Int8Array([1])))
    ).toBeFalsy();
  });

  test("keeps the order of a Map's entries, a Set's items and an array's elements", () => {
    const pairs: [string, number][] = [
      ["a", 1],
      ["b", 2],
    ];
    expect(
      equivalent(encode(new Map(pairs)), encode(new Map(pairs.toReversed())))
    ).toBeFalsy();
    expect(
      equivalent(encode(new Set(["a", "b"])), encode(new Set(["b", "a"])))
    ).toBeFalsy();
    expect(equivalent(encode(["a", "b"]), encode(["b", "a"]))).toBeFalsy();
  });
});
