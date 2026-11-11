/**
 * How the Brain evaluation (GRA-1726) scores a run: pure functions over
 * what apps/core/test/brain-eval.test.ts printed, one result per question.
 * scripts/brain-eval.ts runs it and prints and keeps what these return.
 *
 * Retrieval only, no model: is the question's source among the first
 * {@link resultBudget} results (recall at that budget: each question has
 * one source, so it is whether it was found), and where (the reciprocal of
 * its rank). Each comes with a 95% interval, by a seeded bootstrap over
 * questions, so a difference narrower than it means nothing.
 */
import { z } from "zod";

/** How many results a reader is counted as looking at. */
export const resultBudget = 5;

/** Bootstrap resamples for every interval. */
const resamples = 2000;

/** The latency targets, from the design: half within 0.4 s, 95% within 1 s. */
export const latencyTargetsMs = { p50: 400, p95: 1000 } as const;

const languageSchema = z.enum(["en", "nl", "de", "fr", "es"]);
const waySchema = z.enum(["words", "forms", "exact", "paraphrase"]);
export type Way = z.infer<typeof waySchema>;

const armSchema = z.object({
  rank: z.int().positive().nullable(),
  returned: z.int().nonnegative(),
  leaks: z.array(z.string()),
});

/** One question's result, as the run printed it. */
export const questionResultSchema = z.object({
  id: z.string(),
  digest: z.string(),
  language: languageSchema,
  sourceLanguage: languageSchema.nullable(),
  expects: z.enum(["answer", "absent", "hidden"]),
  way: waySchema.nullable(),
  brain: armSchema.extend({ ms: z.number().nonnegative() }),
  grep: armSchema,
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

const found = (rank: number | null): number =>
  rank !== null && rank <= resultBudget ? 1 : 0;

const reciprocal = (rank: number | null): number =>
  rank === null ? 0 : 1 / rank;

export interface ArmScore {
  recall: Estimate | null;
  mrr: Estimate | null;
}

export interface GroupScore {
  group: string;
  questions: number;
  brain: ArmScore;
  grep: ArmScore;
  /** The Brain's recall less plain text search's, paired by question. */
  brainOverGrep: Estimate | null;
}

const scoreGroup = (
  group: string,
  results: readonly QuestionResult[]
): GroupScore => ({
  group,
  questions: results.length,
  brain: {
    recall: estimate(results.map(({ brain }) => found(brain.rank))),
    mrr: estimate(results.map(({ brain }) => reciprocal(brain.rank))),
  },
  grep: {
    recall: estimate(results.map(({ grep }) => found(grep.rank))),
    mrr: estimate(results.map(({ grep }) => reciprocal(grep.rank))),
  },
  brainOverGrep: estimate(
    results.map(({ brain, grep }) => found(brain.rank) - found(grep.rank))
  ),
});

const languageNames = {
  en: "English",
  nl: "Dutch (written in Dutch)",
  de: "German",
  fr: "French",
  es: "Spanish",
} as const;

/**
 * The groups a run is reported in, each a filter over answerable
 * questions: all of them, each language asked of its own documents,
 * across languages, and each way of finding a source.
 */
export const groups: readonly {
  name: string;
  has: (result: QuestionResult) => boolean;
}[] = [
  { name: "All answerable", has: () => true },
  ...languageSchema.options.map((language) => ({
    name: languageNames[language],
    has: (result: QuestionResult) =>
      result.language === language && result.sourceLanguage === language,
  })),
  {
    name: "Across languages",
    has: (result: QuestionResult) => result.language !== result.sourceLanguage,
  },
  ...waySchema.options.map((way) => ({
    name: `Way: ${way}`,
    has: (result: QuestionResult) => result.way === way,
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
  /** Questions whose answer is hidden from the asker: what leaked. */
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

export type Verdict = "better" | "worse" | "same";

export interface GroupChange {
  group: string;
  /** Questions in both runs, unchanged. */
  paired: number;
  /** This run's recall less the earlier one's, paired by question. */
  change: Estimate | null;
  verdict: Verdict;
}

const verdictOf = (change: Estimate | null): Verdict => {
  if (change === null || (change.low <= 0 && change.high >= 0)) {
    return "same";
  }
  return change.low > 0 ? "better" : "worse";
};

/**
 * The Brain's recall now against an earlier run's, per group, paired by
 * question: only questions in both whose digest is unchanged count.
 * `better` or `worse` only when the interval leaves out no change.
 */
export const compareRuns = (
  now: readonly QuestionResult[],
  before: readonly QuestionResult[]
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
    const change = estimate(
      paired.map(
        ({ result, previous }) =>
          found(result.brain.rank) - found(previous.brain.rank)
      )
    );
    return {
      group: name,
      paired: paired.length,
      change,
      verdict: verdictOf(change),
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

/** The run's numbers as compact text tables. */
export const report = (
  summary: Summary,
  changes: readonly GroupChange[] | null
): string => {
  const quality = table(
    [
      "Group",
      "n",
      `Brain recall@${resultBudget}`,
      `grep recall@${resultBudget}`,
      "Brain − grep [95%]",
      "Brain MRR",
      "grep MRR",
    ],
    summary.groups.map((group) => [
      group.group,
      String(group.questions),
      withMargin(group.brain.recall),
      withMargin(group.grep.recall),
      signed(group.brainOverGrep),
      withMargin(group.brain.mrr),
      withMargin(group.grep.mrr),
    ])
  );
  const { absent, hidden, leaks, latency } = summary;
  const lines = [
    quality,
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
    lines.push(
      "",
      table(
        [
          "Against the last run",
          "paired",
          `Δ Brain recall@${resultBudget} [95%]`,
          "verdict",
        ],
        changes.map((change) => [
          change.group,
          String(change.paired),
          signed(change.change),
          change.verdict,
        ])
      )
    );
  }
  return lines.join("\n");
};
