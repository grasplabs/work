/**
 * How the Brain evaluation (GRA-1726) scores a run: pure functions over
 * what apps/core/test/brain-eval.test.ts printed, one result per question.
 * scripts/brain-eval.ts runs it and prints and keeps what these return.
 *
 * Retrieval only, no model: is the question's source among the first
 * {@link resultBudget} results (recall at that budget: each question has
 * one source, so it is whether it was found), and where (the reciprocal of
 * its rank, MRR).
 *
 * Two kinds of uncertainty, each where it fits:
 * - Recall is 0 or 1 per question, so whether one arm or run beats another
 *   is the exact sign test on the questions where they differ (McNemar's
 *   exact test, {@link signTest}): `better` or `worse` only at p < 0.05.
 * - The size of a difference, and MRR, which isn't 0 or 1, get a 95%
 *   interval by a seeded bootstrap over questions, for display.
 */
import { z } from "zod";

import {
  brainEvalLanguages,
  brainEvalWays,
} from "../apps/core/test/fixtures/brain-eval/company.ts";

/** How many results a reader is counted as looking at. */
export const resultBudget = 5;

/** The level at which a difference is called `better` or `worse`. */
export const significance = 0.05;

/** Bootstrap resamples for every interval. */
const resamples = 2000;

/** The latency targets, from the design: half within 0.4 s, 95% within 1 s. */
export const latencyTargetsMs = { p50: 400, p95: 1000 } as const;

const languageSchema = z.enum(brainEvalLanguages);

/** One question's result, as the run printed it. */
export const questionResultSchema = z.object({
  id: z.string(),
  digest: z.string(),
  language: languageSchema,
  sourceLanguage: languageSchema.nullable(),
  expects: z.enum(["answer", "absent", "hidden"]),
  way: z.enum(brainEvalWays).nullable(),
  brain: z.object({
    rank: z.int().positive().nullable(),
    returned: z.int().nonnegative(),
    leaks: z.array(z.string()),
    ms: z.number().nonnegative(),
  }),
  grep: z.object({
    rank: z.int().positive().nullable(),
    returned: z.int().nonnegative(),
  }),
});
export type QuestionResult = z.infer<typeof questionResultSchema>;

/** What the run printed about itself. */
export const runInfoSchema = z.object({
  set: z.string(),
  setDigest: z.string(),
  sources: z.int(),
  questions: z.int(),
  recallLimit: z.int(),
});
export type RunInfo = z.infer<typeof runInfoSchema>;

/** A mean and its 95% interval. */
export interface Estimate {
  mean: number;
  low: number;
  high: number;
}

/** The Park–Miller generator's modulus and multiplier. */
const modulus = 2_147_483_647;
const multiplier = 48_271;

/**
 * A seeded generator in [0, 1) (Park–Miller), so the same results give
 * the same intervals in every run.
 */
const seeded = (seed: number): (() => number) => {
  let state = (seed % (modulus - 1)) + 1;
  return () => {
    state = (state * multiplier) % modulus;
    return (state - 1) / (modulus - 1);
  };
};

const meanOf = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0) / values.length;

/** The `p`th percentile (0–100) of sorted `values`, nearest rank. */
const percentileOf = (sorted: readonly number[], p: number): number =>
  sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ] ?? 0;

/**
 * The mean of `values` and its 95% percentile-bootstrap interval over
 * them; `null` when there are none.
 */
export const estimate = (
  values: readonly number[],
  seed = 1726
): Estimate | null => {
  if (values.length === 0) {
    return null;
  }
  const random = seeded(seed);
  const means = Array.from({ length: resamples }, () =>
    meanOf(values.map(() => values[Math.floor(random() * values.length)] ?? 0))
  ).toSorted((a, b) => a - b);
  return {
    mean: meanOf(values),
    low: percentileOf(means, 2.5),
    high: percentileOf(means, 97.5),
  };
};

