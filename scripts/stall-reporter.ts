// A Vitest reporter for CI (`vp test --reporter=default
// --reporter=./scripts/stall-reporter.ts`) that names what a stalled run is
// stuck on, and ends it. Nothing in Vitest times out a test worker that no
// longer answers, so a stall otherwise shows only as the step timing out
// after every reported file passed, without saying which file or test never
// ended. This reporter:
//
// - writes one line per finished test to GRASP_TEST_PROGRESS_FILE, which
//   CI keeps as an artifact, so the log itself isn't flooded;
// - GRASP_STALL_REPORT_AFTER_MINUTES after the process started, shortly
//   before the step's own timeout, prints each file and test still running
//   and for how long. None at all means the hang is in teardown or in
//   shutting the pool down;
// - ends the run, after naming it, once a test has run
//   GRASP_TEST_OVERDUE_GRACE_SECONDS past its own timeout, or a file has
//   reported nothing for that long past the longest its tests may take.
//   Vitest times a test out from inside its worker, so a test that blocks
//   the worker (a loop that never yields, say) or whose request workerd
//   cancels as hung takes that timer with it, and the run would wait for
//   it until the step's timeout. A blocked worker may not even have sent
//   that its test started: hence the file's silence. Past that, nothing
//   will report it any more;
// - says why a run that didn't pass ended, in the step's summary on GitHub
//   (GITHUB_STEP_SUMMARY) and as an error annotation: its own verdict, or
//   Vitest's failed files and unhandled errors, with the runner's memory.
//
// A run that passes in time prints nothing more.
//
// What a test or file is doing is read from Vitest's state, not from the
// order its events arrive in. Those events are not reliable on their own:
// a test's start can arrive after its result (seen with the forks pool,
// where messages from a worker are handled concurrently), and
// vitest-pool-workers can send a batch of events late, from the runner's
// own I/O context, after Vitest's runner has emptied and refilled the
// array it handed over (`eventsPacks` in @vitest/runner), so a batch's
// events are lost or arrive beside another batch's results. Results
// themselves still reach Vitest's state. Trusting the events alone, the
// reporter took passing tests for hung ones and ended healthy runs (seen in
// CI as a failed step with nothing failed, and every file reported passed).
import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { appendFile } from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import { finished } from "node:stream/promises";
import { setTimeout as wait } from "node:timers/promises";

import type { Reporter } from "vite-plus/test/node";

const minuteMs = 60 * 1000;

/** `name`'s value as a positive number, if it is set to one. */
const positiveFromEnv = (name: string): number | undefined => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

/**
 * How long from now until the report is due: `minutes` after the process
 * started, `uptimeSeconds` ago, so a slow start doesn't push it past the
 * step's timeout. At once if that is already past.
 */
export const reportDelayMs = (minutes: number, uptimeSeconds: number): number =>
  Math.max(0, minutes * minuteMs - uptimeSeconds * 1000);

const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;

/** What the reporter reads of a test file: Vitest's `TestModule` has it. */
export interface ReportedModule {
  readonly id: string;
  readonly project: { readonly name: string };
  readonly relativeModuleId: string;
  readonly children: { allTests: () => Iterable<ReportedCase> };
  /** "queued" or "pending" until the file has run. */
  state: () => string;
}

/** What the reporter reads of a test: Vitest's `TestCase` has it. */
export interface ReportedCase {
  readonly id: string;
  readonly module: ReportedModule;
  readonly fullName: string;
  readonly options: {
    readonly timeout?: number | undefined;
    readonly retry?: number | { readonly count?: number } | undefined;
    readonly repeats?: number | undefined;
  };
  /** "pending" until the test has ended. */
  result: () => { readonly state: string };
}

/** What the reporter reads of an unhandled error Vitest reports. */
export interface ReportedError {
  readonly name?: string | undefined;
  readonly message?: string | undefined;
}

/** Whether Vitest's state has `testCase` as ended, whatever its events said. */
const ended = (testCase: ReportedCase): boolean =>
  testCase.result().state !== "pending";

/** Whether Vitest's state has `testModule` as run to its end. */
const moduleEnded = (testModule: ReportedModule): boolean => {
  const state = testModule.state();
  return state !== "pending" && state !== "queued";
};

/**
 * The longest `testCase` can run and still be reported by Vitest: its
 * timeout for each attempt its retries and repeats allow, and `graceMs`
 * for its hooks. Undefined for a test without a timeout.
 */
export const budgetMs = (
  testCase: ReportedCase,
  graceMs: number
): number | undefined => {
  const { timeout, retry, repeats } = testCase.options;
  if (timeout === undefined || timeout <= 0) {
    return undefined;
  }
  const retries = typeof retry === "number" ? retry : (retry?.count ?? 0);
  return timeout * (retries + 1) * ((repeats ?? 0) + 1) + graceMs;
};

