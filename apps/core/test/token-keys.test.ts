import { describe, expect, it } from "vite-plus/test";

import { keyRing } from "../src/auth/token-keys.ts";

// The token-signing keys as one isolate holds them: to check tokens, read
// from D1 at most once a minute, again a few seconds after for a key
// another isolate made since, and at once after this isolate made one; to
// sign, always afresh.

const now = Date.parse("2026-10-15T12:00:00Z");

/** A store of key rows, counting how often it is read. */
const store = (ids: string[]) => {
  let reads = 0;
  return {
    read: async () => {
      reads += 1;
      return await Promise.resolve(ids.map((id) => ({ id })));
    },
    reads: () => reads,
    add: (id: string) => {
      ids.push(id);
    },
  };
};

describe("an isolate's token keys", () => {
  it("reads them once a minute for the keys it holds, and again after a minute", async () => {
    const keys = store(["one"]);
    const ring = keyRing<{ id: string }>();
    await ring.keys(keys.read, "one", now);
    await ring.keys(keys.read, "one", now + 30_000);
    await ring.keys(keys.read, "one", now + 59_000);
    const withinMinute = keys.reads();
    await ring.keys(keys.read, "one", now + 60_000);
    expect({ withinMinute, after: keys.reads() }).toStrictEqual({
      withinMinute: 1,
      after: 2,
    });
  });

  it("finds a key made since a few seconds on, and reads no more often for keys nobody made", async () => {
    const keys = store(["one"]);
    const ring = keyRing<{ id: string }>();
    await ring.keys(keys.read, "one", now);
    keys.add("two");
    const soon = await ring.keys(keys.read, "two", now + 1000);
    const later = await ring.keys(keys.read, "two", now + 5000);
    await ring.keys(keys.read, "made-up", now + 6000);
    await ring.keys(keys.read, "made-up", now + 9000);
    expect({
      soon: soon.map(({ id }) => id),
      later: later.map(({ id }) => id),
      reads: keys.reads(),
    }).toStrictEqual({ soon: ["one"], later: ["one", "two"], reads: 2 });
  });

  it("signs with the keys as they are now, and reads them again at once after it made one", async () => {
    const keys = store(["one"]);
    const ring = keyRing<{ id: string }>();
    await ring.keys(keys.read, "one", now);
    keys.add("two");
    const signing = await ring.keys(keys.read, undefined, now + 1);
    keys.add("three");
    ring.forget();
    const checking = await ring.keys(keys.read, "three", now + 2);
    expect({
      signing: signing.map(({ id }) => id),
      checking: checking.map(({ id }) => id),
    }).toStrictEqual({
      signing: ["one", "two"],
      checking: ["one", "two", "three"],
    });
  });
});
