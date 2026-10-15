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
import type { TranscriptPart } from "./brain-stub-model.ts";
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
  /** Every string the model was sent in the trial, joined: for leaks. */
  modelInput: string;
  /**
   * The chat as the model read it, request after request, each part marked
   * by who wrote it. Evidence counts where a source gave it before the
   * model wrote it, or where a tool result holds the whole stored line it
   * is in (`corpus`) before the model wrote that line itself. The corpus
   * is made up and the model starts each trial knowing none of it: a
   * whole line can only reach a tool result through a read, never through
   * code the model writes before it has read the line.
   */
  transcript: readonly TranscriptPart[];
  /** Every corpus document and memory as stored when the trial ran. */
  corpus: readonly string[];
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
/** The protocol's answer line: `ANSWER:` and only the answer, on one line. */
const answerLine = /^\s*answer:(?<answer>[^\n]*)/iu;
/**
 * Words that turn an answer line around ("not Marta Ruiz"), in the five
 * languages: such a line asserts nothing the task can check.
 */
const negation =
  /(?<![\p{L}\p{N}])(?:not|no|never|niet|geen|nooit|nicht|kein|keine|nie|pas|jamais|nunca|ninguno)(?![\p{L}\p{N}])/iu;
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
/**
 * What joins the digits of one number: a decimal, thousands, time or date
 * separator.
 */
const numberJoint = /[.,:\-\u2212]/u;
/** A sign, or the hyphen of a date or range, before a number. */
const signed = /[-+\u2212]/u;

/**
 * Whether the match of `words` at `at` in `text` stands alone at its
 * start: no letter or digit before it, and when it starts with a digit,
 * no sign and no number it continues ("37" in "-37", "1.37" or
 * "2026-37").
 */
const startsAlone = (text: string, words: string, at: number): boolean => {
  const before = text.charAt(at - 1);
  if (wordCharacter.test(before)) {
    return false;
  }
  if (!digit.test(words.charAt(0))) {
    return true;
  }
  return !(
    signed.test(before) ||
    (numberJoint.test(before) && digit.test(text.charAt(at - 2)))
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

const trailing = /[\s.,!]+$/u;

/**
 * Whether one value of the answer line says `fact`: it is one of the
 * fact's words exactly, or those words with the wording around them in
 * the evidence ("37 trucks" when the source says "37 trucks"). Anything
 * else it adds ("Ilse Vermeer, Marta Ruiz", "37 or 99") isn't the fact.
 */
const says = (
  part: string,
  fact: BrainFact,
  evidence: readonly string[]
): boolean => {
  const value = part.replace(trailing, "");
  return fact.some((variant) => {
    const words = normalized(variant);
    return (
      value === words ||
      (holds(value, words) && evidence.some((marker) => holds(marker, value)))
    );
  });
};

/** Every ordering of `0 … count - 1`: for the few values of one answer. */
const orderings = (count: number): number[][] =>
  count <= 1
    ? [Array.from({ length: count }, (_, index) => index)]
    : orderings(count - 1).flatMap((shorter) =>
        Array.from({ length: count }, (_, at) => [
          ...shorter.slice(0, at),
          count - 1,
          ...shorter.slice(at),
        ])
      );

/**
 * Whether the answer line's values, separated by semicolons, are the
 * task's facts: one value each, in the order asked unless any order goes,
 * none denied ("not 37"). A value joined to another ("37 or 99") isn't
 * the fact (`says`).
 */
const answers = (
  said: string,
  expected: Extract<BrainExpectation, { kind: "answer" }>
): boolean => {
  if (negation.test(said)) {
    return false;
  }
  const values = said.split(";").map((value) => value.trim());
  const evidence = expected.evidence.map(({ marker }) => normalized(marker));
  if (values.length !== expected.facts.length) {
    return false;
  }
  // A value that also holds another of the requested facts ("06:00 and
  // 09:00") answers two slots at once: it fits neither.
  const holdsOther = (value: string, index: number) =>
    expected.facts.some(
      (other, at) =>
        at !== index &&
        other.some((variant) => holds(value, normalized(variant)))
    );
  const fits = (order: readonly number[]) =>
    order.every((value, index) => {
      const fact = expected.facts[index];
      const given = values[value] ?? "";
      return (
        fact !== undefined &&
        says(given, fact, evidence) &&
        !holdsOther(given, index)
      );
    });
  return expected.anyOrder === true
    ? orderings(values.length).some(fits)
    : fits(values.map((_, index) => index));
};

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
  // What the answer asserts: its answer line, citations aside. Facts named
  // only in an explanation or a citation's label aren't the answer.
  const said = normalized(
    (answerLine.exec(observed.answer)?.groups?.answer ?? "").replaceAll(
      citation,
      " "
    )
  );
  const input = normalized(observed.modelInput);
  const parts = observed.transcript.map(({ by, text }) => ({
    by,
    text: normalized(text),
  }));
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
  const storedLines = observed.corpus.flatMap((text) =>
    text.split("\n").map((line) => normalized(line))
  );
  // A source gave it before the model wrote it, or a tool result holds a
  // whole stored line with it that no earlier part of the model's held.
  // A guess the model made earlier doesn't spoil a read after it.
  const reached = expect.evidence.filter(({ marker }) => {
    const words = normalized(marker);
    const lines = storedLines.filter((line) => line.includes(words));
    const first = parts.find(({ text }) => text.includes(words));
    return (
      first?.by === "source" ||
      parts.some(
        ({ by, text }, index) =>
          by === "tool" &&
          lines.some(
            (line) =>
              text.includes(line) &&
              !parts
                .slice(0, index)
                .some((part) => part.by === "model" && part.text.includes(line))
          )
      )
    );
  }).length;
  const cited = citationsOf(observed.answer);
  const supported = cited.filter((source) =>
    expect.evidence.some((evidence) => names(source, evidence.source))
  ).length;
  const answered = !failed && !abstained;
  const right =
    answers(said, expect) &&
    !(expect.forbidden ?? []).some((stale) => holds(said, normalized(stale)));
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
