import type { RunActivity } from "@grasp-os/shared/workflows";

// The figures over the runs (prototype `components/workflow-runs.tsx`
// `Big`, `builder-runs.tsx` `Stats`), from what core counted
// (`workflows.activity`): the runs of the Apps' workflows started over
// its window, how many of them needed no person, and how many wait for
// one. Pure, so the views only draw them. Core counts only the workflows
// of the Apps the person can open, never independent ones, and no cost.

/** The figures over a list of runs. */
export interface RunFigures {
  /** Runs started in the window. */
  runs: number;
  /** From 0 to 1, of `runs`; null without runs, where there is no share. */
  alone: number | null;
  /** Runs waiting for a person's decision. */
  waiting: number;
}

/**
 * Every workflow's runs together: those started in the window, the share
 * that asked no one for a decision, as core counted it (`runs`, never
 * counted again here from the days), and those of them waiting for a
 * decision now.
 */
export const runFiguresOf = (activity: RunActivity): RunFigures => {
  const { total, withoutPerson } = activity.runs;
  return {
    runs: total,
    alone: total === 0 ? null : withoutPerson / total,
    waiting: activity.days.reduce((sum, day) => sum + day.waiting, 0),
  };
};
