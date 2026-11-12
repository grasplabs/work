import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { auditedBatch } from "../audit-outbox.ts";
import { eraseSources, runSource } from "../brain-next-origins.ts";
import {
  workflowResourceParams,
  workflowStartReceipts,
  runBrainEvidence,
  runChatSources,
  resourceRunMailCalls,
  runMailStampClaims,
  runInboxes,
  runLineageAttempts,
  runLineages,
  workflowDecisions,
  workflowResourceRuns,
  workflowStateWrites,
} from "../db/core/schema.ts";
import { runRetentionDays } from "./engine.ts";
import { runFilesRemoved } from "./run-files.ts";
import { orphanedSnapshotsRemoved } from "./state-snapshots.ts";

// Retention of workflow runs. A run reads what its person may read (a
// message, a chat's transcript, a record) and keeps it: as its input, in
// what its steps returned and in its output, all with the engine; in what
// its decisions asked and were answered; and in the input of a side
// effect connect still holds for its person. Kept for ever, that outlives
// the retention of whatever it was read from. So once a run has ended for
// the run retention (`runRetentionDays`, 30 days), those details go:
// - the engine's record, by the engine itself: every run is created with
//   the retention as its instance's own (engine.ts), which covers every
//   way an instance ends (completed, terminated, errored);
// - the rest by the 15-minute clock (`sweepWorkflowStartDetails`): a start
//   receipt's input and the parameter values it froze, once it was
//   admitted that long ago and the run it admitted, if any, ended that
//   long ago (the run reads them from the receipt until it ends:
//   resource-runs.ts), with the receipts of that run's attempts (its
//   lineage's row stays), what its decisions asked and were answered, and
//   connect's held actions; and the values of a parameter revision once
//   another replaced it that long ago, or its workflow was deleted. The
//   database lets nothing else of either change, nor be written over by
//   an insert by key or rowid (migrations 0080, 0095 and 0101): their IDs,
//   hashes, revisions and who did what stay, so a start sent again is
//   still known by its key and input's hash, and the revision in force is
//   never touched.
//
// The run's row stays, with what it was and how it went, none of which
// holds what the run read: it is still listed and counted, and the audit
// log's events of it still name a run there is. Whoever reads the run
// once its retention is over is told so (`detailsRemoved`,
// `removedText`), never an empty answer passed off as the run's.
//
// Kept, each by rules of its own, not this retention's:
// - The audit log: it has its own retention (audit-log.ts), and its
//   events of a run's steps name them as the workflow did, keys and all.
// - What a workflow wrote elsewhere: an App's own storage, Knowledge,
//   mail it sent.
// - The engine's records of core's own runs (Knowledge's extractions):
//   the engine keeps those as long as the account's plan lets it, 30 days
//   at most.
//
// What can go wrong, and why it doesn't:
// - A live run swept. Only a start whose run has ended, by the time it
//   ended, is swept: a run that waits, sleeps or is paused has not ended,
//   however long ago it started. Ending is final, so a run read as ended
//   stays ended while it is swept.
// - The sweep stopped half-way, or run twice at once. Connect's held
//   actions go first and the receipt is marked last, in one batch with
//   the rest, so a pass that stops in between leaves the start due, and
//   the next removes what is left and marks it: removing what is gone
//   removes nothing. Marking is conditional on the receipt not being
//   marked, so two passes mark it once.
// - The engine's clock, the sweep's and a reader's not agreeing. Readers
//   go by neither: a run's details are removed once its retention is over
//   by its row's own time (`detailsRemoved`), one rule for every read of
//   a run, and from then on nothing the engine may still have of it is
//   shown.

const dayMs = 24 * 60 * 60 * 1000;

/** Most start receipts swept at once, as one page (`dueStarts`). */
export const sweptPerBatch = 50;

/**
 * Whether a run's details are removed, as every reader of a run asks: its
 * row is marked, or it has ended and its retention is over. By the row
 * alone, so a run reads the same wherever it is read, whether the sweep
 * has reached it yet or not, and whatever the engine still has of it.
 */
export const detailsRemoved = (
  row: { endedAt: Date | null; detailsRemovedAt: Date | null },
  now = Date.now()
): boolean =>
  row.detailsRemovedAt !== null ||
  (row.endedAt !== null &&
    row.endedAt.getTime() + runRetentionDays * dayMs <= now);

/**
 * What readers say where a swept run's own words were (its failure's
 * message, its decisions' descriptions): the rows keep nothing in their
 * place.
 */
export const removedText = `The details of this run were removed: they are kept for ${runRetentionDays} days after a run ends.`;

/**
 * The statements that remove the receipts of the steps' attempts of
 * `runs` (run IDs, or a query of them): a receipt names its step by the engine's key,
 * which can hold a keyed step's data, and kept for ever, the receipts of
 * ended runs would grow the table without bound, so none outlives its
 * run's details. One still holding (a last attempt that never returned:
 * its run has ended) is settled first, as an admission would, charging
 * its lineage up to its deadline (now, at the latest), so the lineage's
 * row, which stays, neither keeps holding it nor loses what it used.
 * Then every receipt of the runs goes.
 */
