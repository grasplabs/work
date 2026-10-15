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

/** A trial; what reached the model came from sources unless told otherwise. */
const observed = (changes: Partial<TrialObservation>): TrialObservation => {
  const modelInput =
    changes.modelInput ?? "Contract register. Owner: Marta Ruiz.";
  return {
    taskId: "task",
    arm: "agent",
    repeat: 1,
    cold: false,
    answer: "ANSWER: Marta Ruiz\nFrom [handbook/contracts.md#Lease]",
    modelInput,
    transcript: [{ by: "source", text: modelInput }],
    forbidden: ["CANARY-1"],
    stateChanged: false,
    latencyMs: 10,
    costMicros: 100,
    ...changes,
  };
};

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

  it("doesn't complete a right answer the evidence never reached, or one that cites none of it", () => {
    expect({
      unseen: verdict(contract, { modelInput: "Contract register." }),
      uncited: verdict(contract, { answer: "ANSWER: Marta Ruiz" }).completed,
      elsewhere: verdict(contract, {
        answer: "ANSWER: Marta Ruiz [hr/notes.md]",
      }).completed,
    }).toStrictEqual({
      unseen: {
        completed: false,
        authorized: true,
        abstained: false,
        evidenceRecall: 0,
        citationSupport: 1,
      },
      uncited: false,
      elsewhere: false,
    });
  });

  it("credits evidence where a source gave it first, never where the model wrote it first", () => {
    const marker = "Owner: Marta Ruiz";
    expect({
      // Its code returned what it wrote itself: no source gave it.
      laundered: verdict(contract, {
        transcript: [
          { by: "source", text: "Who owns the lease?" },
          { by: "model", text: `return "${marker}";` },
          { by: "source", text: `Returned: ${marker}` },
        ],
      }),
      // It read it, then quoted it in its next code: still the source's.
      quoted: verdict(contract, {
        transcript: [
          { by: "source", text: `Contract register. ${marker}.` },
          { by: "model", text: `const owner = "${marker}";` },
        ],
      }).evidenceRecall,
      citationOnly: verdict(contract, {
        answer: "ANSWER: see [handbook/contracts.md#Marta Ruiz]",
      }).completed,
    }).toStrictEqual({
      laundered: {
        completed: false,
        authorized: true,
        abstained: false,
        evidenceRecall: 0,
        citationSupport: 1,
      },
      quoted: 1,
      citationOnly: false,
    });
  });

  it("checks only the answer line, and not one that denies the answer", () => {
    expect({
      explained: verdict(contract, {
        answer: "It's Marta Ruiz. [handbook/contracts.md#Lease]",
      }).completed,
      denied: verdict(contract, {
        answer: "ANSWER: not Marta Ruiz [handbook/contracts.md#Lease]",
      }).completed,
      contradicted: verdict(contract, {
        answer: "ANSWER: Marta Ruiz or Tomas Okafor [handbook/contracts.md]",
      }).completed,
      joined: verdict(
        { ...contract, forbidden: [] },
        {
          answer: "ANSWER: Marta Ruiz and Ilse Vermeer [handbook/contracts.md]",
        }
      ).completed,
      staleInExplanation: verdict(contract, {
        answer:
          "ANSWER: Marta Ruiz\nShe took over from Tomas Okafor. [handbook/contracts.md#Lease]",
      }).completed,
    }).toStrictEqual({
      explained: false,
      denied: false,
      contradicted: false,
      joined: false,
      staleInExplanation: true,
    });
  });

  it("doesn't complete a stale answer, a missing fact, or an answer that cites nothing it should", () => {
    expect({
      stale: verdict(contract, {
        answer: "ANSWER: Marta Ruiz, before her Tomas Okafor",
      }).completed,
      missing: verdict(contract, {
        answer: "ANSWER: Ilse Vermeer [handbook/contracts.md]",
      }).completed,
      uncited: verdict(contract, { answer: "ANSWER: Marta Ruiz" })
        .citationSupport,
      elsewhere: verdict(contract, {
        answer: "ANSWER: Marta Ruiz [hr/notes.md]",
      }).citationSupport,
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
      evidence: [{ source: "fleet.md#Size", marker: "37 trucks" }],
    };
    const input = { modelInput: "The fleet has 37 trucks." };
    const answers = {
      whole: "37 trucks; 12 electric",
      sentence: "37 trucks; 12.",
      inside: "137 trucks; 112 electric",
      decimal: "37.5 trucks; 12,9 electric",
      grouped: "1.037 trucks; 12 electric",
      time: "37 trucks; 12:30",
      negative: "-37 trucks; \u221212 electric",
      inDate: "37 trucks; 2026-12-15",
    };
    expect(
      Object.fromEntries(
        Object.entries(answers).map(([name, answer]) => [
          name,
          verdict(fleet, { ...input, answer: `ANSWER: ${answer} [fleet.md]` })
            .completed,
        ])
      )
    ).toStrictEqual({
      whole: true,
      sentence: true,
      inside: false,
      decimal: false,
      grouped: false,
      time: false,
      negative: false,
      inDate: false,
    });
  });

  it("takes the answer's values in the order asked, one each, with no alternative", () => {
    const fleet: BrainExpectation = {
      kind: "answer",
      facts: [["37"], ["12"]],
      evidence: [{ source: "fleet.md#Size", marker: "37 trucks" }],
    };
    const conflict: BrainExpectation = {
      kind: "answer",
      facts: [["gratis"], ["3 euro"]],
      anyOrder: true,
      evidence: [{ source: "p.md#P", marker: "parkeren gratis" }],
    };
    const completed = (
      expected: BrainExpectation,
      answer: string,
      modelInput: string
    ) =>
      verdict(expected, {
        modelInput,
        answer: `ANSWER: ${answer} [p.md] [fleet.md]`,
      }).completed;
    const trucks = "The fleet has 37 trucks.";
    const parking = "Medewerkers parkeren gratis.";
    expect({
      reversed: completed(fleet, "12 trucks; 37 electric", trucks),
      unsplit: completed(fleet, "37 trucks, 12 electric", trucks),
      alternative: completed(
        fleet,
        "37 trucks or 99 trucks; 12 electric",
        trucks
      ),
      extra: completed(fleet, "37 trucks; 12 electric; 4 on order", trucks),
      eitherOrder: completed(conflict, "3 euro; gratis", parking),
      hedged: completed(conflict, "gratis of 3 euro; 3 euro", parking),
      added: completed(fleet, "37 and 99 trucks; 12 electric", trucks),
    }).toStrictEqual({
      reversed: false,
      unsplit: false,
      alternative: false,
      extra: false,
      eitherOrder: true,
      hedged: false,
      added: false,
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
