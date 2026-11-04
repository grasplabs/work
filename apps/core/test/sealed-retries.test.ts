import { describe, expect, it } from "vite-plus/test";

import type { SealedTask } from "../src/workflow-builds.ts";
import { retryDecided } from "../src/workflows/sealed-run.ts";

// What a sealed run's retry decides of the isolate's choice (sealed-run.ts,
// `retryDecided`): pure logic, so tested alone. The isolate only says which
// catch takes the failure and whether its retry's `when` holds; the host
// holds that to the catches around the task and to the policy's limits.

type Try = Extract<SealedTask, { kind: "try" }>;

/** A try task `id`, its catch `catcher`, around the failing task. */
const tryOf = (id: string, catcher: Try["catch"]): Try => ({
  id,
  pointer: `/do/0/${id}`,
  steps: ["catch"],
  scope: [],
  branches: [],
  schemas: {},
  kind: "try",
  catch: catcher,
});

const caught = {
  type: "https://open-workflow-specification.org/spec/1.0.0/errors/runtime",
  status: 500,
  instance: "/do/0/outer/try/0/inner/try/0/fetch",
  title: "Something went wrong.",
};

/** A policy of `attempts` rounds, a second apart as `backoff` grows it. */
const retrying = (
  backoff: "constant" | "linear" | "exponential",
  more: Partial<NonNullable<Try["catch"]["retry"]>> = {}
): Try["catch"] => ({
  variable: "error",
  retry: { attempts: 5, delayMs: 1000, backoff, ...more },
});

const now = (): number => Date.now();

/** The choice of `by`'s catch, retrying or not. */
const by = (id: string, retry = true) => ({ by: id, retry });

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

/** `catcher` with conditions of its own, and its retry's, if any. */
const conditional = (catcher: Try["catch"]): Try["catch"] => ({
  ...catcher,
  when: 0,
  ...(catcher.retry === undefined
    ? {}
    : { retry: { ...catcher.retry, when: 1 } }),
});

describe("a sealed run's retry decision", () => {
  it("backs off as its policy grows, each round, jitter within its range", () => {
    const delays = (backoff: "constant" | "linear" | "exponential") =>
      [1, 2, 3].map(
        (round) =>
          retryDecided(
            [tryOf("t", retrying(backoff, { jitter: { fromMs: 5, toMs: 5 } }))],
            caught,
            round,
            by("t"),
            now()
          ).delayMs
      );
    expect({
      constant: delays("constant"),
      linear: delays("linear"),
      exponential: delays("exponential"),
    }).toStrictEqual({
      constant: [1005, 1005, 1005],
      linear: [1005, 2005, 3005],
      exponential: [1005, 2005, 4005],
    });
  });

  it("retries no more once its rounds, its duration or a year are spent", () => {
    const decide = (catcher: Try["catch"], round: number, since = now()) =>
      retryDecided([tryOf("t", catcher)], caught, round, by("t"), since).retry;
    expect({
      lastRound: decide(retrying("constant", { attempts: 3 }), 3),
      pastDuration: decide(
        retrying("constant", { limitMs: 60_000 }),
        1,
        now() - 60_000
      ),
      pastAYear: decide(
        retrying("exponential", { delayMs: 200 * 86_400_000 }),
        2
      ),
      within: decide(retrying("constant", { limitMs: 60_000 }), 1),
    }).toStrictEqual({
      lastRound: false,
      pastDuration: false,
      pastAYear: false,
      within: true,
    });
  });

  it("takes the isolate's choice only of a catch around the task whose filter the error has, and none past the innermost with no conditions", () => {
    // Its catch's `when` and its retry's are the isolate's to decide.
    const inner = tryOf("inner", conditional(retrying("constant")));
    const middle = tryOf("middle", {
      variable: "error",
      errors: { status: 409 },
    });
    const outer = tryOf("outer", retrying("constant"));
    const tries = [inner, middle, outer];
    const decide = (choice?: unknown, around: readonly Try[] = tries) =>
      retryDecided(around, caught, 1, choice, now()).retry;
    expect({
      innerOrOuter: [decide(by("inner")), decide(by("outer"))],
      notRetrying: decide(by("inner", false)),
      none: decide(null, [inner]),
      // Its code failed to choose: an inner catch's `when` may have failed.
      failedInside: decide(),
      refused: {
        // Its filter doesn't take the error; nor a task around it.
        middle: refused(() => decide(by("middle"))),
        elsewhere: refused(() => decide(by("elsewhere"))),
        // The outer catch, with no conditions, takes it, and its policy,
        // with none, retries it.
        none: refused(() => decide(null)),
        outerNotRetrying: refused(() => decide(by("outer", false))),
        // Nor a catch past one with none.
        pastIt: refused(() =>
          decide(by("outer"), [tryOf("inner", retrying("constant")), outer])
        ),
        unshaped: refused(() => decide({ by: "inner" })),
        // Nothing for its code to decide, and it failed.
        failedOutside: refused(() => decide(undefined, [outer])),
      },
    }).toStrictEqual({
      innerOrOuter: [true, true],
      notRetrying: false,
      none: false,
      failedInside: false,
      refused: {
        middle: true,
        elsewhere: true,
        none: true,
        outerNotRetrying: true,
        pastIt: true,
        unshaped: true,
        failedOutside: true,
      },
    });
  });
});
