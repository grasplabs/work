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
  WorkflowGoLiveWaiting,
  WorkflowLifecycle,
  WorkflowStage,
} from "@grasp-os/shared/workflow-lifecycle";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { z } from "zod";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { activeMember } from "./auth/auth.ts";
import type { Acting } from "./auth/identity.ts";
import {
  members,
  workflowResourceDrafts,
  workflowResourceLifecycles,
  workflowResources,
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
//   version; only the workflow's owner or an admin decides, and not the
//   person who asked (`workflow.go_live_own_request`). A decision names
//   the version it approves, so it never approves one asked for after it
//   was read (`workflow.go_live_not_pending`).
// - Nothing ever going live where nobody else may decide (a company with
//   one admin, GRA-1227). Whoever asked decides it themselves only while
//   no other active member may: an admin, or the workflow's owner. That
//   is read with the state the decision names, and asked again by the
//   decision's own write, so an approver who joins in between refuses it.
//   It is recorded as self-approved, on the lifecycle and in the audit
//   event, with why; the next request, once someone else may decide, is
//   four-eyes again.
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

/**
 * That an active member of the organization other than `requester` may
 * decide a go-live of a workflow owned by `owner`, as SQL: an admin, or
 * its owner. Grasp staff aren't members, and never decide one.
 */
const otherApproverSql = (
  owner: string | SQLiteColumn,
  requester: string | SQL
): SQL => sql`(EXISTS (
    SELECT 1 FROM ${members}
    WHERE ${members.userId} IS NOT ${requester}
      AND ${activeMember(members.userId, ["admin"])}
  )
  OR (${owner} IS NOT ${requester} AND ${activeMember(owner)}))`;

/**
 * The workflow's lifecycle row (if any), its draft's revisions, and
 * whether nobody but whoever asked for the version waiting may decide it,
 * read together.
 */
const stateOf = async (
  env: Env,
  workflow: Pick<Workflow, "id" | "owner">
): Promise<{
  row: Lifecycle | undefined;
  draft: WorkflowLifecycle["draft"];
  onlyApprover: boolean;
}> => {
  const { id } = workflow;
  const db = drizzle(env.DB);
  const requester = sql`(SELECT ${workflowResourceLifecycles.goLiveRequestedBy}
    FROM ${workflowResourceLifecycles}
    WHERE ${workflowResourceLifecycles.workflowResourceId} = ${id})`;
  const [rows, drafts, others] = await db.batch([
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
    db
      .select({
        other: sql<number>`${otherApproverSql(workflow.owner, requester)}`,
      })
      .from(workflowResources)
      .where(eq(workflowResources.id, id)),
  ]);
  const [counted] = drafts;
  return {
    row: rows[0],
    onlyApprover: others[0]?.other === 0,
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
    selfApproved: row.liveSelfApproved,
  };
};

/** Who paused it and when, as the API answers it. */
const pausedOf = (row: Lifecycle | undefined): WorkflowLifecycle["paused"] =>
  row?.pausedAt === null || row?.pausedAt === undefined || row.pausedBy === null
    ? null
    : { by: row.pausedBy, at: row.pausedAt.toISOString() };

/** The version waiting to go live, as the API answers it. */
const goLiveOf = (
  row: Lifecycle | undefined,
  onlyApprover: boolean
): WorkflowLifecycle["goLive"] => {
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
    onlyApprover,
  };
};

