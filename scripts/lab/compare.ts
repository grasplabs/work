/**
 * How two runs compare. A difference counts only when it is larger than
 * what two runs of the same Stephen on the same cases differ by: that is
 * the noise, and it is measured, never assumed. Pure. Ported from the
 * prototype (grasplabs/prototype, packages/grasp: meansOf, noiseOf and
 * compare in src/lib/lab.ts).
 */
import type { CaseScore } from "./results.ts";

/** Numbers where less is better; the rest are better when higher. */
export const lessIsBetter: ReadonlySet<string> = new Set([
  "repeats",
  "notSaid",
  "mistakes",
  "taken",
  "wasted",
]);

/** Numbers that say how much there was, not how good it was: shown, never judged. */
export const neutral: ReadonlySet<string> = new Set([
  "notes",
  "answers",
  "stephenShare",
  "steps",
]);

/** Numbers that are a count for each case, never a share. */
export const counts: ReadonlySet<string> = new Set([
  "notes",
  "answers",
  "steps",
  "wasted",
]);

/** The smallest change that counts even when two runs of the same Stephen were the same. */
const least = 0.02;

const mean = (values: readonly number[]): number =>
  values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;

const metricsOf = (cases: readonly CaseScore[]): string[] => [
  ...new Set(cases.flatMap((each) => Object.keys(each.scores))),
];

/** The mean of every number over the cases that have it. */
export const meansOf = (cases: readonly CaseScore[]): Record<string, number> =>
  Object.fromEntries(
    metricsOf(cases).map((metric) => [
      metric,
      mean(cases.flatMap((each) => each.scores[metric] ?? [])),
    ])
  );

/** The cases two runs share, for one number: the two values of each. */
const pairsOf = (
  a: readonly CaseScore[],
  b: readonly CaseScore[],
  metric: string
): [number, number][] =>
  a.flatMap((each): [number, number][] => {
    const one = each.scores[metric];
    const other = b.find((found) => found.id === each.id)?.scores[metric];
    return one === undefined || other === undefined ? [] : [[one, other]];
  });

/** Every two of some runs, each pair once. */
const twosOf = <T>(items: readonly T[]): [T, T][] =>
  items.flatMap((first, at) =>
    items.slice(at + 1).map((second): [T, T] => [first, second])
  );

/**
 * What runs of the same Stephen on the same cases differ by, per number:
 * how far the mean of one run lies from the mean of another over the cases
 * both have, averaged over every two of them. None with fewer than two runs.
 */
export const noiseOf = (
  runs: readonly { cases: readonly CaseScore[] }[]
): Record<string, number> | null => {
  if (runs.length < 2) {
    return null;
  }
  const metrics = metricsOf(runs.flatMap((run) => run.cases));
  return Object.fromEntries(
    metrics.map((metric) => [
      metric,
      mean(
        twosOf(runs).flatMap(([first, second]) => {
          const pairs = pairsOf(first.cases, second.cases, metric);
          return pairs.length === 0
            ? []
            : [Math.abs(mean(pairs.map(([one, other]) => other - one)))];
        })
      ),
    ])
  );
};

export const verdicts = [
  "better",
  "worse",
  "no difference",
  "noise not measured",
  "not judged",
] as const;
export type Verdict = (typeof verdicts)[number];

export interface Compared {
  metric: string;
  /** The cases both runs have a value for. */
  cases: number;
  before: number;
  after: number;
  /** After minus before, over those cases. */
  change: number;
  /** Cases that went up, and that went down. */
  up: number;
  down: number;
  noise: number | null;
  verdict: Verdict;
}

const verdictOf = (
  metric: string,
  change: number,
  noise: Record<string, number> | null
): Verdict => {
  if (neutral.has(metric)) {
    return "not judged";
  }
  const measured = noise?.[metric];
  if (measured === undefined) {
    return "noise not measured";
  }
  const bar = Math.max(measured, least);
  const good = lessIsBetter.has(metric) ? -change : change;
  if (good > bar) {
    return "better";
  }
  return good < -bar ? "worse" : "no difference";
};

/**
 * Two runs of the same bench on the same cases, number by number, each
 * with a verdict. `noise` is from runs of the first one's Stephen
 * (`noiseOf`); without it nothing is called better or worse.
 */
export const compare = (
  before: { cases: readonly CaseScore[] },
  after: { cases: readonly CaseScore[] },
  noise: Record<string, number> | null
): Compared[] =>
  metricsOf([...before.cases, ...after.cases]).flatMap((metric) => {
    const pairs = pairsOf(before.cases, after.cases, metric);
    if (pairs.length === 0) {
      return [];
    }
    const change = mean(pairs.map(([one, other]) => other - one));
    return [
      {
        metric,
        cases: pairs.length,
        before: mean(pairs.map(([one]) => one)),
        after: mean(pairs.map(([, other]) => other)),
        change,
        up: pairs.filter(([one, other]) => other > one).length,
        down: pairs.filter(([one, other]) => other < one).length,
        noise: noise?.[metric] ?? null,
        verdict: verdictOf(metric, change, noise),
      },
    ];
  });

/** A number as people read it: a share in percent, a count with one decimal. */
export const shown = (metric: string, value: number): string =>
  counts.has(metric) || Math.abs(value) > 1
    ? value.toFixed(1)
    : `${Math.round(value * 100)}%`;
