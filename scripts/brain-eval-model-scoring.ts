/**
 * How the Brain evaluation's model run (GRA-1813) scores: pure functions
 * over what apps/core/test/brain-eval-model.test.ts printed, one result
 * per question asked. scripts/brain-eval-model.ts runs it and prints what
 * these return, in the groups and the table shape of the evaluation's
 * own report (brain-eval-scoring.ts).
 *
 * Two arms, the same model, the same instructions: `pack` answers from
 * the Brain's recall pack, `everything` from everything the asker may
 * read, within the model's window. Each answer is right or wrong:
 * - a question with an answer: the same model, as judge, says CORRECT
 *   against the passage that answers it;
 * - a question with no answer in the set: the model said NOT FOUND;
 * - a question whose answer is hidden from the asker: the model said NOT
 *   FOUND, and no secret is in its answer (one that is, is a leak, and
 *   fails the run).
 * Whether one arm beats the other is the exact sign test on the questions
 * only one got right (`signTest`), and every share has its 95% bootstrap
 * interval, as in the evaluation.
 */
import { z } from "zod";

import {
  brainEvalLanguages,
  brainEvalWays,
} from "../apps/core/test/fixtures/brain-eval/company.ts";
import type { Price } from "../apps/core/test/fixtures/brain-eval/everything.ts";
import type { Grouping } from "../apps/core/test/fixtures/brain-eval/set.ts";
import {
  estimate,
  groups,
  pOf,
  signTest,
  signed,
  table,
  withMargin,
} from "./brain-eval-scoring.ts";
import type { Estimate, SignTest } from "./brain-eval-scoring.ts";

const languageSchema = z.enum(brainEvalLanguages);

const armSchema = z.object({
  /** Right, as the question's kind decides (above). */
  correct: z.boolean(),
  /** Secrets of the question the answer holds: each one a leak. */
  leaks: z.array(z.string()),
  /** What the arm's calls used, its verdict's included, as the gateway counted. */
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
});

/** Whether `A` and `B` are the same type, each assignable to the other. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * `schema`, which must read exactly `T`: one that reads more or less fails
 * to compile.
 */
const exactly =
  <T>() =>
  <S extends z.ZodType>(
    schema: S & (Same<z.infer<S>, T> extends true ? unknown : never)
  ): S =>
    schema;

/**
 * What decides a result's groups, exactly as the set's `groupingOf` writes
 * it: a new kind of question, way or field there fails to compile here,
 * before any run.
 */
const groupingSchema = exactly<Grouping>()(
  z.object({
    language: languageSchema,
    sourceLanguage: languageSchema.nullable(),
    expects: z.enum(["answer", "absent", "hidden"]),
    way: z.enum(brainEvalWays).nullable(),
    long: z.boolean(),
    lookalike: z.boolean(),
  })
);

/** One question's result, as the run printed it. */
export const modelResultSchema = groupingSchema.extend({
  id: z.string(),
  pack: armSchema,
  everything: armSchema.extend({
    /** Sources in the context, and whether one was cut or left out at the budget. */
    sources: z.int().nonnegative(),
    cut: z.boolean(),
  }),
});
export type ModelResult = z.infer<typeof modelResultSchema>;

/** What the run printed about itself, before its first question. */
export const modelRunInfoSchema = z.object({
  set: z.string(),
  setDigest: z.string(),
  model: z.string(),
  questions: z.int(),
  packTokens: z.int(),
  /** The cut below the model's window, in tokens; null for the window. */
  everythingTokens: z.int().positive().nullable(),
  budgetUsd: z.number(),
  /** How the pack arm's recall searched: by words and exact parts, no vectors. */
  packSearch: z.literal("words and exact parts"),
});
export type ModelRunInfo = z.infer<typeof modelRunInfoSchema>;

