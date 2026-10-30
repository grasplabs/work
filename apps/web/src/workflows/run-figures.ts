import type { RunActivity } from "@grasp-os/shared/workflows";

import { withoutPerson } from "../dashboard/runs.ts";

// The figures over the runs (prototype `components/workflow-runs.tsx`
// `Big`, `builder-runs.tsx` `Stats`), from what core counted
// (`workflows.activity`): the runs of the domains' workflows started over
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
 * that asked no one for a decision (as the dashboard's Runs widget says
 * it), and those of them waiting for a decision now.
 */
export const runFiguresOf = (activity: RunActivity): RunFigures => ({
  runs: activity.runs.total,
  alone: withoutPerson(activity.days).share,
  waiting: activity.days.reduce((total, day) => total + day.waiting, 0),
});

/**
 * One App workflow's runs: those started in the window and the share of
 * them that completed without asking anyone (core counts no more for one
 * workflow), and `waiting`, its runs waiting for a decision now, which
 * its summary counts over every run, not only the window's.
 */
export const workflowFiguresOf = (
  activity: RunActivity,
  { app, workflow }: { app: string; workflow: string },
  waiting: number
): RunFigures => {
  const counted = activity.workflows.find(
    (row) => row.app === app && row.workflow === workflow
  );
  const runs = counted?.started ?? 0;
  return {
    runs,
    alone:
      counted === undefined || runs === 0
        ? null
        : counted.completedAlone / runs,
    waiting,
  };
};
