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

/**
 * Where Vitest's state has each test and file, as its `result()` and
 * `state()` read it, by ID: running until `finish` or `finishFile`.
 */
const states = new Map<string, string>();

let files = 0;

const file = (name: string): ReportedModule => {
  const tests: ReportedCase[] = [];
  files += 1;
  const id = `file ${files}`;
  states.set(id, "pending");
  const testModule: ReportedModule = {
    id,
    project: { name: "core" },
    relativeModuleId: `test/${name}.test.ts`,
    children: { allTests: () => tests },
    state: () => states.get(id) ?? "pending",
  };
  testsOf.set(testModule, tests);
  return testModule;
};

/**
 * Another object for the same test, as Vitest may hand over with a later
 * event.
 */
const sameTest = (testCase: ReportedCase): ReportedCase => ({ ...testCase });

const test = (
  module: ReportedModule,
  fullName: string,
  options?: ReportedCase["options"]
): ReportedCase => {
  const id = `${module.id} > ${fullName}`;
  states.set(id, "pending");
  const testCase: ReportedCase = {
    id,
    module,
    fullName,
    options: options ?? { timeout: 60_000 },
    result: () => ({ state: states.get(id) ?? "pending" }),
  };
  testsOf.get(module)?.push(testCase);
  return testCase;
};

/** `testCase`, passed in Vitest's state. */
const finish = (testCase: ReportedCase): ReportedCase => {
  states.set(testCase.id, "passed");
  return testCase;
};

/** `testModule`, run to its end in Vitest's state. */
const finishFile = (testModule: ReportedModule): ReportedModule => {
  states.set(testModule.id, "passed");
  return testModule;
};

/**
 * A reporter that ends the run once a test runs `graceSeconds` (50 ms by
 * default) past its timeout, looking every 10 ms: `ended` counts how often
 * it did.
 */
