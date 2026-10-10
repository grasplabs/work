import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";

// What model requests cost, in whole millionths of a US dollar (micros):
// the prices a request is pinned to when it is admitted, the most it can
// cost, which the model ledger reserves (model-ledger.ts), and what its
// usage cost, which the ledger charges. Integers only, rounded up, so no
// sum of many small requests rounds away to nothing, and a reservation is
// never below what its request can cost at those prices.
//
// Some models are priced in tiers: past a number of prompt tokens, all of
// the request is charged at the tier's prices (OpenAI's GPT-5.4 and later
// past 272K). A request is charged at its tier as pi's `calculateCost`
// picks it, so the ledger agrees with the cost the audit log records, and
// bounded at the dearest tier, which its prompt may reach.
//
// Prices the catalog leaves out are refused before a request is sent
// (model-requests.ts): Anthropic's one-hour cache writes, a provider's
// service tiers. Anthropic's long-context premium, which pi's catalog
// doesn't price either, is added here as a tier (`listPricesOf`).

/** Micros in a US dollar. */
export const microsPerDollar = 1_000_000;

/** The token counts that prices are given per. */
const tokensPerPrice = 1_000_000n;

/** Prices per million tokens, of each kind. */
export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Prices that apply to a request whose prompt has more than `inputTokensAbove` tokens. */
export interface Tier extends Rates {
  inputTokensAbove: number;
}

/**
 * A model's list prices as a request is charged at them: micros per
 * million tokens, rounded up to whole micros, its tiers lowest first, and
 * the content hash of all of them, which names the catalog entry they came
 * from.
 */
export interface PinnedPrice extends Rates {
  version: string;
  tiers: Tier[];
}

/** A model's prices as pi's catalog gives them: US dollars per million tokens. */
export interface ListPrices extends Rates {
  tiers?: readonly Tier[];
}

/** Tokens a request used, or may use, by how they are priced. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

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
 * Dollars per million tokens as whole micros, rounded up. The catalog's
 * prices are decimals such as 0.293, which are a hair off in binary: they
 * are rounded to a thousandth of a micro first, so 0.293 is 293000.
 */
const microsOf = (dollars: number): number =>
  Math.ceil(Math.round(dollars * microsPerDollar * 1000) / 1000);

const isPrice = (value: number): boolean =>
  Number.isFinite(value) && value >= 0 && Number.isSafeInteger(microsOf(value));

/** Whether `rates` are all prices, with some for input and output. */
const arePrices = ({ input, output, cacheRead, cacheWrite }: Rates): boolean =>
  [input, output, cacheRead, cacheWrite].every(isPrice) &&
  input > 0 &&
  output > 0;

const ratesOf = ({ input, output, cacheRead, cacheWrite }: Rates): Rates => ({
  input: microsOf(input),
  output: microsOf(output),
  cacheRead: microsOf(cacheRead),
  cacheWrite: microsOf(cacheWrite),
});

/**
 * The prices a model's requests are pinned to, or `undefined` for a model
 * with no safe price: a price that isn't a number, below nothing, or none
 * at all for its input or its output, which a catalog gives a model it
 * doesn't know the price of, in its base prices or any tier. Such a model
 * can't be admitted against a budget: what it costs can't be bounded.
 */
export const pinnedPrice = async (
  prices: ListPrices
): Promise<PinnedPrice | undefined> => {
  const tiers = prices.tiers ?? [];
  if (
    !arePrices(prices) ||
    !tiers.every(
      (tier) =>
        arePrices(tier) &&
        Number.isSafeInteger(tier.inputTokensAbove) &&
        tier.inputTokensAbove >= 0
    )
  ) {
    return undefined;
  }
  const rates = {
    ...ratesOf(prices),
    tiers: tiers
      .map((tier) => ({
        inputTokensAbove: tier.inputTokensAbove,
        ...ratesOf(tier),
      }))
      .toSorted((one, other) => one.inputTokensAbove - other.inputTokensAbove),
  };
  return {
    version: `sha256:${await sha256Hex(canonicalJson(rates))}`,
    ...rates,
  };
};

/**
 * The rates `tokens` are charged at, as pi's `calculateCost` picks them:
 * the tier with the highest threshold its whole prompt (cached or not) is
 * past, or the base prices.
 */
const ratesFor = (price: PinnedPrice, tokens: TokenCounts): Rates => {
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  let rates: Rates = price;
  let matched = -1;
  for (const tier of price.tiers) {
    if (prompt > tier.inputTokensAbove && tier.inputTokensAbove > matched) {
      rates = tier;
      matched = tier.inputTokensAbove;
    }
  }
  return rates;
};

/** `tokens` at `rate` micros a million, rounded up. */
const priced = (tokens: number, rate: number): bigint => {
  if (!(Number.isSafeInteger(tokens) && tokens >= 0)) {
    throw new RangeError("A token count is a whole number, at least 0");
  }
  const product = BigInt(tokens) * BigInt(rate);
  return (product + tokensPerPrice - 1n) / tokensPerPrice;
};

const safeMicros = (micros: bigint): number => {
  const value = Number(micros);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError("A cost too large to count");
  }
  return value;
};

/** What `tokens` cost at `price`, each kind at its own price, in its tier. */
export const costMicros = (price: PinnedPrice, tokens: TokenCounts): number => {
  const rates = ratesFor(price, tokens);
  return safeMicros(
    priced(tokens.input, rates.input) +
      priced(tokens.output, rates.output) +
      priced(tokens.cacheRead, rates.cacheRead) +
      priced(tokens.cacheWrite, rates.cacheWrite)
  );
};

/**
 * What `tokens` cost at `price`, in US dollars, as exactly as a float
 * holds it, before the ledger rounds each kind up to a micro: for the
 * audit event, which records the same cost.
 */
export const costDollars = (
  price: PinnedPrice,
  tokens: TokenCounts
): number => {
  const rates = ratesFor(price, tokens);
  const micros =
    BigInt(tokens.input) * BigInt(rates.input) +
    BigInt(tokens.output) * BigInt(rates.output) +
    BigInt(tokens.cacheRead) * BigInt(rates.cacheRead) +
    BigInt(tokens.cacheWrite) * BigInt(rates.cacheWrite);
  return Number(micros) / (Number(tokensPerPrice) * microsPerDollar);
};

/**
 * The most a request can cost at `price`: its input bound at the dearest
 * price any input token can take, in any tier (written to the provider's
 * cache costs more than plain input), and its output bound at the dearest
 * output price.
 */
export const boundMicros = (
  price: PinnedPrice,
  bound: { inputTokens: number; outputTokens: number }
): number => {
  const all: Rates[] = [price, ...price.tiers];
  const input = Math.max(
    ...all.map(({ input: plain, cacheRead, cacheWrite }) =>
      Math.max(plain, cacheRead, cacheWrite)
    )
  );
  const output = Math.max(...all.map((rates) => rates.output));
  return safeMicros(
    priced(bound.inputTokens, input) + priced(bound.outputTokens, output)
  );
};
