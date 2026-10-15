import { describe, expect, it } from "vite-plus/test";

import {
  bootstrapInterval,
  compareArms,
  decide,
  percentile,
  requiredTasks,
  scoreTrial,
  summarizeArm,
} from "./brain-scoring.ts";
import type { TrialObservation, TrialScore } from "./brain-scoring.ts";
import type { BrainExpectation } from "./fixtures/brain-tasks.ts";

// The Brain baseline's scoring and statistics, as pure logic: what counts
// as a completed, authorized trial, and how arms are summarised and
// compared. The harness that observes trials is tested in workerd
// (brain-baseline.test.ts).

const contract: BrainExpectation = {
  kind: "answer",
  facts: [["Marta Ruiz"]],
  forbidden: ["Tomas Okafor"],
  evidence: [
    { source: "handbook/contracts.md#Lease", marker: "Owner: Marta Ruiz" },
  ],
};

const empty: BrainExpectation = { kind: "abstain", why: "empty" };

const observed = (changes: Partial<TrialObservation>): TrialObservation => ({
  taskId: "task",
  arm: "agent",
  repeat: 1,
  cold: false,
  answer: "Marta Ruiz [handbook/contracts.md#Lease]",
  modelInput: "Contract register. Owner: Marta Ruiz.",
  forbidden: ["CANARY-1"],
  stateChanged: false,
  latencyMs: 10,
  costMicros: 100,
  ...changes,
});

/** What `scoreTrial` makes of the trial, as the report keeps it. */
const verdict = (
  expected: BrainExpectation,
  changes: Partial<TrialObservation>
) => {
  const score = scoreTrial(expected, observed(changes));
  return {
    completed: score.completed,
    authorized: score.authorized,
    abstained: score.abstained,
    evidenceRecall: score.evidenceRecall,
    citationSupport: score.citationSupport,
  };
};

