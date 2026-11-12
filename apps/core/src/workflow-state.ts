import { actorOf } from "@grasp-os/shared/audit";
import { identifierMaxLength } from "@grasp-os/shared/identifier";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import {
  workflowResourceErrors,
  workflowStateKeySchema,
  workflowStateMaxBytes,
} from "@grasp-os/shared/workflow-resources";
import type {
  WorkflowState,
  WorkflowStateEntry,
} from "@grasp-os/shared/workflow-resources";
import { runOfStepKey } from "@grasp-os/shared/workflows";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed, outboxedWhere } from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import {
  workflowResourceRuns,
  workflowState,
  workflowStateWrites,
} from "./db/core/schema.ts";
import { notNullFailed } from "./db/d1.ts";
import { requireNotStaff } from "./sharing.ts";
import { requireWorkflowRole } from "./workflow-resources.ts";

// What an independent workflow keeps between its runs (GRA-1552): a few
// JSON values by key, which a run reads once as it starts (its `state`)
// and a step sets once it succeeded. Workflows keep no data of their own
// beyond this: records belong in an App, which a workflow reaches through
// the App's functions. Threat model, and how each is closed:
//
// - One workflow reading or writing another's state: a write names only
//   its run and its step's key, never a workflow. The workflow is the
//   run's own, read from its row, and the receipt that lets the write land
//   requires, in the batch, that run of that workflow, not ended, and the
//   workflow live. A step's key names its run (`stepIdempotencyKey`), so a
//   key of another run is refused. A run's snapshot is read by its own
//   workflow's ID, which its start already holds. People read and reset it
//   only as its builders or the organization's admins (never Grasp staff
//   resetting it): what one person's run kept is no other user's, as its
//   results aren't (workflows/resource-runs.ts, workflow-own.ts).
// - What a restricted run read reaching other runs (restricted.ts): such a
//   run shares nothing with the workflow's other runs, so it keeps no
//   state. A run that recalled the Brain is one (workflows/brain-calls.ts):
//   what its person's teams may read never reaches another person's run. Its write is refused (`workflow.state_restricted`), by the
//   run's pinned flag, read in the batch.
// - Oversized values: keys are names (`workflowStateKeySchema`) and values
//   JSON; one workflow's state takes at most `workflowStateMaxBytes` in
//   all, counted in the batch that writes it, after its own writes and
//   whatever concurrent runs wrote, so no interleaving passes the cap:
//   past it the whole write is refused (`workflow.state_too_large`) and
//   nothing of it lands.
// - A write from a failed or retried step: the run host calls this only
//   for an attempt that succeeded and whose record it accepted. A step's
//   write lands once, by its idempotency key (the same on every attempt
//   and replay): a receipt written in the same batch, which any later
//   write of that key finds, so the first write stands and a replay after
//   a crash between the write and the journal writes nothing again, even
//   after the state was reset or another run wrote since.
// - Concurrent runs: each key's value is the last write that landed (the
//   database serializes batches). Nothing merges.
// - Erasure: state is the company's record of what its runs computed, as
//   their outputs are (D3, person-erasure-inventory.ts); it names no
//   person. It goes with its workflow when the workflow is deleted, and
//   its builders can empty it any time.
// - What the audit log learns: each write and reset is recorded with the
//   run, step and sizes, never a key's value.

/** The most bytes a workflow's state takes, as SQL over its rows. */
const stateBytesSql = (workflowId: string) =>
  sql`(SELECT COALESCE(SUM(length(CAST(key AS BLOB)) + length(CAST(value AS BLOB))), 0)
    FROM workflow_state WHERE workflow_resource_id = ${workflowId})`;

const valuesSchema = z.record(workflowStateKeySchema, z.json());

/** The bytes of `text` in UTF-8, as SQLite's `length` of it as a blob. */
const bytesOf = (text: string): number =>
  new TextEncoder().encode(text).byteLength;

