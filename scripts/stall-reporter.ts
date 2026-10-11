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
//   will report it any more.
//
// A run that ends in time prints nothing more.
import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
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
  readonly project: { readonly name: string };
  readonly relativeModuleId: string;
  readonly children: { allTests: () => Iterable<ReportedCase> };
}

/** What the reporter reads of a test: Vitest's `TestCase` has it. */
export interface ReportedCase {
  readonly module: ReportedModule;
  readonly fullName: string;
  readonly options: {
    readonly timeout?: number | undefined;
    readonly retry?: number | { readonly count?: number } | undefined;
    readonly repeats?: number | undefined;
  };
  result: () => { readonly state: string };
}

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
});

const moduleName = (testModule: ReportedModule): string =>
  `${testModule.project.name} ${testModule.relativeModuleId}`;

const caseName = (testCase: ReportedCase): string =>
  `${moduleName(testCase.module)} > ${testCase.fullName}`;

export default class StallReporter implements Reporter {
  readonly #modules = new Map<ReportedModule, number>();
  readonly #cases = new Map<ReportedCase, number>();
  /** When each running file last reported anything. */
  readonly #heard = new Map<ReportedModule, number>();
  readonly #progress: WriteStream | undefined;
  readonly #reportAfterMinutes: number | undefined;
  readonly #overdueGraceMs: number | undefined;
  readonly #overdueCheckMs: number;
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
  // test that blocks the worker at once keeps from ever leaving.
  onTestModuleCollected(testModule: ReportedModule): void {
    this.#started(testModule);
  }

  onTestModuleStart(testModule: ReportedModule): void {
    this.#started(testModule);
  }

  onTestModuleEnd(testModule: ReportedModule): void {
    this.#modules.delete(testModule);
    this.#heard.delete(testModule);
  }

  onTestCaseReady(testCase: ReportedCase): void {
    this.#cases.set(testCase, Date.now());
    this.#heardFrom(testCase.module);
  }

  onTestCaseResult(testCase: ReportedCase): void {
    const started = this.#cases.get(testCase);
    this.#cases.delete(testCase);
    this.#heardFrom(testCase.module);
    const took = started === undefined ? "" : ` ${Date.now() - started}ms`;
    this.#progress?.write(
      `${new Date().toISOString()} ${testCase.result().state}${took} ${caseName(testCase)}\n`
    );
  }

  async onTestRunEnd(): Promise<void> {
    clearTimeout(this.#timer);
    clearInterval(this.#overdueTimer);
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
    if (!this.#modules.has(testModule)) {
      this.#modules.set(testModule, now);
    }
    this.#heard.set(testModule, now);
  }

  #heardFrom(testModule: ReportedModule): void {
    if (this.#heard.has(testModule)) {
      this.#heard.set(testModule, Date.now());
    }
  }

  /** What has run past all Vitest would wait for, if anything. */
  #overdue(now: number, graceMs: number): string | undefined {
    for (const [testCase, started] of this.#cases) {
      const budget = budgetMs(testCase, graceMs);
      if (budget !== undefined && now - started > budget) {
        return `${caseName(testCase)} has run for ${seconds(now - started)}, past its timeout`;
      }
    }
    for (const [testModule, heard] of this.#heard) {
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
    const overdue = this.#overdue(Date.now(), graceMs);
    if (overdue === undefined) {
      return;
    }
    this.#ended = true;
    clearTimeout(this.#timer);
    clearInterval(this.#overdueTimer);
    this.#report(
      `Ending the run, as Vitest no longer times it out: ${overdue}`
    );
    // The progress file, as far as it goes, for the artifact; not waited
    // for past a few seconds.
    await Promise.race([
      this.#flush(),
      wait(flushMs, undefined, { ref: false }),
    ]);
    this.#end();
  }

  #report(heading: string): void {
    const now = Date.now();
    const lines = [
      "",
      `${heading}: ${this.#modules.size} files, ${this.#cases.size} tests.`,
      ...[...this.#modules].map(
        ([testModule, started]) =>
          `  file ${moduleName(testModule)} (for ${seconds(now - started)})`
      ),
      ...[...this.#cases].map(
        ([testCase, started]) =>
          `  test ${caseName(testCase)} (for ${seconds(now - started)})`
      ),
      "",
    ];
    this.#write(lines.join("\n"));
  }
}
