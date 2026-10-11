import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { describe, expect, it } from "vite-plus/test";

import StallReporter, { budgetMs, reportDelayMs } from "./stall-reporter.ts";
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

/** The tests of each file, as `test` makes them. */
const testsOf = new WeakMap<ReportedModule, ReportedCase[]>();

const file = (name: string): ReportedModule => {
  const tests: ReportedCase[] = [];
  const testModule: ReportedModule = {
    project: { name: "core" },
    relativeModuleId: `test/${name}.test.ts`,
    children: { allTests: () => tests },
  };
  testsOf.set(testModule, tests);
  return testModule;
};

const test = (
  module: ReportedModule,
  fullName: string,
  options?: ReportedCase["options"]
): ReportedCase => {
  const testCase: ReportedCase = {
    module,
    fullName,
    options: options ?? { timeout: 60_000 },
    result: () => ({ state: "passed" }),
  };
  testsOf.get(module)?.push(testCase);
  return testCase;
};

/**
 * A reporter that ends the run once a test runs 50 ms past its timeout,
 * looking every 10 ms: `ended` counts how often it did.
 */
const ending = () => {
  const written: string[] = [];
  const state = { ended: 0 };
  const reporter = new StallReporter({
    overdueGraceSeconds: 0.05,
    overdueCheckMs: 10,
    write: (text) => {
      written.push(text);
    },
    end: () => {
      state.ended += 1;
    },
  });
  return { reporter, written, state };
};

/** Well past a 20 ms test's timeout and the 50 ms grace. */
const pastTheGrace = 300;

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

describe("how long a test may run", () => {
  it("is its timeout for every attempt its retries and repeats allow, and the grace", () => {
    const builds = file("package-builds");
    expect([
      budgetMs(test(builds, "once", { timeout: 60_000 }), 120_000),
      budgetMs(test(builds, "retried", { timeout: 1000, retry: 2 }), 500),
      budgetMs(
        test(builds, "retried by count", {
          timeout: 1000,
          retry: { count: 1 },
          repeats: 1,
        }),
        0
      ),
      budgetMs(test(builds, "untimed", {}), 500),
    ]).toStrictEqual([180_000, 3500, 4000, undefined]);
  });
});

describe("a test past its timeout", () => {
  it("ends the run once, naming it, when Vitest never reports it", async () => {
    const { reporter, written, state } = ending();
    const builds = file("package-builds");
    const spinning = test(builds, "spins forever", { timeout: 20 });
    reporter.onTestRunStart();
    reporter.onTestModuleStart(builds);
    reporter.onTestCaseReady(spinning);
    await wait(pastTheGrace);

    const report = written.join("");
    expect({
      ended: state.ended,
      heading: report.includes(
        "no longer times it out: core test/package-builds.test.ts > spins forever has run for"
      ),
      named: report.includes(
        "  test core test/package-builds.test.ts > spins forever"
      ),
    }).toStrictEqual({ ended: 1, heading: true, named: true });
  });

  it("ends the run when its file goes quiet, even before Vitest says it started", async () => {
    const { reporter, written, state } = ending();
    const builds = file("package-builds");
    const done = test(builds, "builds", { timeout: 20 });
    test(builds, "spins forever", { timeout: 20 });
    reporter.onTestRunStart();
    reporter.onTestModuleCollected(builds);
    reporter.onTestCaseReady(done);
    reporter.onTestCaseResult(done);
    await wait(pastTheGrace);

    expect({
      ended: state.ended,
      heading: written
        .join("")
        .includes(
          "no longer times it out: core test/package-builds.test.ts has reported nothing for"
        ),
    }).toStrictEqual({ ended: 1, heading: true });
  });

  it("leaves a run alone whose tests Vitest reports, timed out or not", async () => {
    const { reporter, written, state } = ending();
    const builds = file("package-builds");
    const timedOut = test(builds, "times out", { timeout: 20 });
    const untimed = test(builds, "has no timeout", {});
    reporter.onTestRunStart();
    reporter.onTestModuleStart(builds);
    reporter.onTestCaseReady(timedOut);
    reporter.onTestCaseReady(untimed);
    await wait(40);
    reporter.onTestCaseResult(timedOut);
    await wait(pastTheGrace);
    reporter.onTestCaseResult(untimed);
    reporter.onTestModuleEnd(builds);
    await reporter.onTestRunEnd();

    expect({ ended: state.ended, written }).toStrictEqual({
      ended: 0,
      written: [],
    });
  });

  it("never ends a run without a grace set", async () => {
    const written: string[] = [];
    const state = { ended: 0 };
    const reporter = new StallReporter({
      overdueCheckMs: 10,
      write: (text) => {
        written.push(text);
      },
      end: () => {
        state.ended += 1;
      },
    });
    const builds = file("package-builds");
    reporter.onTestRunStart();
    reporter.onTestCaseReady(test(builds, "spins forever", { timeout: 20 }));
    await wait(pastTheGrace);

    expect({ ended: state.ended, written }).toStrictEqual({
      ended: 0,
      written: [],
    });
  });
});
