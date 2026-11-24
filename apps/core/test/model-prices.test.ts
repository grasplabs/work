import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vite-plus/test";

import { parseModelRef } from "../src/model-catalog.ts";
import { listPricesOf, usageCost } from "../src/model-prices.ts";

// What a model request cost at list prices: pi's `calculateCost` over the
// provider's usage, with the tier pi's catalog leaves out. Pure
// arithmetic, tested on its own.

const claude = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
/** GPT-5.4's prices past 272K prompt tokens, as pi's catalog gives them. */
const gpt54 = {
  input: 2.5,
  output: 15,
  cacheRead: 0.25,
  cacheWrite: 0,
  tiers: [
    {
      inputTokensAbove: 272_000,
      input: 5,
      output: 22.5,
      cacheRead: 0.5,
      cacheWrite: 0,
    },
  ],
};

/** A provider's usage of `counts`, its cost not yet worked out. */
const usageOf = (counts: Partial<Usage>): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  ...counts,
});

/** Claude Sonnet 4.5 from pi's catalog, as the gateway prices it. */
const sonnet = () => {
  const ref = parseModelRef("anthropic/claude-sonnet-4-5");
  if (ref === undefined) {
    throw new Error("The catalog has Claude Sonnet 4.5");
  }
  return { provider: ref.provider, id: ref.id, model: ref.catalog };
};

describe("model prices", () => {
  it("give the Claude models that carry Anthropic's long-context premium a tier past 200K, and no others", () => {
    const premium = {
      inputTokensAbove: 200_000,
      input: 6,
      output: 22.5,
      cacheRead: 0.6,
      cacheWrite: 7.5,
    };
    expect([
      listPricesOf("anthropic", "claude-sonnet-4-5", claude),
      listPricesOf("anthropic", "claude-sonnet-4-5-20250929", claude),
      listPricesOf("anthropic", "claude-sonnet-4-20250514", claude),
      listPricesOf("anthropic", "claude-sonnet-4-6", claude),
      listPricesOf("anthropic", "claude-opus-4-6", claude),
      listPricesOf("openrouter", "claude-sonnet-4-5", claude),
      listPricesOf("openai", "gpt-5.4", gpt54),
    ]).toStrictEqual([
      { ...claude, tiers: [premium] },
      { ...claude, tiers: [premium] },
      { ...claude, tiers: [premium] },
      claude,
      claude,
      claude,
      gpt54,
    ]);
  });

  it("cost a prompt past 200K on a model with the premium at the premium, and one below it at list prices", () => {
    const model = sonnet();
    const { input, output } = model.model.cost;
    const short = usageOf({ input: 100_000, output: 1000 });
    const long = usageOf({ input: 250_000, output: 1000 });

    expect([usageCost(model, short), usageCost(model, long)]).toStrictEqual([
      (100_000 * input + 1000 * output) / 1_000_000,
      (250_000 * input * 2 + 1000 * output * 1.5) / 1_000_000,
    ]);
  });

  it("cost one-hour cache writes at twice the input price, as Anthropic bills them", () => {
    const model = sonnet();
    const { input } = model.model.cost;

    expect(
      usageCost(model, usageOf({ cacheWrite: 10_000, cacheWrite1h: 10_000 }))
    ).toBeCloseTo((10_000 * input * 2) / 1_000_000, 12);
  });

  it("cost a count that isn't one as nothing, and never write into the caller's usage", () => {
    const model = sonnet();
    const usage = usageOf({ input: 1000 });

    expect({
      broken: usageCost(model, usageOf({ input: Number.NaN })),
      cost: usageCost(model, usage) > 0,
      untouched: usage.cost.total,
    }).toStrictEqual({ broken: 0, cost: true, untouched: 0 });
  });
});
