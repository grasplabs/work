import { createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { errorName, log } from "@grasp-os/shared/log";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import {
  auditedBatch,
  outboxedEventWhere,
  uuidFromHash,
} from "./audit-outbox.ts";
import { removeRunSources, runRemovalsMax } from "./brain-next-origins.ts";
import {
  brainRunSources,
  workflowResourceRuns,
  workflowStartReceipts,
} from "./db/core/schema.ts";
import { queriesPerInvocationMax } from "./db/d1.ts";
import { workflowRoleSql } from "./workflow-roles.ts";

// A person's run results leave use in the Brain once they lose the
// workflow (GRA-1829, decided as its option 2; built in GRA-1816, whose
// threat model and design are on the issue). Core shows a run's result
// only to a person who holds the workflow's role now (workflows/
// resource-runs.ts `resourceRunFor`); the Brain keeps a run's result as a
// source for that person alone, in their own store (brain-sources.ts). So
// once they lose the role, those sources are removed there: out of use for
// good, their history kept, read by no one (brain-next.ts
// `removeOwnSources`, through brain-next-origins.ts `removeRunSources`).
//
// Not a run an App started for its person (its receipt's invoker an App):
// whoever uses the App sees its result on the App's page whether or not
// they hold the workflow (workflow-starts.ts `appStartHoldsSql`), so the
// workflow's role decides nothing of it. It is handed over as any run, and
// has no part here: its App's rule for taking it out of use is GRA-1926.
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
//    workflow: revoked at that statement's time, owed, and how many of
//    their runs of it were created since its last revocation (`markLost`). Only a row whose earlier removal is no
//    longer owed, so a second loss never takes the place of a removal
//    whose event is not stored yet: it is marked at a later tick.
// 2. The person's own store removes the sources of those runs, a page at a
//    time in one call each (`removePage`): every run of theirs of that
//    workflow created by the revocation and after the one before, so a
//    hand-over that read their role before the loss is of a run among
//    them, and its key is closed whichever lands first. Pages go in the
//    order of the index the runs are read by (created, then ID); after
//    each, the row keeps the last run it removed, and the next page, at
//    this tick or a later one, goes on from there.
// 3. With its last page, one batch clears the removal owed and stores its
//    one event, made the same each time from the row (`removedEvent`).
//
// A tick does a bounded number of pages (`pagesPerTick`), one for each
// owed row in turn before any gets a second, so a person with many runs
// never holds up anyone else's removal. A revocation left owed (a failure,
// a lost answer, a Worker that stopped) goes on at the clock's next tick
// from the last page it kept, never by anyone's action. Nothing brings
// removed sources back: a person who regains the role finds only what runs
// of theirs make from then on.

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

/** That run `run` (an ID, or a column holding one) was started by an App, as SQL. */
const appStartedSql = (run: string | SQLiteColumn): SQL =>
  sql`EXISTS (SELECT 1 FROM ${workflowStartReceipts}
    WHERE ${workflowStartReceipts.id} = ${run}
      AND ${workflowStartReceipts.invokerType} = 'app')`;

/** Whether run `runId` was started by an App for its person (above). */
export const appStarted = async (
  env: Pick<Env, "DB">,
  runId: string
): Promise<boolean> => {
  const [row] = await drizzle(env.DB).all<{ app: number }>(
    sql`SELECT ${appStartedSql(runId)} AS app`
  );
  return row?.app === 1;
};

/**
 * The statement that records run `runId`'s person and workflow as holding
 * a run source in use: for the batch that ends its hand-over as added
 * (brain-sources.ts), under `condition`, so only the attempt that ends it
 * records it. Not for a run an App started (above). On a row already
 * there, only for a run created after its last revocation: a run created
 * by then is one that revocation removes, whichever order its hand-over
 * and the revocation land in, so it never marks the person's loss again.
 */
export const runSourceInUse = (
  db: DrizzleD1Database,
  runId: string,
  condition: SQL
) => {
  const runs = workflowResourceRuns;
  return db
    .insert(brainRunSources)
    .select(
      sql`SELECT ${runs.principalId}, ${runs.workflowResourceId}, 1, NULL, NULL, 0, NULL, NULL
        FROM ${runs}
        WHERE ${runs.id} = ${runId} AND NOT ${appStartedSql(runs.id)} AND ${condition}`
    )
    .onConflictDoUpdate({
      target: [brainRunSources.personId, brainRunSources.workflowId],
      set: { inUse: true },
      setWhere: sql`${brainRunSources.revokedAt} IS NULL
        OR ${brainRunSources.revokedAt} < (SELECT ${runs.createdAt} FROM ${runs} WHERE ${runs.id} = ${runId})`,
    });
};

/** The database's own time, in milliseconds, as SQL: the same throughout one statement. */
const statementTimeSql = sql`CAST(unixepoch('subsec') * 1000 AS INTEGER)`;

/**
 * The person-started runs of workflow `workflowId` for `personId` created
 * by `revokedAt` (an instant, or SQL for one), in the order of the index
 * they are read by (`workflow_resource_runs_principal_idx`: created, then
 * ID).
 */
const coveredRuns = (
  personId: string | SQLiteColumn,
  workflowId: string | SQLiteColumn,
  revokedAt: number | SQL
): SQL => {
  const runs = workflowResourceRuns;
  return sql`${runs.workflowResourceId} = ${workflowId}
    AND ${runs.principalId} = ${personId}
    AND ${runs.createdAt} <= ${revokedAt}
    AND NOT ${appStartedSql(runs.id)}`;
};

/**
 * Marks every row in use whose person no longer holds its workflow
 * (`holdsWorkflowSql`, read in this statement) as revoked, owed, and with
 * how many of their runs of it it covers; only a row whose earlier removal
 * is no longer owed. Revoked at the statement's own time, the moment the
 * role was read: a run created by then is covered, one after it is the
 * hand-over's to judge (brain-sources.ts). It covers the runs created
 * after the row's last revocation, whose removal is complete, so each
 * loss removes, and counts, only what came since: its cursor starts after
 * that moment (`removedThroughAt`, with no run).
 *
 * What it costs each minute: one pass over the rows in use (their partial
 * index), and for each, the role's indexed lookups until one holds
 * (`workflowRoleSql`: the person's membership, the workflow, its shares by
 * person, team and project). Measured in workerd (D1's `rows_read`): 5 rows
 * read a row whose person owns the workflow, 6 through a share to them, 8
 * through a team; so at 25,000 rows in use, some 125,000 to 200,000 rows
 * read a minute, every one by an index.
 */
const markLost = async (env: Pick<Env, "DB">): Promise<void> => {
  const rows = brainRunSources;
  const runs = workflowResourceRuns;
  await drizzle(env.DB)
    .update(rows)
    .set({
      inUse: false,
      // Each right-hand side reads the row as it was before this update.
      revokedAt: sql`${statementTimeSql}`,
      removedThroughAt: sql`${rows.revokedAt}`,
      removedThrough: null,
      removalOwed: true,
      runs: sql`(SELECT count(*) FROM ${runs}
        WHERE ${coveredRuns(rows.personId, rows.workflowId, statementTimeSql)}
          AND (${rows.revokedAt} IS NULL OR ${runs.createdAt} > ${rows.revokedAt}))`,
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

/** A revocation still owed, as `markLost` wrote it and its pages since. */
interface OwedRevocation {
  personId: string;
  workflowId: string;
  revokedAt: Date;
  runs: number;
  /**
   * Where its next page starts, after (`removedThroughAt`,
   * `removedThrough`) in the runs' index order: the last run it removed,
   * its creation and ID; before its first page, the last revocation's
   * moment and no run, so it starts after every run that one covered; or
   * nothing at all for a first revocation.
   */
  removedThroughAt: Date | null;
  removedThrough: string | null;
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

/** `row`'s own row, while it is owed for the revocation it holds. */
const stillOwed = (row: OwedRevocation): SQL | undefined =>
  and(
    eq(brainRunSources.personId, row.personId),
    eq(brainRunSources.workflowId, row.workflowId),
    eq(brainRunSources.revokedAt, row.revokedAt),
    eq(brainRunSources.removalOwed, true)
  );

/** That run (created, ID) comes after `row`'s cursor, in index order, as SQL. */
const afterCursor = (row: OwedRevocation): SQL | undefined => {
  const runs = workflowResourceRuns;
  if (row.removedThroughAt === null) {
    return undefined;
  }
  const at = row.removedThroughAt.getTime();
  return row.removedThrough === null
    ? sql`${runs.createdAt} > ${at}`
    : sql`(${runs.createdAt}, ${runs.id}) > (${at}, ${row.removedThrough})`;
};

/**
 * One page of `row`'s revocation: the next runs it covers after its
 * cursor, in the order of the index they are read by, as many as one call
 * of the store removes (`runRemovalsMax`), removed in the person's own
 * store in that one call (safe to repeat: a key removed already is left as
 * it is). Then, while the row is owed for this revocation, either the
 * page's last run kept as its cursor (only ever forward, so a tick that
 * overlaps another never moves it back), or, for the last page, the
 * removal no longer owed and its one event stored, in one batch. Whether
 * the revocation is complete. Throws when a step fails: the revocation
 * stays owed, from the last page it kept.
 */
const removePage = async (env: Env, row: OwedRevocation): Promise<boolean> => {
  const db = drizzle(env.DB);
  const runs = workflowResourceRuns;
  const rows = brainRunSources;
  const page = await db
    .select({ id: runs.id, createdAt: runs.createdAt })
    .from(runs)
    .where(
      and(
        coveredRuns(row.personId, row.workflowId, row.revokedAt.getTime()),
        afterCursor(row)
      )
    )
    .orderBy(runs.createdAt, runs.id)
    .limit(runRemovalsMax);
  if (page.length > 0) {
    await removeRunSources(
      env,
      row.personId,
      page.map(({ id }) => id)
    );
  }
  const last = page.at(-1);
  if (last !== undefined && page.length === runRemovalsMax) {
    const at = last.createdAt.getTime();
    await db
      .update(rows)
      .set({ removedThroughAt: last.createdAt, removedThrough: last.id })
      .where(
        and(
          stillOwed(row),
          sql`(${rows.removedThroughAt} IS NULL
            OR ${rows.removedThroughAt} < ${at}
            OR (${rows.removedThroughAt} = ${at} AND ${rows.removedThrough} < ${last.id}))`
        )
      );
    row.removedThroughAt = last.createdAt;
    row.removedThrough = last.id;
    return false;
  }
  await auditedBatch(env, db, [
    db
      .update(rows)
      .set({ removalOwed: false, removedThroughAt: null, removedThrough: null })
      .where(stillOwed(row)),
    outboxedEventWhere(db, await removedEvent(row), sql`changes() > 0`),
  ]);
  return true;
};

/**
 * The most pages one tick removes, across every owed revocation: each page
 * makes three calls (its read and its progress to D1, and one to the
 * person's store), and a tick takes a tenth of what one invocation may
 * make (`queriesPerInvocationMax`), which every task of the clock's
 * shares, as brain-hand-overs.ts gives its notes alone. So a tick removes
 * at most 33 pages, 3,300 runs, and completes at most 33 revocations; the
 * rest go on at the next. A team of 200 that loses 30 workflows (6,000
 * revocations) is done some three hours later, and until then each of
 * them still recalls their own earlier results.
 */
export const pagesPerTick = Math.floor(queriesPerInvocationMax / 10 / 3);

/**
 * Takes the run results of everyone who lost a workflow out of use in the
 * Brain (above): marks each loss (`markLost`), then goes through the
 * revocations still owed, at most `pages` pages: one page for each in turn
 * (those not yet begun first, then the oldest), then a second round for
 * those still owed, and so on. One whose page fails is logged with its
 * workflow's ID and its error's name, and has no more turns this tick: it
 * goes on at the next, from the last page it kept. The clock runs it each
 * minute; a run that overlaps the next repeats only pages, which are safe
 * to repeat, and stores each event once.
 */
export const removeLostRunSources = async (
  env: Env,
  pages: number = pagesPerTick
): Promise<void> => {
  await markLost(env);
  // Only those that can get a turn: at most one a page.
  const owed = await drizzle(env.DB)
    .select({
      personId: brainRunSources.personId,
      workflowId: brainRunSources.workflowId,
      revokedAt: brainRunSources.revokedAt,
      runs: brainRunSources.runs,
      removedThroughAt: brainRunSources.removedThroughAt,
      removedThrough: brainRunSources.removedThrough,
    })
    .from(brainRunSources)
    // As the partial index on owed removals is written, so it is used.
    .where(sql.raw("removal_owed = 1"))
    .orderBy(
      sql`${brainRunSources.removedThrough} IS NOT NULL`,
      brainRunSources.revokedAt
    )
    .limit(pages);
  let turning: OwedRevocation[] = owed.flatMap(({ revokedAt, runs, ...row }) =>
    revokedAt === null || runs === null ? [] : [{ ...row, revokedAt, runs }]
  );
  let left = pages;
  while (left > 0 && turning.length > 0) {
    const next: OwedRevocation[] = [];
    for (const row of turning.slice(0, left)) {
      left -= 1;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one page at a time
        if (!(await removePage(env, row))) {
          next.push(row);
        }
      } catch (error) {
        log.warn("brain.run_sources.removal_owed", {
          workflowId: row.workflowId,
          errorName: errorName(error),
        });
      }
    }
    turning = next;
  }
};
