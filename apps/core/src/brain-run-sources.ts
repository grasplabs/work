import { createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { and, asc, eq, gt, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import {
  auditedBatch,
  outboxedEventWhere,
  uuidFromHash,
} from "./audit-outbox.ts";
import { removeRunSources } from "./brain-next-origins.ts";
import { brainRunSources, workflowResourceRuns } from "./db/core/schema.ts";
import { completeEachOwed } from "./owed-removals.ts";
import { workflowRoleSql } from "./workflow-roles.ts";

// A person's run results leave use in the Brain once they lose the
// workflow (GRA-1829, decided as its option 2; built in GRA-1816, whose
// threat model and design are on the issue). Core shows a run's result
// only to a person who holds the workflow's role now (workflows/
// resource-runs.ts `resourceRunFor`); the Brain keeps a run's result as a
// source for that person alone, in their own store (brain-sources.ts). So
// once they lose the role, those sources are removed there: out of use for
// good, their history kept, read by no one (brain-next.ts `removeSource`).
//
// A role is lost in many ways (unshared, a team or project left or
// deleted, the workflow deleted or given another owner, an admin demoted,
// a member removed), some committed in Better Auth's own batch with no
// statement of ours beside them. So nothing waits for a signal from each:
// the clock decides from the role as read now (`holdsWorkflowSql`, the run
// page's own rule), each minute, for every person and workflow whose runs
// were handed over (`brain_run_sources`, written by the hand-over's own
// ending batch, brain-sources.ts):
//
// 1. One statement marks each row in use whose person no longer holds its
//    workflow: revoked now, owed, and how many of their runs of it were
//    created by then (`markLost`). Only a row whose earlier removal is no
//    longer owed, so a second loss never takes the place of a removal
//    whose event is not stored yet: it is marked at a later tick.
// 2. The Brain removes the source of each of those runs from their own
//    store (`removeRunSources`): every run of theirs of that workflow
//    created by the revocation, so a hand-over that read their role before
//    the loss is of a run among them, and its key is closed whichever
//    lands first.
// 3. One batch clears the removal owed and stores its one event, made the
//    same each time from the row (`removedEvent`).
//
// A revocation left owed (a failure, a lost answer, a Worker that stopped)
// is completed at the clock's next tick, never by anyone's action. Nothing
// brings removed sources back: a person who regains the role finds only
// what runs of theirs make from then on.

/**
 * That `person` holds workflow `workflow` now, as the run page decides it
 * (`resourceRunFor`): the workflow is live and they have a role in it
 * (`workflowRoleSql`), read in the statement it stands in. Each an ID, or a
 * column holding one.
 */
export const holdsWorkflowSql = (
  person: string | SQLiteColumn,
  workflow: string | SQLiteColumn
): SQL => sql`(EXISTS (SELECT 1 FROM workflow_resources AS live
    WHERE live.id = ${workflow} AND live.deleted_at IS NULL)
  AND ${workflowRoleSql(person, workflow)})`;

/**
 * The statement that records run `runId`'s person and workflow as holding
 * a run source in use: for the batch that ends its hand-over as added
 * (brain-sources.ts), under `condition`, so only the attempt that ends it
 * records it.
 */
export const runSourceInUse = (
  db: DrizzleD1Database,
  runId: string,
  condition: SQL
) =>
  db
    .insert(brainRunSources)
    .select(
      sql`SELECT ${workflowResourceRuns.principalId}, ${workflowResourceRuns.workflowResourceId}, 1, NULL, NULL, 0
        FROM ${workflowResourceRuns}
        WHERE ${workflowResourceRuns.id} = ${runId} AND ${condition}`
    )
    .onConflictDoUpdate({
      target: [brainRunSources.personId, brainRunSources.workflowId],
      set: { inUse: true },
    });

/**
 * Marks every row in use whose person no longer holds its workflow
 * (`holdsWorkflowSql`, read in this statement) as revoked at `now`, owed,
 * and with how many of their runs of it were created by then; only a row
 * whose earlier removal is no longer owed.
 */
const markLost = async (env: Pick<Env, "DB">, now: Date): Promise<void> => {
  const rows = brainRunSources;
  await drizzle(env.DB)
    .update(rows)
    .set({
      inUse: false,
      revokedAt: now,
      removalOwed: true,
      runs: sql`(SELECT count(*) FROM ${workflowResourceRuns}
        WHERE ${workflowResourceRuns.workflowResourceId} = ${rows.workflowId}
          AND ${workflowResourceRuns.principalId} = ${rows.personId}
          AND ${workflowResourceRuns.createdAt} <= ${now.getTime()})`,
    })
    .where(
      and(
        // As the partial index on rows in use is written, so it is used.
        sql.raw("in_use = 1"),
        eq(rows.removalOwed, false),
        sql`NOT ${holdsWorkflowSql(rows.personId, rows.workflowId)}`
      )
    );
};

/** A revocation still owed, as `markLost` wrote it. */
interface OwedRevocation {
  personId: string;
  workflowId: string;
  revokedAt: Date;
  runs: number;
}

/**
 * The one event a revocation is recorded by, the same each time it is
 * completed: its ID derived from the person, the workflow and when it was
 * marked, its time that moment, and its detail from the row.
 */
const removedEvent = async (row: OwedRevocation): Promise<AuditEvent> => ({
  ...createAuditEvent(
    {
      actor: { type: "system" },
      action: "brain.run_sources.removed",
      target: { type: "workflow_resource", id: row.workflowId },
      detail: { personId: row.personId, runs: row.runs },
    },
    "core"
  ),
  id: uuidFromHash(
    await sha256Hex(
      JSON.stringify([
        "brain.run_sources.removed",
        row.personId,
        row.workflowId,
        row.revokedAt.getTime(),
      ])
    )
  ),
  at: row.revokedAt.toISOString(),
});

/** How many run IDs one read takes, and one removal is given. */
const runsPage = 500;

/**
 * Completes `row`: the Brain removes the source of each of the person's
 * runs of the workflow created by its revocation, a page at a time (safe
 * to repeat: a key removed already is left as it is), then the row is no
 * longer owed and the revocation's one event is stored with it, in one
 * batch, by the completion that cleared it. Throws when either step
 * fails: the revocation stays owed, for the clock's next tick. Nothing
 * records a failure: a removal whose answer was lost may have happened.
 */
const completeRevocation = async (
  env: Env,
  row: OwedRevocation
): Promise<void> => {
  const db = drizzle(env.DB);
  const runs = workflowResourceRuns;
  let after = "";
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a page after the other, by ID
    const page = await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.workflowResourceId, row.workflowId),
          eq(runs.principalId, row.personId),
          lte(runs.createdAt, row.revokedAt),
          gt(runs.id, after)
        )
      )
      .orderBy(asc(runs.id))
      .limit(runsPage);
    // oxlint-disable-next-line no-await-in-loop -- a page after the other
    await removeRunSources(
      env,
      row.personId,
      page.map(({ id }) => id)
    );
    const last = page.at(-1);
    if (last === undefined || page.length < runsPage) {
      break;
    }
    after = last.id;
  }
  await auditedBatch(env, db, [
    db
      .update(brainRunSources)
      .set({ removalOwed: false })
      .where(
        and(
          eq(brainRunSources.personId, row.personId),
          eq(brainRunSources.workflowId, row.workflowId),
          eq(brainRunSources.revokedAt, row.revokedAt),
          eq(brainRunSources.removalOwed, true)
        )
      ),
    outboxedEventWhere(db, await removedEvent(row), sql`changes() > 0`),
  ]);
};

