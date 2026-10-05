import { describe, expect, it } from "vite-plus/test";

import { jsonBytes } from "../src/screen-limits.ts";
import { takeToken, TokenBuckets } from "../src/token-bucket.ts";

const rate = { burst: 3, perMinute: 60 };

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
      ascii: jsonBytes("abcd"),
      // Two bytes a letter.
      accented: jsonBytes("éééé"),
      // Three bytes a sign.
      euro: jsonBytes("€€€€"),
      // Four bytes each, though each is two UTF-16 code units.
      emoji: jsonBytes("😀😀😀😀"),
    }).toStrictEqual({ ascii: 6, accented: 10, euro: 14, emoji: 18 });
  });

  it("counts the keys and punctuation a value travels with", () => {
    expect(jsonBytes({ note: ["a", 1, null] })).toBe(
      '{"note":["a",1,null]}'.length
    );
  });

  it("counts bytes as their base64 and a big integer as its digits", () => {
    expect({
      bytes: jsonBytes(new Uint8Array(300)),
      big: jsonBytes(12_345_678_901_234_567_890n),
    }).toStrictEqual({ bytes: 402, big: 22 });
  });

  it("puts a value that holds itself past any limit", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(jsonBytes(loop)).toBe(Number.POSITIVE_INFINITY);
  });
});
