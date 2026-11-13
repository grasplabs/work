// Whether an independent workflow is paused (core's workflow-lifecycle.ts).
// Which version runs is its live one, made live by a publish or a roll
// back (@grasp-os/shared/drafts).

/** Whether a workflow is paused, for anyone with a role in it. */
export interface WorkflowLifecycle {
  workflowId: string;
  /** Who paused it and when; null while it runs. */
  paused: { by: string; at: string } | null;
  /** Whether the person may pause or resume it: its builders, never Grasp staff. */
  canChange: boolean;
}

/** A workflow's pause, for its builders (`workflowResources.lifecycle`). */
export interface WorkflowLifecycleApi {
  get: (id: string) => Promise<WorkflowLifecycle>;
  /**
   * Pauses it: it starts no runs until resumed; runs already going go on.
   * Pausing a paused workflow changes nothing.
   */
  pause: (id: string) => Promise<WorkflowLifecycle>;
  /** Resumes it. Resuming one that isn't paused changes nothing. */
  resume: (id: string) => Promise<WorkflowLifecycle>;
}
