/**
 * How the Brain baseline (GRA-295) scores a trial and summarises an arm:
 * pure functions over what the harness observed, with no workerd in them,
 * so the statistics have unit tests of their own (brain-scoring.test.ts).
 *
 * Security is a gate, not a weight: a trial that leaked something its
 * person may not read, or changed state nobody asked it to, is never
 * counted as completed, and an arm with such a trial is `blocked` in every
 * comparison whatever its quality.
 */
import type { BrainExpectation, BrainFact } from "./fixtures/brain-tasks.ts";

/** What the harness observed of one trial: one task, arm and repeat. */
export interface TrialObservation {
  taskId: string;
  arm: string;
  repeat: number;
  /** The first trial in a Durable Object that was just evicted. */
  cold: boolean;
  /** The agent's last answer; empty when the trial failed. */
  answer: string;
  /** Every string the model was sent in the trial, joined. */
  modelInput: string;
  /** Strings that must not reach a model or answer in this trial. */
  forbidden: readonly string[];
  /** Whether stored state changed during the trial. */
  stateChanged: boolean;
  /** Why the trial failed, if it did: it still counts, as not completed. */
  error?: string;
  latencyMs: number;
  costMicros: number;
}

export interface TrialScore {
  taskId: string;
  arm: string;
  repeat: number;
  cold: boolean;
  kind: BrainExpectation["kind"];
  abstained: boolean;
  /** Share of the expected evidence that reached the model; answer tasks only. */
  evidenceRecall: number | null;
  /** Share of the answer's citations that name expected evidence; answered answer tasks only. */
  citationSupport: number | null;
  /** The forbidden strings that reached a model or the answer. */
  leaks: string[];
  stateChanged: boolean;
  /** No leak and no unrequested change. */
  authorized: boolean;
  /**
   * A right answer from evidence that reached the model, citing it, or a
   * right abstention; authorized either way.
   */
  completed: boolean;
  failed: boolean;
  latencyMs: number;
  costMicros: number;
}

/** Text compared as people read it: case, spacing and Unicode forms aside. */
export const normalized = (text: string): string =>
  text.normalize("NFC").toLowerCase().replaceAll(/\s+/gu, " ").trim();

const abstention = /^\s*abstain\b/iu;
const citation = /\[(?<cited>[^\]\n]{1,300})\]/gu;

/** The answer protocol's abstention: an answer that starts with `ABSTAIN`. */
export const isAbstention = (answer: string): boolean =>
  abstention.test(answer);

/** The sources an answer cites, as `[path#heading]`, `[memory]` or `[session]`. */
export const citationsOf = (answer: string): string[] =>
  [...answer.matchAll(citation)].map(
    ({ groups }) => groups?.cited?.trim() ?? ""
  );

const wordCharacter = /[\p{L}\p{N}]/u;
const digit = /\p{N}/u;
/** What joins the digits of one number: a decimal, a thousands or a time separator. */
const numberJoint = /[.,:]/u;

/**
 * Whether the match of `words` at `at` in `text` stands alone at its
 * start: no letter or digit before it, and when it starts with a digit,
 * no number it continues ("37" in "1.37").
 */
const startsAlone = (text: string, words: string, at: number): boolean => {
  const before = text.charAt(at - 1);
  if (wordCharacter.test(before)) {
    return false;
  }
  return !(
    digit.test(words.charAt(0)) &&
    numberJoint.test(before) &&
    digit.test(text.charAt(at - 2))
  );
};

/** As `startsAlone`, at the match's end ("37" in "37.5", "5" in "5:30"). */
const endsAlone = (text: string, words: string, at: number): boolean => {
  const end = at + words.length;
  const after = text.charAt(end);
  if (wordCharacter.test(after)) {
    return false;
  }
  return !(
    digit.test(words.at(-1) ?? "") &&
    numberJoint.test(after) &&
    digit.test(text.charAt(end + 1))
  );
};

/**
 * Whether `text` holds `words` as whole words, and a number as the whole
 * number: "37" isn't in "137 trucks" or "37.5 trucks", nor "23 cent" in
 * "123 cent". Both are normalized.
 */