const ending = (graceSeconds = 0.05) => {
  const written: string[] = [];
  const state = { ended: 0 };
  const reporter = new StallReporter({
    overdueGraceSeconds: graceSeconds,
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

/** A progress line's time, and how long its test took when known. */
const progressPrefix = /^\S+ (?<state>\S+)(?: \d+ms)? /u;

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
    const admin = file("admin");
    const done = test(builds, "builds the browser target");
    const stuck = test(builds, "resolves each target by its own conditions");
    reporter.onTestRunStart();
    reporter.onTestModuleStart(builds);
    reporter.onTestModuleStart(board);
    reporter.onTestModuleStart(admin);
    reporter.onTestCaseReady(done);
    reporter.onTestCaseResult(finish(done));
    reporter.onTestCaseReady(stuck);
    reporter.onTestCaseReady(test(board, "reads the board"));
    reporter.onTestCaseResult(finish(test(board, "another board test")));
    reporter.onTestCaseReady(test(admin, "lists the members"));
    reporter.onTestModuleEnd(finishFile(admin));
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
        "file core test/board-page.test.ts",
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
    reporter.onTestCaseResult(finish(done));
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
      reporter.onTestCaseResult(finish(each));
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
    reporter.onTestCaseResult(finish(done));
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
    // A 200 ms grace: the timed-out test is reported well within it, however
    // late the 40 ms wait ends on a loaded machine.
    const { reporter, written, state } = ending(0.2);
    const builds = file("package-builds");
    const timedOut = test(builds, "times out", { timeout: 20 });
    const untimed = test(builds, "has no timeout", {});
    reporter.onTestRunStart();
    reporter.onTestModuleStart(builds);
    reporter.onTestCaseReady(timedOut);
    reporter.onTestCaseReady(untimed);
    await wait(40);
    reporter.onTestCaseResult(finish(timedOut));
    await wait(pastTheGrace);
    reporter.onTestCaseResult(finish(untimed));
    reporter.onTestModuleEnd(builds);
    await reporter.onTestRunEnd();

    expect({ ended: state.ended, written }).toStrictEqual({
      ended: 0,
      written: [],
    });
  });

  it("leaves a file alone while it is quiet for less than its tests may take, and once it ends", async () => {
    // Every test of the file has a timeout, so its quiet is checked: 20 ms
    // and a 200 ms grace.
    const { reporter, written, state } = ending(0.2);
    const builds = file("package-builds");
    const done = test(builds, "builds", { timeout: 20 });
    test(builds, "resolves", { timeout: 20 });
    reporter.onTestRunStart();
    reporter.onTestModuleCollected(builds);
    reporter.onTestCaseReady(done);
    reporter.onTestCaseResult(finish(done));
    await wait(40);
    const whileQuiet = state.ended;
    reporter.onTestModuleEnd(builds);
    await wait(pastTheGrace);

    expect({ whileQuiet, ended: state.ended, written }).toStrictEqual({
      whileQuiet: 0,
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

// Vitest's events for a test can arrive out of order, for another object
// than the one before, or not at all, while its state still records how
// the test ended (see the reporter's header). What counts is that state.
describe("a test whose events Vitest delivers unreliably", () => {
  it("leaves the run alone when the test has ended in Vitest's state, though its result never arrived", async () => {
    const { reporter, written, state } = ending();
    const workflows = file("lifecycle");
    const paused = test(workflows, "pauses a sleeping run", { timeout: 20 });
    reporter.onTestRunStart();
    reporter.onTestModuleStart(workflows);
    reporter.onTestCaseReady(paused);
    // Neither its result nor its file's end arrives.
    finish(paused);
    finishFile(workflows);
    await wait(pastTheGrace);

    expect({ ended: state.ended, written }).toStrictEqual({
      ended: 0,
      written: [],
    });
  });

  it("leaves the run alone when the test's result arrives before its start", async () => {
    const { reporter, written, state } = ending();
    const bridge = file("screen-bridge");
    const flood = test(bridge, "passes on twenty reports", { timeout: 20 });
    reporter.onTestRunStart();
    reporter.onTestModuleStart(bridge);
    reporter.onTestCaseResult(finish(flood));
    reporter.onTestCaseReady(flood);
    reporter.onTestModuleEnd(finishFile(bridge));
    await wait(pastTheGrace);

    expect({ ended: state.ended, written }).toStrictEqual({
      ended: 0,
      written: [],
    });
  });

  it("leaves the run alone when the test's result comes with another object for it", async () => {
    const { reporter, written, state } = ending();
    const workflows = file("batches");
    const deleted = test(workflows, "deletes each ID once", { timeout: 20 });
    reporter.onTestRunStart();
    reporter.onTestModuleStart(workflows);
    reporter.onTestCaseReady(deleted);
    reporter.onTestCaseResult(sameTest(finish(deleted)));
    reporter.onTestModuleEnd(finishFile(workflows));
    await wait(pastTheGrace);

    expect({ ended: state.ended, written }).toStrictEqual({
      ended: 0,
      written: [],
    });
  });

  it("counts none of a file's tests as running once the file has ended", async () => {
    const { reporter, written, state } = ending();
    const workflows = file("results");
    reporter.onTestRunStart();
    reporter.onTestModuleStart(workflows);
    reporter.onTestCaseReady(test(workflows, "streams", { timeout: 20 }));
    reporter.onTestModuleEnd(finishFile(workflows));
    await wait(pastTheGrace);

    expect({ ended: state.ended, written }).toStrictEqual({
      ended: 0,
      written: [],
    });
  });

  it("leaves a quiet file alone that has ended in Vitest's state, though its end never arrived", async () => {
    const { reporter, written, state } = ending();
    const artifacts = file("package-artifacts");
    const served = test(artifacts, "serves", { timeout: 20 });
    reporter.onTestRunStart();
    reporter.onTestModuleCollected(artifacts);
    reporter.onTestCaseReady(served);
    finish(served);
    finishFile(artifacts);
    await wait(pastTheGrace);

    expect({ ended: state.ended, written }).toStrictEqual({
      ended: 0,
      written: [],
    });
  });

  it("still ends the run for a test that hasn't ended in Vitest's state either", async () => {
    const { reporter, state } = ending();
    const workflows = file("lifecycle");
    const spinning = test(workflows, "spins forever", { timeout: 20 });
    reporter.onTestRunStart();
    reporter.onTestModuleStart(workflows);
    reporter.onTestCaseReady(spinning);
    reporter.onTestCaseReady(sameTest(spinning));
    await wait(pastTheGrace);

    expect(state.ended).toBe(1);
  });

  it("writes the test's result to the progress file once, however its events arrive", async () => {
    const progressFile = path.join(
      await mkdtemp(path.join(tmpdir(), "stall-reporter-")),
      "progress.log"
    );
    const { reporter } = reporting(progressFile);
    const workflows = file("lifecycle");
    const early = test(workflows, "result first");
    const lost = test(workflows, "result lost");
    const twice = test(workflows, "result twice");
    reporter.onTestRunStart();
    reporter.onTestModuleStart(workflows);
    reporter.onTestCaseResult(finish(early));
    reporter.onTestCaseReady(early);
    reporter.onTestCaseReady(lost);
    finish(lost);
    reporter.onTestCaseReady(twice);
    reporter.onTestCaseResult(finish(twice));
    reporter.onTestCaseResult(sameTest(twice));
    reporter.onTestModuleEnd(finishFile(workflows));
    await reporter.onTestRunEnd();

    const progress = await readFile(progressFile, "utf-8");
    const lines = progress
      .trimEnd()
      .split("\n")
      .map((line) => line.replace(progressPrefix, "$<state> "))
      .toSorted();
    expect(lines).toStrictEqual([
      "passed core test/lifecycle.test.ts > result first",
      "passed core test/lifecycle.test.ts > result lost",
      "passed core test/lifecycle.test.ts > result twice",
    ]);
  });
});

/** A reporter that explains a run's end in a summary file, annotated. */
const explaining = async (graceSeconds?: number) => {
  const summaryFile = path.join(
    await mkdtemp(path.join(tmpdir(), "stall-reporter-")),
    "summary.md"
  );
  const written: string[] = [];
  const state = { ended: 0 };
  const reporter = new StallReporter({
    overdueGraceSeconds: graceSeconds,
    overdueCheckMs: 10,
    summaryFile,
    annotate: true,
    write: (text) => {
      written.push(text);
    },
    end: () => {
      state.ended += 1;
    },
  });
  const summary = async (): Promise<string> => {
    try {
      return await readFile(summaryFile, "utf-8");
    } catch {
      return "";
    }
  };
  return { reporter, written, state, summary };
};

describe("why a run ended", () => {
  it("is the reporter's own verdict, with what still ran and the memory, when it ends the run", async () => {
    const { reporter, written, state, summary } = await explaining(0.05);
    const builds = file("package-builds");
    reporter.onTestRunStart();
    reporter.onTestModuleStart(builds);
    reporter.onTestCaseReady(test(builds, "spins forever", { timeout: 20 }));
    await wait(pastTheGrace);

    const explained = await summary();
    expect({
      ended: state.ended,
      verdict: explained.includes(
        "Ending the run, as Vitest no longer times it out: core test/package-builds.test.ts > spins forever has run for"
      ),
      stillRan: explained.includes(
        "- test core test/package-builds.test.ts > spins forever"
      ),
      memory: explained.includes("MiB free of"),
      annotated: written.some((text) =>
        text.startsWith(
          "::error title=vp test::Ending the run, as Vitest no longer times it out"
        )
      ),
    }).toStrictEqual({
      ended: 1,
      verdict: true,
      stillRan: true,
      memory: true,
      annotated: true,
    });
  });

  it("is Vitest's failed files and unhandled errors when Vitest fails the run", async () => {
    const { reporter, written, summary } = await explaining();
    const failing = file("ledger");
    const passing = file("budgets");
    states.set(failing.id, "failed");
    reporter.onTestRunStart();
    await reporter.onTestRunEnd(
      [failing, finishFile(passing)],
      [
        {
          name: "Error",
          message: "Worker exited unexpectedly\n    at somewhere",
        },
      ],
      "failed"
    );

    const explained = await summary();
    expect({
      heading: explained.includes(
        "Vitest ended the run failed: 1 files failed, 1 unhandled errors."
      ),
      failed: explained.includes("- failed: core test/ledger.test.ts"),
      passedLeftOut: explained.includes("budgets"),
      error: explained.includes(
        "- unhandled: Error: Worker exited unexpectedly\n"
      ),
      annotated: written.some((text) =>
        text.startsWith("::error title=vp test::Vitest ended the run failed")
      ),
    }).toStrictEqual({
      heading: true,
      failed: true,
      passedLeftOut: false,
      error: true,
      annotated: true,
    });
  });

  it("is left unsaid for a run that passes", async () => {
    const { reporter, written, summary } = await explaining();
    reporter.onTestRunStart();
    await reporter.onTestRunEnd([finishFile(file("budgets"))], [], "passed");

    expect({ summary: await summary(), written }).toStrictEqual({
      summary: "",
      written: [],
    });
  });
});