export type Verdict = "better" | "worse" | "same";

/**
 * Paired 0/1 outcomes compared: how many questions only the first side
 * found (`gained`), how many only the second (`lost`), the exact two-sided
 * sign test's p over those (McNemar's exact test; questions both or
 * neither found say nothing), and the verdict at {@link significance}.
 */
export interface SignTest {
  gained: number;
  lost: number;
  p: number;
  verdict: Verdict;
}

/** McNemar's exact test: `gained` against `lost`, each equally likely. */
export const signTest = (gained: number, lost: number): SignTest => {
  const changed = gained + lost;
  let tail = 0;
  let term = 0.5 ** changed;
  for (let k = 0; k <= Math.min(gained, lost); k += 1) {
    tail += term;
    term = (term * (changed - k)) / (k + 1);
  }
  const p = Math.min(1, 2 * tail);
  let verdict: Verdict = "same";
  if (p < significance) {
    verdict = gained > lost ? "better" : "worse";
  }
  return { gained, lost, p, verdict };
};

const found = (rank: number | null): boolean =>
  rank !== null && rank <= resultBudget;

const reciprocal = (rank: number | null): number =>
  rank === null ? 0 : 1 / rank;

/** `first` against `second`, paired: found by one and not the other. */
const signTestOf = (pairs: readonly (readonly [boolean, boolean])[]) =>
  signTest(
    pairs.filter(([first, second]) => first && !second).length,
    pairs.filter(([first, second]) => !first && second).length
  );

export interface ArmScore {
  recall: Estimate | null;
  mrr: Estimate | null;
}

export interface GroupScore {
  group: string;
  questions: number;
  brain: ArmScore;
  grep: ArmScore;
  /** The Brain's recall against grep's, paired by question. */
  brainOverGrep: SignTest;
  /** The size of that difference, for display. */
  recallDifference: Estimate | null;
  /** The Brain's MRR less grep's, paired by question (bootstrap). */
  mrrDifference: Estimate | null;
}

const scoreGroup = (
  group: string,
  results: readonly QuestionResult[]
): GroupScore => {
  const recallOf = (rank: number | null) => (found(rank) ? 1 : 0);
  return {
    group,
    questions: results.length,
    brain: {
      recall: estimate(results.map(({ brain }) => recallOf(brain.rank))),
      mrr: estimate(results.map(({ brain }) => reciprocal(brain.rank))),
    },
    grep: {
      recall: estimate(results.map(({ grep }) => recallOf(grep.rank))),
      mrr: estimate(results.map(({ grep }) => reciprocal(grep.rank))),
    },
    brainOverGrep: signTestOf(
      results.map(({ brain, grep }) => [found(brain.rank), found(grep.rank)])
    ),
    recallDifference: estimate(
      results.map(
        ({ brain, grep }) => recallOf(brain.rank) - recallOf(grep.rank)
      )
    ),
    mrrDifference: estimate(
      results.map(
        ({ brain, grep }) => reciprocal(brain.rank) - reciprocal(grep.rank)
      )
    ),
  };
};

const languageNames = {
  en: "English",
  nl: "Dutch (written in Dutch)",
  de: "German",
  fr: "French",
  es: "Spanish",
} as const;

const sameLanguage = (result: QuestionResult): boolean =>
  result.language === result.sourceLanguage;

/**
 * The groups a run is reported in, each a filter over answerable
 * questions: all of them; asked in the language of their source, pooled
 * and per language; across languages; and each way of finding a source,
 * in the same language only, so a way's group measures that way alone.
 */
export const groups: readonly {
  name: string;
  has: (result: QuestionResult) => boolean;
}[] = [
  { name: "All answerable", has: () => true },
  { name: "Same language", has: sameLanguage },
  ...brainEvalLanguages.map((language) => ({
    name: languageNames[language],
    has: (result: QuestionResult) =>
      sameLanguage(result) && result.language === language,
  })),
  {
    name: "Across languages",
    has: (result: QuestionResult) => !sameLanguage(result),
  },
  ...brainEvalWays.map((way) => ({
    name: `Way: ${way}`,
    has: (result: QuestionResult) => sameLanguage(result) && result.way === way,
  })),
];

