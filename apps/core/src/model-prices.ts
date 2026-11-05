import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { calculateCost } from "@earendil-works/pi-ai/models";

// What a model request cost, in US dollars at its provider's list prices:
// pi's own `calculateCost` over the usage the provider reported, which
// prices a model's tiers (past a number of prompt tokens, all of a request
// at the tier's prices: OpenAI's GPT-5.4 and later past 272K) and
// Anthropic's one-hour cache writes. Anthropic's long-context premium,
// which pi's catalog doesn't price, is added here as a tier
// (`listPricesOf`). An estimate for an overview, never a bill: the
// provider's invoice is the bill.

/** A model's prices as pi's catalog gives them: US dollars per million tokens. */
export type ListPrices = Model<Api>["cost"];

/** The prompt tokens past which Anthropic's long-context premium applies. */
const longContextTokens = 200_000;

/**
 * The Claude models that may be charged Anthropic's long-context premium:
 * 2x input and 1.5x output (cache prices scaled with input) for a whole
 * request whose prompt, cached tokens included, is over 200K tokens.
 *
 * Source: Anthropic's pricing page, "Long context pricing"
 * (https://platform.claude.com/docs/en/about-claude/pricing), read on
 * 2026-10-10. It confirms that Claude 4.6 and later models (except Haiku
 * 5.5, which pi's catalog doesn't offer) take the full 1M window at
 * standard prices. It no longer states the premium for earlier models,
 * so Sonnet 4.5 and Sonnet 4, the earlier models with a window past 200K,
 * carry it here to be safe: their 1M-context beta was priced 2x/1.5x
 * past 200K. Opus 4.5 and Haiku 4.5 have a 200K window, so they can't
 * reach it.
 */
const longContextPremium = /^claude-sonnet-4(?:-5)?(?:-\d{8})?$/u;

/**
 * A model's prices as pi's catalog gives them, with Anthropic's
 * long-context premium as a tier past 200K prompt tokens for the models
 * that carry it, which the catalog leaves out.
 */
export const listPricesOf = (
  provider: string,
  id: string,
  prices: ListPrices
): ListPrices => {
  if (provider !== "anthropic" || !longContextPremium.test(id)) {
    return prices;
  }
  const { input, output, cacheRead, cacheWrite } = prices;
  return {
    ...prices,
    tiers: [
      ...(prices.tiers ?? []),
      {
        inputTokensAbove: longContextTokens,
        input: input * 2,
        output: output * 1.5,
        cacheRead: cacheRead * 2,
        cacheWrite: cacheWrite * 2,
      },
    ],
  };
};

/**
 * What `usage` cost on `model` (pi's catalog entry of `provider`'s model
 * `id`), in US dollars at its list prices (`listPricesOf`), as pi's
 * `calculateCost` prices it; 0 for a count that isn't one.
 */
export const usageCost = (
  { provider, id, model }: { provider: string; id: string; model: Model<Api> },
  usage: Usage
): number => {
  const { total } = calculateCost(
    { ...model, cost: listPricesOf(provider, id, model.cost) },
    // pi writes the cost into the usage it is given: never the caller's.
    { ...usage, cost: { ...usage.cost } }
  );
  return Number.isFinite(total) && total > 0 ? total : 0;
};
