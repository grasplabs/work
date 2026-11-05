/**
 * The Stephen Score: where Stephen stands, out of 10, from the Stephen
 * Lab's runs of one Stephen. It is what the lab climbs: a change is kept
 * when it raises the score by more than the noise and lowers no part of
 * it, and the climb stops once the goal is reached on the hidden set.
 *
 * Six parts, each out of 10 (its share times ten), so no single number can
 * hide another:
 *
 * | Part              | From                                        | Weight |
 * | ----------------- | ------------------------------------------- | ------ |
 * | Heard             | whole interviews: of what people knew, said | 25%    |
 * | Hard turns        | whole interviews: the right line after one  | 20%    |
 * | Next question     | the ask bench: the right line for a moment  | 20%    |
 * | Workflow drawing  | the draw bench: found, order and numbers    | 15%    |
 * | Notes             | the notes bench: written, and supported     | 10%    |
 * | Contradictions    | whole interviews: their own side written    | 10%    |
 *
 * The goal is reached when the weighted average is at least its target and
 * the lowest part at least its floor, and every limit holds: lines that
 * break his rules, notes nobody said, a guess written as fact, and people
 * who went away before the read-back. A part or a limit no run measured
 * leaves the goal unreached: a score is never complete by leaving a part
 * out.
 *
 * Several runs of one bench are averaged first (the floor is held on the
 * average of runs, not on one run's luck). Pure, and shared: the lab and
 * the admin's Stephen Lab work it out the same way.
 */
import type { Bench } from "./lab-runs.ts";

/** A part of the score. */
export interface ScorePart {
  id:
    | "heard"
    | "hardTurns"
    | "nextQuestion"
    | "drawing"
    | "notes"
    | "contradictions";
  label: string;
  bench: Bench;
  /** The numbers of that bench it is the mean of. */
  metrics: readonly string[];
  /** Its share of the average; the weights add up to one. */
  weight: number;
}

export const scoreParts: readonly ScorePart[] = [
  {
    id: "heard",
    label: "Heard",
    bench: "whole",
    metrics: ["heard"],
    weight: 0.25,
  },
  {
    id: "hardTurns",
    label: "Hard turns",
    bench: "whole",
    metrics: ["handled"],
    weight: 0.2,
  },
  {
    id: "nextQuestion",
    label: "Next question",
    bench: "ask",
    metrics: ["right"],
    weight: 0.2,
  },
  {
    id: "drawing",
    label: "Workflow drawing",
    bench: "draw",
    metrics: ["found", "order", "numbers"],
    weight: 0.15,
  },
  {
    id: "notes",
    label: "Notes",
    bench: "notes",
    metrics: ["written", "supported"],
    weight: 0.1,
  },
  {
    id: "contradictions",
    label: "Contradictions",
    bench: "whole",
    metrics: ["contradictions"],
    weight: 0.1,
  },
];

/** A limit that must hold whatever the score: a share at most, or at least. */
export interface ScoreLimit {
  id: string;
  label: string;
  bench: Bench;
  metric: string;
  most?: number;
  least?: number;
}

export const scoreLimits: readonly ScoreLimit[] = [
  {
    id: "ruleBroken",
    label: "Lines that break his rules",
    bench: "ask",
    metric: "mistakes",
    most: 0.02,
  },
  {
    id: "notSaid",
    label: "Notes nobody said",
    bench: "notes",
    metric: "notSaid",
    most: 0.02,
  },
  {
    id: "takenAsFact",
    label: "Something not so, written as fact",
    bench: "whole",
    metric: "taken",
    most: 0.05,
  },
  {
    id: "stayed",
    label: "People who stayed to the read-back",
    bench: "whole",
    metric: "agreed",
    least: 0.8,
  },
];

/** What the climb aims for, out of 10. */
export interface ScoreGoal {
  /** The weighted average at least this. */
  target: number;
  /** Every part at least this. */
  floor: number;
}

/** The first goal: 9 out of 10, no part below 8.5. */
export const firstGoal: ScoreGoal = { target: 9, floor: 8.5 };

/** One run of one bench, as the score reads it: its means. */
export interface ScoredRun {
  bench: Bench;
  means: Readonly<Record<string, number>>;
}

export interface PartStanding {
  id: ScorePart["id"];
  label: string;
  weight: number;
  /** Out of 10; none when no run measured it. */
  value: number | null;
  /** How many runs it is the average of. */
  runs: number;
  /** Whether it is at least the goal's floor. */
  aboveFloor: boolean;
}

export interface LimitStanding {
  id: string;
  label: string;
  /** The share measured; none when no run measured it. */
  value: number | null;
  most?: number;
  least?: number;
  holds: boolean;
}

export interface Standing {
  parts: PartStanding[];
  limits: LimitStanding[];
  /** The weighted average out of 10, over every part; none until every part is measured. */
  score: number | null;
  /** The lowest part, out of 10; none until every part is measured. */
  lowest: PartStanding | null;
  /** The parts and limits no run measured yet. */
  missing: string[];
  goal: ScoreGoal;
  /** Every part measured, the average at least the target, the lowest at least the floor, every limit held. */
  reached: boolean;
}

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

