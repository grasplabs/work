/**
 * The test files' durations (test-durations.ts), read from the shards'
 * test-progress logs as scripts/stall-reporter.ts writes them.
 */
import { describe, expect, it } from "vite-plus/test";

import { fileSecondsIn, updatedDurations } from "./test-durations.ts";

const log = (...lines: string[]): string => `${lines.join("\n")}\n`;

describe("reading test files' durations from progress logs", () => {
  it("adds up each file's tests, and counts a test without a time as none", () => {
    const seconds = fileSecondsIn(
      log(
        "2026-10-16T10:00:42.023Z passed 1500ms @grasp-os/core test/a.test.ts > a > does one thing",
        "2026-10-16T10:00:43.023Z passed 500ms @grasp-os/core test/a.test.ts > a > does another > in a nested block",
        "2026-10-16T10:00:44.023Z passed @grasp-os/workerflow test/b.test.ts > b > took no time anyone saw",
        "2026-10-16T10:00:45.023Z failed 2000ms scripts scripts/c.test.ts > c > fails"
      )
    );

    expect(Object.fromEntries(seconds)).toStrictEqual({
      "@grasp-os/core test/a.test.ts": 2,
      "@grasp-os/workerflow test/b.test.ts": 0,
      "scripts scripts/c.test.ts": 2,
    });
  });

  it("skips lines that aren't a finished test", () => {
    expect(fileSecondsIn(log("", "not a test line"))).toStrictEqual(new Map());
  });

  it("takes each file's median over the runs, and keeps the files no run named", () => {
    const run = (ms: number) =>
      log(
        `2026-10-16T10:00:42.023Z passed ${ms}ms console test/x.test.ts > x > runs`
      );

    expect(
      updatedDurations(
        { "console test/x.test.ts": 99, "console test/y.test.ts": 3 },
        [run(1000), run(4000), run(1234)]
      )
    ).toStrictEqual({
      "console test/x.test.ts": 1.2,
      "console test/y.test.ts": 3,
    });
  });
});
