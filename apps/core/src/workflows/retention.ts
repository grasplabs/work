import { errorFields, log } from "@grasp-os/shared/log";
import { and, asc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import {
  workflowResourceParams,
  workflowStartReceipts,
  runLineageChildren,
  runMailCalls,
  runMailStampClaims,
  runMailStampRefusals,
  runMailStamps,
  runLineageAttempts,
  runLineages,
  workflowDecisions,
  workflowRuns,
} from "../db/core/schema.ts";
import { chunks } from "../db/d1.ts";
import { runEngine, runRetentionDays } from "./engine.ts";

// Retention of workflow runs. A run reads what its person may read (a
// message, a chat's transcript, a record) and keeps it: as its input, in
// what its steps returned and in its output, all with the engine; in the
// message its failure report quotes; in the key of a keyed step, which
// its failure report and its decisions name; in what its decisions asked
// and were answered; and in the input of a side effect connect still
// holds for its person. Kept for ever, that outlives the retention of
// whatever it was read from. So once a run has ended for the deployment's
// retention (`RUN_RETENTION_DAYS`, 30 days unless set, never more), those
// details go:
// - the engine's record, by the engine itself: every run is created with
//   the retention as its instance's own (engine.ts), which covers every
//   way an instance ends (completed, terminated, errored);
// - the rest by the 15-minute cron trigger (`sweepRunDetails`): what the
//   run's row and its decisions keep, and connect's held actions.
//
// The run's row stays, with what it was and how it went: its ID, App,
// workflow and version, who started it, its status and times, and of a
// failed run the step's name, the error's code and the input's shape,
// none of which hold what the run read. So it is still listed and
// counted, the audit log's events of it still name a run there is, and
// its trigger key still stands for it: a trigger delivered again finds
// this run and starts no other. The row says when its details went
// (`details_removed_at`), and whoever reads the run is told so, never an
// empty answer passed off as the run's. What went is left empty in the
// rows; readers say why, with the retention as the deployment has it when
// they read (`removedText`), so no row keeps a number that may change.
//
// The same retention removes what independent workflows keep of what a
// person put in (`sweepWorkflowStartDetails`): a start receipt's input and
// the parameter values it froze, once it was admitted that long ago and
// the run it admitted, if any, ended that long ago (the run reads them
// from the receipt until it ends: resource-runs.ts), with the receipts
// of that run's attempts, as an App run's go with its details (its
// lineage's row stays, as an App run's does), and
// the values of a parameter revision once another replaced it that long
// ago, or its workflow was deleted. The database lets nothing else of
// either change (migration 0080): their IDs, hashes, revisions and who
// did what stay, so a start sent again is still known by its key and
// input's hash, and the revision in force is never touched.
//
// Kept, each by rules of its own, not this retention's:
// - The audit log: it has its own retention (audit-log.ts), and its
//   events of a run's steps name them as the workflow did, keys and all.
// - A chat started to fix a failed run keeps the failure report it was
//   started with, message included, as the chat's attachment
//   (workspace.ts), for as long as the chat is kept.
// - What a workflow wrote elsewhere: its App's own storage, Knowledge,
//   mail it sent.
// - The engine's records of core's own runs (Knowledge's extractions),
//   which aren't Apps' runs: the engine keeps those as long as the
//   account's plan lets it, 30 days at most.
//
// What can go wrong, and why it doesn't:
// - A live run swept. Only a run whose row has ended is swept, by the
//   time it ended: a run that waits (for a decision, a held
//   side effect, a feature switched back on), sleeps or is paused has not
//   ended, however long ago it started, and the engine's own retention
//   starts only when its instance ends. Ending is final: every write that
//   ends a row is conditional on it not having ended, and none sets one
//   back, so a row read as ended stays ended while it is swept.
// - Details an approval still needs. A decision or a held side effect is
//   waited for by a run that hasn't ended, which isn't swept; once the
//   run has ended nothing takes an answer, and connect runs no held
//   action for it (pending-actions.ts).
// - A run core ended whose instance the engine never did: a cancel whose
//   termination failed leaves the instance waiting or paused, and the
//   engine's retention never starts for it. It takes no step anyway
//   (dispatcher.ts refuses it on every execution). The sweep removes the
//   instance of every cancelled run itself, the one ended state the
//   engine's retention doesn't cover; one it can't remove is logged, left
//   due, and tried again by the next pass, and holds up none behind it.
// - A swept run run again. Replaying needs the engine's record of its
//   steps, which is gone, so an instance under its ID would do every step
//   again. Nothing creates one: a start finds the run by its trigger key
//   and leaves it be unless it is still starting. If something did, the
//   dispatcher refuses a run whose details were removed, before any step.
// - The sweep stopped half-way, or run twice at once. Connect's held
//   actions go first and the row is marked last, so a pass that stops in
//   between leaves the run due, and the next removes what is left and
//   marks it: removing what is gone removes nothing. Marking is
//   conditional on the row not being marked, so two passes mark it once.
// - The engine's clock, the sweep's and a reader's not agreeing. The
//   engine counts from when the instance ended, the sweep from when the
//   row did, a moment apart, and the sweep runs every 15 minutes. So
//   readers go by neither: a run's details are removed once its row is
//   marked or its retention is over by its row's own time
//   (`detailsRemoved`), one rule for every read of a run, and from then
//   on nothing the row or the engine may still have of it is shown.
// - The retention changed. A run's instance keeps the retention it was
//   created with. Shortened, `RUN_RETENTION_DAYS` applies to rows and
//   readers at once, so nothing of an earlier run is shown past the new
//   retention, though the engine holds its record until the old one is
//   over (30 days at most). Lengthened, an earlier run's record still
//   goes from the engine when the old one is over: it then reads as a run
//   that returned nothing until the new one is over too.
// - A deployment's config that doesn't parse. Nothing is removed, and it
//   is logged (`config.invalid`): never a guess at how long to keep. Runs
//   started meanwhile get no retention of their own, so the engine keeps
//   them as long as the account's plan lets it, 30 days at most.

const dayMs = 24 * 60 * 60 * 1000;

/**
 * Most runs swept at once: their IDs are bound to one statement, with a
 * few values more, of the 100 D1 binds.
 */
export const sweptPerBatch = 50;

/** Most batches one cron run sweeps: 500 runs every 15 minutes. */
export const batchesPerSweep = 10;

/** The statuses of a run that has ended. */
const ended = ["completed", "failed", "cancelled"] as const;

/**
 * Whether a run's details are removed, as every reader of a run asks: its
 * row is marked, or it has ended and its retention, as the deployment has
 * it now, is over. By the row and the setting alone, so a run reads the
 * same wherever it is read, whether the sweep has reached it yet or not,
 * and whatever the engine still has of it.
 */
export const detailsRemoved = (
  env: Pick<Env, "RUN_RETENTION_DAYS">,
  row: { endedAt: Date | null; detailsRemovedAt: Date | null },
  now = Date.now()
): boolean => {
  if (row.detailsRemovedAt !== null) {
    return true;
  }
  const days = runRetentionDays(env);
  return (
    days !== undefined &&
    row.endedAt !== null &&
    row.endedAt.getTime() + days * dayMs <= now
  );
};

/**
 * What readers say where a swept run's own words were (its failure's
 * message, its decisions' descriptions), with the retention as the
 * deployment has it now: the rows keep nothing in their place.
 */
export const removedText = (env: Pick<Env, "RUN_RETENTION_DAYS">): string => {
  const days = runRetentionDays(env);
  if (days === undefined) {
    return "The details of this run were removed when its retention ended.";
  }
  return `The details of this run were removed: they are kept for ${days} ${days === 1 ? "day" : "days"} after a run ends.`;
};

/**
 * A step's name without its key: `name:key` is how a keyed step is named
 * (the SDK's, `@grasp-os/sdk/workflow`), and the key is the run's data.
 */
const unkeyed = (step: SQL): SQL =>
  sql`CASE WHEN instr(${step}, ':') > 0 THEN substr(${step}, 1, instr(${step}, ':') - 1) ELSE ${step} END`;

/**
 * The statements that remove the receipts of the steps' attempts of
 * `runs` (run IDs, or a query of them; of either run table, as
 * quotas.ts keeps both): a receipt names its step by the engine's key,
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

/**
 * The statements that remove what quotas.ts and mail-stamps.ts keep of
 * App runs `runs` (IDs of runs marked, at most
 * {@link receiptRunsPerBatch}, as each is bound several times): their
 * attempts' receipts (`attemptsPruned`), and every token of their mail.
 * Run before its runs are marked, so a sweep that stops before marking
 * them leaves them due, and none of a marked run is left.
 */
const receiptsPruned = (
  db: DrizzleD1Database,
  runs: readonly string[],
  now: Date
) =>
  [
    ...attemptsPruned(db, runs, now),
    // The tokens of the runs' mail (mail-stamps.ts): mail to one this
    // late is mail to an address no one receives at.
    db.delete(runMailStamps).where(inArray(runMailStamps.runId, runs)),
    // Before their calls, which name their stamps.
    db.delete(runMailStampClaims).where(
      inArray(
        runMailStampClaims.stamp,
        db
          .select({ stamp: sql<string>`${runMailCalls.stamp}` })
          .from(runMailCalls)
          .where(inArray(runMailCalls.runId, runs))
      )
    ),
    db.delete(runMailStampRefusals).where(
      inArray(
        runMailStampRefusals.stamp,
        db
          .select({ stamp: sql<string>`${runMailCalls.stamp}` })
          .from(runMailCalls)
          .where(inArray(runMailCalls.runId, runs))
      )
    ),
    db.delete(runMailCalls).where(inArray(runMailCalls.runId, runs)),
    // The children their keys admitted (quotas.ts): what a delivery this
    // late starts is admitted afresh, if its lineage has room.
    db.delete(runLineageChildren).where(
      inArray(
        runLineageChildren.triggerKey,
        db
          .select({ key: sql<string>`${workflowRuns.triggerKey}` })
          .from(workflowRuns)
          .where(inArray(workflowRuns.id, runs))
      )
    ),
  ] as const;

/**
 * The statements that mark `runs`, those of them still `due`, as having
 * had their details removed at `now`, and empty what their rows and their
 * decisions kept of them: the failure's message, and the key of the step
 * it names; each decision's description, its answer's payload, and the
 * key in its step's name, replaced by the decision's own ID, since a run
 * has one decision per step name. Only the decisions of runs marked, by
 * this batch or before.
 */
const marked = (
  db: DrizzleD1Database,
  runs: string[],
  now: Date,
  due: SQL | undefined
) => {
  const step = sql`json_extract(${workflowRuns.failure}, '$.step')`;
  return [
    db
      .update(workflowRuns)
      .set({
        detailsRemovedAt: now,
        // A summary showing the message is out of date: its next revision.
        summaryRevision: sql`${workflowRuns.summaryRevision} + 1`,
        // Null stays null: only a failed run has a report.
        failure: sql`json_set(${workflowRuns.failure}, '$.error.message', '', '$.step', ${unkeyed(step)})`,
      })
      .where(and(inArray(workflowRuns.id, runs), due)),
    db
      .update(workflowDecisions)
      .set({
        description: "",
        payload: null,
        step: sql`CASE WHEN instr(${workflowDecisions.step}, ':') > 0 THEN substr(${workflowDecisions.step}, 1, instr(${workflowDecisions.step}, ':')) || ${workflowDecisions.id} ELSE ${workflowDecisions.step} END`,
      })
      .where(
        inArray(
          workflowDecisions.runId,
          db
            .select({ id: workflowRuns.id })
            .from(workflowRuns)
            .where(
              and(
                inArray(workflowRuns.id, runs),
                isNotNull(workflowRuns.detailsRemovedAt)
              )
            )
        )
      ),
  ] as const;
};

/** Most runs whose attempt receipts one batch removes (`receiptsPruned`). */
const receiptRunsPerBatch = 10;

/** Removes the attempt receipts of `runs`, each marked (`receiptsPruned`). */
const pruneReceipts = async (
  db: DrizzleD1Database,
  runs: readonly string[],
  now: Date
): Promise<void> => {
  for (let from = 0; from < runs.length; from += receiptRunsPerBatch) {
    // oxlint-disable-next-line no-await-in-loop -- one bounded batch after another
    await db.batch(
      receiptsPruned(db, runs.slice(from, from + receiptRunsPerBatch), now)
    );
  }
};

/** Most start receipts, and parameter revisions, one cron run empties. */
export const startDetailsPerSweep = 500;

/**
 * Removes the input and frozen parameter values of start receipts
 * admitted before `before`, with the receipts of the attempts of the
 * runs they admitted (`attemptsPruned`; the runs' lineages stay), and
 * the values of parameter revisions replaced before it or of workflows
 * deleted before it, at most {@link startDetailsPerSweep} of each, oldest
 * first, marked at `now`: set to null once, which is all the database
 * lets anything change of them. The rest is left to the next cron run.
 * One batch, so the attempts go only with their start's details, and
 * those of every start marked are gone.
 */
export const sweepWorkflowStartDetails = async (
  env: Env,
  before: Date,
  now: Date
): Promise<void> => {
  const db = drizzle(env.DB);
  const receipts = workflowStartReceipts;
  const params = workflowResourceParams;
  // The starts due, as each statement reads them before the last marks
  // them: by when they were admitted and their IDs, the same ones.
  const due = db
    .select({ id: receipts.id })
    .from(receipts)
    .where(
      and(
        isNull(receipts.detailsRemovedAt),
        lt(receipts.createdAt, before),
        // Not while its run reads them: a run that hasn't ended
        // loads its input and parameters from its receipt on every
        // activation (resource-runs.ts). Once it ended, its
        // retention counts from its end, as an App run's does.
        sql`NOT EXISTS (SELECT 1 FROM workflow_resource_runs AS run
          WHERE run.id = ${receipts.id}
            AND (run.ended_at IS NULL OR run.ended_at >= ${before.getTime()}))`
      )
    )
    .orderBy(asc(receipts.createdAt), asc(receipts.id))
    .limit(startDetailsPerSweep);
  // What connect still holds of the restricted runs among them goes
  // first, as an App run's does (`removedElsewhere`): a run that ended
  // while its side effect was held leaves the action, with its exact
  // input, until its person confirms it, which they may never do. Only a
  // restricted run's side effects are held: its own, under the workflow,
  // and those of every App its calls reached, keyed by its steps as its
  // own are, which connect drops by the run (`dropForEndedRuns`). A sweep
  // that fails here marks nothing, and the next does it again.
  const heldOf = await db
    .select({ runId: receipts.id, workflowId: receipts.workflowResourceId })
    .from(receipts)
    .where(
      and(
        inArray(receipts.id, due),
        eq(receipts.restricted, true),
        sql`EXISTS (SELECT 1 FROM workflow_resource_runs AS run
          WHERE run.id = ${receipts.id})`
      )
    );
  for (const runs of chunks(heldOf, sweptPerBatch)) {
    // oxlint-disable-next-line no-await-in-loop -- one bounded batch after another
    await env.CONNECT.dropForEndedRuns({ runs });
  }
  await db.batch([
    // A start's run has its receipt's ID (resource-runs.ts).
    ...attemptsPruned(db, due, now),
    db
      .update(receipts)
      .set({ input: null, params: null, detailsRemovedAt: now })
      .where(inArray(receipts.id, due)),
    db
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
      ),
  ]);
};

