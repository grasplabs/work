import type { WorkflowRunStatus } from "@grasp-os/shared/workflow-resources";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

// How a run of an independent workflow stands, in words and as a dot: the
// same wherever a run shows (its list, Traces, a test, the activity).

// Each in a context of its own: a run's status, not a workflow's.
export const runStatusLabels: Readonly<
  Record<WorkflowRunStatus, MessageDescriptor>
> = {
  starting: msg({ message: "Starting", context: "status of a workflow run" }),
  running: msg({ message: "Running", context: "status of a workflow run" }),
  paused: msg({ message: "Paused", context: "status of a workflow run" }),
  completed: msg({ message: "Completed", context: "status of a workflow run" }),
  failed: msg({ message: "Failed", context: "status of a workflow run" }),
  cancelled: msg({ message: "Cancelled", context: "status of a workflow run" }),
};

/** The colour of a run's dot, as the runs log has it (`runs.tsx`). */
export const runDotOf = (status: WorkflowRunStatus): string => {
  if (status === "completed") {
    return "bg-status-agreed";
  }
  return status === "failed" ? "bg-status-attention" : "bg-foreground";
};
