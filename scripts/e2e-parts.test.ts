/**
 * The split between CI's e2e parts (e2e-parts.ts) and the times it reads
 * (e2e-durations.ts): every parallel file runs in exactly one part, the
 * same way on every runner, and the long files spread out.
 */
import { describe, expect, it } from "vite-plus/test";

import { fileSecondsIn, updatedDurations } from "./e2e-durations.ts";
import { filterOf, parallelFiles, partOf } from "./e2e-parts.ts";

const files = [
  "e2e/catalog.e2e.ts",
  "e2e/notes-app.e2e.ts",
  "e2e/chat.e2e.ts",
  "e2e/web.e2e.ts",
  "e2e/apps.e2e.ts",
  "e2e/new.e2e.ts",
];
const durations = {
  "e2e/catalog.e2e.ts": 200,
  "e2e/notes-app.e2e.ts": 140,
  "e2e/chat.e2e.ts": 60,
  "e2e/web.e2e.ts": 70,
  "e2e/apps.e2e.ts": 90,
};

const partsOf = (count: number): string[][] =>
  Array.from({ length: count }, (_, index) =>
    partOf(files, durations, index + 1, count)
  );

describe("splitting the e2e files between CI's parts", () => {
  it("runs every file in exactly one part, the untimed one too", () => {
    expect(partsOf(3).flat().toSorted()).toStrictEqual(files.toSorted());
  });

  it("splits the same files the same way, whatever order they come in", () => {
    expect(
      Array.from({ length: 3 }, (_, index) =>
        partOf(files.toReversed(), durations, index + 1, 3)
      )
    ).toStrictEqual(partsOf(3));
  });

  it("gives the longest files parts of their own, and fills the rest by time", () => {
    expect(partsOf(3)).toStrictEqual([
      ["e2e/catalog.e2e.ts"],
      ["e2e/notes-app.e2e.ts", "e2e/web.e2e.ts"],
      ["e2e/apps.e2e.ts", "e2e/chat.e2e.ts", "e2e/new.e2e.ts"],
    ]);
  });

  it("leaves the serial projects' files to parts of their own", () => {
    expect(
      parallelFiles([
        "chat.e2e.ts",
        "onboarding.e2e.ts",
        "interview.e2e.ts",
        "spoken-interview.e2e.ts",
        "admin-journey.e2e.ts",
        "people.ts",
      ])
    ).toStrictEqual(["e2e/chat.e2e.ts"]);
  });

  it("filters for a file's path only, never another's that ends alike", () => {
    const filter = new RegExp(filterOf("e2e/chat.e2e.ts"), "u");

    expect(filter.test("/repo/e2e/chat.e2e.ts")).toBeTruthy();
    expect(filter.test("/repo/e2e/admin-chat.e2e.ts")).toBeFalsy();
    expect(filter.test("/repo/e2e/chatXe2eXts")).toBeFalsy();
  });
});

/** A Playwright JSON report of `tests`: file, then each attempt's ms and status. */
const report = (
  tests: readonly [string, readonly [number, string][]][]
): string =>
  JSON.stringify({
    suites: tests.map(([file, results]) => ({
      file,
      specs: [
        {
          file,
          tests: [
            {
              results: results.map(([duration, status]) => ({
                duration,
                status,
              })),
            },
          ],
        },
      ],
    })),
  });

describe("recording the e2e files' times", () => {
  it("counts a test's passing attempt, or its last when none passed", () => {
    expect(
      fileSecondsIn(
        report([
          [
            "chat.e2e.ts",
            [
              [30_000, "failed"],
              [10_000, "passed"],
            ],
          ],
          [
            "web.e2e.ts",
            [
              [5000, "failed"],
              [7000, "failed"],
            ],
          ],
        ])
      )
    ).toStrictEqual(
      new Map([
        ["e2e/chat.e2e.ts", 10],
        ["e2e/web.e2e.ts", 7],
      ])
    );
  });

  it("adds a run's parts up, takes the median of runs, and keeps files no run named", () => {
    const run = (seconds: number): string[] => [
      report([["chat.e2e.ts", [[seconds * 1000, "passed"]]]]),
      report([["chat.e2e.ts", [[1000, "passed"]]]]),
    ];

    expect(
      updatedDurations({ "e2e/old.e2e.ts": 9, "e2e/chat.e2e.ts": 99 }, [
        run(10),
        run(20),
        run(40),
      ])
    ).toStrictEqual({ "e2e/chat.e2e.ts": 21, "e2e/old.e2e.ts": 9 });
  });
});
