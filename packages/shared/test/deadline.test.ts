import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { withinTime } from "../src/deadline.ts";

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
