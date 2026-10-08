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
});
