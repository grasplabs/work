import { actorOf } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import {
  liveStages,
  workflowGoLiveDecisionSchema,
  workflowGoLiveRequestSchema,
  workflowPauseSchema,
  workflowStageSetSchema,
} from "@grasp-os/shared/workflow-lifecycle";
import type {
  WorkflowLifecycle,
  WorkflowStage,
} from "@grasp-os/shared/workflow-lifecycle";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { z } from "zod";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import {
  workflowResourceDrafts,
  workflowResourceLifecycles,
} from "./db/core/schema.ts";
import { requireNotStaff } from "./sharing.ts";
import {
  nextGeneration,
  previousChanged,
  requireWorkflowRole,
} from "./workflow-resources.ts";

// Where an independent workflow is in its life: its stage, its draft
// beside the version that went live, whether it is paused, and the
// version waiting to go live (GRA-512). Publishing a version stays what it
// was: a version anyone with a role may start by its number. Going live
// says which version the organization runs it on, and takes an approval.
//
// Threat model, and how each is closed:
//
// - Two writers at once (a builder pausing while an admin approves). Every
//   write names the lifecycle revision it read and lands only over it, so
//   the second is refused (`workflow.lifecycle_conflict`), never merged;
//   what each write checks against the state it read holds as it lands.
// - Going live on one's own say. A builder asks for an exact published
//   version; only the workflow's owner or an admin decides, and never the
//   person who asked (`workflow.go_live_own_request`). A decision names
//   the version it approves, so it never approves one asked for after it
//   was read (`workflow.go_live_not_pending`).
// - A stage that says more than is true. `live` and `scaling` need a
//   version that went live, and a workflow with one stays in them
//   (`workflow.stage_invalid`); only an approval makes it live.
// - A paused workflow still starting runs. A pause moves the workflow's
//   policy generation on in its batch, so a start decided before it and
//   admitted after is refused (workflow-starts.ts), and one decided after
//   it sees the pause (`workflow.paused`). Runs already going go on: a
//   builder stops one by terminating it. Test runs of the draft never run
//   anything, and still start.
// - Grasp staff changing a client's workflow: they read it, never change
//   it, as with its owner and askability.
//
// Every change is audited in its own batch, only if it landed.

type Lifecycle = typeof workflowResourceLifecycles.$inferSelect;

/** The stage a workflow is in without one set: as far as it got. */
const followedStage = (
  lifecycle: Lifecycle | undefined,
  draft: WorkflowLifecycle["draft"],
  publishedVersion: number | null
): WorkflowStage => {
  if (lifecycle?.liveVersion !== null && lifecycle?.liveVersion !== undefined) {
    return "live";
  }
  if (publishedVersion !== null) {
    return "testing";
  }
  return draft === null ? "mapped" : "designed";
};

/** The workflow's lifecycle row (if any) and its draft's revisions, read together. */
const stateOf = async (
  env: Env,
  id: string
): Promise<{
  row: Lifecycle | undefined;
  draft: WorkflowLifecycle["draft"];
}> => {
  const db = drizzle(env.DB);
  const [rows, drafts] = await db.batch([
    db
      .select()
      .from(workflowResourceLifecycles)
      .where(eq(workflowResourceLifecycles.workflowResourceId, id)),
    db
      .select({
        revision: sql<number | null>`MAX(${workflowResourceDrafts.revision})`,
        checkpoint: sql<
          number | null
        >`MAX(CASE WHEN ${workflowResourceDrafts.checked} THEN ${workflowResourceDrafts.revision} END)`,
      })
      .from(workflowResourceDrafts)
      .where(eq(workflowResourceDrafts.workflowResourceId, id)),
  ]);
  const [counted] = drafts;
  return {
    row: rows[0],
    draft:
      counted?.revision === null || counted?.revision === undefined
        ? null
        : { revision: counted.revision, checkpoint: counted.checkpoint },
  };
};

type Workflow = Awaited<ReturnType<typeof requireWorkflowRole>>;

