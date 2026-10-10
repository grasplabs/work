import { describe, expect, it } from "vite-plus/test";

import { boundMicros, costMicros, pinnedPrice } from "../src/model-prices.ts";

// What model requests cost in whole micros: pure arithmetic, tested on
// its own.

const llama = { input: 0.293, output: 2.253, cacheRead: 0, cacheWrite: 0 };
const claude = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
/** GPT-5.4's prices past 272K prompt tokens, as pi's catalog gives them. */
const longPrompt = {
  inputTokensAbove: 272_000,
  input: 5,
  output: 22.5,
  cacheRead: 0.5,
  cacheWrite: 0,
};
/** As pi's catalog prices it: twice the input and half again the output past 272K. */
const gpt54 = {
  input: 2.5,
  output: 15,
  cacheRead: 0.25,
  cacheWrite: 0,
  tiers: [longPrompt],
};

describe("model prices", () => {
  it("pin a model's list prices as whole micros a million tokens, rounded up, named by their hash", async () => {
    const pinned = await pinnedPrice(llama);
    expect(pinned).toMatchObject({
      input: 293_000,
      output: 2_253_000,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(pinned?.version).toMatch(/^sha256:[0-9a-f]{64}$/u);
    await expect(pinnedPrice({ ...llama })).resolves.toStrictEqual(pinned);
    const other = await pinnedPrice(claude);
    expect(other?.version).not.toBe(pinned?.version);
    await expect(
      pinnedPrice({ ...llama, input: 0.0000001 })
    ).resolves.toMatchObject({ input: 1 });
  });

  it("give a model no price when its input or output has none, or one isn't a price", async () => {
    const prices = await Promise.all([
      pinnedPrice({ ...llama, input: 0 }),
      pinnedPrice({ ...llama, output: 0 }),
      pinnedPrice({ ...llama, output: Number.NaN }),
      pinnedPrice({ ...llama, cacheRead: -1 }),
      pinnedPrice({ ...llama, cacheWrite: Number.POSITIVE_INFINITY }),
      pinnedPrice({ ...llama, output: 1e300 }),
    ]);
    expect(prices.map((price) => price === undefined)).toStrictEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it("charge each kind of token at its own price, rounding each up, so no use is free", async () => {
    const pinned = await pinnedPrice(claude);
    if (pinned === undefined) {
      throw new Error("Claude has prices");
    }
    expect(
      costMicros(pinned, {
        input: 1000,
        output: 100,
        cacheRead: 1000,
        cacheWrite: 1000,
      })
    ).toBe(3000 + 1500 + 300 + 3750);
    expect(
      costMicros(pinned, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 })
    ).toBe(3);
    expect(
      costMicros(pinned, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    ).toBe(0);
  });

  it("bound a request at the dearest input price, so a cache write can't cost more than was reserved", async () => {
    const pinned = await pinnedPrice(claude);
    if (pinned === undefined) {
      throw new Error("Claude has prices");
    }
    const bound = boundMicros(pinned, { inputTokens: 1000, outputTokens: 100 });
    expect(bound).toBe(3750 + 1500);
    for (const tokens of [
      { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 },
      { input: 0, output: 100, cacheRead: 1000, cacheWrite: 0 },
      { input: 0, output: 100, cacheRead: 0, cacheWrite: 1000 },
      { input: 500, output: 100, cacheRead: 250, cacheWrite: 250 },
    ]) {
      expect(costMicros(pinned, tokens)).toBeLessThanOrEqual(bound);
    }
  });

  it("charge a prompt past a tier's threshold at that tier's prices, as pi counts it, cached tokens included", async () => {
    const pinned = await pinnedPrice(gpt54);
    if (pinned === undefined) {
      throw new Error("GPT-5.4 has prices");
    }
    // At the threshold: the base prices.
    expect(
      costMicros(pinned, {
        input: 272_000,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
      })
    ).toBe(272_000 * 2.5 + 1500);
    // Past it, cached tokens counting towards it: the tier's, for all of it.
    expect(
      costMicros(pinned, {
        input: 272_000,
        output: 100,
        cacheRead: 28_000,
        cacheWrite: 0,
      })
    ).toBe(272_000 * 5 + 2250 + 28_000 * 0.5);
  });

  it("bound a tiered model at its dearest tier, and name its tiers in its version", async () => {
    const pinned = await pinnedPrice(gpt54);
    const untiered = await pinnedPrice({ ...gpt54, tiers: [] });
    if (pinned === undefined || untiered === undefined) {
      throw new Error("GPT-5.4 has prices");
    }
    expect(boundMicros(pinned, { inputTokens: 1000, outputTokens: 100 })).toBe(
      1000 * 5 + 2250
    );
    expect(pinned.version).not.toBe(untiered.version);
    // A tier whose prices aren't prices leaves the model with none.
    await expect(
      pinnedPrice({
        ...gpt54,
        tiers: [{ ...longPrompt, output: Number.NaN }],
      })
    ).resolves.toBeUndefined();
    await expect(
      pinnedPrice({
        ...gpt54,
        tiers: [{ ...longPrompt, inputTokensAbove: -1 }],
      })
    ).resolves.toBeUndefined();
  });

  it("refuse a count that isn't one, or a cost too large to count exactly", async () => {
    const pinned = await pinnedPrice(claude);
    if (pinned === undefined) {
      throw new Error("Claude has prices");
    }
    expect(() =>
      costMicros(pinned, { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 })
    ).toThrow(RangeError);
    expect(() =>
      costMicros(pinned, { input: 1.5, output: 0, cacheRead: 0, cacheWrite: 0 })
    ).toThrow(RangeError);
    expect(() =>
      boundMicros(pinned, {
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: Number.MAX_SAFE_INTEGER,
      })
    ).toThrow(RangeError);
  });
});
