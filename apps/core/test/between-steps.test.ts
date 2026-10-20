import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { betweenSteps } from "../src/workflows/between-steps.ts";

// The clock of a run's time between steps (between-steps.ts), as pure
// logic: the clock and its timer are faked, so a step call can land after
// the budget is spent but before the budget's timer has fired, as on an
// isolate busy enough to run a timer late. Runs over the real engine are
// in workflow-time-between-steps.test.ts.

const budgetMs = 1000;

/** Whether `promise` has settled once pending work has run, and how. */
const settledOf = async (promise: Promise<unknown>): Promise<string> => {
  const settled = (async () => {
    try {
      await promise;
      return "fulfilled";
    } catch {
      return "rejected";
    }
  })();
  const pending = (async () => {
    await Promise.resolve();
    await Promise.resolve();
    return "pending";
  })();
  return await Promise.race([settled, pending]);
};

/** What `clock.spent` rejected with once pending work has run: its code. */
const spentCode = async (spent: Promise<never>): Promise<unknown> => {
  const rejected = (async () => {
    try {
      return await spent;
    } catch (error) {
      return error instanceof Error && "code" in error ? error.code : "other";
    }
  })();
  const notYet = (async () => {
    await Promise.resolve();
    await Promise.resolve();
    return "not spent";
  })();
  return await Promise.race([rejected, notYet]);
};

describe("a run's clock of its time between steps", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses a step call once the budget is spent, though the budget's timer hasn't fired yet", async () => {
    const clock = betweenSteps(budgetMs);
    clock.started();
    // The time passes, but the timer that would end the budget doesn't run.
    vi.setSystemTime(Date.now() + budgetMs);
    let stepRan = false;

    const call = clock.around(async () => {
      stepRan = true;
      return await Promise.resolve("ran");
    });

    expect({
      call: await settledOf(call),
      stepRan,
      over: clock.over.aborted,
      spent: await spentCode(clock.spent),
    }).toStrictEqual({
      call: "pending",
      stepRan: false,
      over: true,
      spent: "workflow.between_steps_limit",
    });
  });

  it("lets a step call in while the gap before it is within the budget", async () => {
    const clock = betweenSteps(budgetMs);
    clock.started();
    vi.setSystemTime(Date.now() + budgetMs - 1);

    expect({
      call: await clock.around(async () => await Promise.resolve("ran")),
      over: clock.over.aborted,
    }).toStrictEqual({ call: "ran", over: false });
  });
});