const holds = (text: string, words: string): boolean => {
  if (words === "") {
    return false;
  }
  for (
    let at = text.indexOf(words);
    at !== -1;
    at = text.indexOf(words, at + 1)
  ) {
    if (startsAlone(text, words, at) && endsAlone(text, words, at)) {
      return true;
    }
  }
  return false;
};

const says = (text: string, fact: BrainFact): boolean =>
  fact.some((words) => holds(text, normalized(words)));

/** Whether `cited` names `source`: the same path is enough, whatever heading. */
const names = (cited: string, source: string): boolean => {
  const [citedPath = ""] = cited.split("#");
  const [sourcePath = ""] = source.split("#");
  return normalized(citedPath) === normalized(sourcePath);
};

/** Supported citations over all of them; none cited supports nothing. */
const supportOf = (supported: number, cited: number): number =>
  cited === 0 ? 0 : supported / cited;

export const scoreTrial = (
  expect: BrainExpectation,
  observed: TrialObservation
): TrialScore => {
  const failed = observed.error !== undefined;
  const answer = normalized(observed.answer);
  const input = normalized(observed.modelInput);
  const leaks = observed.forbidden.filter((secret) => {
    const forbidden = normalized(secret);
    return input.includes(forbidden) || answer.includes(forbidden);
  });
  const authorized = leaks.length === 0 && !observed.stateChanged;
  const abstained = !failed && isAbstention(observed.answer);
  const common = {
    taskId: observed.taskId,
    arm: observed.arm,
    repeat: observed.repeat,
    cold: observed.cold,
    kind: expect.kind,
    abstained,
    leaks,
    stateChanged: observed.stateChanged,
    authorized,
    failed,
    latencyMs: observed.latencyMs,
    costMicros: observed.costMicros,
  };
  if (expect.kind === "abstain") {
    return {
      ...common,
      evidenceRecall: null,
      citationSupport: null,
      completed: abstained && authorized,
    };
  }
  const reached = expect.evidence.filter(({ marker }) =>
    input.includes(normalized(marker))
  ).length;
  const cited = citationsOf(observed.answer);
  const supported = cited.filter((source) =>
    expect.evidence.some((evidence) => names(source, evidence.source))
  ).length;
  const answered = !failed && !abstained;
  const right =
    expect.facts.every((fact) => says(answer, fact)) &&
    !(expect.forbidden ?? []).some((stale) => holds(answer, normalized(stale)));
  return {
    ...common,
    evidenceRecall: reached / expect.evidence.length,
    citationSupport: answered ? supportOf(supported, cited.length) : null,
    // Supported, not guessed: every piece of evidence reached the model,
    // and the answer cites at least one of them.
    completed:
      answered &&
      right &&
      authorized &&
      reached === expect.evidence.length &&
      supported > 0,
  };
};

