import { and, desc, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { z } from "zod";

import { auditedBatch, outboxed } from "./audit.ts";
import type { Brain } from "./brain.ts";
import { brainErrors } from "./contract.ts";
import {
  brainEvalCalibrations,
  brainEvalCases,
  brainEvalLabels,
  brainEvalSuiteVersions,
} from "./db/schema.ts";
import { inChunks } from "./documents.ts";
import type { Writer } from "./documents.ts";
import { sha256Hex } from "./encoding.ts";
import { requireEvaluator, versionOf } from "./eval-suites.ts";
import { canonicalJson } from "./json.ts";
import { knowledgeErrors } from "./knowledge.ts";

// Calibrating a learning suite's grader (GRA-311, L4; the Brain design's
// "Grading and calibration"): before a suite is used, its grader is
// compared with its owner's reviewed labels. Each labelled output is
// graded several times, in a random order, through the host's judge
// (`evaluation.grade`: its model gateway, under its budget):
//
// - agreement: how often the grader's majority verdict matches the
//   owner's label;
// - instability: how often repeated grading of the same output disagreed
//   with itself;
// - errors: timeouts and provider errors, counted apart from verdicts and
//   never as a failed task.
//
// The labels are the owner's alone (`labelOutputs`): they label outputs
// of development and validation cases, one label per case and output, and
// the evaluator calibrates against what the owner labelled, never labels
// of their own. The sealed final set never calibrates.
//
// A calibration passes when it graded at least the version's
// `minimumSamples` labels, agreement reaches its `minimumGraderAgreement`,
// nothing it graded was unstable, and errors stayed under
// `calibrationErrorShareMax` of its gradings; only then does the version
// move to `calibrated`. It grades a bounded number of labels a few at a
// time, so it ends well within a request. What it records is counts and
// cost: never an output. A real run spends only what the host's budget
// allows, and nothing by default (core: `BRAIN_CALIBRATION_BUDGET_USD`,
// off unless set).

/** Most labels one calibration grades: well within a request. */
export const calibrationSamplesMax = 60;

/** Gradings run at once. */
const gradingsAtOnce = 10;

/** Most of a calibration's gradings that may fail for it to pass. */
export const calibrationErrorShareMax = 0.1;

const labelSchema = z.strictObject({
  caseId: z.string().min(1).max(100),
  output: z.json(),
  /** The owner's own judgment of that output. */
  verdict: z.enum(["pass", "fail"]),
});

const labelsSchema = z.strictObject({
  labels: z.array(labelSchema).min(1).max(calibrationSamplesMax),
});
export type LabelsInput = z.input<typeof labelsSchema>;

const calibrationSchema = z.strictObject({
  /** Times each output is graded, to see the grader disagree with itself. */
  repeats: z.int().min(2).max(3),
});
export type CalibrationInput = z.input<typeof calibrationSchema>;

/** What a calibration found. */
export interface Calibration {
  id: string;
  samples: number;
  repeats: number;
  graded: number;
  errors: number;
  agreement: number;
  instability: number;
  cost: number;
  passed: boolean;
}

/** `items` in a random order. */
const shuffled = <T>(items: readonly T[]): T[] => {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const [random = 0] = crypto.getRandomValues(new Uint32Array(1));
    const other = random % (index + 1);
    const swap = out[index];
    const with_ = out[other];
    if (swap !== undefined && with_ !== undefined) {
      out[index] = with_;
      out[other] = swap;
    }
  }
  return out;
};

type Grade = NonNullable<
  NonNullable<Brain<unknown>["ports"]["evaluation"]>["grade"]
>;

/** How grading the labels went: counts, and what it cost. */
interface Tally {
  spent: number;
  errors: number;
  graded: number;
  agreed: number;
  unstable: number;
}

/**
 * Grades each of `labels`' outputs `repeats` times with `grade`, keeping
 * count: a label graded every time counts as graded, agreeing when the
 * majority verdict is the owner's, unstable when its verdicts differ. A
 * budget refusal stops it.
 */
