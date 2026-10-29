import { z } from "zod";

// Where an independent workflow is in its life (core's
// workflow-lifecycle.ts): its stage, its draft beside the version that
// went live, whether it is paused, and the version waiting to go live.

/**
 * A workflow's stages, in order: `mapped` (named, nothing drafted),
 * `designed` (drafted), `testing` (published, nothing live), `live` (a
 * version went live through an approval) and `scaling` (live, rolled out
 * further). Only an approval makes a workflow live.
 */
export const workflowStages = [
  "mapped",
  "designed",
  "testing",
  "live",
  "scaling",
] as const;
export const workflowStageSchema = z.enum(workflowStages);
export type WorkflowStage = z.infer<typeof workflowStageSchema>;

/** The stages a workflow with a live version may have. */
export const liveStages: readonly WorkflowStage[] = ["live", "scaling"];

/**
 * Every lifecycle write names the revision it read, so of two concurrent
 * writes the second is refused (`workflow.lifecycle_conflict`).
 */
const revisionSchema = z.int().min(0);

/** A builder sets the stage (`liveStages` only with a live version). */
export const workflowStageSetSchema = z.strictObject({
  stage: workflowStageSchema,
  revision: revisionSchema,
});

/** A pause or a resume. */
export const workflowPauseSchema = z.strictObject({
  revision: revisionSchema,
});

/** A builder asks for a published version to go live. */
export const workflowGoLiveRequestSchema = z.strictObject({
  version: z.int().min(1),
  revision: revisionSchema,
});

/** The owner or an admin approves or rejects the version waiting. */
export const workflowGoLiveDecisionSchema = z.strictObject({
  version: z.int().min(1),
  verdict: z.enum(["approve", "reject"]),
  revision: revisionSchema,
});

/** A workflow's lifecycle, for anyone with a role in it. */
export interface WorkflowLifecycle {
  workflowId: string;
  /** What the next write names (`revision` in each input); 0 before the first. */
  revision: number;
  stage: WorkflowStage;
  /** Whether a builder set the stage, rather than it following the workflow. */
  stageSet: boolean;
  /** Its draft's latest revision and latest checkpoint; null before any edit. */
  draft: { revision: number; checkpoint: number | null } | null;
  /** The version published last; null before the first. */
  publishedVersion: number | null;
  /** The version that went live last, through an approval; null until one did. */
  live: { version: number; approvedBy: string; approvedAt: string } | null;
  /** While paused it starts no runs; test runs of its draft still start. */
  paused: { by: string; at: string } | null;
  /** The version asked to go live, waiting on the owner or an admin. */
  goLive: { version: number; requestedBy: string; requestedAt: string } | null;
  /** Whether the caller may set its stage, pause, resume and ask to go live. */
  canChange: boolean;
  /** Whether the caller may approve or reject the version waiting. */
  canDecide: boolean;
}

/**
 * A version waiting to go live that the caller may approve or reject: on
 * a workflow they own, or any for the organization's admins, never one
 * they asked for themselves.
 */
export interface WorkflowGoLiveWaiting {
  workflowId: string;
  name: string;
  version: number;
  requestedBy: string;
  requestedAt: string;
  /** The lifecycle revision it was read at, which a decision names. */
  revision: number;
  /** Whether it waits on the caller as the workflow's owner, rather than as an admin. */
  asOwner: boolean;
}

/** An independent workflow's lifecycle over `/rpc` (`workflowResources.lifecycle`). */
export interface WorkflowLifecycleApi {
  get: (id: string) => Promise<WorkflowLifecycle>;
  /** Sets its stage (`workflowStageSetSchema`); for builders. */
  setStage: (id: string, input: unknown) => Promise<WorkflowLifecycle>;
  /** Pauses it (`workflowPauseSchema`); for builders. */
  pause: (id: string, input: unknown) => Promise<WorkflowLifecycle>;
  /** Resumes it (`workflowPauseSchema`); for builders. */
  resume: (id: string, input: unknown) => Promise<WorkflowLifecycle>;
  /** Asks for a version to go live (`workflowGoLiveRequestSchema`); for builders. */
  requestGoLive: (id: string, input: unknown) => Promise<WorkflowLifecycle>;
  /**
   * Approves or rejects the version waiting
   * (`workflowGoLiveDecisionSchema`); for its owner and admins, never who
   * asked.
   */
  decideGoLive: (id: string, input: unknown) => Promise<WorkflowLifecycle>;
  /** Every version waiting to go live that the caller may decide, oldest request first. */
  waiting: () => Promise<WorkflowGoLiveWaiting[]>;
}
