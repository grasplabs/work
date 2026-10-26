import type { ChannelSigningKey } from "@grasp-os/shared/channel-keys";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { channelKeys, keyFor } from "../src/channels/signing-keys.ts";

// A channel's webhook signing keys as one isolate holds them
// (src/channels/signing-keys.ts, threat model GRA-1078): fetches shared
// while under way, one stuck past its time replaced, a late one never
// kept over a newer set, and a failed one keeping the set held before.
// The door's own tests (channels-door.test.ts) cover rotation and the
// once-a-minute limit through connect.

/** A key with id `kid`, as connect answers it. */
const key = (kid: string): ChannelSigningKey => ({
  kid,
  kty: "RSA",
  n: "n",
  e: "AQAB",
  endorsements: ["msteams"],
});

const minute = 60_000;

/** Moves the clock `ms` on, for `Date` alone. */
const later = (ms: number): void => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + ms });
};

/** A provider whose fetches each wait until answered, counting them. */
const provider = () => {
  const pending: PromiseWithResolvers<readonly ChannelSigningKey[]>[] = [];
  return {
    fetch: async (): Promise<readonly ChannelSigningKey[]> => {
      const answer = Promise.withResolvers<readonly ChannelSigningKey[]>();
      pending.push(answer);
      return await answer.promise;
    },
    fetches: () => pending.length,
    /** Answers the `index`th fetch with `keys`. */
    answer: (index: number, keys: readonly ChannelSigningKey[]) => {
      pending[index]?.resolve(keys);
    },
    /** Fails the `index`th fetch. */
    fail: (index: number) => {
      pending[index]?.reject(new Error("connect unavailable"));
    },
  };
};

/** Once `provider` has had `count` fetches. */
const fetchesReach = async (
  keys: ReturnType<typeof provider>,
  count: number
): Promise<void> => {
  await vi.waitFor(() => {
    expect(keys.fetches()).toBe(count);
  });
};

describe("a channel's signing keys", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("share one fetch among the requests that come while it is under way", async () => {
    const source = provider();
    const keys = channelKeys();
    const asked = Promise.all(
      ["one", "two", "made-up"].map(
        async (kid) => await keyFor(source.fetch, keys, kid)
      )
    );
    await fetchesReach(source, 1);
    source.answer(0, [key("one"), key("two")]);
    const found = await asked;

    expect({
      found: found.map((each) => each?.kid),
      fetches: source.fetches(),
    }).toStrictEqual({ found: ["one", "two", undefined], fetches: 1 });
  });

  it("fetch anew once a fetch is stuck past its time, and never keep the stuck one's late answer", async () => {
    const source = provider();
    const keys = channelKeys();
    // A fetch whose request was cancelled: it doesn't settle in time.
    const stuck = keyFor(source.fetch, keys, "old");
    await fetchesReach(source, 1);
    later(minute);
    const replaced = keyFor(source.fetch, keys, "rotated");
    await fetchesReach(source, 2);
    source.answer(1, [key("rotated")]);
    const found = await replaced;
    // The stuck one settles after all, with the keys as they were.
    source.answer(0, [key("old")]);
    await stuck;

    expect({
      found: found?.kid,
      fetches: source.fetches(),
      kept: [...(keys.set?.keys.keys() ?? [])],
    }).toStrictEqual({ found: "rotated", fetches: 2, kept: ["rotated"] });
  });

  it("keep the set held before when a fetch fails, and fetch again no sooner than a minute on", async () => {
    const source = provider();
    const keys = channelKeys();
    const first = keyFor(source.fetch, keys, "one");
    await fetchesReach(source, 1);
    source.answer(0, [key("one")]);
    await first;
    later(2 * minute);
    const failing = keyFor(source.fetch, keys, "rotated");
    await fetchesReach(source, 2);
    source.fail(1);
    const failed = await failing.then(
      () => "answered",
      () => "refused"
    );
    const withinMinute = await keyFor(source.fetch, keys, "rotated");
    const held = await keyFor(source.fetch, keys, "one");

    expect({
      failed,
      withinMinute,
      held: held?.kid,
      fetches: source.fetches(),
    }).toStrictEqual({
      failed: "refused",
      withinMinute: undefined,
      held: "one",
      fetches: 2,
    });
  });
});
