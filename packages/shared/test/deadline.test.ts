import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { idleDeadline, withinTime } from "../src/deadline.ts";

/** What a race ends with: its value, or what it was rejected with. */
const outcomeOf = async <T>(race: Promise<T>) => {
  try {
    return { value: await race };
  } catch (error) {
    return {
      error: error instanceof Error ? [error.name, error.message] : error,
    };
  }
};

describe("racing work against a deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers with the work when it ends in time", async () => {
    const race = outcomeOf(
      withinTime(async () => await Promise.resolve(7), 1000)
    );

    await expect(race).resolves.toStrictEqual({ value: 7 });
  });

  it("rejects with a TimeoutError once the time is up, whatever the work does after", async () => {
    const work = Promise.withResolvers<number>();
    const race = outcomeOf(withinTime(async () => await work.promise, 1000));

    await vi.advanceTimersByTimeAsync(1000);
    work.reject(new Error("too late"));

    await expect(race).resolves.toStrictEqual({
      error: ["TimeoutError", "The work took too long"],
    });
  });

  it("rejects with the caller's reason when the caller aborts first", async () => {
    const caller = new AbortController();
    const work = Promise.withResolvers<number>();
    const race = outcomeOf(
      withinTime(async () => await work.promise, 1000, caller.signal)
    );

    caller.abort(new Error("erased"));

    await expect(race).resolves.toStrictEqual({
      error: ["Error", "erased"],
    });
  });
});

describe("a deadline that waits for silence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends work that goes quiet for its idle time, as time running out", async () => {
    const limit = idleDeadline(1000, 60_000);

    await vi.advanceTimersByTimeAsync(999);
    const before = limit.stopped();
    await vi.advanceTimersByTimeAsync(1);

    expect({ before, after: limit.stopped() }).toStrictEqual({
      before: undefined,
      after: "timeout",
    });
    expect(limit.signal.aborted).toBeTruthy();
    limit.clear();
  });

  it("lets work that keeps making progress run long past its idle time", async () => {
    const limit = idleDeadline(1000, 60_000);

    for (let tick = 0; tick < 10; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one moment after another
      await vi.advanceTimersByTimeAsync(900);
      limit.touch();
    }

    expect(limit.stopped()).toBeUndefined();
    limit.clear();
  });

  it("ends work at its ceiling however much progress it makes", async () => {
    const limit = idleDeadline(1000, 5000);

    for (let tick = 0; tick < 10; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one moment after another
      await vi.advanceTimersByTimeAsync(500);
      limit.touch();
    }

    expect(limit.stopped()).toBe("timeout");
    limit.clear();
  });

  it("says a caller's cancel is a cancel, and leaves no timer once cleared", () => {
    const caller = new AbortController();
    const limit = idleDeadline(1000, 5000, caller.signal);

    caller.abort();
    const stopped = limit.stopped();
    limit.clear();

    expect({ stopped, timers: vi.getTimerCount() }).toStrictEqual({
      stopped: "cancelled",
      timers: 0,
    });
  });
});
