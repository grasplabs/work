/**
 * How experiment E02 (GRA-304) scores a recall and decides on a policy:
 * pure functions over what brain-recall-harness.ts observed, with unit
 * tests of their own (brain-recall-scoring.test.ts).
 *
 * Quality is where an arm ranks the result that quotes a case's evidence:
 * its reciprocal rank (1 first, ½ second, 0 when it isn't among the
 * results) and whether it is in the top {@link recallTopK}. Security is a
 * gate, as in E01: an arm that quoted anything a case's reader may not
 * read, or an outdated version, is blocked whatever its quality.
 *
 * A candidate policy is adopted over full-text search only when it is
 * better by at least the minimum meaningful gain, with a paired interval
 * that excludes 0, within {@link recallBudgets}, and measured against a
 * real model: a stubbed reranker's numbers prove the harness, not the
 * policy.
 */
import {
  bootstrapInterval,
  decide,
  percentile,
  requiredTasks,
  standardDeviation,
} from "./brain-scoring.ts";
import type { ComparisonDecision } from "./brain-scoring.ts";
import type { BrainLanguage } from "./fixtures/brain-corpus.ts";
import type {
  BrainRecallCase,
  BrainRecallKind,
} from "./fixtures/brain-recall-cases.ts";

/** The results a reader looks at: a hit below them is as good as a miss. */
export const recallTopK = 5;

/**
 * What a policy must stay within to be adopted, per recall: its p95
 * latency, cold (first asked) and warm (asked again), and its cost. The
 * deadline a recall gets by default (`recallDefaults.deadlineMs`, 5 s) is
 * the ceiling of both latencies; a rerank's model call costs at most a
 * tenth of a cent. Targets, to be confirmed against a real model's run.
 */
export const recallBudgets = {
  coldP95Ms: 5000,
  warmP95Ms: 1000,
  costMicrosPerRecall: 1000,
} as const;

/** What the harness observed of one recall: one case, arm, repeat and phase. */
export interface RecallObservation {
  caseId: string;
  arm: string;
  repeat: number;
  /** `cold`: first asked; `warm`: the same reader asking it again. */
  phase: "cold" | "warm";
  /** The text of each result, best first. */
  texts: readonly string[];
  /** Whether the result quoting the marker cites the document it is in. */
  cited: boolean | null;
  latencyMs: number;
  costMicros: number;
  /** A lane failed, timed out or was skipped: what's missing proves nothing. */
  degraded: boolean;
}

export interface RecallScore {
  caseId: string;
  arm: string;
  repeat: number;
  phase: "cold" | "warm";
  kind: BrainRecallKind;
  language: BrainLanguage;
  /** 1-based rank of the first result quoting the marker; `null` when none does. */
  rank: number | null;
  /** 1 / rank, 0 for a miss; `null` for a case that expects nothing. */
  reciprocalRank: number | null;
  /** Whether that result is in the top K; `null` for a case that expects nothing. */
  hit: boolean | null;
  cited: boolean | null;
  /** Forbidden strings any result quoted. */
  leaks: string[];
  latencyMs: number;
  costMicros: number;
  degraded: boolean;
}

/** 1 / `rank`, 0 for a miss. */
const reciprocalOf = (rank: number | null): number =>
  rank === null ? 0 : 1 / rank;

export const scoreRecall = (
  recallCase: BrainRecallCase,
  observation: RecallObservation
): RecallScore => {
  const { marker, forbidden = [] } = recallCase;
  const index =
    marker === undefined
      ? -1
      : observation.texts.findIndex((text) => text.includes(marker));
  const rank = index === -1 ? null : index + 1;
  const expects = marker !== undefined;
  return {
    caseId: recallCase.id,
    arm: observation.arm,
    repeat: observation.repeat,
    phase: observation.phase,
    kind: recallCase.kind,
    language: recallCase.language,
    rank,
    reciprocalRank: expects ? reciprocalOf(rank) : null,
    hit: expects ? rank !== null && rank <= recallTopK : null,
    cited: observation.cited,
    leaks: forbidden.filter((text) =>
      observation.texts.some((each) => each.includes(text))
    ),
    latencyMs: observation.latencyMs,
    costMicros: observation.costMicros,
    degraded: observation.degraded,
  };
};

