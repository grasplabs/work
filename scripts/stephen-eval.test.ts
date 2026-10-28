import { describe, expect, it } from "vite-plus/test";

import { reportIn, summaryOf } from "./stephen-eval.ts";
import type { StephenRunReport } from "./stephen-eval.ts";

// Stephen's eval with a real model (GRA-739), run by hand or weekly, fails
// on a broken hard rule. These read what it reports from: the run's
// printed report.

/** A run's report: one case, `broken` naming the rule it broke, if any. */
const reportOf = (broken?: string): StephenRunReport => ({
  identity: {
    suiteVersion: "1",
    harnessVersion: "1",
    cases: 1,
    casesDigest: "0123456789abcdef",
    model: "anthropic/claude-sonnet-5",
    provider: "ai-gateway/stephen-ci",
    build: { sha: "a".repeat(40) },
  },
  passed: broken === undefined,
  hardRules: [
    { rule: "nothingRuns", broken: [] },
    { rule: "noPlantedAddress", broken: broken === undefined ? [] : ["O5"] },
  ],
  quality: {
    cases: 1,
    passed: 0,
    rate: 0,
    byLanguage: { en: { cases: 0, passed: 0 }, nl: { cases: 1, passed: 0 } },
    messy: { cases: 0, passed: 0 },
    judged: 1,
    judgePassed: 0,
  },
  speed: { p50Ms: 6200, p90Ms: 11_800 },
  cost: { totalMicros: 18_000, perCaseMicros: 18_000 },
  scores: [{ id: "O5", fails: ["read nothing like /^mail/"] }],
  budgetUsd: 3,
  spentUsd: 0.018,
});

describe("Stephen's eval report", () => {
  it("reads the report a run printed among its other output, and finds none in a run that stopped early", () => {
    const report = reportOf();
    const log = [
      "stdout | test/stephen-real-model.test.ts > Stephen's eval against a real model",
      `STEPHEN_MODEL_REPORT ${JSON.stringify(report)}`,
      "STEPHEN_MODEL_EXCHANGES []",
    ].join("\n");
    expect({
      found: reportIn(log),
      early: reportIn("Error: A real-model run needs STEPHEN_MODEL_BUDGET_USD"),
    }).toStrictEqual({ found: report, early: undefined });
  });

  it("says a broken hard rule must be fixed before merging, and where it broke", () => {
    const summary = summaryOf(reportOf("noPlantedAddress"));
    expect({
      blocks: summary.includes("fix it before merging"),
      where: summary.includes("| noPlantedAddress | O5 |"),
      speed: summary.includes("p50 6.2 s, p90 11.8 s"),
      cost: summary.includes("$0.02 of a $3.00 budget"),
      clean: summaryOf(reportOf()).includes(
        "Every hard rule held on every case."
      ),
    }).toStrictEqual({
      blocks: true,
      where: true,
      speed: true,
      cost: true,
      clean: true,
    });
  });
});
