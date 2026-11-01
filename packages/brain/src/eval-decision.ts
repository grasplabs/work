import { z } from "zod";

import { knowledgeErrors } from "./knowledge.ts";

// A learning suite's decision policy (GRA-311, L3; the Brain design's
// "Bounded search and publication"): what a candidate must show against
// the pinned baseline before it may be published, proposed with the suite
// version by its designer, accepted with it by its owner, and frozen with
// it. An observed average gain alone never
// permits publication:
//
// - every hard security gate passes on every trial: it counts as many
//   trials as the candidate ran, each one passed;
// - every family the suite measures has enough samples, or the verdict
//   names it as not covered;
// - each family is the same share of the trials on both sides, so the
//   overall rates weigh the families alike and only a family's own rate
//   moves the gain, never running more of its easy tasks;
// - no family falls further below the baseline than its regression floor,
//   a family's own floor only ever tighter than the policy's;
// - cost and latency stay under their ceilings;
// - the gain's lower bound, at the owner's confidence, reaches the
//   minimum meaningful gain.
//
// Scores are success rates in [0, 1]; the bound on their difference is
// Newcombe's hybrid score interval, from Wilson intervals of each side, so
// it stays honest at rates of 0 or 1 and at small samples. A comparison is
// checked first: counts are whole and never more successes than trials,
// numbers finite; every ceiling holds closed, so a value that isn't a
// number never passes; and a family the suite doesn't hold holds the
// verdict rather than counting toward its gain. More generated
// cases or more judge calls don't make a verdict correct: it says what
// it couldn't measure, and grader disagreement holds it.

/** One-sided z for the confidences an owner may choose. */
const zOf = {
  "0.8": 0.8416,
  "0.9": 1.2816,
  "0.95": 1.6449,
  "0.975": 1.96,
  "0.99": 2.3263,
} as const;

const rate = z.number().min(0).max(1);

/** The fewest trials per side and family any policy may ask for. */
export const leastSamples = 30;

export const decisionPolicySchema = z
  .strictObject({
    /** Least improvement of the overall success rate worth publishing. */
    minimumGain: rate,
    /** The confidence of the gain's lower bound. */
    confidence: z.enum(["0.8", "0.9", "0.95", "0.975", "0.99"]),
    /**
     * Fewest trials a family needs, on each side, to be measured: never
     * fewer than `leastSamples`, below which no interval says much.
     */
    minimumSamples: z.int().min(leastSamples).max(100_000),
    /** Largest drop below the baseline any family may show. */
    regressionFloor: rate,
    /** Tighter floors for some families, by name: never looser. */
    familyFloors: z.record(z.string().min(1).max(100), rate).default({}),
    /** Most a trial may cost on average, in the host's currency units. */
    costCeiling: z.number().min(0),
    /** Most a trial may take at the 95th percentile, in milliseconds. */
    latencyCeilingMs: z.int().min(0),
    /** Checks every trial must pass: a single failure holds publication. */
    securityGates: z.array(z.string().min(1).max(200)).max(100),
    /** Least agreement of the grader with the owner's labels (L4). */
    minimumGraderAgreement: rate,
  })
  .refine(
    ({ familyFloors, regressionFloor }) =>
      Object.values(familyFloors).every((floor) => floor <= regressionFloor),
    { message: "A family's floor is never looser than the policy's" }
  );
export type DecisionPolicy = z.output<typeof decisionPolicySchema>;
export type DecisionPolicyInput = z.input<typeof decisionPolicySchema>;

/** One side of a family's comparison: successes out of trials. */
const measuredSchema = z
  .strictObject({
    successes: z.int().min(0),
    trials: z.int().min(0),
  })
  .refine(({ successes, trials }) => successes <= trials, {
    message: "No more successes than trials",
  });
type Measured = z.output<typeof measuredSchema>;

/** What a bounded search measured of a candidate against the baseline. */
export const comparisonSchema = z.strictObject({
  families: z.record(
    z.string().min(1).max(100),
    z.strictObject({ baseline: measuredSchema, candidate: measuredSchema })
  ),
  /** Each security gate's passes out of trials. */
  gates: z.record(z.string().min(1).max(200), measuredSchema),
  /** The candidate's average cost per trial. */
  costPerTrial: z.number().min(0),
  /** The candidate's 95th-percentile latency, in milliseconds. */
  latencyP95Ms: z.number().min(0),
  /** The grader's agreement with the owner's labels, from calibration. */
  graderAgreement: rate,
});
export type Comparison = z.input<typeof comparisonSchema>;

/** Why a candidate may not be published, each a stable code. */
export type HoldReason =
  | "unknown_family"
  | "security_gate"
  | "not_covered"
  | "family_mix"
  | "regression"
  | "cost"
  | "latency"
  | "grader_disagreement"
  | "gain_uncertain";

/** What the policy decides of a comparison, and why. */
export interface Verdict {
  publish: boolean;
  reasons: HoldReason[];
  /** The overall success rates and the gain's lower bound. */
  baselineRate: number;
  candidateRate: number;
  gainLowerBound: number;
  /** Families the suite holds that weren't measured enough, or at all. */
  notCovered: string[];
  /** Families that fell below their floor. */
  regressed: string[];
  /** Gates that failed at least once. */
  failedGates: string[];
}

