import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";

// What model requests cost, in whole millionths of a US dollar (micros):
// the prices a request is pinned to when it is admitted, the most it can
// cost, which the model ledger reserves (model-ledger.ts), and what its
// usage cost, which the ledger charges. Integers only, rounded up, so no
// sum of many small requests rounds away to nothing, and a reservation is
// never below what its request can cost at those prices.

/** Micros in a US dollar. */
export const microsPerDollar = 1_000_000;

/** The token counts that prices are given per. */
const tokensPerPrice = 1_000_000n;

/**
 * A model's list prices as a request is charged at them: micros per
 * million tokens, rounded up to whole micros, and the content hash of
 * those prices, which names the catalog entry they came from.
 */
export interface PinnedPrice {
  version: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** A model's prices as pi's catalog gives them: US dollars per million tokens. */
export interface ListPrices {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Tokens a request used, or may use, by how they are priced. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Dollars per million tokens as whole micros, rounded up. The catalog's
 * prices are decimals such as 0.293, which are a hair off in binary: they
 * are rounded to a thousandth of a micro first, so 0.293 is 293000.
 */
const microsOf = (dollars: number): number =>
  Math.ceil(Math.round(dollars * microsPerDollar * 1000) / 1000);

const isPrice = (value: number): boolean =>
  Number.isFinite(value) && value >= 0 && Number.isSafeInteger(microsOf(value));

/**
 * The prices a model's requests are pinned to, or `undefined` for a model
 * with no safe price: a price that isn't a number, below nothing, or none
 * at all for its input or its output, which a catalog gives a model it
 * doesn't know the price of. Such a model can't be admitted against a
 * budget: what it costs can't be bounded.
 */
export const pinnedPrice = async (
  prices: ListPrices
): Promise<PinnedPrice | undefined> => {
  const { input, output, cacheRead, cacheWrite } = prices;
  if (
    ![input, output, cacheRead, cacheWrite].every(isPrice) ||
    !(input > 0 && output > 0)
  ) {
    return undefined;
  }
  const rates = {
    input: microsOf(input),
    output: microsOf(output),
    cacheRead: microsOf(cacheRead),
    cacheWrite: microsOf(cacheWrite),
  };
  return {
    version: `sha256:${await sha256Hex(canonicalJson(rates))}`,
    ...rates,
  };
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

/** What `tokens` cost at `price`, each kind at its own price. */
export const costMicros = (price: PinnedPrice, tokens: TokenCounts): number =>
  safeMicros(
    priced(tokens.input, price.input) +
      priced(tokens.output, price.output) +
      priced(tokens.cacheRead, price.cacheRead) +
      priced(tokens.cacheWrite, price.cacheWrite)
  );

/**
 * The most a request can cost at `price`: its input bound at the dearest
 * price any input token can take (written to the provider's cache costs
 * more than plain input), and its output bound at the output price.
 */
export const boundMicros = (
  price: PinnedPrice,
  bound: { inputTokens: number; outputTokens: number }
): number =>
  safeMicros(
    priced(
      bound.inputTokens,
      Math.max(price.input, price.cacheRead, price.cacheWrite)
    ) + priced(bound.outputTokens, price.output)
  );