const mean = (values: readonly number[]): number | null =>
  values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0) / values.length;

const ranked = (scores: readonly RecallScore[]) =>
  scores.flatMap((score) =>
    score.reciprocalRank === null || score.hit === null
      ? []
      : [{ reciprocalRank: score.reciprocalRank, hit: score.hit }]
  );

/** Mean reciprocal rank and top-K hit rate of `scores`; `null` when none expects anything. */
const qualityOf = (scores: readonly RecallScore[]) => {
  const expecting = ranked(scores);
  return {
    mrr: mean(expecting.map(({ reciprocalRank }) => reciprocalRank)),
    hitRate: mean(expecting.map(({ hit }) => (hit ? 1 : 0))),
  };
};

export interface RecallArmSummary {
  arm: string;
  cases: number;
  recalls: number;
  /** Over cold recalls: what a reader asking first gets. */
  mrr: number | null;
  hitRate: number | null;
  byLanguage: Partial<
    Record<BrainLanguage, { mrr: number | null; hitRate: number | null }>
  >;
  byKind: Partial<
    Record<BrainRecallKind, { mrr: number | null; hitRate: number | null }>
  >;
  /** Share of found evidence whose result cites its document. */
  citationSupport: number | null;
  /** Recalls that quoted something forbidden: any blocks the arm. */
  leaking: number;
  degraded: number;
  /** Whether a warm recall ranked differently from its cold one. */
  unstable: number;
  latencyMs: { coldP95: number | null; warmP95: number | null };
  costMicrosPerRecall: number | null;
}

const qualityByGroup = <K extends string>(
  scores: readonly RecallScore[],
  keyOf: (score: RecallScore) => K
) => {
  const quality: Partial<
    Record<K, { mrr: number | null; hitRate: number | null }>
  > = {};
  for (const [key, group] of Map.groupBy(scores, keyOf)) {
    quality[key] = qualityOf(group);
  }
  return quality;
};

const pairKey = ({ caseId, repeat }: RecallScore): string =>
  `${caseId}\u0000${repeat}`;

export const summarizeRecallArm = (
  arm: string,
  scores: readonly RecallScore[]
): RecallArmSummary => {
  const cold = scores.filter(({ phase }) => phase === "cold");
  const warm = scores.filter(({ phase }) => phase === "warm");
  const coldRanks = new Map(cold.map((score) => [pairKey(score), score.rank]));
  const found = cold.filter(
    ({ rank, cited }) => rank !== null && cited !== null
  );
  return {
    arm,
    cases: new Set(scores.map(({ caseId }) => caseId)).size,
    recalls: scores.length,
    ...qualityOf(cold),
    byLanguage: qualityByGroup(cold, ({ language }) => language),
    byKind: qualityByGroup(cold, ({ kind }) => kind),
    citationSupport: mean(found.map(({ cited }) => (cited === true ? 1 : 0))),
    leaking: scores.filter(({ leaks }) => leaks.length > 0).length,
    degraded: scores.filter(({ degraded }) => degraded).length,
    unstable: warm.filter(
      (score) =>
        coldRanks.has(pairKey(score)) &&
        coldRanks.get(pairKey(score)) !== score.rank
    ).length,
    latencyMs: {
      coldP95: percentile(
        cold.map(({ latencyMs }) => latencyMs),
        95
      ),
      warmP95: percentile(
        warm.map(({ latencyMs }) => latencyMs),
        95
      ),
    },
    costMicrosPerRecall: mean(scores.map(({ costMicros }) => costMicros)),
  };
};

export interface RecallComparison {
  candidate: string;
  baseline: string;
  /** Cases both arms answered, paired, each averaged over its repeats. */
  cases: number;
  /** Mean of the candidate's reciprocal rank less the baseline's. */
  meanDifference: number;
  interval: [number, number];
  sdDifference: number;
  requiredCases: number;
  decision: ComparisonDecision;
}

/** Each case's mean cold reciprocal rank over its repeats. */
const rankByCase = (scores: readonly RecallScore[]) => {
  const byCase = new Map<string, number[]>();
  for (const score of scores) {
    if (score.phase === "cold" && score.reciprocalRank !== null) {
      const ranks = byCase.get(score.caseId) ?? [];
      ranks.push(score.reciprocalRank);
      byCase.set(score.caseId, ranks);
    }
  }
  return new Map(
    [...byCase].map(([caseId, ranks]) => [caseId, mean(ranks) ?? 0])
  );
};

