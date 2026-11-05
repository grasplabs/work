import type { Goal } from "@grasp-os/shared/brain";
import type { WorkflowSummary } from "@grasp-os/shared/workflows";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

// What the prototype's dashboard answers for whoever leads the change with
// Grasp (`lib/dashboard.ts`): what each workflow brings back, how far the
// board's goals are, and how far each team is with AI, read from the work
// itself. The return, goals and teams widgets draw it
// (`standard-widgets.tsx`). Core keeps the board's goals and the
// workflows linked to each (`brain.goals`), but no team that owns a
// workflow, no hours by hand and no stage on the way to live yet. So the
// goals widget shows how far the workflows are, without a return; the
// return and teams widgets get nothing, and say so as the prototype does;
// once core has the rest, it fills these shapes. Euros are the
// value of the hours by hand at the client's own rate, never money saved.

/**
 * Where a workflow is on its way to live, in the five words everyone uses:
 * drawn (it needs a check, then it is agreed), redesigned, in its test, live.
 */
export const stages = [
  "check",
  "agreed",
  "redesign",
  "testing",
  "live",
] as const;
export type Stage = (typeof stages)[number];

export const stageLabel: Record<Stage, MessageDescriptor> = {
  check: msg({ message: "Needs a check", context: "workflow stage" }),
  agreed: msg({ message: "Agreed", context: "workflow stage" }),
  redesign: msg({ message: "Redesign", context: "workflow stage" }),
  testing: msg({ message: "Testing", context: "workflow stage" }),
  live: msg({ message: "Live", context: "workflow stage" }),
};

/** How far along the way to live a stage is, the furthest first. */
export const stageOrder: Record<Stage, number> = {
  live: 0,
  testing: 1,
  redesign: 2,
  agreed: 3,
  check: 4,
};

/** How sure a return is: measured on real work, expected from a design, or only the hours by hand known. */
export type ReturnBasis =
  | "measured"
  | "expected"
  | "estimated"
  | "observed"
  | "unknown";

/** The workflow a return is of: where it opens, and the goal it serves. */
export interface ReturnWorkflow {
  /** The workflow's ID, where it opens, and its name. */
  id: string;
  name: string;
  /** The board goal it serves, if any. */
  goalId: string | null;
}

/** One workflow's return, in euros a month: what its hours by hand were worth, and what is left. */
export interface WorkflowReturn {
  workflow: ReturnWorkflow;
  stage: Stage;
  /** Hours a week by hand before Grasp, and after: measured when live, expected from the design. */
  hoursBefore: number | null;
  hoursAfter: number | null;
  /** The hours by hand before, valued a month; null while they are not known. */
  before: number | null;
  /** What is left a month: the hours still by hand, valued, plus what the model costs. */
  after: number | null;
  /** Before minus after: what comes back a month. */
  back: number | null;
  /** The share of the hours that no longer takes a person, 0 to 1. */
  cut: number | null;
  basis: ReturnBasis;
}

/** A workflow's key among the others: its ID. */
export const returnKey = ({ workflow }: WorkflowReturn): string => workflow.id;

/** What all the work adds up to, a month. */
export interface ReturnTotals {
  /** Back from what is live, measured. */
  back: number;
  liveCount: number;
  /** Back once the designs and tests go live, expected. */
  coming: number;
  comingCount: number;
  /** What all the work with known hours costs by hand before Grasp. */
  byHand: number;
}

const sum = (
  rows: readonly WorkflowReturn[],
  pick: (row: WorkflowReturn) => number | null
): number => rows.reduce((total, row) => total + (pick(row) ?? 0), 0);

export const returnTotals = (rows: readonly WorkflowReturn[]): ReturnTotals => {
  const live = rows.filter((row) => row.stage === "live" && row.back !== null);
  const coming = rows.filter(
    (row) => row.stage !== "live" && row.back !== null
  );
  const known = rows.filter((row) => row.before !== null);
  return {
    back: sum(live, (row) => row.back),
    liveCount: live.length,
    coming: sum(coming, (row) => row.back),
    comingCount: coming.length,
    byHand: sum(known, (row) => row.before),
  };
};

/** Where a workflow is on its way, in three: live, on the way (redesigned or in its test), or only mapped. */
export type Way = "live" | "onTheWay" | "mapped";

export const wayOf = (stage: Stage): Way => {
  if (stage === "live") {
    return "live";
  }
  return stage === "redesign" || stage === "testing" ? "onTheWay" : "mapped";
};

/** One of the board's goals, with the workflows that serve it and how far they are. */
export interface GoalProgress {
  id: string;
  title: string;
  rows: WorkflowReturn[];
  live: number;
  back: number;
  coming: number;
}

/**
 * The board's goals as core keeps them (`brain.goals`), each by its newest
 * wording, with the workflows linked to it that `workflows` lists: live
 * once it handled items this week, else in its test (it is built, and
 * handles nothing yet). Core keeps no hours, so no return: a workflow's
 * is unknown.
 */
export const goalProgressOf = (
  goals: readonly Goal[],
  workflows: readonly WorkflowSummary[]
): GoalProgress[] =>
  goals.map((goal) => {
    const rows = goal.workflows.flatMap((id) => {
      const summary = workflows.find((each) => each.workflowId === id);
      if (summary === undefined) {
        return [];
      }
      const row: WorkflowReturn = {
        workflow: { id, name: summary.name, goalId: goal.id },
        stage: summary.handled > 0 ? "live" : "testing",
        hoursBefore: null,
        hoursAfter: null,
        before: null,
        after: null,
        back: null,
        cut: null,
        basis: "unknown",
      };
      return [row];
    });
    return {
      id: goal.id,
      title: goal.versions.at(-1)?.title ?? "",
      rows,
      live: rows.filter(({ stage }) => stage === "live").length,
      back: 0,
      coming: 0,
    };
  });

/** What the board's return and goals widgets are drawn from. */
export interface WorkReturns {
  /** Every workflow's return, the most valuable by hand first. */
  rows: WorkflowReturn[];
  goals: GoalProgress[];
}

/** What core has of it now: nothing, so each widget shows its empty state. */
export const noReturns: WorkReturns = { rows: [], goals: [] };