/** Whether `by` may approve or reject what waits to go live on `workflow`. */
const decides = (by: Acting, workflow: Workflow): boolean =>
  !by.staff && (workflow.owner === by.userId || isAdmin(by.role));

/** The version that went live last, as the API answers it. */
const liveOf = (row: Lifecycle | undefined): WorkflowLifecycle["live"] => {
  if (
    row?.liveVersion === null ||
    row?.liveVersion === undefined ||
    row.liveApprovedBy === null ||
    row.liveApprovedAt === null
  ) {
    return null;
  }
  return {
    version: row.liveVersion,
    approvedBy: row.liveApprovedBy,
    approvedAt: row.liveApprovedAt.toISOString(),
  };
};

/** Who paused it and when, as the API answers it. */
const pausedOf = (row: Lifecycle | undefined): WorkflowLifecycle["paused"] =>
  row?.pausedAt === null || row?.pausedAt === undefined || row.pausedBy === null
    ? null
    : { by: row.pausedBy, at: row.pausedAt.toISOString() };

/** The version waiting to go live, as the API answers it. */
const goLiveOf = (row: Lifecycle | undefined): WorkflowLifecycle["goLive"] => {
  if (
    row?.goLiveVersion === null ||
    row?.goLiveVersion === undefined ||
    row.goLiveRequestedBy === null ||
    row.goLiveRequestedAt === null
  ) {
    return null;
  }
  return {
    version: row.goLiveVersion,
    requestedBy: row.goLiveRequestedBy,
    requestedAt: row.goLiveRequestedAt.toISOString(),
  };
};

const lifecycleOf = (
  by: Acting,
  workflow: Workflow,
  row: Lifecycle | undefined,
  draft: WorkflowLifecycle["draft"]
): WorkflowLifecycle => {
  const goLive = goLiveOf(row);
  return {
    workflowId: workflow.id,
    revision: row?.revision ?? 0,
    stage: row?.stage ?? followedStage(row, draft, workflow.currentVersion),
    stageSet: row?.stage !== null && row?.stage !== undefined,
    draft,
    publishedVersion: workflow.currentVersion,
    live: liveOf(row),
    paused: pausedOf(row),
    goLive,
    canChange: workflow.role === "builder" && !by.staff,
    canDecide:
      goLive !== null &&
      goLive.requestedBy !== by.userId &&
      decides(by, workflow),
  };
};

/** Workflow `id`'s lifecycle, for anyone with a role in it. */
export const workflowLifecycle = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<WorkflowLifecycle> => {
  const workflow = await requireWorkflowRole(env, by, id, "user");
  const { row, draft } = await stateOf(env, workflow.id);
  return lifecycleOf(by, workflow, row, draft);
};

/** Whether workflow `id` is paused now. */
export const isPaused = async (env: Env, id: string): Promise<boolean> => {
  const row = await drizzle(env.DB)
    .select({ pausedAt: workflowResourceLifecycles.pausedAt })
    .from(workflowResourceLifecycles)
    .where(eq(workflowResourceLifecycles.workflowResourceId, id))
    .get();
  return row?.pausedAt !== null && row?.pausedAt !== undefined;
};

/** The columns a write sets, besides its revision. */
type Change = Partial<
  Omit<Lifecycle, "workflowResourceId" | "revision" | "updatedAt">
>;

/**
 * Writes `change` over lifecycle revision `revision` of `workflow`, with
 * `entry` audited, and the policy generation moved on too if `fences`:
 * only if the revision is still the one read, or
 * `workflow.lifecycle_conflict`. Answers the lifecycle as it left it.
 */
