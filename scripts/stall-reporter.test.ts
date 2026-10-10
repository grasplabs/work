import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { describe, expect, it } from "vite-plus/test";

import StallReporter, { reportDelayMs } from "./stall-reporter.ts";
import type { ReportedCase, ReportedModule } from "./stall-reporter.ts";

/** A report due 60 ms after the run starts, written to `written`. */
const reporting = (progressFile?: string) => {
  const written: string[] = [];
  const reporter = new StallReporter({
    reportAfterMinutes: 0.001,
    uptimeSeconds: () => 0,
    progressFile,
    write: (text) => {
      written.push(text);
    },
  });
  return { reporter, written };
};

/** Long enough for a report due 60 ms after the run starts to be out. */
const pastTheReport = 200;

const file = (name: string): ReportedModule => ({
  project: { name: "core" },
  relativeModuleId: `test/${name}.test.ts`,
});

const test = (module: ReportedModule, fullName: string): ReportedCase => ({
  module,
  fullName,
  result: () => ({ state: "passed" }),
});

describe("when the stall report is due", () => {
  it("counts from the process's start, not from when the tests start", () => {
    expect([
      reportDelayMs(15, 0),
      reportDelayMs(15, 90),
      reportDelayMs(0.5, 10.5),
    ]).toStrictEqual([900_000, 810_000, 19_500]);
  });

  it("is at once when the process has already run that long", () => {
    expect([reportDelayMs(15, 900), reportDelayMs(15, 1000)]).toStrictEqual([
      0, 0,
    ]);
  });
});

describe("the stall report", () => {
  it("names exactly the files and tests still running", async () => {
    const { reporter, written } = reporting();
    const builds = file("package-builds");
    const board = file("board-page");
    const done = test(builds, "builds the browser target");
    const stuck = test(builds, "resolves each target by its own conditions");
    reporter.onTestRunStart();
    reporter.onTestModuleStart(builds);
    reporter.onTestModuleStart(board);
    reporter.onTestCaseReady(done);
    reporter.onTestCaseResult(done);
    reporter.onTestCaseReady(stuck);
    reporter.onTestCaseReady(test(board, "reads the board"));
    reporter.onTestCaseResult(test(board, "another board test"));
    reporter.onTestModuleEnd(board);
    await wait(pastTheReport);

    const report = written.join("");
    const named = report
      .split("\n")
      .filter((line) => line.startsWith("  "))
      .map((line) => line.replace(/ \(for \d+s\)$/u, "").trim());
    expect({
      heading: report.includes("2 tests."),
      named,
    }).toStrictEqual({
      heading: true,
      named: [
        "file core test/package-builds.test.ts",
        "test core test/package-builds.test.ts > resolves each target by its own conditions",
        "test core test/board-page.test.ts > reads the board",
      ],
    });
  });

  it("prints nothing for a run that ends in time", async () => {
    const { reporter, written } = reporting();
    const builds = file("package-builds");
    const done = test(builds, "builds the browser target");
    reporter.onTestRunStart();
    reporter.onTestModuleStart(builds);
    reporter.onTestCaseReady(done);
    reporter.onTestCaseResult(done);
    reporter.onTestModuleEnd(builds);
    await reporter.onTestRunEnd();
    await wait(pastTheReport);

    expect(written).toStrictEqual([]);
  });
});

describe("the progress file", () => {
  it("holds every finished test once the run's end resolves", async () => {
    const progressFile = path.join(
      await mkdtemp(path.join(tmpdir(), "stall-reporter-")),
      "progress.log"
    );
    const { reporter } = reporting(progressFile);
    const builds = file("package-builds");
    const tests = Array.from({ length: 500 }, (_, index) =>
      test(builds, `test ${index}`)
    );
    reporter.onTestRunStart();
    reporter.onTestModuleStart(builds);
    for (const each of tests) {
      reporter.onTestCaseReady(each);
      reporter.onTestCaseResult(each);
    }
    reporter.onTestModuleEnd(builds);
    await reporter.onTestRunEnd();

    const written = await readFile(progressFile, "utf-8");
    const lines = written.trimEnd().split("\n");
    expect(
      lines.map((line) =>
        line.replace(/^\S+ (?<state>\S+) \d+ms /u, "$<state> ")
      )
    ).toStrictEqual(
      tests.map(
        ({ fullName }) =>
          `passed core test/package-builds.test.ts > ${fullName}`
      )
    );
  });
});