const lifecycleOf = (
  by: Acting,
  workflow: Workflow,
  { row, draft, onlyApprover }: Awaited<ReturnType<typeof stateOf>>
): WorkflowLifecycle => {
  const goLive = goLiveOf(row, onlyApprover);
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
      (goLive.requestedBy !== by.userId || goLive.onlyApprover) &&
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
  return lifecycleOf(by, workflow, await stateOf(env, workflow));
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
 * only if the revision is still the one read, and `also` holds as it
 * lands, or `workflow.lifecycle_conflict`. Answers the lifecycle as it
 * left it.
 */
const write = async (
  env: Env,
  by: Acting,
  workflow: Workflow,
  revision: number,
  change: Change,
  action: string,
  detail: AuditEntry["detail"],
  { fences = false, also }: { fences?: boolean; also?: SQL } = {}
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
              eq(workflowResourceLifecycles.revision, revision),
              also
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
  return lifecycleOf(by, workflow, await stateOf(env, workflow));
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
  onlyApprover: boolean;
}> => {
  requireNotStaff(by);
  const workflow = await requireWorkflowRole(env, by, id, "user");
  const parsed = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    schema,
    input
  );
  const { row, onlyApprover } = await stateOf(env, workflow);
  return { workflow, input: parsed, row, onlyApprover };
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
    { fences: true }
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
 * for its owner and the organization's admins; for whoever asked for it
 * only while nobody else may (`otherApproverSql`), as read with the
 * revision the decision names and again as it lands, else
 * `workflow.go_live_own_request`. Approved, it is the live version, and
 * the workflow live unless it was scaling already. Audited as
 * `workflow.go_live.approved` or `workflow.go_live.rejected`, a decision
 * of one's own request with `self` and why.
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
    onlyApprover,
  } = await changing(env, by, id, workflowGoLiveDecisionSchema, input);
  if (!decides(by, workflow)) {
    throw roleErrors.create("role.forbidden");
  }
  requireRevision(row, decision.revision);
  if (row === undefined || row.goLiveVersion !== decision.version) {
    throw workflowResourceErrors.create("workflow.go_live_not_pending");
  }
  const own = row.goLiveRequestedBy === by.userId;
  if (own && !onlyApprover) {
    throw workflowResourceErrors.create("workflow.go_live_own_request");
  }
  const cleared: Change = {
    goLiveVersion: null,
    goLiveRequestedBy: null,
    goLiveRequestedAt: null,
  };
  const self: AuditEntry["detail"] = own
    ? { self: true, reason: "no_other_approver" }
    : {};
  // Asked again as it lands: an approver who joined since refuses it.
  const also = own
    ? sql`NOT ${otherApproverSql(workflow.owner, by.userId)}`
    : undefined;
  try {
    if (decision.verdict === "reject") {
      return await write(
        env,
        by,
        workflow,
        decision.revision,
        cleared,
        "workflow.go_live.rejected",
        {
          version: decision.version,
          requestedBy: row.goLiveRequestedBy,
          ...self,
        },
        { also }
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
        liveSelfApproved: own,
        stage: row.stage === "scaling" ? "scaling" : "live",
      },
      "workflow.go_live.approved",
      {
        version: decision.version,
        previous: row.liveVersion,
        requestedBy: row.goLiveRequestedBy,
        ...self,
      },
      { also }
    );
  } catch (error) {
    // Refused as it landed: by an approver who joined, unless the
    // lifecycle moved on too.
    const now = own ? await stateOf(env, workflow) : undefined;
    if (
      workflowResourceErrors.codeOf(error) === "workflow.lifecycle_conflict" &&
      now?.row?.revision === decision.revision &&
      !now.onlyApprover
    ) {
      throw workflowResourceErrors.create("workflow.go_live_own_request");
    }
    throw error;
  }
};

/**
 * Every version waiting to go live that `by` may decide, oldest request
 * first: as `decides` has it, on the workflows they own, or every one for
 * the organization's admins, never Grasp staff, and one they asked for
 * themselves only while nobody else may decide it. For the waiting feed
 * (waiting-rpc.ts).
 */
export const goLivesWaiting = async (
  env: Env,
  by: Acting
): Promise<WorkflowGoLiveWaiting[]> => {
  if (by.staff) {
    return [];
  }
  const lifecycles = workflowResourceLifecycles;
  const rows = await drizzle(env.DB)
    .select({
      workflowId: workflowResources.id,
      name: workflowResources.name,
      owner: workflowResources.ownerId,
      version: lifecycles.goLiveVersion,
      requestedBy: lifecycles.goLiveRequestedBy,
      requestedAt: lifecycles.goLiveRequestedAt,
      revision: lifecycles.revision,
    })
    .from(lifecycles)
    .innerJoin(
      workflowResources,
      eq(workflowResources.id, lifecycles.workflowResourceId)
    )
    .where(
      and(
        isNull(workflowResources.deletedAt),
        isNotNull(lifecycles.goLiveVersion),
        sql`(${lifecycles.goLiveRequestedBy} IS NOT ${by.userId}
          OR NOT ${otherApproverSql(workflowResources.ownerId, by.userId)})`,
        isAdmin(by.role) ? undefined : eq(workflowResources.ownerId, by.userId)
      )
    )
    .orderBy(asc(lifecycles.goLiveRequestedAt), asc(workflowResources.id));
  return rows.flatMap((row): WorkflowGoLiveWaiting[] =>
    row.version === null || row.requestedBy === null || row.requestedAt === null
      ? []
      : [
          {
            workflowId: row.workflowId,
            name: row.name,
            version: row.version,
            requestedBy: row.requestedBy,
            requestedAt: row.requestedAt.toISOString(),
            revision: row.revision,
            asOwner: row.owner === by.userId,
            selfApproval: row.requestedBy === by.userId,
          },
        ]
  );
};