/** How often the reporter looks for a test past its budget, by default. */
const defaultOverdueCheckMs = 5000;

/**
 * How long ending an overdue run waits for the progress file to be
 * written before it exits regardless.
 */
const flushMs = 5000;

/** How many failed files or unhandled errors a summary names. */
const summaryLimit = 20;

const mebibyte = 1024 * 1024;

/** The runner's memory as `os` sees it, and this process's own. */
const memoryNow = (): string =>
  `memory: ${Math.round(freemem() / mebibyte)} MiB free of ${Math.round(totalmem() / mebibyte)} MiB; Vitest's process holds ${Math.round(process.memoryUsage().rss / mebibyte)} MiB`;

/**
 * Where the reporter writes, and when it reports. Given any of them, the
 * env isn't read at all: what is left out is off.
 */
export interface StallReporterOptions {
  /** Minutes after the process started; no report when unset. */
  reportAfterMinutes?: number;
  /**
   * Seconds past its timeout a test may run before the run is ended; never
   * ended when unset.
   */
  overdueGraceSeconds?: number;
  /** How often to look for an overdue test, in milliseconds. */
  overdueCheckMs?: number;
  /** The progress file; none when unset. */
  progressFile?: string;
  /**
   * The Markdown file a run that didn't pass is explained in (GitHub's
   * step summary); none when unset.
   */
  summaryFile?: string;
  /** Whether to annotate that explanation as an error, as GitHub reads it. */
  annotate?: boolean;
  /** How long the process has run, in seconds. */
  uptimeSeconds?: () => number;
  /** Where the report goes. */
  write?: (text: string) => void;
  /**
   * Ends the run, failed, once a test is overdue; by default, the process
   * exits 1. Exiting stops workerd too: miniflare disposes of it on exit.
   */
  end?: () => void;
}

/** The settings CI gives in the env (.github/workflows/ci.yml). */
const fromEnv = (): StallReporterOptions => ({
  reportAfterMinutes: positiveFromEnv("GRASP_STALL_REPORT_AFTER_MINUTES"),
  overdueGraceSeconds: positiveFromEnv("GRASP_TEST_OVERDUE_GRACE_SECONDS"),
  progressFile: process.env.GRASP_TEST_PROGRESS_FILE,
  summaryFile: process.env.GITHUB_STEP_SUMMARY,
  annotate: process.env.GITHUB_ACTIONS === "true",
});

const moduleName = (testModule: ReportedModule): string =>
  `${testModule.project.name} ${testModule.relativeModuleId}`;

const caseName = (testCase: ReportedCase): string =>
  `${moduleName(testCase.module)} > ${testCase.fullName}`;

/** `text` on one line, as a GitHub annotation's message must be. */
const annotation = (text: string): string =>
  text.replaceAll("%", "%25").replaceAll("\r", "").replaceAll("\n", "%0A");

/** An unhandled error's first line, named. */
const errorLine = (error: ReportedError): string => {
  const [firstLine] = (error.message ?? "").split("\n");
  return `${error.name ?? "Error"}: ${firstLine ?? ""}`;
};

/** Why Vitest ended a run that didn't pass, by its own account. */
const runEnd = (
  testModules: readonly ReportedModule[],
  unhandledErrors: readonly ReportedError[],
  reason: string
): string[] => {
  const failed = testModules.filter(
    (testModule) => testModule.state() === "failed"
  );
  return [
    `Vitest ended the run ${reason}: ${failed.length} files failed, ${unhandledErrors.length} unhandled errors.`,
    ...failed
      .slice(0, summaryLimit)
      .map((testModule) => `- failed: ${moduleName(testModule)}`),
    ...unhandledErrors
      .slice(0, summaryLimit)
      .map((error) => `- unhandled: ${errorLine(error)}`),
  ];
};

/** A test that started, and when, by its ID. */
interface Running {
  testCase: ReportedCase;
  started: number;
}

/** A file that started, when, and when it last reported, by its ID. */
interface RunningModule {
  testModule: ReportedModule;
  started: number;
  heard: number;
}

export default class StallReporter implements Reporter {
  // By ID, not by object: an event may hand over another object for the
  // same test or file than the one before.
  readonly #modules = new Map<string, RunningModule>();
  readonly #cases = new Map<string, Running>();
  /** Tests already written to the progress file, so a late start is ignored. */
  readonly #finished = new Set<string>();
  readonly #progress: WriteStream | undefined;
  readonly #reportAfterMinutes: number | undefined;
  readonly #overdueGraceMs: number | undefined;
  readonly #overdueCheckMs: number;
  readonly #summaryFile: string | undefined;
  readonly #annotate: boolean;
  readonly #uptimeSeconds: () => number;
  readonly #write: (text: string) => void;
  readonly #end: () => void;
  #timer: NodeJS.Timeout | undefined;
  #overdueTimer: NodeJS.Timeout | undefined;
  #ended = false;

