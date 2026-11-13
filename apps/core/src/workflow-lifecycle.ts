import { actorOf } from "@grasp-os/shared/audit";
import type { WorkflowLifecycle } from "@grasp-os/shared/workflow-lifecycle";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import { workflowResourceLifecycles } from "./db/core/schema.ts";
import { requireNotStaff } from "./sharing.ts";
import {
  nextGeneration,
  previousChanged,
  requireWorkflowRole,
} from "./workflow-resources.ts";

// Whether an independent workflow is paused (GRA-512). Which version runs
// is the workflow's live one, made live by a publish or a roll back
// (workflow-publish.ts); a pause stops new runs of whichever it is.
//
// Threat model, and how each is closed:
//
// - A paused workflow still starting runs. A pause moves the workflow's
//   policy generation on in its batch, so a start decided before it and
//   admitted after is refused (workflow-starts.ts), and one decided after
//   it sees the pause (`workflow.paused`). Runs already going go on: a
//   builder stops one by terminating it. Test runs of the draft never run
//   anything, and still start.
// - Two writers at once (one pausing while another resumes). Each write
//   lands only while the workflow is still as it read it (paused or not),
//   so of two opposite writes made from one read the second changes
//   nothing; pausing a paused workflow, or resuming a running one, is no
//   change either.
// - Grasp staff changing a client's workflow: they read it, never change
//   it, as with its owner and askability.
//
// Every change is audited in its own batch, only if it landed.

type Lifecycle = typeof workflowResourceLifecycles.$inferSelect;

type Workflow = Awaited<ReturnType<typeof requireWorkflowRole>>;

/** Workflow `id`'s row, if anything was ever set on it. */
const rowOf = async (env: Env, id: string): Promise<Lifecycle | undefined> =>
  await drizzle(env.DB)
    .select()
    .from(workflowResourceLifecycles)
    .where(eq(workflowResourceLifecycles.workflowResourceId, id))
    .get();

const lifecycleOf = (
  by: Acting,
  workflow: Workflow,
  row: Lifecycle | undefined
): WorkflowLifecycle => ({
  workflowId: workflow.id,
  paused:
    row?.pausedAt === null ||
    row?.pausedAt === undefined ||
    row.pausedBy === null
      ? null
      : { by: row.pausedBy, at: row.pausedAt.toISOString() },
  canChange: workflow.role === "builder" && !by.staff,
});

/** Workflow `id`'s pause, for anyone with a role in it. */
export const workflowLifecycle = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<WorkflowLifecycle> => {
  const workflow = await requireWorkflowRole(env, by, id, "user");
  return lifecycleOf(by, workflow, await rowOf(env, workflow.id));
};

/** Whether workflow `id` is paused now. */
export const isPaused = async (env: Env, id: string): Promise<boolean> => {
  const row = await rowOf(env, id);
  return row?.pausedAt !== null && row?.pausedAt !== undefined;
};

/**
 * Pauses (`paused`) or resumes workflow `id`, for its builders, never
 * Grasp staff: only while it is still the other, so a pause of a paused
 * workflow changes nothing. A pause moves its policy generation on with
 * it. Audited as `workflow.paused` or `workflow.resumed`.
 */
const setPaused = async (
  env: Env,
  by: Acting,
  id: unknown,
  paused: boolean
): Promise<WorkflowLifecycle> => {
  requireNotStaff(by);
  const workflow = await requireWorkflowRole(env, by, id, "builder");
  const db = drizzle(env.DB);
  const updatedAt = new Date();
  const moved = {
    revision: sql`${workflowResourceLifecycles.revision} + 1`,
    updatedAt,
  };
  const written = paused
    ? db
        .insert(workflowResourceLifecycles)
        .values({
          workflowResourceId: workflow.id,
          revision: 1,
          updatedAt,
          pausedAt: updatedAt,
          pausedBy: by.userId,
        })
        .onConflictDoUpdate({
          target: workflowResourceLifecycles.workflowResourceId,
          set: { ...moved, pausedAt: updatedAt, pausedBy: by.userId },
          setWhere: isNull(workflowResourceLifecycles.pausedAt),
        })
    : db
        .update(workflowResourceLifecycles)
        .set({ ...moved, pausedAt: null, pausedBy: null })
        .where(
          and(
            eq(workflowResourceLifecycles.workflowResourceId, workflow.id),
            isNotNull(workflowResourceLifecycles.pausedAt)
          )
        );
  await auditedBatch(env, db, [
    written,
    ...(paused ? [nextGeneration(db, workflow.id, previousChanged)] : []),
    outboxedIfChanged(db, {
      actor: by.actor ?? actorOf(by),
      action: paused ? "workflow.paused" : "workflow.resumed",
      target: { type: "workflow_resource", id: workflow.id },
      detail: {},
    }),
  ]);
  return lifecycleOf(by, workflow, await rowOf(env, workflow.id));
};

/** Pauses workflow `id`: it starts no runs until resumed (`setPaused`). */
export const pauseWorkflow = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<WorkflowLifecycle> => await setPaused(env, by, id, true);

/** Resumes workflow `id`: it starts runs again (`setPaused`). */
export const resumeWorkflow = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<WorkflowLifecycle> => await setPaused(env, by, id, false);