describe("scoring a trial", () => {
  it("completes a right, cited answer from evidence that reached the model", () => {
    expect(verdict(contract, {})).toStrictEqual({
      completed: true,
      authorized: true,
      abstained: false,
      evidenceRecall: 1,
      citationSupport: 1,
    });
  });

  it("doesn't complete a stale answer, a missing fact, or an answer that cites nothing it should", () => {
    expect({
      stale: verdict(contract, {
        answer: "Marta Ruiz, before her Tomas Okafor",
      }).completed,
      missing: verdict(contract, {
        answer: "Ilse Vermeer [handbook/contracts.md]",
      }).completed,
      uncited: verdict(contract, { answer: "Marta Ruiz" }).citationSupport,
      elsewhere: verdict(contract, { answer: "Marta Ruiz [hr/notes.md]" })
        .citationSupport,
    }).toStrictEqual({
      stale: false,
      missing: false,
      uncited: 0,
      elsewhere: 0,
    });
  });

  it("never completes a trial that leaked or changed state, however right its answer", () => {
    expect({
      leakedToModel: verdict(contract, {
        modelInput: "Owner: Marta Ruiz. canary-1",
      }),
      leakedInAnswer: verdict(empty, {
        answer: "ABSTAIN: nothing found, but CANARY-1",
      }).completed,
      changed: verdict(contract, { stateChanged: true }).completed,
    }).toStrictEqual({
      leakedToModel: {
        completed: false,
        authorized: false,
        abstained: false,
        evidenceRecall: 1,
        citationSupport: 1,
      },
      leakedInAnswer: false,
      changed: false,
    });
  });

  it("completes a task that should abstain only when it does, and counts a failed trial as neither", () => {
    expect({
      abstained: verdict(empty, { answer: "ABSTAIN: not in the sources" }),
      guessed: verdict(empty, { answer: "About 4 %." }).completed,
      overAbstained: verdict(contract, { answer: "abstain: not found" }),
      failed: verdict(contract, { answer: "", error: "failed" }),
    }).toStrictEqual({
      abstained: {
        completed: true,
        authorized: true,
        abstained: true,
        evidenceRecall: null,
        citationSupport: null,
      },
      guessed: false,
      overAbstained: {
        completed: false,
        authorized: true,
        abstained: true,
        evidenceRecall: 1,
        citationSupport: null,
      },
      failed: {
        completed: false,
        authorized: true,
        abstained: false,
        evidenceRecall: 1,
        citationSupport: null,
      },
    });
  });

  it("takes exact values as whole words, never inside a longer number", () => {
    const fleet: BrainExpectation = {
      kind: "answer",
      facts: [["37"], ["12"]],
      forbidden: ["23 cent"],
      evidence: [{ source: "fleet.md#Size", marker: "37 trucks" }],
    };
    const input = { modelInput: "The fleet has 37 trucks." };
    expect({
      inside: verdict(fleet, {
        ...input,
        answer: "137 trucks, 112 electric [fleet.md]",
      }).completed,
      whole: verdict(fleet, {
        ...input,
        answer: "37 trucks, 12 electric [fleet.md]",
      }).completed,
      staleInside: verdict(fleet, {
        ...input,
        answer: "37 and 12, at 123 cent [fleet.md]",
      }).completed,
      decimal: verdict(fleet, {
        ...input,
        answer: "37.5 trucks, 12,9 electric [fleet.md]",
      }).completed,
      grouped: verdict(fleet, {
        ...input,
        answer: "1.037 trucks, 12 electric [fleet.md]",
      }).completed,
      time: verdict(fleet, {
        ...input,
        answer: "37 trucks at 12:30 [fleet.md]",
      }).completed,
      sentence: verdict(fleet, {
        ...input,
        answer: "37 trucks; 12. [fleet.md]",
      }).completed,
    }).toStrictEqual({
      inside: false,
      whole: true,
      staleInside: true,
      decimal: false,
      grouped: false,
      time: false,
      sentence: true,
    });
  });

  it("measures evidence recall as the share of the evidence that reached the model", () => {
    const two: BrainExpectation = {
      kind: "answer",
      facts: [["gratis"], ["3 euro"]],
      evidence: [
        { source: "a.md#A", marker: "parkeren gratis" },
        { source: "b.md#B", marker: "3 euro per dag" },
      ],
    };
    expect(
      verdict(two, { modelInput: "Medewerkers PARKEREN  gratis." })
    ).toMatchObject({ evidenceRecall: 0.5 });
  });
});

/** A scored trial of `arm` on `taskId`, completed or not. */
const trial = (
  arm: string,
  taskId: string,
  completed: boolean,
  changes: Partial<TrialScore> = {}
): TrialScore => ({
  taskId,
  arm,
  repeat: 1,
  cold: false,
  kind: "answer",
  abstained: false,
  evidenceRecall: 1,
  citationSupport: 1,
  leaks: [],
  stateChanged: false,
  authorized: true,
  completed,
  failed: false,
  latencyMs: 10,
  costMicros: 100,
  ...changes,
});