const write = async (
  env: Env,
  by: Acting,
  workflow: Workflow,
  revision: number,
  change: Change,
  action: string,
  detail: AuditEntry["detail"],
  fences = false
): Promise<WorkflowLifecycle> => {
  const db = drizzle(env.DB);
  const updatedAt = new Date();
  const returned = { revision: workflowResourceLifecycles.revision };
  const landed =
    revision === 0
      ? db
          .insert(workflowResourceLifecycles)
          .values({
            workflowResourceId: workflow.id,
            revision: 1,
            updatedAt,
            ...change,
          })
          .onConflictDoNothing()
          .returning(returned)
      : db
          .update(workflowResourceLifecycles)
          .set({ ...change, revision: revision + 1, updatedAt })
          .where(
            and(
              eq(workflowResourceLifecycles.workflowResourceId, workflow.id),
              eq(workflowResourceLifecycles.revision, revision)
            )
          )
          .returning(returned);
  const entry: AuditEntry = {
    actor: by.actor ?? actorOf(by),
    action,
    target: { type: "workflow_resource", id: workflow.id },
    detail,
  };
  // Each statement after the write changes something only if the one
  // before it did (`changes()`), so the event is stored only if it landed.
  const [written] = await auditedBatch(env, db, [
    landed,
    ...(fences ? [nextGeneration(db, workflow.id, previousChanged)] : []),
    outboxedIfChanged(db, entry),
  ]);
  if (written.length === 0) {
    throw workflowResourceErrors.create("workflow.lifecycle_conflict");
  }
  const { row, draft } = await stateOf(env, workflow.id);
  return lifecycleOf(by, workflow, row, draft);
};

/** A change's input, parsed, and the workflow and state it changes. */
const changing = async <Schema extends z.ZodType>(
  env: Env,
  by: Acting,
  id: unknown,
  schema: Schema,
  input: unknown
): Promise<{
  workflow: Workflow;
  input: z.infer<Schema>;
  row: Lifecycle | undefined;
}> => {
  requireNotStaff(by);
  const workflow = await requireWorkflowRole(env, by, id, "user");
  const parsed = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    schema,
    input
  );
  const { row } = await stateOf(env, workflow.id);
  return { workflow, input: parsed, row };
};

/** That `revision` is the one `row` is at, or `workflow.lifecycle_conflict`. */
const requireRevision = (row: Lifecycle | undefined, revision: number) => {
  if ((row?.revision ?? 0) !== revision) {
    throw workflowResourceErrors.create("workflow.lifecycle_conflict");
  }
};

const requireBuilds = (workflow: Workflow) => {
  if (workflow.role !== "builder") {
    throw roleErrors.create("role.forbidden");
  }
};

/**
 * Sets workflow `id`'s stage, for its builders: `live` and `scaling` only
 * once a version went live, and only those then. Audited as
 * `workflow.stage.updated`.
 */
export const setWorkflowStage = async (
  env: Env,
  by: Acting,
  id: unknown,
  input: unknown
): Promise<WorkflowLifecycle> => {
  const {
    workflow,
    input: set,
    row,
  } = await changing(env, by, id, workflowStageSetSchema, input);
  requireBuilds(workflow);
  requireRevision(row, set.revision);
  const hasLive = row?.liveVersion !== null && row?.liveVersion !== undefined;
  if (liveStages.includes(set.stage) !== hasLive) {
    throw workflowResourceErrors.create("workflow.stage_invalid");
  }
  return await write(
    env,
    by,
    workflow,
    set.revision,
    { stage: set.stage },
    "workflow.stage.updated",
    { stage: set.stage, previous: row?.stage ?? null }
  );
};

/**
 * Pauses workflow `id`, for its builders: it starts no runs until resumed.
 * Pausing a paused workflow changes nothing. Audited as `workflow.paused`.
 */
export const pauseWorkflow = async (
  env: Env,
  by: Acting,
  id: unknown,
  input: unknown
): Promise<WorkflowLifecycle> => {
  const {
    workflow,
    input: pause,
    row,
  } = await changing(env, by, id, workflowPauseSchema, input);
  requireBuilds(workflow);
  requireRevision(row, pause.revision);
  if (row?.pausedAt !== null && row?.pausedAt !== undefined) {
    return await workflowLifecycle(env, by, workflow.id);
  }
  return await write(
    env,
    by,
    workflow,
    pause.revision,
    { pausedAt: new Date(), pausedBy: by.userId },
    "workflow.paused",
    {},
    true
  );
};

