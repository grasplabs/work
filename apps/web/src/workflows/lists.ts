import { businessProcesses } from "@grasp-os/shared/business-processes";
import type { BusinessProcess } from "@grasp-os/shared/business-processes";
import type { WorkflowSummary } from "@grasp-os/shared/workflows";

// How the Workflows page sorts the workflows into its lists
// (workflows-table.tsx): at work and on the way, and those that need a
// person now; and the business processes they serve, to filter by.

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

/**
 * What `rows` handled this week, together: the sum of each one's runs
 * completed in the last week (`handled`), so a person's total counts only
 * the workflows they can open.
 */
export const handledOf = (rows: readonly WorkflowSummary[]): number =>
  rows.reduce((sum, row) => sum + row.handled, 0);

/**
 * The processes `served` holds, in the order the UI lists them: what the
 * page offers to filter by. A workflow that serves none is in no process.
 */
export const processesIn = (
  served: Iterable<BusinessProcess | null>
): BusinessProcess[] => {
  const present = new Set(served);
  return businessProcesses.filter((process) => present.has(process));
};

/** Whether a workflow serving `process` shows while `chosen` filters, if any does. */
export const showsUnder = (
  chosen: BusinessProcess | undefined,
  process: BusinessProcess | null
): boolean => chosen === undefined || chosen === process;