/** A run to sweep, as the sweep reads it. */
type DueRun = Pick<typeof workflowRuns.$inferSelect, "id" | "appId" | "status">;

/**
 * Removes what is kept of `runs` outside core's database, and answers the
 * ones nothing is kept of any more. The engine's instance of each
 * cancelled run, which its own retention may not reach (see above): one
 * it can't remove is logged and left out. Then the side effects connect
 * still holds for the rest.
 */
const removedElsewhere = async (
  env: Env,
  runs: readonly DueRun[]
): Promise<string[]> => {
  const kept = new Set<string>();
  await Promise.all(
    runs
      .filter(({ status }) => status === "cancelled")
      .map(async ({ id }) => {
        try {
          await runEngine(env).remove(id);
        } catch (error) {
          kept.add(id);
          log.error("workflow.run_details_not_removed", {
            runId: id,
            ...errorFields(error),
          });
        }
      })
  );
  const gone = runs.filter(({ id }) => !kept.has(id));
  if (gone.length > 0) {
    await env.CONNECT.dropForEndedRuns({
      runs: gone.map(({ id, appId }) => ({ appId, runId: id })),
    });
  }
  return gone.map(({ id }) => id);
};

/**
 * Removes the details core and connect keep of runs that ended more than
 * the retention before `now`, longest ended first, read by the index of
 * ended runs that still have theirs: at most `batchesPerSweep` batches of
 * `sweptPerBatch`, the rest left to the next cron run. For each batch,
 * what is kept elsewhere goes first (`removedElsewhere`), then the rows
 * are marked and emptied in one batch (`marked`). Each batch starts past
 * the last run of the one before, by when it ended and its ID, so a run
 * left out stays due for the next cron run and holds up none behind it.
 *
 * On-prem has no runs, and so reaches neither the engine nor connect.
 */
