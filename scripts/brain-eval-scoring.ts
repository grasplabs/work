/**
 * How the Brain evaluation (GRA-1726) scores a run: pure functions over
 * what apps/core/test/brain-eval.test.ts printed, one result per question.
 * scripts/brain-eval.ts runs it and prints and keeps what these return.
 *
 * Retrieval only, no model: is the passage that answers the question (a
 * chunk of its source holding the quote) among the first
 * {@link resultBudget} results (recall at that budget: each question has
 * one such passage, so it is whether it was found), and where (the
 * reciprocal of its rank, MRR). For questions over long documents, cut
 * into several passages, also how often the right source was returned but
 * not the passage that answers.
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

/**
 * The evaluation's command-line arguments, as `parseArgs` reads them:
 * without the one leading `--` that `vp run brain:eval -- --out <dir>`
 * passes on, which would otherwise make every option after it positional.
 */
export const evalArgs = (args: readonly string[]): string[] =>
  args[0] === "--" ? args.slice(1) : [...args];

/** How many results a reader is counted as looking at. */
export const resultBudget = 5;

/** The level at which a difference is called `better` or `worse`. */
export const significance = 0.05;

/** Bootstrap resamples for every interval. */
const resamples = 2000;

/** The latency targets, from the design: half within 0.4 s, 95% within 1 s. */
export const latencyTargetsMs = { p50: 400, p95: 1000 } as const;

const languageSchema = z.enum(brainEvalLanguages);

const rankSchema = z.int().positive().nullable();

/**
 * One question's result, as the run printed it. `long`, `lookalike` and
 * `sourceRank` came with long documents: a run written before them lacks
 * them and still parses, as over sources of one passage with no source
 * rank, since an earlier run is only read for the Brain's rank per
 * question.
 */
export const questionResultSchema = z.object({
  id: z.string(),
  digest: z.string(),
  language: languageSchema,
  sourceLanguage: languageSchema.nullable(),
  expects: z.enum(["answer", "absent", "hidden"]),
  way: z.enum(brainEvalWays).nullable(),
  /** The question's source is a long document, cut into several passages. */
  long: z.boolean().default(false),
  /** The answer names a look-alike passage of the same document. */
  lookalike: z.boolean().default(false),
  brain: z.object({
    rank: rankSchema,
    sourceRank: rankSchema.default(null),
    returned: z.int().nonnegative(),
    leaks: z.array(z.string()),
    ms: z.number().nonnegative(),
  }),
  grep: z.object({
    rank: rankSchema,
    sourceRank: rankSchema.default(null),
    returned: z.int().nonnegative(),
  }),
});
export type QuestionResult = z.infer<typeof questionResultSchema>;

/**
 * What the run printed about itself. `passagesDigest` (how the Brain's
 * chunker cut the set) came with long documents: a run written before it
 * lacks it and still parses.
 */
