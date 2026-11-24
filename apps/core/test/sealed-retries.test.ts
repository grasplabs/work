import type { SealedTask } from "@grasp-os/workflow-schema/sealed";
import { describe, expect, it } from "vite-plus/test";

import { retryDecided, retryingTry } from "../src/workflows/sealed-run.ts";

// What a sealed run's retry decides (sealed-run.ts, `retryingTry` and
// `retryDecided`): pure logic, so tested alone. The host picks the one try
// around the failed call whose catch retries; the isolate only says
// whether that retry's `when` holds; the host holds it to the policy's
// limits.

type Try = Extract<SealedTask, { kind: "try" }>;

/** A try task `id`, its catch `catcher`, around the failing task. */
const tryOf = (id: string, catcher: Try["catch"]): Try => ({
  id,
  pointer: `/steps/0/${id}`,
  steps: [],
  scope: [],
  kind: "try",
  catch: catcher,
});

const caught = {
  code: "connect.server_unavailable",
  message: "The connection's server is unavailable.",
  step: "fetch",
};

/** A policy of `attempts` rounds, a second apart as `backoff` grows it. */
const retrying = (
  backoff: "constant" | "linear" | "exponential",
  more: Partial<NonNullable<Try["catch"]["retry"]>> = {}
): Try["catch"] => ({
  variable: "error",
  retry: { attempts: 5, delayMs: 1000, backoff, ...more },
});

/** Whether `decide` is refused as tampering. */
const refused = (decide: () => unknown): boolean => {
  try {
    decide();
    return false;
  } catch (error) {
    return (
      error instanceof Error &&
      Reflect.get(error, "code") === "workflow.invalid"
    );
  }
};

describe("a sealed run's retry decision", () => {
  it("backs off as its policy grows, each round", () => {
    const delays = (backoff: "constant" | "linear" | "exponential") =>
      [1, 2, 3].map(
        (round) =>
          retryDecided(tryOf("t", retrying(backoff)), round, true).delayMs
      );
    expect({
      constant: delays("constant"),
      linear: delays("linear"),
      exponential: delays("exponential"),
    }).toStrictEqual({
      constant: [1000, 1000, 1000],
      linear: [1000, 2000, 3000],
      exponential: [1000, 2000, 4000],
    });
  });

  it("retries no more once its rounds or a year are spent, or its `when` doesn't hold", () => {
    const decide = (catcher: Try["catch"], round: number, choice?: unknown) =>
      retryDecided(tryOf("t", catcher), round, choice).retry;
    expect({
      lastRound: decide(retrying("constant", { attempts: 3 }), 3, true),
      pastAYear: decide(
        retrying("exponential", { delayMs: 200 * 86_400_000 }),
        2,
        true
      ),
      within: decide(retrying("constant", { attempts: 3 }), 2, true),
      whenFails: decide(retrying("constant"), 1, false),
      // Its code failed to choose: its `when` failed as it ran.
      failedInside: decide(retrying("constant"), 1),
      refused: refused(() =>
        decide(retrying("constant"), 1, { by: "t", retry: true })
      ),
    }).toStrictEqual({
      lastRound: false,
      pastAYear: false,
      within: true,
      whenFails: false,
      failedInside: false,
      refused: true,
    });
  });

  it("retries only by the try around the call whose catch retries, its code filter the error's, and no catch further in taking it first", () => {
    const outer = tryOf("outer", retrying("constant"));
    const pick = (tries: readonly Try[]) => retryingTry(tries, caught)?.id;
    expect({
      alone: pick([outer]),
      // A catch further in with a `when` may not take it: the retry runs.
      conditionalInside: pick([
        tryOf("inner", { variable: "error", when: 0 }),
        outer,
      ]),
      // One further in with no conditions takes it whatever the code says.
      takenInside: pick([tryOf("inner", { variable: "error" }), outer]),
      // One further in for another code doesn't.
      otherCodeInside: pick([
        tryOf("inner", { variable: "error", code: "data.conflict" }),
        outer,
      ]),
      ofItsCode: pick([
        tryOf("outer", {
          ...retrying("constant"),
          code: "connect.server_unavailable",
        }),
      ]),
      ofAnotherCode: pick([
        tryOf("outer", { ...retrying("constant"), code: "data.conflict" }),
      ]),
      none: pick([tryOf("inner", { variable: "error", when: 0 })]),
    }).toStrictEqual({
      alone: "outer",
      conditionalInside: "outer",
      takenInside: undefined,
      otherCodeInside: "outer",
      ofItsCode: "outer",
      ofAnotherCode: undefined,
      none: undefined,
    });
  });
});
