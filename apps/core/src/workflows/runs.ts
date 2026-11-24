import { platformLimits } from "@grasp-os/shared/platform-limits";
import type { WorkflowRunStatus } from "@grasp-os/shared/workflow-resources";
import { workflowErrors } from "@grasp-os/shared/workflows";
import type { WorkflowRun } from "@grasp-os/shared/workflows";
import type { InstanceStatus } from "@grasp-os/workerflow/contracts";

import type { RunWait } from "./admission.ts";

// What every kind of workflow run shares (resource-runs.ts, an independent
// workflow's; candidate-runs.ts, a test run of its draft): how a status
// reads, how much input a run starts with, and where the engine says a
// run is.

/**
 * Whether a run goes on (starting or running): the runs a step of which
 * may wait in the queue for a share (admission.ts, `runActive`).
 */
export const goesOn = (status: WorkflowRunStatus): boolean =>
  status === "starting" || status === "running";

/** A status as callers see it: a run starting shows as running. */
export const shownStatus = (
  status: WorkflowRunStatus
): Exclude<WorkflowRunStatus, "starting"> =>
  status === "starting" ? "running" : status;

/**
 * The most input a run starts with, in bytes of its UTF-8 JSON: the public
 * function input limit (spec 18.1), whoever starts the run.
 */
export const maxInputBytes = platformLimits.functionArgsBytes;

/** The bytes of `value` as UTF-8 JSON. */
export const jsonBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

/**
 * A run as it reads while held for its AI provider (admission.ts,
 * `queuedRuns`): `queued`, with since when, while it would otherwise read
 * as running, or as waiting the way the engine has a step that sleeps
 * between asks. A run that is paused or has ended waits for nothing.
 */
export const queuedRun = <
  Run extends Pick<WorkflowRun, "status" | "aiProvider">,
>(
  run: Run,
  wait: RunWait | undefined
): Run =>
  wait !== undefined && (run.status === "running" || run.status === "waiting")
    ? { ...run, status: "queued", ...wait }
    : run;

/** Where the engine says a run is, as its notification has it. */
export interface EngineStatus {
  status: InstanceStatus["status"];
  /** When the run took the status, in ms since the epoch. */
  at: number;
  /**
   * The notification's sequence: applied only if newer than the last the
   * row took. Absent only for an end the engine confirmed just now, in
   * answer to core's own command: an ended run never changes again, so
   * nothing later can be newer.
   */
  sequence?: number;
  /**
   * For a run that ended having rolled back (its steps' compensations,
   * spec 10.7.3), how that went, from the engine's own record of it.
   */
  rollback?: "complete" | "errored";
  /**
   * For a run rolling back, why: its failure (with the code it failed
   * with, if any) or a cancellation, from the engine's own record.
   */
  compensation?: { cause: "failure" | "cancellation"; code: string | null };
}

/**
 * What a run whose compensation failed ends with (spec 10.7.3): failed,
 * as `workflow.compensation_failed`, whatever it failed with or was ended
 * by; both failures stay in its history, its step's and its compensation's.
 */
export const compensationFailedError = {
  code: "workflow.compensation_failed",
  message: workflowErrors.create("workflow.compensation_failed").message,
};

/**
 * The most runs mail, or connector events, start of one workflow in an
 * hour, each counted on its own.
 */
export const triggeredRunsPerHour = 60;