export const runInfoSchema = z.object({
  set: z.string(),
  setDigest: z.string(),
  passagesDigest: z.string().optional(),
  sources: z.int(),
  longDocuments: z.int().optional(),
  passages: z.int().optional(),
  questions: z.int(),
  recallLimit: z.int(),
  /** The model and build recall searched by meaning with; null for none. */
  vectors: z.string().nullable().optional(),
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
  /**
   * How often a passage of the right source was among the first
   * {@link resultBudget} results but the one that answers wasn't.
   */
  sourceNotPassage: Estimate | null;
}

export interface GroupScore {
  group: string;
  /** Whether the group holds questions over long documents. */
  long: boolean;
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
  long: boolean,
  results: readonly QuestionResult[]
): GroupScore => {
  const recallOf = (rank: number | null) => (found(rank) ? 1 : 0);
  const sourceNotPassageOf = ({
    rank,
    sourceRank,
  }: QuestionResult["brain" | "grep"]) =>
    found(sourceRank) && !found(rank) ? 1 : 0;
  return {
    group,
    long,
    questions: results.length,
    brain: {
      recall: estimate(results.map(({ brain }) => recallOf(brain.rank))),
      mrr: estimate(results.map(({ brain }) => reciprocal(brain.rank))),
      sourceNotPassage: estimate(
        results.map(({ brain }) => sourceNotPassageOf(brain))
      ),
    },
    grep: {
      recall: estimate(results.map(({ grep }) => recallOf(grep.rank))),
      mrr: estimate(results.map(({ grep }) => reciprocal(grep.rank))),
      sourceNotPassage: estimate(
        results.map(({ grep }) => sourceNotPassageOf(grep))
      ),
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

/** What a question's groups are decided by: any result that says it can be grouped. */
export type Grouped = Pick<
  QuestionResult,
  "language" | "sourceLanguage" | "way" | "long" | "lookalike"
>;

const sameLanguage = (result: Grouped): boolean =>
  result.language === result.sourceLanguage;

const shortSource = (result: Grouped): boolean => !result.long;

/**
 * The groups a run is reported in, each a filter over answerable
 * questions, and whether it holds questions over long documents (`long`).
 * Over sources of one passage: all of them; asked in the language of their
 * source, pooled and per language; across languages; and each way of
 * finding a source, in the same language only, so a way's group measures
 * that way alone. Over long documents, apart: every question over one, in
 * any language and any way, and those whose answer has a look-alike. The
 * ways and languages were measured on sources of one passage, and mixing
 * in passages of long documents, where the right source is no longer
 * enough, would blur what each of them measures.
 */
export const groups: readonly {
  name: string;
  long: boolean;
  has: (result: Grouped) => boolean;
}[] = [
  { name: "All answerable", long: false, has: shortSource },
  {
    name: "Same language",
    long: false,
    has: (result: Grouped) => shortSource(result) && sameLanguage(result),
  },
  ...brainEvalLanguages.map((language) => ({
    name: languageNames[language],
    long: false,
    has: (result: Grouped) =>
      shortSource(result) &&
      sameLanguage(result) &&
      result.language === language,
  })),
  {
    name: "Across languages",
    long: false,
    has: (result: Grouped) => shortSource(result) && !sameLanguage(result),
  },
  ...brainEvalWays.map((way) => ({
    name: `Way: ${way}`,
    long: false,
    has: (result: Grouped) =>
      shortSource(result) && sameLanguage(result) && result.way === way,
  })),
  {
    name: "Long documents",
    long: true,
    has: (result: Grouped) => result.long,
  },
  {
    name: "Long documents: look-alike",
    long: true,
    has: (result: Grouped) => result.long && result.lookalike,
  },
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
  /** Every group's score, in the order of {@link groups}. */
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
    groups: groups.map(({ name, long, has }) =>
      scoreGroup(name, long, answerable.filter(has))
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
  /** Whether a verdict is given: only when the runs are comparable. */
  judged: boolean;
}

/**
 * What else decides a run's numbers, besides the Brain: the set (its
 * digest covers every source, reader, question, asker and team), how the
 * Brain's chunker cuts it into passages (what counts as found, which
 * questions are over long documents and grep's units), the most results a
 * recall returns, and the result budget recall is counted at.
 * `passagesDigest` is missing from a run written before it.
 */
export interface RunMeasure {
  setDigest: string;
  passagesDigest?: string | undefined;
  recallLimit: number;
  resultBudget: number;
}

/**
 * Whether two runs differ only in the Brain, so a difference in their
 * results is the Brain's: the same set, cut into the same passages, and the
 * same limit and budget. A run without a passage digest is never
 * comparable: its cut is unknown (and its set digest differs anyway, as it
 * predates long documents).
 */
export const comparable = (before: RunMeasure, now: RunMeasure): boolean =>
  before.setDigest === now.setDigest &&
  before.passagesDigest !== undefined &&
  before.passagesDigest === now.passagesDigest &&
  before.recallLimit === now.recallLimit &&
  before.resultBudget === now.resultBudget;

/**
 * The Brain's recall now against an earlier run's, per group, paired by
 * question: only questions in both whose digest is unchanged count, and
 * the sign test says whether more were gained than lost. A question's
 * rank depends on every other source, on how each is cut into passages and
 * on who may read it, so when the
 * runs aren't {@link comparable} the counts are shown without a verdict.
 */
export const compareRuns = (
  now: readonly QuestionResult[],
  before: readonly QuestionResult[],
  { judged }: { judged: boolean }
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
      judged,
      ...test,
      verdict: judged ? test.verdict : "same",
    };
  });
};

const fixed = (value: number): string => value.toFixed(2);

/** `0.62 ±0.11`: the mean and the larger half of its interval. */
export const withMargin = (value: Estimate | null): string =>
  value === null
    ? "–"
    : `${fixed(value.mean)} ±${fixed(Math.max(value.mean - value.low, value.high - value.mean))}`;

export const signed = (value: Estimate | null): string =>
  value === null
    ? "–"
    : `${value.mean >= 0 ? "+" : ""}${fixed(value.mean)} [${fixed(value.low)}, ${fixed(value.high)}]`;

export const pOf = ({ gained, lost, p }: SignTest): string =>
  gained + lost === 0 ? "–" : p.toFixed(3);

export const table = (
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

const qualityHeader = [
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
] as const;

const qualityRow = (group: GroupScore): string[] => [
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
];

/** The run's numbers as compact text tables. */
export const report = (
  summary: Summary,
  changes: readonly GroupChange[] | null
): string => {
  const quality = table(
    qualityHeader,
    summary.groups.filter(({ long }) => !long).map(qualityRow)
  );
  const longQuality = table(
    [...qualityHeader, "Brain source, not passage", "grep source, not passage"],
    summary.groups
      .filter(({ long }) => long)
      .map((group) => [
        ...qualityRow(group),
        withMargin(group.brain.sourceNotPassage),
        withMargin(group.grep.sourceNotPassage),
      ])
  );
  const { absent, hidden, leaks, latency } = summary;
  const lines = [
    quality,
    "",
    longQuality,
    "",
    `Long documents: questions over a source the Brain cuts into several passages, in any language and any way; such a question is found only when the passage that answers it is returned. "Source, not passage": a passage of the right source among the first ${resultBudget} results, but not the one that answers.`,
    "Every other group holds only questions over sources of one passage. grep ranks the same passages the Brain's chunker cuts.",
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
    const judged = changes.every((change) => change.judged);
    lines.push(
      "",
      judged
        ? judgedLine
        : "The set, how it is cut into passages, the result limit or the result budget changed since that run (or that run doesn't record its passages), and every rank depends on them: changes are shown, not judged.",
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
