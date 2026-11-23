import type { WorkflowRunStatus } from "@grasp-os/shared/workflow-resources";
import type { RunStatus } from "@grasp-os/shared/workflows";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import type { BadgeTone } from "../grasp/badge/index.ts";

// How a run stands, in words and as a Badge's tone: one vocabulary wherever
// a run shows (a workflow's runs, the Runs log, Traces, a test, the
// activity). Core says it two ways, a workflow's own runs (the engine's
// `WorkflowRunStatus`) and the Runs log (`RunStatus`, which knows a run
// waits for a decision), so both are worded here, the same word for the
// same thing. "Paused" stays a workflow's word alone: a run its engine
// holds is waiting, never paused.

/** Every way core says a run stands. */
export type AnyRunStatus = RunStatus | WorkflowRunStatus;

// Each in a context of its own: a run's status, not a workflow's.
export const runStatusLabels: Readonly<
  Record<AnyRunStatus, MessageDescriptor>
> = {
  queued: msg({ message: "Starting", context: "status of a workflow run" }),
  starting: msg({ message: "Starting", context: "status of a workflow run" }),
  running: msg({ message: "Running", context: "status of a workflow run" }),
  waiting: msg({
    message: "Waiting for a decision",
    context: "status of a workflow run",
  }),
  paused: msg({ message: "Waiting", context: "status of a workflow run" }),
  completed: msg({ message: "Done", context: "status of a workflow run" }),
  failed: msg({ message: "Failed", context: "status of a workflow run" }),
  cancelled: msg({ message: "Stopped", context: "status of a workflow run" }),
};

/**
 * How a run's status stands as a Badge: attention only where it waits for
 * someone's decision, success once done, danger where it failed, a plain
 * fact while it goes on, waits on its own (a timer, an event) or after it
 * was stopped.
 */
export const runToneOf = (status: AnyRunStatus): BadgeTone => {
  if (status === "waiting") {
    return "attention";
  }
  if (status === "completed") {
    return "success";
  }
  return status === "failed" ? "danger" : "neutral";
};
