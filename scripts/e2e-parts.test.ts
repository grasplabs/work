/**
 * The split between CI's e2e parts (e2e-parts.ts) and the times it reads
 * (e2e-durations.ts): every parallel test runs in exactly one part, the
 * same way on every runner, the long tests spread out, and a file's tests
 * in one part share a worker, as Playwright runs them.
 */
import { describe, expect, it } from "vite-plus/test";

import { testSecondsIn, updatedDurations } from "./e2e-durations.ts";
import { partOf, testsIn } from "./e2e-parts.ts";

const test = (file: string, title: string) => ({
  key: `[chromium] › ${file} › ${title}`,
  file,
});

const tests = [
  test("catalog.e2e.ts", "alert"),
  test("catalog.e2e.ts", "badge"),
  test("catalog.e2e.ts", "button"),
  test("notes-app.e2e.ts", "creates"),
  test("notes-app.e2e.ts", "attaches"),
  test("chat.e2e.ts", "asks"),
  test("web.e2e.ts", "signs in"),
  test("new.e2e.ts", "untimed"),
];
const durations: Record<string, number> = {
  "[chromium] › catalog.e2e.ts › alert": 10,
  "[chromium] › catalog.e2e.ts › badge": 10,
  "[chromium] › catalog.e2e.ts › button": 10,
  "[chromium] › notes-app.e2e.ts › creates": 80,
  "[chromium] › notes-app.e2e.ts › attaches": 40,
  "[chromium] › chat.e2e.ts › asks": 30,
  "[chromium] › web.e2e.ts › signs in": 20,
};

const partsOf = (count: number): string[][] =>
  Array.from({ length: count }, (_, index) =>
    partOf(tests, durations, index + 1, count)
  );

describe("splitting the e2e tests between CI's parts", () => {
  it("runs every test in exactly one part, the untimed one too", () => {
    expect(partsOf(3).flat().toSorted()).toStrictEqual(
      tests.map(({ key }) => key).toSorted()
    );
  });

  it("splits the same tests the same way, whatever order they come in", () => {
    expect(
      Array.from({ length: 3 }, (_, index) =>
        partOf(tests.toReversed(), durations, index + 1, 3)
      )
    ).toStrictEqual(partsOf(3));
  });

  it("splits a long file's tests between parts, and fills the rest by time", () => {
    const parts = partsOf(2);
    const partOfTest = (title: string): number =>
      parts.findIndex((keys) =>
        keys.includes(`[chromium] › notes-app.e2e.ts › ${title}`)
      );
    const seconds = parts.map((keys) =>
      keys.reduce((sum, key) => sum + (durations[key] ?? 20), 0)
    );

    expect(partOfTest("creates")).not.toBe(partOfTest("attaches"));
    expect(seconds).toStrictEqual([130, 90]);
  });
});

/** A Playwright JSON report of `specs`: file, title, then each attempt's ms and status. */
const report = (
  specs: readonly [string, string, readonly [number, string][]][]
): string =>
  JSON.stringify({
    suites: specs.map(([file, title, results]) => ({
      title: file,
      file,
      suites: [
        {
          title: "a describe block",
          file,
          specs: [
            {
              title,
              file,
              tests: [
                {
                  projectName: "chromium",
                  results: results.map(([duration, status]) => ({
                    duration,
                    status,
                  })),
                },
              ],
            },
          ],
        },
      ],
    })),
  });

describe("reading Playwright's tests", () => {
  it("names each test as a test list does: project, file, describe blocks and title", () => {
    expect(
      testsIn(report([["chat.e2e.ts", "asks", []]])).map(({ key, file }) => ({
        key,
        file,
      }))
    ).toStrictEqual([
      {
        key: "[chromium] › chat.e2e.ts › a describe block › asks",
        file: "chat.e2e.ts",
      },
    ]);
  });
});

describe("recording the e2e tests' times", () => {
  it("counts a test's passing attempt, or its last when none passed", () => {
    expect(
      testSecondsIn(
        report([
          [
            "chat.e2e.ts",
            "asks",
            [
              [30_000, "failed"],
              [10_000, "passed"],
            ],
          ],
          [
            "web.e2e.ts",
            "signs in",
            [
              [5000, "failed"],
              [7000, "failed"],
            ],
          ],
        ])
      )
    ).toStrictEqual(
      new Map([
        ["[chromium] › chat.e2e.ts › a describe block › asks", 10],
        ["[chromium] › web.e2e.ts › a describe block › signs in", 7],
      ])
    );
  });

  it("takes the median of runs, and keeps tests no run named", () => {
    const asks = "[chromium] › chat.e2e.ts › a describe block › asks";
    const run = (seconds: number): string[] => [
      report([["chat.e2e.ts", "asks", [[seconds * 1000, "passed"]]]]),
    ];

    expect(
      updatedDurations({ "[chromium] › old.e2e.ts › gone": 9, [asks]: 99 }, [
        run(10),
        run(20),
        run(40),
      ])
    ).toStrictEqual({ "[chromium] › old.e2e.ts › gone": 9, [asks]: 20 });
  });
});
