import type { WorkflowMonthSpend } from "@grasp-os/shared/models";

// What the AI spend widget works out from what the models cost this month
// (`models.spend()`, admins only): what one run of a workflow cost, and
// which workflows its block lists. Pure, so the widget only draws it.

/** How many workflows the block lists; in full, every one core sent. */
export const spendShown = 3;

/**
 * What one run of a workflow cost this month, on average: its spend over
 * the runs it started this month. None while it started none, as spend
 * can come from runs started the month before.
 */
export const costPerRun = ({
  amount,
  runs,
}: Pick<WorkflowMonthSpend, "amount" | "runs">): number | null =>
  runs > 0 ? amount / runs : null;
