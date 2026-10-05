// A token bucket: `burst` tokens at most, refilled at `perMinute`, one
// taken per request. Pure, so the same arithmetic bounds a screen's
// traffic on the page (per frame) and in core (per person and App), where
// it counts: a browser someone changed skips the page's.

/** How fast a bucket fills, and how much it holds. */
export interface BucketRate {
  burst: number;
  perMinute: number;
}

/** A bucket as it was at `at` (milliseconds). */
export interface TokenBucket {
  tokens: number;
  at: number;
}

const minuteMs = 60_000;

/** `bucket` at `now`, filled for the time since it was last read. */
const filled = (
  bucket: TokenBucket | undefined,
  rate: BucketRate,
  now: number
): number =>
  bucket === undefined
    ? rate.burst
    : Math.min(
        rate.burst,
        // A clock that went back fills nothing.
        bucket.tokens +
          (Math.max(0, now - bucket.at) * rate.perMinute) / minuteMs
      );

/**
 * Takes a token from `bucket` (a full one when undefined) at `now`:
 * whether there was one, and the bucket after.
 */
export const takeToken = (
  bucket: TokenBucket | undefined,
  rate: BucketRate,
  now: number
): { taken: boolean; bucket: TokenBucket } => {
  const tokens = filled(bucket, rate, now);
  const taken = tokens >= 1;
  return { taken, bucket: { tokens: taken ? tokens - 1 : tokens, at: now } };
};

/**
 * Past this many keys, the buckets that are full again are forgotten: at
 * most once a minute, as that reads every bucket.
 */
const pruneAbove = 1000;

/** One bucket per key, kept in memory: a restart starts them full. */
export class TokenBuckets {
  readonly #rate: BucketRate;
  readonly #buckets = new Map<string, TokenBucket>();
  #prunedAt = Number.NEGATIVE_INFINITY;

  constructor(rate: BucketRate) {
    this.#rate = rate;
  }

  /** Takes a token of `key`'s bucket, if it has one. */
  take(key: string, now: number = Date.now()): boolean {
    const { taken, bucket } = takeToken(
      this.#buckets.get(key),
      this.#rate,
      now
    );
    this.#buckets.set(key, bucket);
    if (this.#buckets.size > pruneAbove && now - this.#prunedAt >= minuteMs) {
      this.#prunedAt = now;
      this.#prune(now);
    }
    return taken;
  }

  /** Whether `key`'s bucket has a token, without taking it. */
  has(key: string, now: number = Date.now()): boolean {
    return filled(this.#buckets.get(key), this.#rate, now) >= 1;
  }

  /** A full bucket is the same as none: only the others are kept. */
  #prune(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (filled(bucket, this.#rate, now) >= this.#rate.burst) {
        this.#buckets.delete(key);
      }
    }
  }
}