export const sweepRunDetails = async (env: Env, now: Date): Promise<void> => {
  const days = runRetentionDays(env);
  if (days === undefined) {
    return;
  }
  const db = drizzle(env.DB);
  const before = new Date(now.getTime() - days * dayMs);
  // The run has ended, longer ago than the retention, with its details.
  const due = and(
    isNotNull(workflowRuns.endedAt),
    isNull(workflowRuns.detailsRemovedAt),
    lt(workflowRuns.endedAt, before),
    // Checked on the row, not looked up (`+`): SQLite would otherwise read
    // the index by status and time, and sort what it found.
    inArray(sql`+${workflowRuns.status}`, ended)
  );
  let removed = 0;
  let last: { id: string; endedAt: number } | undefined;
  for (let batch = 0; batch < batchesPerSweep; batch += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one bounded batch after another
    const rows = await db
      .select({
        id: workflowRuns.id,
        appId: workflowRuns.appId,
        status: workflowRuns.status,
        endedAt: sql<number>`${workflowRuns.endedAt}`,
      })
      .from(workflowRuns)
      .where(
        and(
          due,
          last &&
            sql`(${workflowRuns.endedAt}, ${workflowRuns.id}) > (${last.endedAt}, ${last.id})`
        )
      )
      .orderBy(asc(workflowRuns.endedAt), asc(workflowRuns.id))
      .limit(sweptPerBatch);
    if (rows.length === 0) {
      break;
    }
    // oxlint-disable-next-line no-await-in-loop -- one bounded batch after another
    const gone = await removedElsewhere(env, rows);
    if (gone.length > 0) {
      // Its receipts first, the row marked last: a sweep that stops in
      // between leaves the run due, and the next does it all again.
      // oxlint-disable-next-line no-await-in-loop -- one bounded batch after another
      await pruneReceipts(db, gone, now);
      // oxlint-disable-next-line no-await-in-loop -- one bounded batch after another
      await db.batch(marked(db, gone, now, due));
    }
    removed += gone.length;
    if (rows.length < sweptPerBatch) {
      break;
    }
    last = rows.at(-1);
  }
  await sweepWorkflowStartDetails(env, before, now);
  if (removed > 0) {
    log.info("workflow.run_details_removed", { runs: removed, days });
  }
};