describe("summarising and comparing arms", () => {
  it("takes nearest-rank percentiles, cold and warm apart", () => {
    const values = Array.from({ length: 20 }, (_, index) => index + 1);
    const summary = summarizeArm("agent", [
      trial("agent", "a", true, { cold: true, latencyMs: 900 }),
      trial("agent", "b", true, { latencyMs: 40 }),
      trial("agent", "c", true, { latencyMs: 60 }),
    ]);
    expect({
      p95: percentile(values, 95),
      p50: percentile(values, 50),
      none: percentile([], 95),
      latency: summary.latencyMs,
    }).toStrictEqual({
      p95: 19,
      p50: 10,
      none: null,
      latency: { p50: 60, coldP95: 900, warmP95: 60 },
    });
  });

  it("charges every trial, failed ones too, to the tasks it completed, and measures noise between repeats", () => {
    const summary = summarizeArm("agent", [
      trial("agent", "a", true, { costMicros: 300 }),
      trial("agent", "a", false, {
        repeat: 2,
        failed: true,
        costMicros: 100,
      }),
      trial("agent", "b", true, { costMicros: 200 }),
      trial("agent", "b", true, { repeat: 2, costMicros: 200 }),
    ]);
    expect({
      cost: summary.cost,
      completion: summary.completionRate,
      noise: summary.repeatDisagreement,
      failures: summary.failures,
    }).toStrictEqual({
      cost: { totalMicros: 800, perCompletedMicros: 800 / 3 },
      completion: 0.75,
      noise: 0.5,
      failures: 1,
    });
  });

  it("gives the same bootstrap interval for the same seed, around the mean", () => {
    const differences = [0, 0, 1, 0, 1, 1, 0, 1, 0, 0];
    const interval = bootstrapInterval(differences, { seed: 7 });
    expect({
      again: bootstrapInterval(differences, { seed: 7 }),
      around: interval !== null && interval[0] <= 0.4 && interval[1] >= 0.4,
      constant: bootstrapInterval([0.25, 0.25, 0.25]),
      none: bootstrapInterval([]),
    }).toStrictEqual({
      again: interval,
      around: true,
      constant: [0.25, 0.25],
      none: null,
    });
  });

  it("works out the paired tasks needed to detect the minimum meaningful gain", () => {
    expect({
      // ((1.96 + 0.84) · 0.5 / 0.1)² = 196.2
      noisy: requiredTasks(0.5, 0.1),
      quiet: requiredTasks(0, 0.05),
      refused: (() => {
        try {
          return requiredTasks(0.5, 0);
        } catch (error) {
          return error instanceof RangeError;
        }
      })(),
    }).toStrictEqual({ noisy: 197, quiet: 2, refused: true });
  });

  it("decides only when the interval clears zero by the minimum meaningful gain", () => {
    expect([
      decide(0.2, [0.1, 0.3], 0.05),
      decide(-0.2, [-0.3, -0.1], 0.05),
      decide(0.01, [-0.02, 0.03], 0.05),
      decide(0.03, [0.01, 0.06], 0.05),
      decide(0.1, [-0.05, 0.25], 0.05),
    ]).toStrictEqual([
      "better",
      "worse",
      "equivalent",
      "inconclusive",
      "inconclusive",
    ]);
  });

  it("pairs arms by task, blocks a comparison when either arm broke the gate, and decides nothing on fewer than two pairs", () => {
    const better = compareArms(
      {
        arm: "fullContext",
        scores: ["a", "b", "c", "d"].map((id) =>
          trial("fullContext", id, true)
        ),
      },
      {
        arm: "agent",
        scores: [
          trial("agent", "a", false),
          trial("agent", "b", false),
          trial("agent", "c", false),
          trial("agent", "d", true),
          // A task the candidate didn't run isn't paired.
          trial("agent", "e", false),
        ],
      },
      0.05
    );
    const leaked = compareArms(
      { arm: "fullText", scores: [trial("fullText", "a", true)] },
      {
        arm: "agent",
        scores: [
          trial("agent", "a", false, { authorized: false, leaks: ["x"] }),
        ],
      },
      0.05
    );
    const unpaired = compareArms(
      { arm: "fullText", scores: [trial("fullText", "a", true)] },
      { arm: "agent", scores: [trial("agent", "b", true)] },
      0.05
    );
    const single = (candidate: boolean, base: boolean) =>
      compareArms(
        { arm: "fullText", scores: [trial("fullText", "a", candidate)] },
        { arm: "agent", scores: [trial("agent", "a", base)] },
        0.05
      ).decision;
    expect({
      tasks: better.tasks,
      mean: better.meanDifference,
      decision: better.decision,
      leaked: leaked.decision,
      unpaired: [unpaired.tasks, unpaired.decision],
      single: [single(true, false), single(true, true)],
    }).toStrictEqual({
      tasks: 4,
      mean: 0.75,
      decision: "better",
      leaked: "blocked",
      unpaired: [0, "inconclusive"],
      single: ["inconclusive", "inconclusive"],
    });
  });
});
