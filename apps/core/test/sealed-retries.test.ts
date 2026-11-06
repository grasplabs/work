import type { SealedTask } from "@grasp-os/workflow-schema/sealed";
import { describe, expect, it } from "vite-plus/test";

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
  kind: "try",
  catch: catcher,
});

const caught = {
  type: "https://grasp.work/schemas/grasp-workflow/1/errors/runtime",
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
  it("backs off as its policy grows, each round", () => {
    const delays = (backoff: "constant" | "linear" | "exponential") =>
      [1, 2, 3].map(
        (round) =>
          retryDecided([tryOf("t", retrying(backoff))], caught, round, by("t"))
            .delayMs
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

  it("retries no more once its rounds or a year are spent", () => {
    const decide = (catcher: Try["catch"], round: number) =>
      retryDecided([tryOf("t", catcher)], caught, round, by("t")).retry;
    expect({
      lastRound: decide(retrying("constant", { attempts: 3 }), 3),
      pastAYear: decide(
        retrying("exponential", { delayMs: 200 * 86_400_000 }),
        2
      ),
      within: decide(retrying("constant", { attempts: 3 }), 2),
    }).toStrictEqual({
      lastRound: false,
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
      retryDecided(around, caught, 1, choice).retry;
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
      },
    });
  });
});
