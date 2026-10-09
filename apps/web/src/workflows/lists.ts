import type { WorkflowSummary } from "@grasp-os/shared/workflows";

// How the Workflows page sorts the workflows into its lists
// (workflows-table.tsx): at work and on the way, and those that need a
// person now.

/** Whether a workflow needs a person now: runs wait for a decision, failed lately, or its schedule stopped. */
export const needsAttention = (workflow: WorkflowSummary): boolean =>
  workflow.waiting > 0 || workflow.failed > 0 || workflow.scheduleStopped;

/**
 * At work: those that have run, the ones that need a person first, each
 * group in the order given. On the way: those that haven't run yet.
 */
export const listsOf = (
  rows: readonly WorkflowSummary[]
): { atWork: WorkflowSummary[]; onTheWay: WorkflowSummary[] } => {
  const ran = rows.filter(({ lastRun }) => lastRun !== null);
  return {
    atWork: [
      ...ran.filter((row) => needsAttention(row)),
      ...ran.filter((row) => !needsAttention(row)),
    ],
    onTheWay: rows.filter(({ lastRun }) => lastRun === null),
  };
};
