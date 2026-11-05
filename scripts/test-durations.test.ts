/**
 * The test files' durations (test-durations.ts), read from the shards'
 * test-progress logs as scripts/stall-reporter.ts writes them.
 */
import { describe, expect, it } from "vite-plus/test";

import { fileSecondsIn, updatedDurations } from "./test-durations.ts";

const log = (...lines: string[]): string => `${lines.join("\n")}\n`;

describe("reading test files' durations from progress logs", () => {
  it("times each file from its first test's start to its last's end, and counts a test without a time as none", () => {
    const seconds = fileSecondsIn(
      log(
        "2026-10-16T10:00:42.023Z passed 1500ms @grasp-os/core test/a.test.ts > a > does one thing",
        "2026-10-16T10:00:43.023Z passed 500ms @grasp-os/core test/a.test.ts > a > does another > in a nested block",
        "2026-10-16T10:00:44.023Z passed @grasp-os/workerflow test/b.test.ts > b > took no time anyone saw",
        "2026-10-16T10:00:45.023Z failed 2000ms scripts scripts/c.test.ts > c > fails"
      )
    );

    expect(Object.fromEntries(seconds)).toStrictEqual({
      // From 10:00:40.523, when the first began, to 10:00:43.023.
      "@grasp-os/core test/a.test.ts": 2.5,
      "@grasp-os/workerflow test/b.test.ts": 0,
      "scripts scripts/c.test.ts": 2,
    });
  });

  it("counts the time between a file's tests, its hooks, as the file's", () => {
    const seconds = fileSecondsIn(
      log(
        "2026-10-16T10:00:10.000Z passed 1000ms @grasp-os/core test/slow.test.ts > s > one",
        "2026-10-16T10:00:20.000Z passed 1000ms @grasp-os/core test/slow.test.ts > s > two"
      )
    );

    expect(Object.fromEntries(seconds)).toStrictEqual({
      "@grasp-os/core test/slow.test.ts": 11,
    });
  });

  it("takes a file's own time, its hooks before and after its tests included, when that is longer", () => {
    const seconds = fileSecondsIn(
      log(
        "2026-10-16T10:01:00.000Z passed 2000ms @grasp-os/compiler build-heap.test.ts > b > builds",
        "2026-10-16T10:01:30.000Z file 62500ms @grasp-os/compiler build-heap.test.ts",
        "2026-10-16T10:01:31.000Z passed 4000ms @grasp-os/core test/quick.test.ts > q > one",
        "2026-10-16T10:01:32.000Z file 3000ms @grasp-os/core test/quick.test.ts"
      )
    );

    expect(Object.fromEntries(seconds)).toStrictEqual({
      "@grasp-os/compiler build-heap.test.ts": 62.5,
      "@grasp-os/core test/quick.test.ts": 4,
    });
  });

  it("skips lines that aren't a finished test", () => {
    expect(fileSecondsIn(log("", "not a test line"))).toStrictEqual(new Map());
  });

  it("takes each file's median over the runs, and keeps the files no run named", () => {
    const run = (ms: number) =>
      log(
        `2026-10-16T10:00:42.023Z passed ${ms}ms admin test/x.test.ts > x > runs`
      );

    expect(
      updatedDurations(
        { "admin test/x.test.ts": 99, "admin test/y.test.ts": 3 },
        [run(1000), run(4000), run(1234)]
      )
    ).toStrictEqual({
      "admin test/x.test.ts": 1.2,
      "admin test/y.test.ts": 3,
    });
  });
});
