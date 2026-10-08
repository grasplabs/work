// How a step's retry delays grow: pure arithmetic.
import { describe, expect, it } from "vite-plus/test";

import { retryDelayMs } from "../src/config.ts";
import { maxWaitMs } from "../src/durations.ts";

const day = 24 * 60 * 60 * 1000;

describe("a retry delay", () => {
  it.each([
    ["constant", 3, 1000],
    ["linear", 3, 3000],
    ["exponential", 1, 1000],
    ["exponential", 3, 4000],
  ] as const)(
    "grows as its %s backoff says, at attempt %i",
    (backoff, attempt, ms) => {
      expect(retryDelayMs(backoff, 1000, attempt)).toBe(ms);
    }
  );

  it.each([
    ["exponential", 2],
    ["linear", 2],
    ["exponential", 2000],
  ] as const)(
    "waits no longer than a sleep can, %s at attempt %i",
    (backoff, attempt) => {
      expect(retryDelayMs(backoff, 300 * day, attempt)).toBe(maxWaitMs);
    }
  );

  it.each([
    ["a delay of 0, exponential, at attempt 1025", "exponential", 0, 1025, 0],
    [
      "a delay of 0, linear, at the largest attempt",
      "linear",
      0,
      Number.MAX_SAFE_INTEGER,
      0,
    ],
    [
      "1 ms, exponential, where 2 ** n is Infinity",
      "exponential",
      1,
      1025,
      maxWaitMs,
    ],
    [
      "the longest delay, exponential, far past Infinity",
      "exponential",
      maxWaitMs,
      1_000_000,
      maxWaitMs,
    ],
    [
      "1 ms, linear, at the largest attempt",
      "linear",
      1,
      Number.MAX_SAFE_INTEGER,
      maxWaitMs,
    ],
    [
      "1 ms, linear, just under the cap",
      "linear",
      1,
      maxWaitMs - 1,
      maxWaitMs - 1,
    ],
  ] as const)("is a finite time for %s", (_, backoff, base, attempt, ms) => {
    const delay = retryDelayMs(backoff, base, attempt);

    expect(delay).toBe(ms);
  });
});