const attemptsPruned = (
  db: DrizzleD1Database,
  runs: readonly string[] | SQLWrapper,
  now: Date
) => {
  const held = runLineageAttempts;
  const lapsed = and(inArray(held.runId, runs), isNull(held.settledAt));
  // What it could use: up to its deadline, or until now.
  const used = sql`min(${held.deadline}, ${now.getTime()}) - ${held.admittedAt}`;
  const lapsedOf = (sum: SQL) =>
    sql`(SELECT coalesce(sum(${sum}), 0) FROM ${held} WHERE ${lapsed} AND ${held.rootRunId} = ${runLineages.rootRunId})`;
  return [
    db
      .update(runLineages)
      .set({
        activeUsedMs: sql`${runLineages.activeUsedMs} + ${lapsedOf(used)}`,
        activeHeldMs: sql`${runLineages.activeHeldMs} - ${lapsedOf(sql`${held.reservedMs}`)}`,
      })
      .where(
        inArray(
          runLineages.rootRunId,
          db.select({ root: held.rootRunId }).from(held).where(lapsed)
        )
      ),
    db.update(held).set({ usedMs: used, settledAt: now }).where(lapsed),
    db.delete(held).where(inArray(held.runId, runs)),
  ] as const;
};

/** Most start receipts, and parameter revisions, one clock run empties. */
export const startDetailsPerSweep = 500;

/** A start receipt the sweep found due (`dueStarts`). */
interface DueStart {
  id: string;
  workflowId: string;
  createdAt: number;
  /** Whether it admitted a run: its run has its ID (resource-runs.ts). */
  ran: boolean;
}

/**
 * The next `limit` start receipts due at `before`, after `after` by when
 * they were admitted and their IDs, oldest first: read by the index of
 * receipts that still have their details, each one's run by its ID, so
 * no table is read whole and nothing sorted. A receipt is due once it was
 * admitted before `before`, and its run, if it admitted one, ended
 * before it too: a run that hasn't ended loads its input and parameters
 * from its receipt on every activation (resource-runs.ts), and once it
 * ended its retention counts from its end.
 */
const dueStarts = async (
  db: DrizzleD1Database,
  before: Date,
  after: DueStart | undefined,
  limit: number
): Promise<DueStart[]> => {
  const receipts = workflowStartReceipts;
  const runs = workflowResourceRuns;
  const rows = await db
    .select({
      id: receipts.id,
      workflowId: receipts.workflowResourceId,
      createdAt: sql<number>`${receipts.createdAt}`,
      run: runs.id,
    })
    .from(receipts)
    .leftJoin(runs, eq(runs.id, receipts.id))
    .where(
      and(
        isNull(receipts.detailsRemovedAt),
        lt(receipts.createdAt, before),
        after &&
          sql`(${receipts.createdAt}, ${receipts.id}) > (${after.createdAt}, ${after.id})`,
        or(isNull(runs.id), lt(runs.endedAt, before))
      )
    )
    .orderBy(asc(receipts.createdAt), asc(receipts.id))
    .limit(limit);
  return rows.map(({ id, workflowId, createdAt, run }) => ({
    id,
    workflowId,
    createdAt,
    ran: run !== null,
  }));
};

/**
 * Removes the details of `dueRows` (`sweepWorkflowStartDetails`), read
 * once, so what connect is asked to drop and what is marked are the same
 * starts, whatever another sweep marks between the two.
 */