const rateOf = ({ successes, trials }: Measured): number =>
  trials === 0 ? 0 : successes / trials;

/** The Wilson score interval of `measured`'s rate, at `z`. */
const wilson = ({ successes, trials }: Measured, zScore: number) => {
  if (trials === 0) {
    return { low: 0, high: 1 };
  }
  const rateOfTrials = successes / trials;
  const z2 = zScore * zScore;
  const centre = (rateOfTrials + z2 / (2 * trials)) / (1 + z2 / trials);
  const half =
    (zScore / (1 + z2 / trials)) *
    Math.sqrt(
      (rateOfTrials * (1 - rateOfTrials)) / trials + z2 / (4 * trials * trials)
    );
  return { low: centre - half, high: centre + half };
};

/**
 * The lower bound of the candidate's gain over the baseline: Newcombe's
 * hybrid score interval (method 10), one-sided at `z`.
 */
const gainLowerBoundOf = (
  baseline: Measured,
  candidate: Measured,
  zScore: number
): number => {
  if (baseline.trials === 0 || candidate.trials === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  const rateBaseline = rateOf(baseline);
  const rateCandidate = rateOf(candidate);
  const candidateLow = wilson(candidate, zScore).low;
  const baselineHigh = wilson(baseline, zScore).high;
  return (
    rateCandidate -
    rateBaseline -
    Math.hypot(rateCandidate - candidateLow, baselineHigh - rateBaseline)
  );
};

/**
 * The verdict of `policy` on `input`, a comparison, for a suite measuring
 * `families`, which only the version itself gives (eval-suites.ts
 * `decideVersion`; this module isn't exported from the package, so no
 * host passes families of its own):
 * publish only when nothing holds it. A comparison that isn't one, or no
 * families, is refused (`knowledge.invalid`).
 */
export const decide = (
  policy: DecisionPolicy,
  input: unknown,
  families: readonly string[]
): Verdict => {
  const comparison = knowledgeErrors.parse(
    "knowledge.invalid",
    comparisonSchema,
    input
  );
  if (families.length === 0) {
    throw knowledgeErrors.create("knowledge.invalid");
  }
  const reasons = new Set<HoldReason>();
  const held = new Set(families);
  if (Object.keys(comparison.families).some((family) => !held.has(family))) {
    reasons.add("unknown_family");
  }
  const total = (side: "baseline" | "candidate"): Measured => {
    let successes = 0;
    let trials = 0;
    // Only the suite's families count toward the gain.
    for (const family of families) {
      const measured = comparison.families[family];
      if (measured !== undefined) {
        successes += measured[side].successes;
        trials += measured[side].trials;
      }
    }
    return { successes, trials };
  };
  const baseline = total("baseline");
  const candidate = total("candidate");
  // A gate passes only on every one of the candidate's trials: fewer
  // counted leaves trials it never checked.
  const failedGates = policy.securityGates.filter((gate) => {
    const measured = comparison.gates[gate];
    return (
      measured === undefined ||
      measured.trials === 0 ||
      measured.trials !== candidate.trials ||
      measured.successes < measured.trials
    );
  });
  if (failedGates.length > 0) {
    reasons.add("security_gate");
  }
  const notCovered = families.filter((family) => {
    const measured = comparison.families[family];
    return (
      measured === undefined ||
      measured.baseline.trials < policy.minimumSamples ||
      measured.candidate.trials < policy.minimumSamples
    );
  });
  if (notCovered.length > 0) {
    reasons.add("not_covered");
  }
  // Each family's share of the trials, the same on both sides, compared
  // exactly as whole numbers: b/B = c/C as b·C = c·B.
  const mixed = families.some((family) => {
    const measured = comparison.families[family];
    return (
      measured !== undefined &&
      BigInt(measured.baseline.trials) * BigInt(candidate.trials) !==
        BigInt(measured.candidate.trials) * BigInt(baseline.trials)
    );
  });
  if (mixed) {
    reasons.add("family_mix");
  }
  const regressed = families.filter((family) => {
    const measured = comparison.families[family];
    if (measured === undefined) {
      return false;
    }
    // A family's floor only tightens the policy's.
    const floor = Math.min(
      policy.familyFloors[family] ?? policy.regressionFloor,
      policy.regressionFloor
    );
    return rateOf(measured.baseline) - rateOf(measured.candidate) > floor;
  });
  if (regressed.length > 0) {
    reasons.add("regression");
  }
  // Closed: a value that isn't under its ceiling, NaN included, holds.
  if (!(comparison.costPerTrial <= policy.costCeiling)) {
    reasons.add("cost");
  }
  if (!(comparison.latencyP95Ms <= policy.latencyCeilingMs)) {
    reasons.add("latency");
  }
  if (!(comparison.graderAgreement >= policy.minimumGraderAgreement)) {
    reasons.add("grader_disagreement");
  }
  const baselineRate = rateOf(baseline);
  const candidateRate = rateOf(candidate);
  const gainLowerBound = gainLowerBoundOf(
    baseline,
    candidate,
    zOf[policy.confidence]
  );
  if (!(gainLowerBound >= policy.minimumGain)) {
    reasons.add("gain_uncertain");
  }
  return {
    publish: reasons.size === 0,
    reasons: [...reasons],
    baselineRate,
    candidateRate,
    gainLowerBound,
    notCovered,
    regressed,
    failedGates,
  };
};
