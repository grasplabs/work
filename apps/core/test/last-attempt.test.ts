import { describe, expect, it } from "vite-plus/test";

import { isLastAttempt } from "../src/workflows/host.ts";

// Whether a step's attempt has no retry after it, should it fail
// (host.ts, `isLastAttempt`): what decides whether it waits out a
// provider's rate limit before failing. Counted by the step's failed
// attempts, as the engine counts its retries: an attempt cut off (its
// activation died) spends none (workerflow's contracts.ts), so it never
// makes a later attempt the last too soon.

/** An attempt as the engine tells it, of a step with `limit` retries. */
const told = (attempt: number, failedAttempts: number, limit: number) => ({
  attempt,
  failedAttempts,
  idempotencyKey: "key:step",
  config: { retries: { limit } },
});

describe("a step's last attempt", () => {
  it("is the one its step's failures before it used every retry for, an attempt cut off not counted", () => {
    expect({
      first: isLastAttempt(told(1, 0, 2), 2),
      afterTwoCutOffs: isLastAttempt(told(3, 0, 2), 2),
      afterCutOffAndFailure: isLastAttempt(told(3, 1, 2), 2),
      afterTwoFailures: isLastAttempt(told(3, 2, 2), 2),
      afterCutOffAndTwoFailures: isLastAttempt(told(4, 2, 2), 2),
    }).toStrictEqual({
      first: false,
      afterTwoCutOffs: false,
      afterCutOffAndFailure: false,
      afterTwoFailures: true,
      afterCutOffAndTwoFailures: true,
    });
  });

  it("is the first of a step with no retries, by its host's limit where the engine gives none", () => {
    const unsaid = {
      attempt: 1,
      failedAttempts: 0,
      idempotencyKey: "key:step",
    };
    expect({
      noRetries: isLastAttempt(told(1, 0, 0), 0),
      hostsNone: isLastAttempt(unsaid, 0),
      hostsTwo: isLastAttempt(unsaid, 2),
    }).toStrictEqual({ noRetries: true, hostsNone: true, hostsTwo: false });
  });
});