export interface Latency {
  recalls: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  withinP50TargetShare: number;
  withinP95TargetShare: number;
}

const latencyOf = (results: readonly QuestionResult[]): Latency | null => {
  const sorted = results.map(({ brain }) => brain.ms).toSorted((a, b) => a - b);
  if (sorted.length === 0) {
    return null;
  }
  const share = (limit: number) =>
    sorted.filter((ms) => ms <= limit).length / sorted.length;
  return {
    recalls: sorted.length,
    p50Ms: percentileOf(sorted, 50),
    p95Ms: percentileOf(sorted, 95),
    maxMs: sorted.at(-1) ?? 0,
    withinP50TargetShare: share(latencyTargetsMs.p50),
    withinP95TargetShare: share(latencyTargetsMs.p95),
  };
};

export interface Summary {
  groups: GroupScore[];
  /** Questions whose answer is nowhere: how often each returned nothing. */
  absent: { questions: number; brainEmpty: number; grepEmpty: number };
  /** Questions whose answer is hidden from the asker. */
  hidden: { questions: number; brainReturnedAny: number };
  /** Every question whose Brain results leaked, and what. */
  leaks: { id: string; leaks: string[] }[];
  latency: Latency | null;
}

export const summarize = (results: readonly QuestionResult[]): Summary => {
  const answerable = results.filter(({ expects }) => expects === "answer");
  const absent = results.filter(({ expects }) => expects === "absent");
  const hidden = results.filter(({ expects }) => expects === "hidden");
  return {
    groups: groups.map(({ name, has }) =>
      scoreGroup(name, answerable.filter(has))
    ),
    absent: {
      questions: absent.length,
      brainEmpty: absent.filter(({ brain }) => brain.returned === 0).length,
      grepEmpty: absent.filter(({ grep }) => grep.returned === 0).length,
    },
    hidden: {
      questions: hidden.length,
      brainReturnedAny: hidden.filter(({ brain }) => brain.returned > 0).length,
    },
    leaks: results.flatMap(({ id, brain }) =>
      brain.leaks.length === 0 ? [] : [{ id, leaks: brain.leaks }]
    ),
    latency: latencyOf(results),
  };
};

export interface GroupChange extends SignTest {
  group: string;
  /** Questions in both runs, each unchanged. */
  paired: number;
  /** Whether a verdict is given: not when the set changed between runs. */
  judged: boolean;
}

/**
 * The Brain's recall now against an earlier run's, per group, paired by
 * question: only questions in both whose digest is unchanged count, and
 * the sign test says whether more were gained than lost. A question's
 * rank depends on every other source too, so when the set changed
 * (`setChanged`) the counts are shown without a verdict.
 */
export const compareRuns = (
  now: readonly QuestionResult[],
  before: readonly QuestionResult[],
  { setChanged }: { setChanged: boolean }
): GroupChange[] => {
  const earlier = new Map(before.map((result) => [result.id, result]));
  const pairs = now.flatMap((result) => {
    const previous = earlier.get(result.id);
    return result.expects === "answer" && previous?.digest === result.digest
      ? [{ result, previous }]
      : [];
  });
  return groups.map(({ name, has }) => {
    const paired = pairs.filter(({ result }) => has(result));
    const test = signTestOf(
      paired.map(({ result, previous }) => [
        found(result.brain.rank),
        found(previous.brain.rank),
      ])
    );
    return {
      group: name,
      paired: paired.length,
      judged: !setChanged,
      ...test,
      verdict: setChanged ? "same" : test.verdict,
    };
  });
};

const fixed = (value: number): string => value.toFixed(2);