/** The state's rows of workflow `workflowId`, by key. */
const rowsOf = async (env: Env, workflowId: string) =>
  await drizzle(env.DB)
    .select({
      key: workflowState.key,
      value: workflowState.value,
      runId: workflowState.runId,
      updatedAt: workflowState.updatedAt,
    })
    .from(workflowState)
    .where(eq(workflowState.workflowResourceId, workflowId))
    .orderBy(asc(workflowState.key));

/**
 * What workflow `workflowId` keeps now, by key: the snapshot a run reads
 * once as it starts, and keeps for every activation after.
 */
export const workflowStateOf = async (
  env: Env,
  workflowId: string
): Promise<Record<string, Json>> => {
  const rows = await rowsOf(env, workflowId);
  return Object.fromEntries(
    rows.map(({ key, value }) => [key, z.json().parse(JSON.parse(value))])
  );
};

/**
 * Sets `values` in the state of run `runId`'s workflow, for its step whose
 * idempotency key is `stepKey`, once: a later call with the same key writes
 * nothing, whatever it carries. For the run host, only after the step
 * succeeded and its record was accepted. Refused: values that aren't named
 * JSON (`workflow.state_invalid`), a state that would pass its cap
 * (`workflow.state_too_large`), a restricted run
 * (`workflow.state_restricted`), a run that isn't one of a live workflow
 * (`workflow.run_unavailable`) or has ended (`workflow.run_ended`).
 */
export const writeWorkflowState = async (
  env: Env,
  runId: string,
  stepKey: string,
  values: Readonly<Record<string, Json>>
): Promise<void> => {
  if (runOfStepKey(stepKey) !== runId) {
    throw new Error("A step's key names another run than the one writing");
  }
  const parsed = valuesSchema.safeParse(values);
  if (!parsed.success) {
    throw workflowResourceErrors.create("workflow.state_invalid");
  }
  // Each value as its canonical JSON text, which `json_each` hands back
  // as it is: the one statement below writes every key.
  const entries = Object.entries(parsed.data).map(
    ([key, value]) => [key, canonicalJson(value)] as const
  );
  const texts = JSON.stringify(Object.fromEntries(entries));
  if (entries.length === 0) {
    return;
  }
  const written = entries.reduce(
    (total, [key, text]) => total + bytesOf(key) + bytesOf(text),
    0
  );
  if (written > workflowStateMaxBytes) {
    throw workflowResourceErrors.create("workflow.state_too_large");
  }
  const db = drizzle(env.DB);
  const run = await db
    .select({
      workflowId: workflowResourceRuns.workflowResourceId,
      restricted: workflowResourceRuns.restricted,
    })
    .from(workflowResourceRuns)
    .where(eq(workflowResourceRuns.id, runId))
    .get();
  if (run === undefined) {
    throw workflowResourceErrors.create("workflow.run_unavailable");
  }
  if (run.restricted) {
    throw workflowResourceErrors.create("workflow.state_restricted");
  }
  const { workflowId } = run;
  const writeId = crypto.randomUUID();
  const now = Date.now();
  // This batch's own receipt: every write below lands only while it holds.
  const mine = sql`EXISTS (SELECT 1 FROM workflow_state_writes
    WHERE step_key = ${stepKey} AND write_id = ${writeId})`;
  const step = stepKey.slice(stepKey.indexOf(":") + 1);
  try {
    await auditedBatch(env, db, [
      db
        .insert(workflowStateWrites)
        .select(
          sql`SELECT ${stepKey}, ${workflowId}, ${runId}, ${writeId}, 0, ${now}
            WHERE NOT EXISTS (SELECT 1 FROM workflow_state_writes WHERE step_key = ${stepKey})
              AND EXISTS (SELECT 1 FROM workflow_resource_runs WHERE id = ${runId}
                AND workflow_resource_id = ${workflowId} AND ended_at IS NULL
                AND restricted = 0)
              AND EXISTS (SELECT 1 FROM workflow_resources WHERE id = ${workflowId}
                AND deleted_at IS NULL)`
        )
        .onConflictDoNothing(),
      db
        .insert(workflowState)
        .select(
          sql`SELECT ${workflowId}, key, value, ${runId}, ${now}
            FROM json_each(${texts}) WHERE ${mine}`
        )
        .onConflictDoUpdate({
          target: [workflowState.workflowResourceId, workflowState.key],
          set: {
            value: sql`excluded.value`,
            runId: sql`excluded.run_id`,
            updatedAt: sql`excluded.updated_at`,
          },
        }),
      // The cap, over what this write left with every other's: NULL past
      // it, which the column refuses, and the whole batch with it.
      db
        .update(workflowStateWrites)
        .set({
          bytes: sql`(SELECT CASE WHEN total <= ${workflowStateMaxBytes}
            THEN total END FROM (SELECT ${stateBytesSql(workflowId)} AS total))`,
        })
        .where(
          sql`${workflowStateWrites.stepKey} = ${stepKey}
            AND ${workflowStateWrites.writeId} = ${writeId}`
        ),
      outboxedWhere(
        db,
        {
          actor: { type: "system" },
          action: "workflow.state.written",
          target: { type: "workflow_run", id: runId },
          detail: {
            workflow: workflowId,
            ...(step.length <= identifierMaxLength ? { step } : {}),
            keys: entries.length,
            bytes: written,
          },
        },
        mine
      ),
    ]);
  } catch (error) {
    if (notNullFailed(error, "workflow_state_writes.bytes")) {
      throw workflowResourceErrors.create("workflow.state_too_large");
    }
    throw error;
  }
  const receipt = await db
    .select({ writeId: workflowStateWrites.writeId })
    .from(workflowStateWrites)
    .where(eq(workflowStateWrites.stepKey, stepKey))
    .get();
  // Written now, or once before by this very step: either way it stands.
  if (receipt !== undefined) {
    return;
  }
  const ended = await db
    .select({ endedAt: workflowResourceRuns.endedAt })
    .from(workflowResourceRuns)
    .where(eq(workflowResourceRuns.id, runId))
    .get();
  throw ended?.endedAt === null || ended?.endedAt === undefined
    ? workflowResourceErrors.create("workflow.run_unavailable")
    : workflowResourceErrors.create("workflow.run_ended");
};