const decisionOf = (
  blocked: boolean,
  cases: number,
  meanDifference: number,
  interval: [number, number],
  gain: number
): ComparisonDecision => {
  if (blocked) {
    return "blocked";
  }
  return cases === 0 ? "inconclusive" : decide(meanDifference, interval, gain);
};

/**
 * The candidate against the baseline, paired by case, on reciprocal rank,
 * with a seeded bootstrap interval: `blocked` when either leaked.
 */
export const compareRecallArms = (
  candidate: { arm: string; scores: readonly RecallScore[] },
  baseline: { arm: string; scores: readonly RecallScore[] },
  gain: number,
  seed = 304
): RecallComparison => {
  const baselines = rankByCase(baseline.scores);
  const differences = [...rankByCase(candidate.scores)].flatMap(
    ([caseId, rank]) => {
      const other = baselines.get(caseId);
      return other === undefined ? [] : [rank - other];
    }
  );
  const meanDifference = mean(differences) ?? 0;
  const interval = bootstrapInterval(differences, { seed }) ?? [0, 0];
  const sdDifference = standardDeviation(differences);
  const blocked = [...candidate.scores, ...baseline.scores].some(
    ({ leaks }) => leaks.length > 0
  );
  return {
    candidate: candidate.arm,
    baseline: baseline.arm,
    cases: differences.length,
    meanDifference,
    interval,
    sdDifference,
    requiredCases: requiredTasks(sdDifference, gain),
    decision: decisionOf(
      blocked,
      differences.length,
      meanDifference,
      interval,
      gain
    ),
  };
};

export interface RecallAdoption {
  arm: string;
  decision: "adopt" | "keep-baseline" | "needs-real-model";
  /** Why it isn't adopted: each comparison or budget it missed. */
  reasons: string[];
}

const overBudget = (summary: RecallArmSummary): string[] => {
  const { coldP95, warmP95 } = summary.latencyMs;
  return [
    coldP95 !== null && coldP95 > recallBudgets.coldP95Ms
      ? "latency.cold-p95"
      : [],
    warmP95 !== null && warmP95 > recallBudgets.warmP95Ms
      ? "latency.warm-p95"
      : [],
    summary.costMicrosPerRecall !== null &&
    summary.costMicrosPerRecall > recallBudgets.costMicrosPerRecall
      ? "cost.per-recall"
      : [],
    summary.leaking > 0 ? "security.leak" : [],
  ].flat();
};

/**
 * Whether `summary`'s policy may replace the baseline: better on quality,
 * within every budget, and measured with a real model (`measured`).
 */
export const recallAdoption = (
  summary: RecallArmSummary,
  comparison: RecallComparison,
  { measured }: { measured: boolean }
): RecallAdoption => {
  const reasons = [
    ...(comparison.decision === "better"
      ? []
      : [`quality.${comparison.decision}`]),
    ...overBudget(summary),
  ];
  if (!measured) {
    return { arm: summary.arm, decision: "needs-real-model", reasons };
  }
  return {
    arm: summary.arm,
    decision: reasons.length === 0 ? "adopt" : "keep-baseline",
    reasons,
  };
};

/**
 * How long an arm took to find what a write wrote: from its first ask
 * after the write until the ask that found it began, 0 when the first
 * did; `null` when none did within the harness's limit.
 */
export interface UpdateLag {
  caseId: string;
  arm: string;
  /** How long after the write the arm was first asked: arms take turns. */
  firstAskedAfterMs: number;
  lagMs: number | null;
}

/** How `lags` went: how many caught up, how many never did, and the longest of those that did. */
export const lagSummary = (lags: readonly UpdateLag[]) => {
  const caughtUp = lags.flatMap(({ lagMs }) => (lagMs === null ? [] : [lagMs]));
  return {
    caughtUp: caughtUp.length,
    never: lags.length - caughtUp.length,
    worstMs: caughtUp.length === 0 ? null : Math.max(...caughtUp),
  };
};