/** The mean over runs of `bench` of one number, and how many runs had it. */
const averaged = (
  runs: readonly ScoredRun[],
  bench: Bench,
  metric: string
): { value: number; runs: number } | null => {
  const values = runs.flatMap((run) =>
    run.bench === bench && run.means[metric] !== undefined
      ? [run.means[metric]]
      : []
  );
  return values.length === 0
    ? null
    : { value: mean(values), runs: values.length };
};

/** Rounded to tenths, as the score is shown: 8.96 is 9.0, and counts as 9. */
const tenths = (value: number): number => Math.round(value * 10) / 10;

/** Where Stephen stands on these runs, against `goal`. */
export const standingOf = (
  runs: readonly ScoredRun[],
  goal: ScoreGoal = firstGoal
): Standing => {
  const parts = scoreParts.map((part): PartStanding => {
    const found = part.metrics.map((metric) =>
      averaged(runs, part.bench, metric)
    );
    const complete = found.every((each) => each !== null);
    const value = complete
      ? tenths(10 * mean(found.map((each) => each?.value ?? 0)))
      : null;
    return {
      id: part.id,
      label: part.label,
      weight: part.weight,
      value,
      runs: complete ? Math.min(...found.map((each) => each?.runs ?? 0)) : 0,
      aboveFloor: value !== null && value >= goal.floor,
    };
  });
  const limits = scoreLimits.map((limit): LimitStanding => {
    const found = averaged(runs, limit.bench, limit.metric);
    const value = found?.value ?? null;
    const holds =
      value !== null &&
      (limit.most === undefined || value <= limit.most) &&
      (limit.least === undefined || value >= limit.least);
    return {
      id: limit.id,
      label: limit.label,
      value,
      ...(limit.most === undefined ? {} : { most: limit.most }),
      ...(limit.least === undefined ? {} : { least: limit.least }),
      holds,
    };
  });
  const missing = [
    ...parts.filter((part) => part.value === null).map((part) => part.label),
    ...limits
      .filter((limit) => limit.value === null)
      .map((limit) => limit.label),
  ];
  const measured = parts.every((part) => part.value !== null);
  const score = measured
    ? tenths(
        parts.reduce((sum, part) => sum + part.weight * (part.value ?? 0), 0)
      )
    : null;
  const lowest = measured
    ? (parts.toSorted((a, b) => (a.value ?? 0) - (b.value ?? 0))[0] ?? null)
    : null;
  return {
    parts,
    limits,
    score,
    lowest,
    missing,
    goal,
    reached:
      score !== null &&
      lowest !== null &&
      score >= goal.target &&
      (lowest.value ?? 0) >= goal.floor &&
      limits.every((limit) => limit.holds),
  };
};

/** How far runs of one Stephen differ by themselves, out of 10: the score, and each part. */
export interface ScoreNoise {
  score: number;
  parts?: Partial<Record<ScorePart["id"], number>>;
}

/**
 * Whether a change may be kept, on the score: it raised the average by more
 * than `noise` (out of 10), and lowered no part by more than that part's own
 * noise, so one part is never traded for another. Parts without a noise of
 * their own take `noise`. With `mustRise: false` it only has to hold: no
 * lower than the noise, as on the hidden set, which confirms a gain the
 * open set found.
 */
export const keepsChange = (
  before: Standing,
  after: Standing,
  noise: ScoreNoise,
  { mustRise = true }: { mustRise?: boolean } = {}
): { keep: boolean; why: string } => {
  if (before.score === null || after.score === null) {
    return {
      keep: false,
      why: "Not every part was measured on both sides.",
    };
  }
  const gain = tenths(after.score - before.score);
  const dropped = after.parts.filter((part) => {
    const was = before.parts.find((each) => each.id === part.id)?.value;
    const allowed = noise.parts?.[part.id] ?? noise.score;
    return (
      was !== null &&
      was !== undefined &&
      part.value !== null &&
      was - part.value > allowed
    );
  });
  if (dropped.length > 0) {
    return {
      keep: false,
      why: `${dropped.map((part) => part.label).join(", ")} went down by more than the noise.`,
    };
  }
  const broken = after.limits.filter((limit) => !limit.holds);
  if (broken.length > 0) {
    return {
      keep: false,
      why: `A limit doesn't hold: ${broken.map((limit) => limit.label).join(", ")}.`,
    };
  }
  if (!mustRise) {
    return gain < -noise.score
      ? {
          keep: false,
          why: `The score fell by ${(-gain).toFixed(1)}, more than the noise (${noise.score.toFixed(1)}).`,
        }
      : { keep: true, why: `The score held (${gain.toFixed(1)}).` };
  }
  if (gain <= noise.score) {
    return {
      keep: false,
      why: `The score moved by ${gain.toFixed(1)}, not more than the noise (${noise.score.toFixed(1)}).`,
    };
  }
  return { keep: true, why: `The score rose by ${gain.toFixed(1)}.` };
};