  // Vitest constructs a reporter given by path with no settings, or an
  // empty object: everything then comes from the env, and only then.
  constructor(given?: StallReporterOptions) {
    const options =
      given === undefined || Object.keys(given).length === 0
        ? fromEnv()
        : given;
    this.#reportAfterMinutes = options.reportAfterMinutes;
    this.#overdueGraceMs =
      options.overdueGraceSeconds === undefined
        ? undefined
        : options.overdueGraceSeconds * 1000;
    this.#overdueCheckMs = options.overdueCheckMs ?? defaultOverdueCheckMs;
    this.#summaryFile =
      options.summaryFile === "" ? undefined : options.summaryFile;
    this.#annotate = options.annotate ?? false;
    this.#uptimeSeconds = options.uptimeSeconds ?? (() => process.uptime());
    this.#write =
      options.write ??
      ((text) => {
        process.stdout.write(text);
      });
    this.#end =
      options.end ??
      (() => {
        process.exit(1);
      });
    const file = options.progressFile;
    this.#progress =
      file === undefined || file === ""
        ? undefined
        : createWriteStream(file, { flags: "w" });
    // Losing the progress file must not fail the run it describes.
    this.#progress?.on("error", (error) => {
      process.stderr.write(
        `The stall reporter can't write ${file}: ${error.message}\n`
      );
    });
  }

  onTestRunStart(): void {
    clearTimeout(this.#timer);
    clearInterval(this.#overdueTimer);
    const minutes = this.#reportAfterMinutes;
    if (minutes !== undefined) {
      this.#timer = setTimeout(
        () => {
          this.#settle();
          this.#report(`Still running after ${minutes} minutes`);
        },
        reportDelayMs(minutes, this.#uptimeSeconds())
      );
      // A run that ends in time doesn't wait for the report.
      this.#timer.unref();
    }
    const graceMs = this.#overdueGraceMs;
    if (graceMs !== undefined) {
      this.#overdueTimer = setInterval(() => {
        void this.#endIfOverdue(graceMs);
      }, this.#overdueCheckMs);
      this.#overdueTimer.unref();
    }
  }

  // A file counts as running from when it is collected: Vitest's worker
  // sends that it started its tests in a batch a moment later, which a
  // test that blocks the worker at once keeps from ever leaving. The quiet
  // file rule assumes a file is collected just before its tests run, one
  // file per task. A pool that collected a batch of files up front (one
  // worker running several files, as `isolate: false` could) would leave
  // the later ones quiet while they wait, and end the run wrongly. Core's
  // `isolate: false` files are collected one at a time, each just before
  // it runs (checked with Vitest 4.1 and one worker).
  onTestModuleCollected(testModule: ReportedModule): void {
    this.#started(testModule);
  }

  onTestModuleStart(testModule: ReportedModule): void {
    this.#started(testModule);
  }

  onTestModuleEnd(testModule: ReportedModule): void {
    this.#moduleDone(testModule);
  }

  onTestCaseReady(testCase: ReportedCase): void {
    this.#heardFrom(testCase.module);
    // Its result came first: it isn't running.
    if (this.#finished.has(testCase.id)) {
      return;
    }
    const running = this.#cases.get(testCase.id);
    this.#cases.set(testCase.id, {
      testCase,
      started: running?.started ?? Date.now(),
    });
  }

  onTestCaseResult(testCase: ReportedCase): void {
    this.#heardFrom(testCase.module);
    this.#caseDone(testCase);
  }

  async onTestRunEnd(
    testModules: readonly ReportedModule[] = [],
    unhandledErrors: readonly ReportedError[] = [],
    reason = "passed"
  ): Promise<void> {
    clearTimeout(this.#timer);
    clearInterval(this.#overdueTimer);
    if (reason !== "passed") {
      await this.#explain(runEnd(testModules, unhandledErrors, reason));
    }
    await this.#flush();
  }

  /** Ends the progress file, once every line is written. */
  async #flush(): Promise<void> {
    const progress = this.#progress;
    if (progress === undefined || progress.destroyed) {
      return;
    }
    progress.end();
    try {
      // Every line written, so the artifact is whole.
      await finished(progress);
    } catch {
      // Warned of by the stream's error listener: the run stands.
    }
  }

  #started(testModule: ReportedModule): void {
    const now = Date.now();
    const running = this.#modules.get(testModule.id);
    this.#modules.set(testModule.id, {
      testModule,
      started: running?.started ?? now,
      heard: now,
    });
  }

  #heardFrom(testModule: ReportedModule): void {
    const running = this.#modules.get(testModule.id);
    if (running !== undefined) {
      running.heard = Date.now();
    }
  }

  /** Writes `testCase`'s result, once, and stops tracking it. */
  #caseDone(testCase: ReportedCase): void {
    const running = this.#cases.get(testCase.id);
    this.#cases.delete(testCase.id);
    if (this.#finished.has(testCase.id)) {
      return;
    }
    this.#finished.add(testCase.id);
    const took =
      running === undefined ? "" : ` ${Date.now() - running.started}ms`;
    this.#progress?.write(
      `${new Date().toISOString()} ${testCase.result().state}${took} ${caseName(testCase)}\n`
    );
  }

  /** Stops tracking `testModule`, and its tests: none runs past its file. */
  #moduleDone(testModule: ReportedModule): void {
    this.#modules.delete(testModule.id);
    for (const { testCase } of this.#cases.values()) {
      if (testCase.module.id === testModule.id) {
        this.#caseDone(testCase);
      }
    }
  }

  /**
   * Drops what Vitest's state has as ended though its events never said
   * so, writing each such test's result. (A Map's iterator skips what is
   * deleted while it runs, so these loops may delete.)
   */
  #settle(): void {
    for (const { testCase } of this.#cases.values()) {
      if (ended(testCase)) {
        this.#caseDone(testCase);
      }
    }
    for (const { testModule } of this.#modules.values()) {
      if (moduleEnded(testModule)) {
        this.#moduleDone(testModule);
      }
    }
  }

  /** What has run past all Vitest would wait for, if anything. */
  #overdue(now: number, graceMs: number): string | undefined {
    for (const { testCase, started } of this.#cases.values()) {
      const budget = budgetMs(testCase, graceMs);
      if (budget !== undefined && now - started > budget) {
        return `${caseName(testCase)} has run for ${seconds(now - started)}, past its timeout`;
      }
    }
    for (const { testModule, heard } of this.#modules.values()) {
      const budgets = [...testModule.children.allTests()].map((testCase) =>
        budgetMs(testCase, graceMs)
      );
      // A file with a test that may run for ever has no bound at all.
      const bounded = budgets.filter((budget) => budget !== undefined);
      if (
        bounded.length > 0 &&
        bounded.length === budgets.length &&
        now - heard > Math.max(...bounded)
      ) {
        return `${moduleName(testModule)} has reported nothing for ${seconds(now - heard)}, longer than any of its tests may take`;
      }
    }
    return undefined;
  }

  async #endIfOverdue(graceMs: number): Promise<void> {
    if (this.#ended) {
      return;
    }
    this.#settle();
    const overdue = this.#overdue(Date.now(), graceMs);
    if (overdue === undefined) {
      return;
    }
    this.#ended = true;
    clearTimeout(this.#timer);
    clearInterval(this.#overdueTimer);
    const verdict = `Ending the run, as Vitest no longer times it out: ${overdue}`;
    this.#report(verdict);
    await Promise.race([
      // The verdict, and the progress file as far as it goes, for the
      // artifact; not waited for past a few seconds.
      Promise.all([
        this.#explain([
          verdict,
          ...this.#running(Date.now()).map((line) => `- ${line.trim()}`),
        ]),
        this.#flush(),
      ]),
      wait(flushMs, undefined, { ref: false }),
    ]);
    this.#end();
  }

  /** Writes why the run ended to the summary, and annotates it. */
  async #explain(lines: string[]): Promise<void> {
    const [heading = ""] = lines;
    const memory = memoryNow();
    if (this.#annotate) {
      this.#write(
        `::error title=vp test::${annotation(`${heading}\n${memory}`)}\n`
      );
    }
    const file = this.#summaryFile;
    if (file === undefined) {
      return;
    }
    try {
      await appendFile(
        file,
        `### Why vp test ended\n\n${lines.join("\n")}\n\n${memory}\n\n`
      );
    } catch (error) {
      // Losing the summary must not change how the run ends.
      process.stderr.write(
        `The stall reporter can't write ${file}: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }

  /** A line for each file and test still running. */
  #running(now: number): string[] {
    return [
      ...[...this.#modules.values()].map(
        ({ testModule, started }) =>
          `  file ${moduleName(testModule)} (for ${seconds(now - started)})`
      ),
      ...[...this.#cases.values()].map(
        ({ testCase, started }) =>
          `  test ${caseName(testCase)} (for ${seconds(now - started)})`
      ),
    ];
  }

  #report(heading: string): void {
    const now = Date.now();
    const lines = [
      "",
      `${heading}: ${this.#modules.size} files, ${this.#cases.size} tests.`,
      ...this.#running(now),
      memoryNow(),
      "",
    ];
    this.#write(lines.join("\n"));
  }
}
