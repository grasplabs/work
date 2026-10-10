import type { RunActivity, RunActivityDay } from "@grasp-os/shared/workflows";

// What the dashboard's Runs widget works out from the runs core counted
// (`workflows.activity`): the last days of the window, each day's runs as
// a column of how they stand, and how many runs needed nobody. Pure, so
// the widget only draws it.

/** The days the widget's block shows: this week, today included. */
export const weekDays = 7;

/** The days its full view shows, and so what the board reads. */
export const fullDays = 30;

/** How a day's runs stand, in the order a column stacks them, from the ground up. */
export const runOutcomes = ["completed", "failed", "waiting", "other"] as const;

export type RunOutcome = (typeof runOutcomes)[number];

/** How many runs started on `day`. */
export const runsOn = (day: RunActivityDay): number =>
  runOutcomes.reduce((total, outcome) => total + day[outcome], 0);

/** The last `count` days of `activity`, oldest first. */
export const lastDays = (
  activity: RunActivity,
  count: number
): RunActivityDay[] => activity.days.slice(-count);

/** A part of a day's column: an outcome, and its share of the tallest column. */
export interface ColumnPart {
  outcome: RunOutcome;
  runs: number;
  /** From 0 to 1: the part's height, the tallest column's being 1 in all. */
  height: number;
  /** From 0 to 1: where it starts, from the ground. */
  from: number;
}

/** A day's column: its runs, and the parts it stacks, those with none left out. */
export interface DayColumn {
  day: RunActivityDay;
  runs: number;
  parts: ColumnPart[];
}

/**
 * Each of `days` as a column, all on one scale: the day with the most
 * runs fills the height, and one without runs has no parts.
 */
export const columnsOf = (days: readonly RunActivityDay[]): DayColumn[] => {
  const most = Math.max(1, ...days.map(runsOn));
  return days.map((day) => {
    let from = 0;
    const parts: ColumnPart[] = [];
    for (const outcome of runOutcomes) {
      const runs = day[outcome];
      if (runs > 0) {
        parts.push({ outcome, runs, height: runs / most, from });
        from += runs / most;
      }
    }
    return { day, runs: runsOn(day), parts };
  });
};

/** How many of a few days' runs needed nobody, and their share of them all. */
export interface WithoutPerson {
  runs: number;
  without: number;
  /** From 0 to 1; null without runs, where there is no share to speak of. */
  share: number | null;
}

/** How many of the runs of `days` asked no one for a decision. */
export const withoutPerson = (
  days: readonly RunActivityDay[]
): WithoutPerson => {
  const runs = days.reduce((total, day) => total + runsOn(day), 0);
  const without = runs - days.reduce((total, day) => total + day.withPerson, 0);
  return { runs, without, share: runs === 0 ? null : without / runs };
};

/**
 * Which of `count` columns are named under the chart: every one of a
 * week; of more, every fifth counted back from today, so today always is.
 */
export const isLabelled = (index: number, count: number): boolean =>
  count <= weekDays || (count - 1 - index) % 5 === 0;