/**
 * Workflow `id` as `by` may read and reset its state: its builders and the
 * organization's admins; `role.forbidden` for its other users.
 */
const requireStateReader = async (env: Env, by: Acting, id: unknown) => {
  const workflow = await requireWorkflowRole(env, by, id, "user");
  if (workflow.role !== "builder" && !isAdmin(by.role)) {
    throw roleErrors.create("role.forbidden");
  }
  return workflow;
};

/** `rows` as the workflow's page shows them. */
const stateOf = (rows: Awaited<ReturnType<typeof rowsOf>>): WorkflowState => {
  const entries: WorkflowStateEntry[] = rows.map((row) => ({
    key: row.key,
    value: z.json().parse(JSON.parse(row.value)),
    runId: row.runId,
    updatedAt: row.updatedAt.toISOString(),
  }));
  return {
    entries,
    bytes: rows.reduce(
      (total, { key, value }) => total + bytesOf(key) + bytesOf(value),
      0
    ),
  };
};

/** What workflow `id` keeps between its runs, for its builders and admins. */
export const readWorkflowState = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<WorkflowState> => {
  const workflow = await requireStateReader(env, by, id);
  return stateOf(await rowsOf(env, workflow.id));
};

/**
 * Empties what workflow `id` keeps between its runs, for its builders and
 * admins, never Grasp staff, audited. A step that wrote before writes
 * nothing again.
 */
export const resetWorkflowState = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<WorkflowState> => {
  requireNotStaff(by);
  const workflow = await requireStateReader(env, by, id);
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .delete(workflowState)
      .where(eq(workflowState.workflowResourceId, workflow.id)),
    outboxed(db, {
      actor: by.actor ?? actorOf(by),
      action: "workflow.state.reset",
      target: { type: "workflow_resource", id: workflow.id },
    }),
  ]);
  return stateOf([]);
};