const startDetailsRemoved = async (
  env: Env,
  dueRows: readonly DueStart[],
  before: Date,
  now: Date
): Promise<void> => {
  const db = drizzle(env.DB);
  const receipts = workflowStartReceipts;
  // As one bound value, within D1's bound parameters however many.
  const due = sql`(SELECT due.value FROM json_each(${JSON.stringify(
    dueRows.map(({ id }) => id)
  )}) AS due)`;
  // What connect still holds of their runs goes first: a run that ended while a side effect of it
  // was held leaves the action, with its exact input, until its person
  // confirms it, which they may never do. A restricted run's own are held,
  // under the workflow, and so may be those of any App its calls reached,
  // an unrestricted run's included (an App entering restricted mode as an
  // export of it runs), keyed by its steps as its own are: connect drops
  // them all by the run (`dropForEndedRuns`). A sweep that fails here
  // marks nothing, and the next does it again.
  const heldOf = dueRows.flatMap(({ id, workflowId, ran }) =>
    ran ? [{ runId: id, workflowId }] : []
  );
  if (heldOf.length > 0) {
    await env.CONNECT.dropForEndedRuns({ runs: heldOf });
  }
  // And what the new Brain took in of their runs (brain-next-origins.ts):
  // erased before they are marked, so a sweep it fails for marks nothing
  // and the next erases them again. A hand-over still on its way for one
  // of them is refused from now on.
  await eraseSources(
    env,
    heldOf.map(({ runId }) => runSource(runId)),
    "retention"
  );
  await auditedBatch(env, db, [
    // A start's run has its receipt's ID (resource-runs.ts).
    ...attemptsPruned(db, due, now),
    // What mail-stamps.ts keeps of its mail: its stamps' claims first,
    // which name them, then its calls. A copy this late starts its runs
    // as a root, as anyone's mail does.
    db
      .delete(runMailStampClaims)
      .where(
        inArray(
          runMailStampClaims.stamp,
          db
            .select({ stamp: resourceRunMailCalls.stamp })
            .from(resourceRunMailCalls)
            .where(inArray(resourceRunMailCalls.runId, due))
        )
      ),
    db
      .delete(resourceRunMailCalls)
      .where(inArray(resourceRunMailCalls.runId, due)),
    // Its own files go with its details (GRA-724): marked here, their
    // chunks deleted by `sweepRunFiles`.
    runFilesRemoved(db, due),
    // What its recalls cited (resource-reads.ts): no new call of its to gate.
    db.delete(runBrainEvidence).where(inArray(runBrainEvidence.runId, due)),
    // And what the chat that had it started had read (workflow-starts.ts).
    db.delete(runChatSources).where(inArray(runChatSources.runId, due)),
    // And its inboxes (run-inboxes.ts): a reply from now on is to an
    // address nobody has.
    db.delete(runInboxes).where(inArray(runInboxes.runId, due)),
    // And the receipts of what its steps kept between the workflow's runs
    // (workflow-state.ts): they only keep a replay from writing twice, and
    // no step of a run this long ended replays. What it wrote stays.
    db
      .delete(workflowStateWrites)
      .where(inArray(workflowStateWrites.runId, due)),
    // What its decisions asked, about what, and what was answered
    // (GRA-941): who answered, when and how stay.
    db
      .update(workflowDecisions)
      .set({ description: "", payload: null, input: null })
      .where(inArray(workflowDecisions.resourceRunId, due)),
    db
      .update(receipts)
      .set({
        input: null,
        params: null,
        stateHash: null,
        detailsRemovedAt: now,
      })
      // Another sweep may have marked some meanwhile: marked once.
      .where(and(inArray(receipts.id, due), isNull(receipts.detailsRemovedAt))),
  ]);
};

/**
 * Removes the values of parameter revisions replaced before `before`, or
 * of workflows deleted before it, at most {@link startDetailsPerSweep},
 * oldest first, marked at `now`: read by the index of revisions that
 * still have their values, each one's successor and workflow by key.
 */
const paramValuesRemoved = async (
  db: DrizzleD1Database,
  before: Date,
  now: Date
): Promise<void> => {
  const params = workflowResourceParams;
  await db
    .update(params)
    .set({ values: null, valuesRemovedAt: now })
    .where(
      sql`rowid IN (SELECT replaced.rowid FROM ${params} AS replaced
          WHERE replaced.values_removed_at IS NULL
            AND (EXISTS (SELECT 1 FROM ${params} AS next
                WHERE next.workflow_resource_id = replaced.workflow_resource_id
                  AND next.revision = replaced.revision + 1
                  AND next.set_at < ${before.getTime()})
              OR EXISTS (SELECT 1 FROM workflow_resources AS gone
                WHERE gone.id = replaced.workflow_resource_id
                  AND gone.deleted_at < ${before.getTime()}))
          ORDER BY replaced.set_at
          LIMIT ${startDetailsPerSweep})`
    );
};

/**
 * Removes the input and frozen parameter values of start receipts
 * admitted before `before`, with the receipts of the attempts of the
 * runs they admitted (`attemptsPruned`; the runs' lineages stay), and
 * the values of parameter revisions replaced before it or of workflows
 * deleted before it, at most {@link startDetailsPerSweep} of each, oldest
 * first, marked at `now`: set to null once, which is all the database
 * lets anything change of them. The rest is left to the next clock run.
 * The starts go a page of `sweptPerBatch` at a time (`dueStarts`), each
 * page past the last start of the one before, so a start left due holds
 * up none behind it; each page in one batch, so the attempts go only with
 * their start's details, and those of every start marked are gone.
 */
export const sweepWorkflowStartDetails = async (
  env: Env,
  before: Date,
  now: Date
): Promise<void> => {
  const db = drizzle(env.DB);
  let swept = 0;
  let after: DueStart | undefined;
  while (swept < startDetailsPerSweep) {
    const limit = Math.min(sweptPerBatch, startDetailsPerSweep - swept);
    // oxlint-disable-next-line no-await-in-loop -- one bounded page after another
    const page = await dueStarts(db, before, after, limit);
    if (page.length === 0) {
      break;
    }
    // oxlint-disable-next-line no-await-in-loop -- one bounded page after another
    await startDetailsRemoved(env, page, before, now);
    swept += page.length;
    if (page.length < limit) {
      break;
    }
    after = page.at(-1);
  }
  await paramValuesRemoved(db, before, now);
  // The snapshots no start or test run names any more.
  await orphanedSnapshotsRemoved(db);
};

/**
 * Removes what core keeps of what independent workflows' runs read, once
 * the run retention before `now` is over (`sweepWorkflowStartDetails`).
 */
export const sweepRunDetails = async (env: Env, now: Date): Promise<void> => {
  const before = new Date(now.getTime() - runRetentionDays * dayMs);
  await sweepWorkflowStartDetails(env, before, now);
};
