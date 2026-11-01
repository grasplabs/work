// Apart from workflows.ts, which re-exports it: the web app checks the
// Runs list's filter in its address before the page loads, without the
// rest of the workflows' schemas.

/**
 * What the Runs list is filtered by: runs waiting for a decision, running
 * otherwise (paused ones too), failed, or done (completed or cancelled).
 */
export const runFilterStatuses = [
  "waiting",
  "running",
  "failed",
  "done",
] as const;

export type RunFilterStatus = (typeof runFilterStatuses)[number];
