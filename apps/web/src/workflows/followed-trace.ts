import type { WorkflowRunTrace } from "@grasp-os/shared/workflow-diagrams";

/**
 * A run's trace as read again while it goes: drawn on the diagram the
 * first read drew, doors and all (`drawn`), as core draws the diagram
 * without doors once the trace is followed (`runTrace`'s `doors`).
 */
export const followedTrace = (
  read: WorkflowRunTrace,
  drawn: WorkflowRunTrace["diagram"] | undefined
): WorkflowRunTrace => ({ ...read, diagram: drawn ?? read.diagram });