/** `0.62 ±0.11`: the mean and the larger half of its interval. */
export const withMargin = (value: Estimate | null): string =>
  value === null
    ? "–"
    : `${fixed(value.mean)} ±${fixed(Math.max(value.mean - value.low, value.high - value.mean))}`;

const signed = (value: Estimate | null): string =>
  value === null
    ? "–"
    : `${value.mean >= 0 ? "+" : ""}${fixed(value.mean)} [${fixed(value.low)}, ${fixed(value.high)}]`;

const pOf = ({ gained, lost, p }: SignTest): string =>
  gained + lost === 0 ? "–" : p.toFixed(3);

const table = (
  header: readonly string[],
  rows: readonly string[][]
): string => {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0))
  );
  const line = (cells: readonly string[]) =>
    cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ");
  return [line(header), ...rows.map(line)].join("\n");
};

const judgedLine = `Each of the ${groups.length} groups is judged on its own at p < ${significance}, with no correction across them: with this many, one group flagged alone may be chance.`;

/** The run's numbers as compact text tables. */
export const report = (
  summary: Summary,
  changes: readonly GroupChange[] | null
): string => {
  const quality = table(
    [
      "Group",
      "n",
      `Brain R@${resultBudget}`,
      `grep R@${resultBudget}`,
      `Δ R@${resultBudget} [95%]`,
      "only Brain/grep",
      "p",
      "vs grep",
      "Brain MRR",
      "grep MRR",
      "Δ MRR [95%]",
    ],
    summary.groups.map((group) => [
      group.group,
      String(group.questions),
      withMargin(group.brain.recall),
      withMargin(group.grep.recall),
      signed(group.recallDifference),
      `${group.brainOverGrep.gained}/${group.brainOverGrep.lost}`,
      pOf(group.brainOverGrep),
      group.brainOverGrep.verdict,
      withMargin(group.brain.mrr),
      withMargin(group.grep.mrr),
      signed(group.mrrDifference),
    ])
  );
  const { absent, hidden, leaks, latency } = summary;
  const lines = [
    quality,
    "",
    `R@${resultBudget} ± and Δ [95%]: seeded bootstrap over questions, for size. "vs grep": exact sign test (McNemar) on the questions only one of them found. MRR: paired bootstrap, not tested.`,
    judgedLine,
    "",
    `No answer in the set: ${absent.questions} questions; the Brain returned nothing for ${absent.brainEmpty}, grep for ${absent.grepEmpty}.`,
    `Answer hidden from the asker: ${hidden.questions} questions; the Brain returned other sources for ${hidden.brainReturnedAny} (any hidden one is a leak).`,
    leaks.length === 0
      ? "Leaks: none. No result reached an asker who may not read it, and no hidden answer was returned."
      : `LEAKS in ${leaks.length} questions: ${leaks.map(({ id, leaks: what }) => `${id} (${what.join(", ")})`).join("; ")}`,
    latency === null
      ? "Latency: no recalls."
      : `Latency per recall (${latency.recalls}): p50 ${latency.p50Ms} ms, p95 ${latency.p95Ms} ms, max ${latency.maxMs} ms; within ${latencyTargetsMs.p50} ms ${Math.round(latency.withinP50TargetShare * 100)}%, within ${latencyTargetsMs.p95} ms ${Math.round(latency.withinP95TargetShare * 100)}%.`,
  ];
  if (changes !== null) {
    const setChanged = changes.some(({ judged }) => !judged);
    lines.push(
      "",
      setChanged
        ? "The set changed since that run, and every rank depends on every source: changes are shown, not judged."
        : judgedLine,
      table(
        ["Against that run", "paired", "gained", "lost", "p", "verdict"],
        changes.map((change) => [
          change.group,
          String(change.paired),
          String(change.gained),
          String(change.lost),
          pOf(change),
          change.judged ? change.verdict : "not judged",
        ])
      )
    );
  }
  return lines.join("\n");
};
