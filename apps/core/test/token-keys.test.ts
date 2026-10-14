import { describe, expect, it } from "vite-plus/test";

import { keyRing } from "../src/auth/token-keys.ts";

// The token-signing keys as one isolate holds them: to check tokens, read
// from D1 at most once a minute, again a few seconds after for a key it
// doesn't hold or can't read, and at once after this isolate made one; to
// sign, always afresh; and requests meanwhile share one read.

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

const sign = { sign: true } as const;

/** The IDs of `keys`. */
const idsOf = (keys: readonly { id: string }[]) => keys.map(({ id }) => id);

describe("an isolate's token keys", () => {
  it("reads them once a minute for the keys it holds, and again after a minute", async () => {
    const keys = store(["one"]);
    const ring = keyRing<{ id: string }>();
    await ring.keys(keys.read, { kid: "one" }, now);
    await ring.keys(keys.read, { kid: "one" }, now + 30_000);
    await ring.keys(keys.read, { kid: "one" }, now + 59_000);
    const withinMinute = keys.reads();
    await ring.keys(keys.read, { kid: "one" }, now + 60_000);
    expect({ withinMinute, after: keys.reads() }).toStrictEqual({
      withinMinute: 1,
      after: 2,
    });
  });

  it("finds a key made since a few seconds on, and reads no more often for keys nobody made or nobody can read", async () => {
    const keys = store(["one"]);
    const ring = keyRing<{ id: string }>();
    await ring.keys(keys.read, { kid: "one" }, now);
    keys.add("two");
    const soon = await ring.keys(keys.read, { kid: "two" }, now + 1000);
    const pending = ring.pending("two", now + 1000);
    const later = await ring.keys(keys.read, { kid: "two" }, now + 5000);
    await ring.keys(keys.read, { kid: "made-up" }, now + 6000);
    await ring.keys(keys.read, { kid: undefined }, now + 7000);
    await ring.keys(keys.read, { kid: undefined }, now + 9000);
    expect({
      soon: idsOf(soon),
      pending,
      later: idsOf(later),
      reads: keys.reads(),
    }).toStrictEqual({
      soon: ["one"],
      pending: true,
      later: ["one", "two"],
      reads: 2,
    });
  });

  it("shares one read among the requests that come while it is under way", async () => {
    const keys = store(["one"]);
    const ring = keyRing<{ id: string }>();
    await Promise.all([
      ring.keys(keys.read, { kid: "one" }, now),
      ring.keys(keys.read, { kid: "made-up" }, now),
      ring.keys(keys.read, sign, now),
    ]);
    expect(keys.reads()).toBe(1);
  });

  it("signs with the keys as they are now, and reads them again at once after it made one", async () => {
    const keys = store(["one"]);
    const ring = keyRing<{ id: string }>();
    await ring.keys(keys.read, { kid: "one" }, now);
    keys.add("two");
    const signing = await ring.keys(keys.read, sign, now + 1);
    keys.add("three");
    ring.forget();
    const checking = await ring.keys(keys.read, { kid: "three" }, now + 2);
    expect({
      signing: idsOf(signing),
      checking: idsOf(checking),
    }).toStrictEqual({
      signing: ["one", "two"],
      checking: ["one", "two", "three"],
    });
  });
});