const gradeAll = async (
  grade: Grade,
  run: {
    suiteId: string;
    version: number;
    grader: z.output<ReturnType<typeof z.json>>;
    repeats: number;
    labels: readonly z.output<typeof labelSchema>[];
    caseOf: (caseId: string) => { input: string; expected: string } | undefined;
  }
): Promise<Tally> => {
  const tally: Tally = {
    spent: 0,
    errors: 0,
    graded: 0,
    agreed: 0,
    unstable: 0,
  };
  const gradeOne = async (
    label: z.output<typeof labelSchema>
  ): Promise<void> => {
    const row = run.caseOf(label.caseId);
    if (row === undefined) {
      return;
    }
    const verdicts: ("pass" | "fail")[] = [];
    for (let attempt = 0; attempt < run.repeats; attempt += 1) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one output's gradings after another
        const answer = await grade({
          suiteId: run.suiteId,
          version: run.version,
          grader: run.grader,
          input: z.json().parse(JSON.parse(row.input)),
          expected: z.json().parse(JSON.parse(row.expected)),
          output: label.output,
          spent: tally.spent,
        });
        tally.spent += answer.cost;
        verdicts.push(answer.verdict);
      } catch (error) {
        // Out of budget: stop, and record nothing.
        if (brainErrors.codeOf(error) === "brain.budget_exceeded") {
          throw error;
        }
        tally.errors += 1;
      }
    }
    if (verdicts.length === run.repeats) {
      tally.graded += 1;
      const passes = verdicts.filter((verdict) => verdict === "pass").length;
      const majority = passes * 2 > run.repeats ? "pass" : "fail";
      tally.agreed += majority === label.verdict ? 1 : 0;
      tally.unstable += passes !== 0 && passes !== run.repeats ? 1 : 0;
    }
  };
  // A few at a time: bounded, and well within a request.
  for (let start = 0; start < run.labels.length; start += gradingsAtOnce) {
    // oxlint-disable-next-line no-await-in-loop -- one batch after another
    await Promise.all(
      run.labels.slice(start, start + gradingsAtOnce).map(gradeOne)
    );
  }
  return tally;
};

/**
 * Labels outputs of suite version `version`'s development and validation
 * cases, as `by`, its owner, for its grader to be calibrated against: one
 * label per case and output, refused twice. Never a sealed final case.
 */