/**
 * Resumes workflow `id`, for its builders: it starts runs again.
 * Resuming one that isn't paused changes nothing. Audited as
 * `workflow.resumed`.
 */
export const resumeWorkflow = async (
  env: Env,
  by: Acting,
  id: unknown,
  input: unknown
): Promise<WorkflowLifecycle> => {
  const {
    workflow,
    input: resume,
    row,
  } = await changing(env, by, id, workflowPauseSchema, input);
  requireBuilds(workflow);
  requireRevision(row, resume.revision);
  if (row?.pausedAt === null || row?.pausedAt === undefined) {
    return await workflowLifecycle(env, by, workflow.id);
  }
  return await write(
    env,
    by,
    workflow,
    resume.revision,
    { pausedAt: null, pausedBy: null },
    "workflow.resumed",
    {}
  );
};

/**
 * Asks for published version `version` of workflow `id` to go live, for
 * its builders: in place of any version asked for before. A version not
 * published, or live already, is `workflow.go_live_invalid`. Audited as
 * `workflow.go_live.requested`.
 */
export const requestGoLive = async (
  env: Env,
  by: Acting,
  id: unknown,
  input: unknown
): Promise<WorkflowLifecycle> => {
  const {
    workflow,
    input: request,
    row,
  } = await changing(env, by, id, workflowGoLiveRequestSchema, input);
  requireBuilds(workflow);
  requireRevision(row, request.revision);
  // Versions are numbered from 1 and never removed.
  if (
    request.version > (workflow.currentVersion ?? 0) ||
    request.version === row?.liveVersion
  ) {
    throw workflowResourceErrors.create("workflow.go_live_invalid");
  }
  return await write(
    env,
    by,
    workflow,
    request.revision,
    {
      goLiveVersion: request.version,
      goLiveRequestedBy: by.userId,
      goLiveRequestedAt: new Date(),
    },
    "workflow.go_live.requested",
    {
      version: request.version,
      replaced: row?.goLiveVersion ?? null,
    }
  );
};

/**
 * Approves or rejects the version waiting to go live on workflow `id`,
 * for its owner and the organization's admins, never who asked for it.
 * Approved, it is the live version, and the workflow live unless it was
 * scaling already. Audited as `workflow.go_live.approved` or
 * `workflow.go_live.rejected`.
 */
export const decideGoLive = async (
  env: Env,
  by: Acting,
  id: unknown,
  input: unknown
): Promise<WorkflowLifecycle> => {
  const {
    workflow,
    input: decision,
    row,
  } = await changing(env, by, id, workflowGoLiveDecisionSchema, input);
  if (!decides(by, workflow)) {
    throw roleErrors.create("role.forbidden");
  }
  requireRevision(row, decision.revision);
  if (row === undefined || row.goLiveVersion !== decision.version) {
    throw workflowResourceErrors.create("workflow.go_live_not_pending");
  }
  if (row.goLiveRequestedBy === by.userId) {
    throw workflowResourceErrors.create("workflow.go_live_own_request");
  }
  const cleared: Change = {
    goLiveVersion: null,
    goLiveRequestedBy: null,
    goLiveRequestedAt: null,
  };
  if (decision.verdict === "reject") {
    return await write(
      env,
      by,
      workflow,
      decision.revision,
      cleared,
      "workflow.go_live.rejected",
      { version: decision.version, requestedBy: row.goLiveRequestedBy }
    );
  }
  return await write(
    env,
    by,
    workflow,
    decision.revision,
    {
      ...cleared,
      liveVersion: decision.version,
      liveApprovedBy: by.userId,
      liveApprovedAt: new Date(),
      stage: row.stage === "scaling" ? "scaling" : "live",
    },
    "workflow.go_live.approved",
    {
      version: decision.version,
      previous: row.liveVersion,
      requestedBy: row.goLiveRequestedBy,
    }
  );
};
