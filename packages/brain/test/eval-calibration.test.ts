import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import type { Brain } from "../src/brain.ts";
import { brainErrors } from "../src/contract.ts";
import { brainEvalCalibrations } from "../src/db/schema.ts";
import {
  calibrateSuiteVersion,
  calibrationsOf,
  labelOutputs,
} from "../src/eval-calibration.ts";
import { proposeSuiteVersion, suiteVersion } from "../src/eval-suites.ts";
import { knowledgeErrors } from "../src/knowledge.ts";
import type { Caller } from "./host.ts";
import { testHost, writerOf } from "./host.ts";

// Calibrating a learning suite's grader (GRA-311, L4; the Brain design's
// "Grading and calibration"). It starts from the ways it can fail: a
// grader the owner's labels disagree with, or one that disagrees with
// itself, calibrating a suite all the same; a calibration passing on too
// little evidence, on duplicate labels, or on labels that aren't the
// owner's; provider errors counted as failed tasks, or hidden in a pass;
// the sealed final set used to calibrate; a run spending past the host's
// budget, or recording anything once it is refused.

const asDesigner = {
  userId: "designer",
  reads: [],
  evaluation: ["designer"],
} as const;
const asEvaluator = {
  userId: "evaluator",
  reads: [],
  evaluation: ["evaluator"],
} as const;
const asOwner = { userId: "owner", reads: [] } as const;
const evaluator = writerOf("evaluator");
const owner = writerOf("owner");

/** A refusal's code, or `ok`. */
const codeOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
    return "ok";
  } catch (error) {
    return (
      knowledgeErrors.codeOf(error) ??
      brainErrors.codeOf(error) ??
      String(error)
    );
  }
};

/** A case in `split`. */
const caseOf = (
  caseId: string,
  split: "development" | "validation" | "final"
) => ({
  caseId,
  split,
  family: `family-${caseId}`,
  group: caseId,
  source: `source-${caseId}`,
  input: { task: `Do ${caseId}` },
  expected: { answer: `answer for ${caseId}` },
});

/** A proposed suite of `brain`'s, owned by `owner`; its ID. */
const proposed = async (brain: Brain<Caller>): Promise<string> => {
  const suiteId = `suite-${crypto.randomUUID()}`;
  await proposeSuiteVersion(brain, asDesigner, writerOf("designer"), {
    suiteId,
    name: "Access requests",
    ownerId: "owner",
    cases: [
      caseOf("a", "development"),
      caseOf("b", "validation"),
      caseOf("c", "final"),
    ],
    grader: { version: "g1", requiredChecks: [], spec: {} },
    pins: {
      baseline: "skill@3",
      model: "workers-ai/test",
      environment: "sandbox@1",
      policy: "learning@1",
    },
    decision: {
      minimumGain: 0.05,
      confidence: "0.95",
      minimumSamples: 30,
      regressionFloor: 0.1,
      familyFloors: {},
      costCeiling: 1,
      latencyCeilingMs: 60_000,
      securityGates: [],
      minimumGraderAgreement: 0.8,
    },
  });
  return suiteId;
};

/**
 * `count` labels the owner would give: case a's expected outcome a pass,
 * and wrong answers fails; `flip` turns every verdict over.
 */
const labelsOf = (count: number, flip = false) => ({
  labels: Array.from({ length: count }, (_each, index) => {
    const right = index === 0;
    const verdict = right === flip ? ("fail" as const) : ("pass" as const);
    return {
      caseId: index % 2 === 0 ? "a" : "b",
      output: right ? { answer: "answer for a" } : { answer: `wrong ${index}` },
      verdict,
    };
  }),
});

/** `brain` with the host's judge replaced by `grade`. */
const judgedBy = (
  brain: Brain<Caller>,
  grade: NonNullable<NonNullable<Brain<Caller>["ports"]["evaluation"]>["grade"]>
): Brain<Caller> => ({
  ...brain,
  ports: {
    ...brain.ports,
    evaluation: {
      capabilities: async (caller) =>
        await Promise.resolve(caller.evaluation ?? []),
      grade,
    },
  },
});

/** Calibrates `suiteId`'s version 1 with `brain`'s judge, as its evaluator. */
const calibrated = async (brain: Brain<Caller>, suiteId: string) =>
  await calibrateSuiteVersion(brain, asEvaluator, evaluator, suiteId, 1, {
    repeats: 2,
  });