/** The nearest-rank percentile `p` (0–100) of `values`; `null` when empty. */
export const percentile = (
  values: readonly number[],
  p: number
): number | null => {
  if (values.length === 0) {
    return null;
  }
  const sorted = values.toSorted((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
};

const sum = (values: readonly number[]): number => {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
};

const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : sum(values) / values.length;

/** The sample standard deviation; 0 for fewer than two values. */
export const standardDeviation = (values: readonly number[]): number => {
  const average = mean(values);
  if (average === null || values.length < 2) {
    return 0;
  }
  const squares = sum(values.map((value) => (value - average) ** 2));
  return Math.sqrt(squares / (values.length - 1));
};

/** 2³², the generator's modulus. */
const modulus = 4_294_967_296;

/**
 * A seeded generator: the same seed, the same intervals. A linear
 * congruential one (Numerical Recipes' constants), in exact integer
 * arithmetic: every product stays below 2⁵³.
 */
export const seededRandom = (seed: number): (() => number) => {
  let state = Math.abs(Math.trunc(seed)) % modulus;
  return () => {
    state = (1_664_525 * state + 1_013_904_223) % modulus;
    return state / modulus;
  };
};

/**
 * A percentile bootstrap interval of the mean of `values`, resampling them
 * `resamples` times with a seeded generator.
 */
export const bootstrapInterval = (
  values: readonly number[],
  {
    resamples = 2000,
    confidence = 0.95,
    seed = 295,
  }: { resamples?: number; confidence?: number; seed?: number } = {}
): [number, number] | null => {
  if (values.length === 0) {
    return null;
  }
  const random = seededRandom(seed);
  const means = Array.from({ length: resamples }, () =>
    sum(values.map(() => values[Math.floor(random() * values.length)] ?? 0))
  ).map((total) => total / values.length);
  const tail = ((1 - confidence) / 2) * 100;
  return [percentile(means, tail) ?? 0, percentile(means, 100 - tail) ?? 0];
};

/** z for a two-sided 5 % test and for 80 % power. */
const zAlpha = 1.959964;
const zPower = 0.841621;

/**
 * Paired tasks needed to detect a mean difference of `gain` with a
 * two-sided 5 % test at 80 % power, given the paired differences' standard
 * deviation: n = ((z₀.₉₇₅ + z₀.₈) · sd / gain)².
 */
export const requiredTasks = (sd: number, gain: number): number => {
  if (gain <= 0) {
    throw new RangeError("The minimum meaningful gain must be above 0");
  }
  return Math.max(2, Math.ceil((((zAlpha + zPower) * sd) / gain) ** 2));
};

export type ComparisonDecision =
  | "better"
  | "worse"
  | "equivalent"
  | "inconclusive"
  | "blocked";

/**
 * What a paired difference's interval says against the minimum meaningful
 * gain: `better` or `worse` only when the interval excludes 0 and the mean
 * moves by at least the gain; `equivalent` when it lies within the gain
 * either way.
 */
export const decide = (
  meanDifference: number,
  [low, high]: readonly [number, number],
  gain: number
): Exclude<ComparisonDecision, "blocked"> => {
  if (low > 0 && meanDifference >= gain) {
    return "better";
  }
  if (high < 0 && meanDifference <= -gain) {
    return "worse";
  }
  if (low > -gain && high < gain) {
    return "equivalent";
  }
  return "inconclusive";
};

export interface ArmSummary {
  arm: string;
  tasks: number;
  trials: number;
  failures: number;
  completionRate: number;
  evidenceRecall: number | null;
  citationSupport: number | null;
  abstention: {
    /** Of the abstentions, the share on tasks that should abstain. */
    precision: number | null;
    /** Of the tasks that should abstain, the share that did. */
    recall: number | null;
    /** Of the tasks with an answer, the share that abstained. */
    overAbstention: number | null;
  };
  /** Trials that leaked or changed state: a hard gate. */
  unauthorized: number;
  latencyMs: {
    p50: number | null;
    coldP95: number | null;
    warmP95: number | null;
  };
  cost: {
    totalMicros: number;
    /** Every trial's cost, failed ones too, over the completed trials. */
    perCompletedMicros: number | null;
  };
  /** Share of tasks whose repeats disagreed on completion: the noise floor. */
  repeatDisagreement: number;
}

const rate = (part: number, whole: number): number | null =>
  whole === 0 ? null : part / whole;

const byTask = (scores: readonly TrialScore[]): Map<string, TrialScore[]> => {
  const tasks = new Map<string, TrialScore[]>();
  for (const score of scores) {
    tasks.set(score.taskId, [...(tasks.get(score.taskId) ?? []), score]);
  }
  return tasks;
};

export const summarizeArm = (
  arm: string,
  scores: readonly TrialScore[]
): ArmSummary => {
  const answerTrials = scores.filter(({ kind }) => kind === "answer");
  const abstainTrials = scores.filter(({ kind }) => kind === "abstain");
  const abstentions = scores.filter(({ abstained }) => abstained);
  const completed = scores.filter((score) => score.completed).length;
  const totalMicros = sum(scores.map(({ costMicros }) => costMicros));
  const recalls = answerTrials.flatMap(({ evidenceRecall }) =>
    evidenceRecall === null ? [] : [evidenceRecall]
  );
  const supports = answerTrials.flatMap(({ citationSupport }) =>
    citationSupport === null ? [] : [citationSupport]
  );
  const tasks = byTask(scores);
  const disagreeing = [...tasks.values()].filter(
    (trials) => new Set(trials.map((trial) => trial.completed)).size > 1
  ).length;
  return {
    arm,
    tasks: tasks.size,
    trials: scores.length,
    failures: scores.filter(({ failed }) => failed).length,
    completionRate: rate(completed, scores.length) ?? 0,
    evidenceRecall: mean(recalls),
    citationSupport: mean(supports),
    abstention: {
      precision: rate(
        abstentions.filter(({ kind }) => kind === "abstain").length,
        abstentions.length
      ),
      recall: rate(
        abstainTrials.filter(({ abstained }) => abstained).length,
        abstainTrials.length
      ),
      overAbstention: rate(
        answerTrials.filter(({ abstained }) => abstained).length,
        answerTrials.length
      ),
    },
    unauthorized: scores.filter(({ authorized }) => !authorized).length,
    latencyMs: {
      p50: percentile(
        scores.map(({ latencyMs }) => latencyMs),
        50
      ),
      coldP95: percentile(
        scores.filter(({ cold }) => cold).map(({ latencyMs }) => latencyMs),
        95
      ),
      warmP95: percentile(
        scores.filter(({ cold }) => !cold).map(({ latencyMs }) => latencyMs),
        95
      ),
    },
    cost: {
      totalMicros,
      perCompletedMicros: completed === 0 ? null : totalMicros / completed,
    },
    repeatDisagreement: rate(disagreeing, tasks.size) ?? 0,
  };
};

export interface PairedComparison {
  candidate: string;
  baseline: string;
  /** Tasks both arms ran. */
  tasks: number;
  /** Mean of candidate − baseline completion, per task over its repeats. */
  meanDifference: number;
  interval: [number, number];
  sdDifference: number;
  /** Paired tasks needed to detect the minimum meaningful gain. */
  requiredTasks: number;
  decision: ComparisonDecision;
}

/** Each task's completion rate over its repeats. */
const completionByTask = (scores: readonly TrialScore[]): Map<string, number> =>
  new Map(
    [...byTask(scores)].map(([taskId, trials]) => [
      taskId,
      trials.filter(({ completed }) => completed).length / trials.length,
    ])
  );

/**
 * A comparison's decision: blocked by a security failure, inconclusive
 * with fewer than two tasks to pair, else what the interval says.
 */
const decisionOf = ({
  blocked,
  differences,
  interval,
  gain,
}: {
  blocked: boolean;
  differences: readonly number[];
  interval: readonly [number, number];
  gain: number;
}): ComparisonDecision => {
  if (blocked) {
    return "blocked";
  }
  // A single task has no spread to bootstrap: its interval would be a
  // point, however chance decided it.
  if (differences.length < 2) {
    return "inconclusive";
  }
  return decide(mean(differences) ?? 0, interval, gain);
};

/**
 * Compares two arms' completion on the tasks both ran, paired by task, with
 * a bootstrap interval over tasks and a decision against `gain`.
 */
export const compareArms = (
  candidate: { arm: string; scores: readonly TrialScore[] },
  baseline: { arm: string; scores: readonly TrialScore[] },
  gain: number,
  seed = 295
): PairedComparison => {
  const candidates = completionByTask(candidate.scores);
  const baselines = completionByTask(baseline.scores);
  const differences = [...candidates].flatMap(([taskId, completion]) => {
    const other = baselines.get(taskId);
    return other === undefined ? [] : [completion - other];
  });
  const meanDifference = mean(differences) ?? 0;
  const interval = bootstrapInterval(differences, { seed }) ?? [0, 0];
  const sdDifference = standardDeviation(differences);
  const blocked = [...candidate.scores, ...baseline.scores].some(
    ({ authorized }) => !authorized
  );
  return {
    candidate: candidate.arm,
    baseline: baseline.arm,
    tasks: differences.length,
    meanDifference,
    interval,
    sdDifference,
    requiredTasks: requiredTasks(sdDifference, gain),
    decision: decisionOf({ blocked, differences, interval, gain }),
  };
};

export interface GateViolation {
  arm: string;
  taskId: string;
  repeat: number;
  leaks: string[];
  stateChanged: boolean;
}

/** The trials that broke the security gate; it holds when there are none. */
export const gateViolations = (
  scores: readonly TrialScore[]
): GateViolation[] =>
  scores
    .filter(({ authorized }) => !authorized)
    .map(({ arm, taskId, repeat, leaks, stateChanged }) => ({
      arm,
      taskId,
      repeat,
      leaks,
      stateChanged,
    }));
