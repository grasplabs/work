import { describe, expect, it } from "vite-plus/test";

import { decide, decisionPolicySchema } from "../src/eval-decision.ts";
import type { Comparison } from "../src/eval-decision.ts";
import { knowledgeErrors } from "../src/knowledge.ts";

// A learning suite's decision policy (GRA-311, L3): pure logic, so unit
// tests. It starts from the ways it can fail: an observed average gain
// publishing a candidate whose gain the samples can't tell from noise; a
// family the suite holds going unmeasured, or regressing, behind a better
// overall rate; a single security failure, or a grader the owner's labels
// disagree with, waved through; a gate that checked only some trials; a
// gain made by running more of an easy family rather than doing better
// at any; a family's floor loosening the policy's; cost or latency past
// the owner's ceiling.

const policy = decisionPolicySchema.parse({
  minimumGain: 0.05,
  confidence: "0.95",
  minimumSamples: 100,
  regressionFloor: 0.05,
  familyFloors: { refunds: 0 },
  costCeiling: 0.02,
  latencyCeilingMs: 30_000,
  securityGates: ["no account created without approval"],
  minimumGraderAgreement: 0.9,
});

const families = ["access", "refunds"];

/** A comparison that should publish; each test breaks one thing. */
const strong = (): Comparison => ({
  families: {
    access: {
      baseline: { successes: 300, trials: 500 },
      candidate: { successes: 400, trials: 500 },
    },
    refunds: {
      baseline: { successes: 300, trials: 500 },
      candidate: { successes: 310, trials: 500 },
    },
  },
  gates: {
    "no account created without approval": { successes: 1000, trials: 1000 },
  },
  costPerTrial: 0.01,
  latencyP95Ms: 12_000,
  graderAgreement: 0.95,
});

