import { describe, expect, it } from "vite-plus/test";

import { jsonBytes } from "../src/screen-limits.ts";
import { takeToken, TokenBuckets } from "../src/token-bucket.ts";

const rate = { burst: 3, perMinute: 60 };

/** A limit no value reaches: the measure itself. */
const unlimited = Number.POSITIVE_INFINITY;

/** `leaf` inside `levels` arrays, each inside the next. */
const wrapped = (leaf: unknown, levels: number): unknown => {
  let value = leaf;
  for (let level = 0; level < levels; level += 1) {
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

describe("a token bucket", () => {
  it("lets a burst through and refuses the next request", () => {
    const buckets = new TokenBuckets(rate);
    const taken = [0, 0, 0, 0, 0].map(() => buckets.take("ada", 1000));
    expect(taken).toStrictEqual([true, true, true, false, false]);
  });

  it("fills at its rate, and never past its burst", () => {
    const buckets = new TokenBuckets(rate);
    for (let request = 0; request < 5; request += 1) {
      buckets.take("ada", 0);
    }
    // One token a second: one more after a second, three after an hour.
    expect({
      afterOneSecond: [buckets.take("ada", 1000), buckets.take("ada", 1000)],
      afterAnHour: [0, 0, 0, 0].map(() => buckets.take("ada", 3_600_000)),
    }).toStrictEqual({
      afterOneSecond: [true, false],
      afterAnHour: [true, true, true, false],
    });
  });

  it("keeps one person's requests from using up another's", () => {
    const buckets = new TokenBuckets(rate);
    for (let request = 0; request < 5; request += 1) {
      buckets.take("ada", 0);
    }
    expect(buckets.take("grace", 0)).toBeTruthy();
  });

  it("fills nothing when the clock goes back", () => {
    let bucket = takeToken(undefined, { burst: 1, perMinute: 60 }, 10_000);
    bucket = takeToken(bucket.bucket, { burst: 1, perMinute: 60 }, 0);
    expect(bucket.taken).toBeFalsy();
  });

  it("refuses everyone's flood alike once it holds many people's buckets", () => {
    const buckets = new TokenBuckets({ burst: 1, perMinute: 1 });
    for (let person = 0; person < 2000; person += 1) {
      buckets.take(`person-${person}`, 0);
    }
    // Forgetting buckets that are full again must not refill one that isn't.
    expect([
      buckets.take("person-0", 1),
      buckets.take("person-1999", 1),
    ]).toStrictEqual([false, false]);
  });
});

describe("the size of a value in bytes", () => {
  it("counts UTF-8 bytes of the JSON text, not characters", () => {
    expect({
      ascii: jsonBytes("abcd", unlimited),
      // Two bytes a letter.
      accented: jsonBytes("éééé", unlimited),
      // Three bytes a sign.
      euro: jsonBytes("€€€€", unlimited),
      // Four bytes each, though each is two UTF-16 code units.
      emoji: jsonBytes("😀😀😀😀", unlimited),
    }).toStrictEqual({ ascii: 6, accented: 10, euro: 14, emoji: 18 });
  });

  it("counts the keys and punctuation a value travels with", () => {
    expect(jsonBytes({ note: ["a", 1, null] }, unlimited)).toBe(
      '{"note":["a",1,null]}'.length
    );
  });

  it("counts bytes as their base64 and a big integer as its digits", () => {
    expect({
      bytes: jsonBytes(new Uint8Array(300), unlimited),
      big: jsonBytes(12_345_678_901_234_567_890n, unlimited),
    }).toStrictEqual({ bytes: 402, big: 22 });
  });

  it("counts an error as the name, message and stack it travels with", () => {
    const error = Object.assign(new Error("A".repeat(5_000_000)), {
      code: "app.failed",
    });
    const bare = new Error("short");
    bare.stack = undefined;
    expect({
      big: jsonBytes([error], unlimited) > 5_000_000,
      inAnAnswer: jsonBytes({ e: error }, unlimited) > 5_000_000,
      bare: jsonBytes(bare, unlimited),
    }).toStrictEqual({
      big: true,
      inAnAnswer: true,
      bare: '{"name":"Error","message":"short"}'.length,
    });
  });

  it("puts what it has no measure for past any limit, wherever it is held", () => {
    class Invoice {
      total = 1;
    }
    const unmeasured = {
      map: new Map([["a", "x".repeat(1000)]]),
      set: new Set(["x".repeat(1000)]),
      buffer: new ArrayBuffer(1000),
      words: new Uint16Array(1000),
      instance: new Invoice(),
      callback: () => "x",
      symbol: Symbol("x"),
    };
    expect(
      Object.entries(unmeasured)
        .filter(
          ([, value]) =>
            Number.isFinite(jsonBytes(value, unlimited)) ||
            Number.isFinite(jsonBytes({ deep: [value] }, unlimited))
        )
        .map(([name]) => name)
    ).toStrictEqual([]);
  });

  it("measures what is plain: a date, nothing, and the same value held twice", () => {
    const shared = { note: "a" };
    expect({
      date: jsonBytes(new Date(0), unlimited),
      nothing: [jsonBytes(null, unlimited), jsonBytes([undefined], unlimited)],
      omitted: jsonBytes({ kept: 1, dropped: undefined }, unlimited),
      twice: jsonBytes([shared, shared], unlimited),
      noPrototype: jsonBytes(
        Object.assign(Object.create(null), { a: 1 }),
        unlimited
      ),
    }).toStrictEqual({
      date: '"1970-01-01T00:00:00.000Z"'.length,
      nothing: [4, 6],
      omitted: '{"kept":1}'.length,
      twice: '[{"note":"a"},{"note":"a"}]'.length,
      noPrototype: '{"a":1}'.length,
    });
  });

  it("checks the buckets it forgets at most once a minute, and refills none that isn't full", () => {
    const buckets = new TokenBuckets({ burst: 1, perMinute: 1 });
    expect(buckets.has("ada", 0)).toBeTruthy();
    buckets.take("ada", 0);
    expect([buckets.has("ada", 0), buckets.has("ada", 60_000)]).toStrictEqual([
      false,
      true,
    ]);
  });

  it("puts a value that holds itself past any limit", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(jsonBytes(loop, unlimited)).toBe(Number.POSITIVE_INFINITY);
  });

  it("measures a value nested far deeper than the call stack goes", () => {
    expect(jsonBytes(wrapped("bottom", 200_000), unlimited)).toBe(
      '"bottom"'.length + 2 * 200_000
    );
  });

  it("stops once past its limit, however many times a value is held", () => {
    expect({
      // 2^64 copies of it, as written out.
      held: jsonBytes(doubled("x".repeat(1000), 64), 256 * 1024),
      atLimit: jsonBytes("abcd", 6),
      pastLimit: jsonBytes("abcd", 5),
    }).toStrictEqual({ held: unlimited, atLimit: 6, pastLimit: unlimited });
  });
});
