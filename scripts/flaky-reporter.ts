// Names every test that passed only when tried again (`vp test --retry` in
// CI): as a warning annotation on its file and in the step's summary
// (GITHUB_STEP_SUMMARY). A retry keeps a flaky test from costing a whole
// re-run of CI, which took a sixth of all pull request runs (October 2026,
// GRA-1094); this keeps the flake in sight, so it is fixed rather than
// retried for ever.
import { appendFile } from "node:fs/promises";

import type { Reporter } from "vite-plus/test/node";

/** What the reporter reads of a test: Vitest's `TestCase` has it. */
export interface RetriedCase {
  readonly fullName: string;
  readonly module: {
    readonly moduleId: string;
    readonly relativeModuleId: string;
    readonly project: { readonly name: string };
  };
  diagnostic: () =>
    | { readonly flaky: boolean; readonly retryCount: number }
    | undefined;
}

/** A test that passed only when tried again. */
export interface Flake {
  readonly project: string;
  readonly file: string;
  readonly path: string;
  readonly name: string;
  readonly retries: number;
}

/** `testCase` as a flake, if it passed only when tried again. */
export const flakeOf = (testCase: RetriedCase): Flake | undefined => {
  const diagnostic = testCase.diagnostic();
  if (diagnostic?.flaky !== true) {
    return undefined;
  }
  return {
    project: testCase.module.project.name,
    file: testCase.module.relativeModuleId,
    path: testCase.module.moduleId,
    name: testCase.fullName,
    retries: diagnostic.retryCount,
  };
};

/** GitHub's workflow commands end at a newline and read `%` as an escape. */
const escapeData = (text: string): string =>
  text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

/** A warning annotation on the flake's file, for the checks page. */
export const annotationOf = (flake: Flake, root: string): string => {
  const file = flake.path.startsWith(`${root}/`)
    ? flake.path.slice(root.length + 1)
    : flake.path;
  const tries = flake.retries === 1 ? "once" : `${flake.retries} times`;
  return `::warning file=${escapeData(file)},title=Flaky test::${escapeData(
    `[${flake.project}] ${flake.name} passed only when tried again (${tries}). Fix it: a retry hides it.`
  )}\n`;
};

/** The step summary's list of flakes, or nothing when there were none. */
export const summaryOf = (flakes: readonly Flake[]): string => {
  if (flakes.length === 0) {
    return "";
  }
  const rows = flakes.map(
    (flake) =>
      `| ${flake.project} | ${flake.file} | ${flake.name.replaceAll("|", "\\|")} | ${flake.retries} |`
  );
  return [
    `### ${flakes.length} flaky ${flakes.length === 1 ? "test" : "tests"}`,
    "",
    "Passed only when tried again. Fix them: a retry hides them.",
    "",
    "| Project | File | Test | Retries |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
};

export default class FlakyReporter implements Reporter {
  readonly #flakes: Flake[] = [];

  onTestCaseResult(testCase: RetriedCase): void {
    const flake = flakeOf(testCase);
    if (flake !== undefined) {
      this.#flakes.push(flake);
    }
  }

  async onTestRunEnd(): Promise<void> {
    const root = process.cwd();
    for (const flake of this.#flakes) {
      process.stdout.write(annotationOf(flake, root));
    }
    const summaryFile = process.env.GITHUB_STEP_SUMMARY;
    if (summaryFile !== undefined && summaryFile !== "") {
      await appendFile(summaryFile, summaryOf(this.#flakes));
    }
  }
}
