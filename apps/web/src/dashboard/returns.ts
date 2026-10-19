import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

// What the prototype's dashboard answers for whoever leads the change with
// Grasp (`lib/dashboard.ts`): what each workflow brings back, how far the
// board's goals are, and how far each team is with AI, read from the work
// itself. The return, goals and teams widgets draw it
// (`standard-widgets.tsx`). Core keeps none of it yet: no hours by hand,
// no stage on the way to live, no goals, no team behind a workflow. So
// the board gives those widgets nothing, and each says so as the
// prototype does; once core has it, it fills these shapes. Euros are the
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

/** The workflow a return is of: where it opens, and whose work it is. */
export interface ReturnWorkflow {
  /** The engine it is in, and its name there: where it opens. */
  app: string;
  name: string;
  /** The team whose work it is, and the board goal it serves, if any. */
  teamId: string | null;
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

/** A workflow's key among the others: its engine and its name. */
export const returnKey = ({ workflow }: WorkflowReturn): string =>
  `${workflow.app}/${workflow.name}`;

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
 * How far a team is with AI, read from its own work: nothing drawn yet,
 * its work drawn, a redesign, a test, something live, and live work
 * across most of its hours.
 */
export type TeamLevel =
  | "notStarted"
  | "mapped"
  | "redesign"
  | "testing"
  | "live"
  | "scaling";

/** One team's work with AI, beside the rest of the company. */
export interface TeamProgress {
  id: string;
  name: string;
  level: TeamLevel;
  workflows: number;
  /** How many of its workflows are at each step, from drawn to live. */
  mapped: number;
  redesign: number;
  testing: number;
  live: number;
  /** The share of its hours by hand that is redesigned, 0 to 1; null without counted hours. */
  share: number | null;
  /** What its counted work costs by hand a month, the measured return a month and the expected one. */
  cost: number;
  measured: number;
  expected: number;
  /** Items its live workflows handled, and how many of them without a person. */
  handled: number;
  alone: number;
  /** Behind the company: work drawn, nothing tested yet, and less of it redesigned than the company's. */
  needsHelp: boolean;
}

/** What the board's return, goals and teams widgets are drawn from. */
export interface WorkReturns {
  /** Every workflow's return, the most valuable by hand first. */
  rows: WorkflowReturn[];
  goals: GoalProgress[];
  /** Every team, the furthest first. */
  teams: TeamProgress[];
}

/** What core has of it now: nothing, so each widget shows its empty state. */
export const noReturns: WorkReturns = { rows: [], goals: [], teams: [] };