/** How the run ended: every question asked, or stopped before the next would pass the budget. */
export const modelRunEndSchema = z.object({
  asked: z.int().nonnegative(),
  stoppedAtBudget: z.boolean(),
  /** A call failed (a provider's error, a refused context): the results are those asked before. */
  failed: z.boolean(),
  /**
   * What core recorded the run spent, in US dollars; null when the run
   * died before it said (the script keeps its results all the same).
   */
  spentUsd: z.number().nonnegative().nullable(),
});
export type ModelRunEnd = z.infer<typeof modelRunEndSchema>;

export interface ModelGroupScore {
  group: string;
  questions: number;
  pack: Estimate | null;
  everything: Estimate | null;
  /** The pack's share right less everything's, paired by question. */
  difference: Estimate | null;
  /** The pack against everything, paired: right in one arm only. */
  packOverEverything: SignTest;
}

/** A right answer as 1, a wrong one as 0. */
const right = (correct: boolean): number => (correct ? 1 : 0);

const scoreOf = (
  group: string,
  results: readonly ModelResult[]
): ModelGroupScore => ({
  group,
  questions: results.length,
  pack: estimate(results.map(({ pack }) => right(pack.correct))),
  everything: estimate(
    results.map(({ everything }) => right(everything.correct))
  ),
  difference: estimate(
    results.map(
      ({ pack, everything }) => right(pack.correct) - right(everything.correct)
    )
  ),
  packOverEverything: signTest(
    results.filter(
      ({ pack, everything }) => pack.correct && !everything.correct
    ).length,
    results.filter(
      ({ pack, everything }) => !pack.correct && everything.correct
    ).length
  ),
});

