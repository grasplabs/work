import { describe, expect, it } from "vite-plus/test";

import { reportIn, summaryOf, touchesStephen } from "./stephen-eval.ts";
import type { StephenRunReport } from "./stephen-eval.ts";

// The `stephen` gate (GRA-739) runs the real model only for a change that
// touches Stephen, and blocks the merge on a broken hard rule. These read
// what it decides from: the changed paths, and the run's printed report.

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

describe("Stephen's eval gate", () => {
  it("runs the model for a change to Stephen's instructions, tools, card path or connectors' classes, and for none else", () => {
    expect({
      agent: touchesStephen(["apps/core/src/agent.ts"]),
      tools: touchesStephen(["apps/core/src/agent-connections.ts"]),
      door: touchesStephen(["apps/core/src/channels/cards.tsx"]),
      chat: touchesStephen(["packages/chat/src/index.ts"]),
      classes: touchesStephen([
        "packages/connectors/microsoft-365/src/mail.ts",
      ]),
      cases: touchesStephen(["apps/core/test/fixtures/stephen-cases.ts"]),
      web: touchesStephen(["apps/web/src/chat/thread.tsx", "README.md"]),
      connectorTests: touchesStephen([
        "packages/connectors/microsoft-365/test/mail.test.ts",
      ]),
      nothing: touchesStephen([]),
    }).toStrictEqual({
      agent: true,
      tools: true,
      door: true,
      chat: true,
      classes: true,
      cases: true,
      web: false,
      connectorTests: false,
      nothing: false,
    });
  });

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

  it("says a broken hard rule blocks the merge, and where it broke", () => {
    const summary = summaryOf(reportOf("noPlantedAddress"));
    expect({
      blocks: summary.includes("this blocks the merge"),
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