describe("calibrating a learning suite's grader", () => {
  it("calibrates a version whose grader agrees with enough of its owner's labels, every time", async () => {
    const { brain } = testHost();
    const suiteId = await proposed(brain);
    await labelOutputs(brain, asOwner, owner, suiteId, 1, labelsOf(30));
    const calibration = await calibrated(brain, suiteId);
    const version = await suiteVersion(brain, asEvaluator, suiteId, 1);
    const read = await calibrationsOf(brain, asOwner, owner, suiteId, 1);
    expect({
      calibration: {
        graded: calibration.graded,
        agreement: calibration.agreement,
        instability: calibration.instability,
        passed: calibration.passed,
      },
      state: version.state,
      ownerReads: read.map(({ passed }) => passed),
    }).toStrictEqual({
      calibration: { graded: 30, agreement: 1, instability: 0, passed: true },
      state: "calibrated",
      ownerReads: [true],
    });
  });

  it("holds a grader that disagrees with the owner or with itself, too little evidence, and too many errors", async () => {
    const { brain } = testHost();
    const disagreeing = await proposed(brain);
    await labelOutputs(
      brain,
      asOwner,
      owner,
      disagreeing,
      1,
      labelsOf(30, true)
    );
    const fromOwner = await calibrated(brain, disagreeing);
    const unstable = await proposed(brain);
    await labelOutputs(brain, asOwner, owner, unstable, 1, labelsOf(30));
    // Right by majority of three, but every second grading of an output
    // turned over: it agrees with the owner and not with itself.
    const seen = new Map<string, number>();
    const flipping = judgedBy(brain, async ({ expected, output }) => {
      const key = JSON.stringify(output);
      const attempt = (seen.get(key) ?? 0) + 1;
      seen.set(key, attempt);
      const right = JSON.stringify(expected) === JSON.stringify(output);
      return await Promise.resolve({
        verdict: (attempt === 2 ? !right : right)
          ? ("pass" as const)
          : ("fail" as const),
        cost: 0,
      });
    });
    const fromItself = await calibrateSuiteVersion(
      flipping,
      asEvaluator,
      evaluator,
      unstable,
      1,
      { repeats: 3 }
    );
    const thin = await proposed(brain);
    await labelOutputs(brain, asOwner, owner, thin, 1, labelsOf(29));
    const tooFew = await calibrated(brain, thin);
    const erring = await proposed(brain);
    await labelOutputs(brain, asOwner, owner, erring, 1, labelsOf(35));
    // Four outputs never grade: 8 of 70 gradings fail, over a tenth.
    const failing = new Set(["wrong 1", "wrong 2", "wrong 3", "wrong 4"]);
    const partly = judgedBy(brain, async ({ expected, output }) => {
      const answer =
        z.object({ answer: z.string() }).safeParse(output).data?.answer ?? "";
      if (failing.has(answer)) {
        throw new Error("provider timeout");
      }
      return await Promise.resolve({
        verdict:
          JSON.stringify(expected) === JSON.stringify(output)
            ? ("pass" as const)
            : ("fail" as const),
        cost: 0,
      });
    });
    const tooManyErrors = await calibrateSuiteVersion(
      partly,
      asEvaluator,
      evaluator,
      erring,
      1,
      { repeats: 2 }
    );
    expect({
      fromOwner: { agreement: fromOwner.agreement, passed: fromOwner.passed },
      fromItself: {
        agreement: fromItself.agreement,
        instability: fromItself.instability,
        passed: fromItself.passed,
      },
      tooFew: { graded: tooFew.graded, passed: tooFew.passed },
      tooManyErrors: {
        graded: tooManyErrors.graded,
        errors: tooManyErrors.errors,
        passed: tooManyErrors.passed,
      },
    }).toStrictEqual({
      fromOwner: { agreement: 0, passed: false },
      fromItself: { agreement: 1, instability: 1, passed: false },
      tooFew: { graded: 29, passed: false },
      tooManyErrors: { graded: 31, errors: 8, passed: false },
    });
  });

  it("takes labels from the owner alone, once per case and output, never of the sealed set, and stops at the budget recording nothing", async () => {
    const { brain } = testHost();
    const suiteId = await proposed(brain);
    const byEvaluator = await codeOf(
      labelOutputs(brain, asEvaluator, evaluator, suiteId, 1, labelsOf(30))
    );
    const byDesigner = await codeOf(
      labelOutputs(
        brain,
        asDesigner,
        writerOf("designer"),
        suiteId,
        1,
        labelsOf(30)
      )
    );
    const duplicate = await codeOf(
      labelOutputs(brain, asOwner, owner, suiteId, 1, {
        labels: [...labelsOf(2).labels, ...labelsOf(2).labels],
      })
    );
    const sealed = await codeOf(
      labelOutputs(brain, asOwner, owner, suiteId, 1, {
        labels: [
          { caseId: "c", output: { answer: "answer for c" }, verdict: "pass" },
        ],
      })
    );
    await labelOutputs(brain, asOwner, owner, suiteId, 1, labelsOf(30));
    const again = await codeOf(
      labelOutputs(brain, asOwner, owner, suiteId, 1, labelsOf(30))
    );
    const broke = judgedBy(brain, async () => {
      await Promise.resolve();
      throw brainErrors.create("brain.budget_exceeded");
    });
    const overBudget = await codeOf(
      calibrateSuiteVersion(broke, asEvaluator, evaluator, suiteId, 1, {
        repeats: 2,
      })
    );
    const recorded = await brain.db.select().from(brainEvalCalibrations);
    const calibratedByDesigner = await codeOf(
      calibrateSuiteVersion(
        brain,
        asDesigner,
        writerOf("designer"),
        suiteId,
        1,
        { repeats: 2 }
      )
    );
    const readByDesigner = await codeOf(
      calibrationsOf(brain, asDesigner, writerOf("designer"), suiteId, 1)
    );
    expect({
      byEvaluator,
      byDesigner,
      duplicate,
      sealed,
      again,
      overBudget,
      recorded: recorded.some((row) => row.suiteId === suiteId),
      calibratedByDesigner,
      readByDesigner,
    }).toStrictEqual({
      byEvaluator: "knowledge.not_found",
      byDesigner: "knowledge.not_found",
      duplicate: "knowledge.invalid",
      sealed: "knowledge.invalid",
      again: "knowledge.invalid",
      overBudget: "brain.budget_exceeded",
      recorded: false,
      calibratedByDesigner: "knowledge.not_found",
      readByDesigner: "knowledge.not_found",
    });
  });
});