/** Tokens an arm used, and what they cost at the model's list price. */
export interface ArmCost {
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export interface ModelSummary {
  /** Questions with an answer, in the evaluation's groups. */
  groups: ModelGroupScore[];
  /** Questions with no answer in the set: each arm right when it said so. */
  absent: ModelGroupScore;
  /** Questions whose answer is hidden from the asker. */
  hidden: ModelGroupScore;
  /** Every answer that held a secret of its question. */
  leaks: { id: string; arm: "pack" | "everything"; leaks: string[] }[];
  /** Questions whose "everything" was cut at the budget. */
  cut: number;
  cost: { pack: ArmCost; everything: ArmCost };
}

const costOfArm = (
  arms: readonly { inputTokens: number; outputTokens: number }[],
  price: Price
): ArmCost => {
  const inputTokens = arms.reduce((sum, arm) => sum + arm.inputTokens, 0);
  const outputTokens = arms.reduce((sum, arm) => sum + arm.outputTokens, 0);
  return {
    inputTokens,
    outputTokens,
    usd: (inputTokens * price.input + outputTokens * price.output) / 1_000_000,
  };
};

/** The run's results, scored; `price` is the model's list price per million tokens. */
export const summarizeModelRun = (
  results: readonly ModelResult[],
  price: Price
): ModelSummary => {
  const answerable = results.filter(({ expects }) => expects === "answer");
  return {
    groups: groups.map(({ name, has }) =>
      scoreOf(name, answerable.filter(has))
    ),
    absent: scoreOf(
      "No answer in the set",
      results.filter(({ expects }) => expects === "absent")
    ),
    hidden: scoreOf(
      "Answer hidden from the asker",
      results.filter(({ expects }) => expects === "hidden")
    ),
    leaks: results.flatMap(({ id, pack, everything }) => [
      ...(pack.leaks.length === 0
        ? []
        : [{ id, arm: "pack" as const, leaks: pack.leaks }]),
      ...(everything.leaks.length === 0
        ? []
        : [{ id, arm: "everything" as const, leaks: everything.leaks }]),
    ]),
    cut: results.filter(({ everything }) => everything.cut).length,
    cost: {
      pack: costOfArm(
        results.map(({ pack }) => pack),
        price
      ),
      everything: costOfArm(
        results.map(({ everything }) => everything),
        price
      ),
    },
  };
};

const header = [
  "Group",
  "n",
  "pack right",
  "everything right",
  "Δ [95%]",
  "only pack/everything",
  "p",
  "pack vs everything",
] as const;

const rowOf = (score: ModelGroupScore): string[] => [
  score.group,
  String(score.questions),
  withMargin(score.pack),
  withMargin(score.everything),
  signed(score.difference),
  `${score.packOverEverything.gained}/${score.packOverEverything.lost}`,
  pOf(score.packOverEverything),
  score.packOverEverything.verdict,
];

const dollars = (usd: number): string => `$${usd.toFixed(2)}`;

const costLine = (arm: string, cost: ArmCost): string =>
  `${arm}: ${cost.inputTokens} input and ${cost.outputTokens} output tokens, ${dollars(cost.usd)} at list price`;

/** How a run's results are kept: as passed, `-partial` or `-failed`. */
export interface Kept {
  /** How it ended: as it printed, or, cut off before it said, as failed. */
  end: ModelRunEnd;
  failed: boolean;
  /** Stopped at its budget: a sample of each group, not the whole set. */
  partial: boolean;
  /** What the result file's name ends with, before `.json`. */
  suffix: "" | "-partial" | "-failed";
}

/**
 * How a run's results are kept, since they were paid for whatever
 * happened: failed when it exited otherwise than 0, a call failed, it was
 * cut off before its end line (a timeout, workerd gone: then its results
 * are what it printed, and what it spent is unknown), or an answer leaked;
 * partial when it stopped at its budget.
 */
export const keptAs = (
  exited: number | null,
  printed: ModelRunEnd | undefined,
  results: readonly ModelResult[],
  leaks: number
): Kept => {
  const end = printed ?? {
    asked: results.length,
    stoppedAtBudget: false,
    failed: true,
    spentUsd: null,
  };
  const failed =
    exited !== 0 || end.failed || results.length !== end.asked || leaks > 0;
  const partial = end.stoppedAtBudget;
  let suffix: Kept["suffix"] = "";
  if (failed) {
    suffix = "-failed";
  } else if (partial) {
    suffix = "-partial";
  }
  return { end, failed, partial, suffix };
};

/** How the run ended, in a line. */
const endLine = (end: ModelRunEnd, questions: number): string => {
  if (end.failed) {
    return `FAILED after ${end.asked} of ${questions} questions: a call failed, or the run was cut off (see the run's output). The results above are those asked before it.`;
  }
  return end.stoppedAtBudget
    ? `STOPPED AT THE BUDGET after ${end.asked} of ${questions} questions (asked in a seeded order, so each group is a sample).`
    : `Every question asked: ${end.asked}.`;
};

/** The run's numbers as compact text, in the evaluation's table shape. */
export const modelReport = (
  summary: ModelSummary,
  end: ModelRunEnd,
  questions: number
): string =>
  [
    table(header, [
      ...summary.groups.map(rowOf),
      rowOf(summary.absent),
      rowOf(summary.hidden),
    ]),
    "",
    `Right: a question with an answer when the judge (the same model) found it correct against the passage that answers it; one with no answer, or with its answer hidden from the asker, when the model said it isn't there. ± and Δ [95%]: seeded bootstrap over questions. "pack vs everything": exact sign test (McNemar) on the questions only one arm got right, at p < 0.05, each group on its own.`,
    `"everything" was cut at its budget for ${summary.cut} of ${end.asked} questions.`,
    endLine(end, questions),
    `Cost, ${costLine("pack", summary.cost.pack)}; ${costLine("everything", summary.cost.everything)}. ${end.spentUsd === null ? "What core recorded as spent is unknown: the run died before it said; the provider's own usage says." : `Core recorded ${dollars(end.spentUsd)} spent.`}`,
    summary.leaks.length === 0
      ? "Leaks: none. No answer held what its asker may not read."
      : `LEAKS in ${summary.leaks.length} answers: ${summary.leaks.map(({ id, arm, leaks }) => `${id} (${arm}: ${leaks.length})`).join("; ")}`,
  ].join("\n");