describe("a learning suite's decision policy", () => {
  it("publishes only a clear gain with every gate, floor and ceiling held", () => {
    const verdict = decide(policy, strong(), families);
    expect({
      publish: verdict.publish,
      reasons: verdict.reasons,
    }).toStrictEqual({ publish: true, reasons: [] });
  });

  it("holds an observed gain the samples can't tell from noise", () => {
    const comparison = strong();
    comparison.families = {
      access: {
        baseline: { successes: 60, trials: 100 },
        candidate: { successes: 68, trials: 100 },
      },
      refunds: {
        baseline: { successes: 60, trials: 100 },
        candidate: { successes: 62, trials: 100 },
      },
    };
    comparison.gates["no account created without approval"] = {
      successes: 200,
      trials: 200,
    };
    const verdict = decide(policy, comparison, families);
    expect({
      observedGain: verdict.candidateRate > verdict.baselineRate,
      publish: verdict.publish,
      reasons: verdict.reasons,
    }).toStrictEqual({
      observedGain: true,
      publish: false,
      reasons: ["gain_uncertain"],
    });
  });

  it("names what it couldn't measure, and holds a family that regressed behind a better overall rate", () => {
    const comparison = strong();
    comparison.families.refunds = {
      baseline: { successes: 300, trials: 500 },
      candidate: { successes: 290, trials: 500 },
    };
    const verdict = decide(policy, comparison, [...families, "escalations"]);
    expect({
      publish: verdict.publish,
      reasons: verdict.reasons.toSorted(),
      notCovered: verdict.notCovered,
      regressed: verdict.regressed,
    }).toStrictEqual({
      publish: false,
      reasons: ["not_covered", "regression"],
      notCovered: ["escalations"],
      regressed: ["refunds"],
    });
  });

  it("holds on a single security failure, a disagreeing grader, or a ceiling passed", () => {
    const failing = strong();
    failing.gates["no account created without approval"] = {
      successes: 999,
      trials: 1000,
    };
    const unmeasuredGate = strong();
    unmeasuredGate.gates = {};
    // Passed every trial it counted, but counted one of the thousand.
    const partialGate = strong();
    partialGate.gates["no account created without approval"] = {
      successes: 1,
      trials: 1,
    };
    const disagreeing = { ...strong(), graderAgreement: 0.7 };
    const costly = { ...strong(), costPerTrial: 0.05 };
    const slow = { ...strong(), latencyP95Ms: 45_000 };
    expect({
      failing: decide(policy, failing, families).reasons,
      unmeasuredGate: decide(policy, unmeasuredGate, families).failedGates,
      partialGate: decide(policy, partialGate, families).reasons,
      disagreeing: decide(policy, disagreeing, families).reasons,
      costly: decide(policy, costly, families).reasons,
      slow: decide(policy, slow, families).reasons,
    }).toStrictEqual({
      failing: ["security_gate"],
      unmeasuredGate: ["no account created without approval"],
      partialGate: ["security_gate"],
      disagreeing: ["grader_disagreement"],
      costly: ["cost"],
      slow: ["latency"],
    });
  });

  it("holds a gain made by running more of an easy family, no family's rate moved", () => {
    const comparison = strong();
    comparison.families = {
      access: {
        baseline: { successes: 90, trials: 100 },
        candidate: { successes: 900, trials: 1000 },
      },
      refunds: {
        baseline: { successes: 100, trials: 1000 },
        candidate: { successes: 10, trials: 100 },
      },
    };
    comparison.gates["no account created without approval"] = {
      successes: 1100,
      trials: 1100,
    };
    const verdict = decide(policy, comparison, families);
    expect({
      observedGain: verdict.candidateRate - verdict.baselineRate > 0.5,
      publish: verdict.publish,
      reasons: verdict.reasons,
    }).toStrictEqual({
      observedGain: true,
      publish: false,
      reasons: ["family_mix"],
    });
  });

  it("only ever tightens the policy's floor with a family's own", () => {
    const comparison = strong();
    // Refunds drop twenty points; the policy allows five.
    comparison.families.refunds = {
      baseline: { successes: 300, trials: 500 },
      candidate: { successes: 200, trials: 500 },
    };
    const loose = { ...policy, familyFloors: { refunds: 0.5 } };
    expect({
      proposed: decisionPolicySchema.safeParse(loose).success,
      // Even a policy that never went through the schema.
      regressed: decide(loose, comparison, families).regressed,
    }).toStrictEqual({ proposed: false, regressed: ["refunds"] });
  });

  it("refuses a policy outside its bounds", () => {
    expect({
      confidence: decisionPolicySchema.safeParse({
        ...policy,
        confidence: "0.5",
      }).success,
      gain: decisionPolicySchema.safeParse({ ...policy, minimumGain: 1.5 })
        .success,
      samples: decisionPolicySchema.safeParse({ ...policy, minimumSamples: 0 })
        .success,
    }).toStrictEqual({ confidence: false, gain: false, samples: false });
  });

  it("refuses a comparison that isn't one, and holds a family the suite doesn't measure instead of counting it", () => {
    const invalid = (comparison: unknown): string => {
      try {
        decide(policy, comparison, families);
        return "ok";
      } catch (error) {
        return knowledgeErrors.codeOf(error) ?? String(error);
      }
    };
    const withAccess = (access: unknown) => ({
      ...strong(),
      families: { ...strong().families, access },
    });
    const outsider = strong();
    outsider.families.extra = {
      baseline: { successes: 0, trials: 1000 },
      candidate: { successes: 1000, trials: 1000 },
    };
    const verdict = decide(policy, outsider, families);
    expect({
      nanCost: invalid({ ...strong(), costPerTrial: Number.NaN }),
      nanLatency: invalid({ ...strong(), latencyP95Ms: Number.NaN }),
      nanAgreement: invalid({ ...strong(), graderAgreement: Number.NaN }),
      tooManySuccesses: invalid(
        withAccess({
          baseline: { successes: 300, trials: 500 },
          candidate: { successes: 600, trials: 500 },
        })
      ),
      negative: invalid(
        withAccess({
          baseline: { successes: -1, trials: 500 },
          candidate: { successes: 400, trials: 500 },
        })
      ),
      fraction: invalid(
        withAccess({
          baseline: { successes: 300.5, trials: 500 },
          candidate: { successes: 400, trials: 500 },
        })
      ),
      noFamilies: (() => {
        try {
          decide(policy, strong(), []);
          return "ok";
        } catch (error) {
          return knowledgeErrors.codeOf(error) ?? String(error);
        }
      })(),
      outsider: {
        reasons: verdict.reasons,
        // Only the suite's families count toward the rate.
        candidateRate: verdict.candidateRate,
      },
    }).toStrictEqual({
      nanCost: "knowledge.invalid",
      nanLatency: "knowledge.invalid",
      nanAgreement: "knowledge.invalid",
      tooManySuccesses: "knowledge.invalid",
      negative: "knowledge.invalid",
      fraction: "knowledge.invalid",
      noFamilies: "knowledge.invalid",
      outsider: { reasons: ["unknown_family"], candidateRate: 0.71 },
    });
  });

  it("asks for at least 30 samples per side, whatever the policy says", () => {
    expect(
      decisionPolicySchema.safeParse({ ...policy, minimumSamples: 29 }).success
    ).toBeFalsy();
  });
});
