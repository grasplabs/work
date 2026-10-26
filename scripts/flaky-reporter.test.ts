/**
 * How the flaky reporter (flaky-reporter.ts) names a test that passed
 * only when tried again: on the checks page and in the step's summary.
 */
import { describe, expect, it } from "vite-plus/test";

import { annotationOf, flakeOf, summaryOf } from "./flaky-reporter.ts";
import type { Flake, RetriedCase } from "./flaky-reporter.ts";

const testCase = (diagnostic?: {
  flaky: boolean;
  retryCount: number;
}): RetriedCase => ({
  fullName: "runs > settle once",
  module: {
    moduleId: "/repo/apps/core/test/runs.test.ts",
    relativeModuleId: "test/runs.test.ts",
    project: { name: "@grasp-os/core" },
  },
  diagnostic: () => diagnostic,
});

const flake: Flake = {
  project: "@grasp-os/core",
  file: "test/runs.test.ts",
  path: "/repo/apps/core/test/runs.test.ts",
  name: "runs > settle once",
  retries: 1,
};

describe("naming the tests that passed only when tried again", () => {
  it("names a test that failed, then passed when tried again", () => {
    expect(flakeOf(testCase({ flaky: true, retryCount: 1 }))).toStrictEqual(
      flake
    );
  });

  it("names neither a test that passed the first time nor one that never ran", () => {
    expect(flakeOf(testCase({ flaky: false, retryCount: 0 }))).toBeUndefined();
    expect(flakeOf(testCase())).toBeUndefined();
  });

  it("annotates the flake's file, from the repository's root", () => {
    expect(annotationOf(flake, "/repo")).toBe(
      "::warning file=apps/core/test/runs.test.ts,title=Flaky test::[@grasp-os/core] runs > settle once passed only when tried again (once). Fix it: a retry hides it.\n"
    );
  });

  it("keeps a test's name from ending the annotation or escaping out of it", () => {
    const annotation = annotationOf(
      { ...flake, name: "100% of runs\n::error::not mine", retries: 2 },
      "/repo"
    );

    expect(annotation).toContain(
      "100%25 of runs%0A::error::not mine passed only when tried again (2 times)"
    );
    expect(annotation.trimEnd()).not.toContain("\n");
  });

  it("lists the flakes in the summary, a test's `|` kept out of the table's columns", () => {
    expect(summaryOf([{ ...flake, name: "a | b" }])).toBe(
      [
        "### 1 flaky test",
        "",
        "Passed only when tried again. Fix them: a retry hides them.",
        "",
        "| Project | File | Test | Retries |",
        "| --- | --- | --- | --- |",
        String.raw`| @grasp-os/core | test/runs.test.ts | a \| b | 1 |`,
        "",
      ].join("\n")
    );
  });

  it("adds nothing to the summary when no test was flaky", () => {
    expect(summaryOf([])).toBe("");
  });
});
