// A Vitest reporter for CI (`vp test --reporter=default
// --reporter=./scripts/stall-reporter.ts`) that names what a stalled run is
// stuck on. Nothing in Vitest times out a test worker stuck after its tests
// (apps/core/vite.config.ts), so a stall shows only as the step timing out
// after every reported file passed, without saying which file or test never
// ended. This reporter:
//
// - writes one line per finished test to GRASP_TEST_PROGRESS_FILE, which
//   CI keeps as an artifact, so the log itself isn't flooded;
// - GRASP_STALL_REPORT_AFTER_MINUTES after the process started, shortly
//   before the step's own timeout, prints each file and test still running
//   and for how long. None at all means the hang is in teardown or in
//   shutting the pool down.
//
// It only listens: a run that ends in time prints nothing more.
import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { finished } from "node:stream/promises";

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
}

/** What the reporter reads of a test: Vitest's `TestCase` has it. */
export interface ReportedCase {
  readonly module: ReportedModule;
  readonly fullName: string;
  result: () => { readonly state: string };
}

/** Where the reporter writes, and when it reports; the env's by default. */
export interface StallReporterOptions {
  /** Minutes after the process started; no report when unset. */
  reportAfterMinutes?: number;
  /** The progress file; none when unset. */
  progressFile?: string;
  /** How long the process has run, in seconds. */
  uptimeSeconds?: () => number;
  /** Where the report goes. */
  write?: (text: string) => void;
}

const moduleName = (testModule: ReportedModule): string =>
  `${testModule.project.name} ${testModule.relativeModuleId}`;

const caseName = (testCase: ReportedCase): string =>
  `${moduleName(testCase.module)} > ${testCase.fullName}`;

export default class StallReporter implements Reporter {
  readonly #modules = new Map<ReportedModule, number>();
  readonly #cases = new Map<ReportedCase, number>();
  readonly #progress: WriteStream | undefined;
  readonly #reportAfterMinutes: number | undefined;
  readonly #uptimeSeconds: () => number;
  readonly #write: (text: string) => void;
  #timer: NodeJS.Timeout | undefined;

  // Vitest constructs a reporter given by path with no options of ours:
  // everything then comes from the env.
  constructor(options: StallReporterOptions = {}) {
    this.#reportAfterMinutes =
      options.reportAfterMinutes ??
      positiveFromEnv("GRASP_STALL_REPORT_AFTER_MINUTES");
    this.#uptimeSeconds = options.uptimeSeconds ?? (() => process.uptime());
    this.#write =
      options.write ??
      ((text) => {
        process.stdout.write(text);
      });
    const file = options.progressFile ?? process.env.GRASP_TEST_PROGRESS_FILE;
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
    const minutes = this.#reportAfterMinutes;
    if (minutes === undefined) {
      return;
    }
    this.#timer = setTimeout(
      () => {
        this.#report(minutes);
      },
      reportDelayMs(minutes, this.#uptimeSeconds())
    );
    // A run that ends in time doesn't wait for the report.
    this.#timer.unref();
  }

  onTestModuleStart(testModule: ReportedModule): void {
    this.#modules.set(testModule, Date.now());
  }

  onTestModuleEnd(testModule: ReportedModule): void {
    this.#modules.delete(testModule);
  }

  onTestCaseReady(testCase: ReportedCase): void {
    this.#cases.set(testCase, Date.now());
  }

  onTestCaseResult(testCase: ReportedCase): void {
    const started = this.#cases.get(testCase);
    this.#cases.delete(testCase);
    const took = started === undefined ? "" : ` ${Date.now() - started}ms`;
    this.#progress?.write(
      `${new Date().toISOString()} ${testCase.result().state}${took} ${caseName(testCase)}\n`
    );
  }

  async onTestRunEnd(): Promise<void> {
    clearTimeout(this.#timer);
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

  #report(minutes: number): void {
    const now = Date.now();
    const lines = [
      "",
      `Still running after ${minutes} minutes: ${this.#modules.size} files, ${this.#cases.size} tests.`,
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
