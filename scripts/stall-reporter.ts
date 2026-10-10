// A Vitest reporter for CI (`vp test --reporter=default
// --reporter=./scripts/stall-reporter.ts`) that names what a stalled run is
// stuck on. Nothing in Vitest times out a test worker stuck after its tests
// (apps/core/vite.config.ts), so a stall shows only as the step timing out
// after every reported file passed, without saying which file or test never
// ended. This reporter:
//
// - appends one line per finished test to GRASP_TEST_PROGRESS_FILE, which
//   CI keeps as an artifact, so the log itself isn't flooded;
// - after GRASP_STALL_REPORT_AFTER_MINUTES, shortly before the step's own
//   timeout, prints each file and test still running and for how long.
//
// It only listens: a run that ends in time prints nothing more.
import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";

import type { Reporter, TestCase, TestModule } from "vite-plus/test/node";

const minuteMs = 60 * 1000;

/** `name`'s value as a positive number, if it is set to one. */
const positiveFromEnv = (name: string): number | undefined => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;

const moduleName = (testModule: TestModule): string =>
  `${testModule.project.name} ${testModule.relativeModuleId}`;

const caseName = (testCase: TestCase): string =>
  `${moduleName(testCase.module)} > ${testCase.fullName}`;

export default class StallReporter implements Reporter {
  readonly #modules = new Map<TestModule, number>();
  readonly #cases = new Map<TestCase, number>();
  readonly #progress: WriteStream | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor() {
    const file = process.env.GRASP_TEST_PROGRESS_FILE;
    this.#progress =
      file === undefined || file === ""
        ? undefined
        : createWriteStream(file, { flags: "a" });
  }

  onTestRunStart(): void {
    const minutes = positiveFromEnv("GRASP_STALL_REPORT_AFTER_MINUTES");
    if (minutes === undefined) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#report(minutes);
    }, minutes * minuteMs);
    // A run that ends in time doesn't wait for the report.
    this.#timer.unref();
  }

  onTestModuleStart(testModule: TestModule): void {
    this.#modules.set(testModule, Date.now());
  }

  onTestModuleEnd(testModule: TestModule): void {
    this.#modules.delete(testModule);
  }

  onTestCaseReady(testCase: TestCase): void {
    this.#cases.set(testCase, Date.now());
  }

  onTestCaseResult(testCase: TestCase): void {
    const started = this.#cases.get(testCase);
    this.#cases.delete(testCase);
    const took = started === undefined ? "" : ` ${Date.now() - started}ms`;
    this.#progress?.write(
      `${new Date().toISOString()} ${testCase.result().state}${took} ${caseName(testCase)}\n`
    );
  }

  onTestRunEnd(): void {
    clearTimeout(this.#timer);
    this.#progress?.end();
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
    process.stdout.write(lines.join("\n"));
  }
}