export const labelOutputs = async <C>(
  brain: Brain<C>,
  reader: C,
  by: Writer,
  suiteId: string,
  version: number,
  input: unknown
): Promise<{ labels: number }> => {
  const { labels } = knowledgeErrors.parse(
    "knowledge.invalid",
    labelsSchema,
    input
  );
  const current = await versionOf(brain, suiteId, version);
  if (
    brain.ports.ownerOf(reader) !== by.userId ||
    current.ownerId !== by.userId
  ) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  if (current.state !== "proposed") {
    throw knowledgeErrors.create("knowledge.conflict");
  }
  const { db } = brain;
  const cases = await db
    .select({ caseId: brainEvalCases.caseId, split: brainEvalCases.split })
    .from(brainEvalCases)
    .where(
      and(
        eq(brainEvalCases.suiteId, suiteId),
        eq(brainEvalCases.version, version)
      )
    );
  const splitOf = new Map(cases.map(({ caseId, split }) => [caseId, split]));
  if (
    labels.some(
      ({ caseId }) =>
        splitOf.get(caseId) === undefined || splitOf.get(caseId) === "final"
    )
  ) {
    throw knowledgeErrors.create("knowledge.invalid", {
      issues: ["labels: a case isn't a development or validation case of it"],
    });
  }
  const rows = await Promise.all(
    labels.map(async (label) => ({
      suiteId,
      version,
      caseId: label.caseId,
      outputDigest: await sha256Hex(canonicalJson(label.output)),
      output: canonicalJson(label.output),
      verdict: label.verdict,
      labeledBy: by.userId,
      at: brain.ports.clock(),
    }))
  );
  const keys = rows.map(
    ({ caseId, outputDigest }) => `${caseId}\n${outputDigest}`
  );
  if (new Set(keys).size !== keys.length) {
    throw knowledgeErrors.create("knowledge.invalid", {
      issues: ["labels: the same case and output twice"],
    });
  }
  try {
    const inserts: BatchItem<"sqlite">[] = inChunks(rows).map((chunk) =>
      db.insert(brainEvalLabels).values(chunk)
    );
    await auditedBatch(brain.ports, db, [
      outboxed(brain, {
        actor: by.actor,
        action: "knowledge.eval_suite.labelled",
        target: { type: "eval_suite", id: suiteId },
        detail: { version, labels: rows.length },
      }),
      ...inserts,
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      throw knowledgeErrors.create("knowledge.invalid", {
        issues: ["labels: a case and output already labelled"],
      });
    }
    throw error;
  }
  return { labels: rows.length };
};

/**
 * Calibrates proposed suite version `version`'s grader against `input`'s
 * labels, for `reader`, its evaluator: recorded and audited, and the
 * version moved to `calibrated` when it passes. A budget refusal stops
 * it and records nothing.
 */
export const calibrateSuiteVersion = async <C>(
  brain: Brain<C>,
  reader: C,
  by: Writer,
  suiteId: string,
  version: number,
  input: unknown
): Promise<Calibration> => {
  const { repeats } = knowledgeErrors.parse(
    "knowledge.invalid",
    calibrationSchema,
    input
  );
  await requireEvaluator(brain, reader, by, suiteId);
  const current = await versionOf(brain, suiteId, version);
  if (current.state !== "proposed") {
    throw knowledgeErrors.create("knowledge.conflict");
  }
  const grade = brain.ports.evaluation?.grade;
  if (grade === undefined) {
    throw brainErrors.create("brain.unavailable");
  }
  const { db } = brain;
  const cases = await db
    .select()
    .from(brainEvalCases)
    .where(
      and(
        eq(brainEvalCases.suiteId, suiteId),
        eq(brainEvalCases.version, version)
      )
    );
  const byId = new Map(cases.map((row) => [row.caseId, row]));
  // The owner's labels alone, of development and validation cases.
  const stored = await db
    .select()
    .from(brainEvalLabels)
    .where(
      and(
        eq(brainEvalLabels.suiteId, suiteId),
        eq(brainEvalLabels.version, version),
        eq(brainEvalLabels.labeledBy, current.ownerId)
      )
    )
    .limit(calibrationSamplesMax);
  const labels = stored.flatMap((row) =>
    byId.get(row.caseId)?.split === "final"
      ? []
      : [
          {
            caseId: row.caseId,
            output: z.json().parse(JSON.parse(row.output)),
            verdict: row.verdict,
          },
        ]
  );
  const [graderRow] = await db
    .select({ grader: brainEvalSuiteVersions.grader })
    .from(brainEvalSuiteVersions)
    .where(
      and(
        eq(brainEvalSuiteVersions.suiteId, suiteId),
        eq(brainEvalSuiteVersions.version, version)
      )
    );
  const grader = z.json().parse(JSON.parse(graderRow?.grader ?? "null"));
  const tally = await gradeAll(grade, {
    suiteId,
    version,
    grader,
    repeats,
    labels: shuffled(labels),
    caseOf: (caseId) => byId.get(caseId),
  });
  const { spent, errors, graded, agreed, unstable } = tally;
  const agreement = graded === 0 ? 0 : agreed / graded;
  const instability = graded === 0 ? 1 : unstable / graded;
  const attempts = labels.length * repeats;
  const passed =
    graded >= current.decision.minimumSamples &&
    agreement >= current.decision.minimumGraderAgreement &&
    instability === 0 &&
    errors <= attempts * calibrationErrorShareMax;
  const id = crypto.randomUUID();
  const now = brain.ports.clock();
  await auditedBatch(brain.ports, db, [
    db.insert(brainEvalCalibrations).values({
      id,
      suiteId,
      version,
      by: by.userId,
      samples: labels.length,
      repeats,
      graded,
      errors,
      agreement,
      instability,
      cost: spent,
      passed,
      at: now,
    }),
    ...(passed
      ? [
          db
            .update(brainEvalSuiteVersions)
            .set({
              state: "calibrated",
              revision: current.revision + 1,
              updatedAt: now,
            })
            .where(
              and(
                eq(brainEvalSuiteVersions.suiteId, suiteId),
                eq(brainEvalSuiteVersions.version, version),
                eq(brainEvalSuiteVersions.revision, current.revision),
                eq(brainEvalSuiteVersions.state, "proposed")
              )
            ),
        ]
      : []),
    outboxed(brain, {
      actor: by.actor,
      action: "knowledge.eval_suite.calibration",
      target: { type: "eval_suite", id: suiteId },
      detail: { version, graded, errors, passed },
    }),
  ]);
  return {
    id,
    samples: labels.length,
    repeats,
    graded,
    errors,
    agreement,
    instability,
    cost: spent,
    passed,
  };
};

/**
 * The calibrations of suite version `version`, newest first, counts
 * alone: for its evaluator, or its owner before they accept it.
 */
export const calibrationsOf = async <C>(
  brain: Brain<C>,
  reader: C,
  by: Writer,
  suiteId: string,
  version: number
): Promise<Calibration[]> => {
  const current = await versionOf(brain, suiteId, version);
  const owner =
    current.ownerId === by.userId && brain.ports.ownerOf(reader) === by.userId;
  if (!owner) {
    await requireEvaluator(brain, reader, by, suiteId);
  }
  const rows = await brain.db
    .select()
    .from(brainEvalCalibrations)
    .where(
      and(
        eq(brainEvalCalibrations.suiteId, suiteId),
        eq(brainEvalCalibrations.version, version)
      )
    )
    .orderBy(desc(brainEvalCalibrations.at));
  return rows.map((row) => ({
    id: row.id,
    samples: row.samples,
    repeats: row.repeats,
    graded: row.graded,
    errors: row.errors,
    agreement: row.agreement,
    instability: row.instability,
    cost: row.cost,
    passed: row.passed,
  }));
};