/**
 * Takes the run results of everyone who lost a workflow out of use in the
 * Brain (above): marks each loss (`markLost`), then completes every
 * revocation still owed, oldest first, each on its own
 * (`completeEachOwed`): one that fails is logged with its workflow's ID
 * and its error's name, and the run goes on to the rest, so it never holds
 * up another; it is tried again at the next tick. The clock runs it each minute. Unbounded, as `retryErasures`
 * beside it: what is owed is only a loss not yet completed, and a run that
 * overlaps the next repeats nothing, as a completion is safe to repeat and
 * stores its one event once.
 */
export const removeLostRunSources = async (env: Env): Promise<void> => {
  await markLost(env, new Date());
  const owed = await drizzle(env.DB)
    .select({
      personId: brainRunSources.personId,
      workflowId: brainRunSources.workflowId,
      revokedAt: brainRunSources.revokedAt,
      runs: brainRunSources.runs,
    })
    .from(brainRunSources)
    // As the partial index on owed removals is written, so it is used.
    .where(sql.raw("removal_owed = 1"))
    .orderBy(asc(brainRunSources.revokedAt));
  await completeEachOwed(
    owed.flatMap(({ revokedAt, runs, ...row }) =>
      revokedAt === null || runs === null ? [] : [{ ...row, revokedAt, runs }]
    ),
    async (row) => {
      await completeRevocation(env, row);
    },
    "brain.run_sources.removal_owed",
    ({ workflowId }) => ({ workflowId })
  );
};
