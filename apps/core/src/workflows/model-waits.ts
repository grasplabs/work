import { sha256Hex } from "@grasp-os/shared/encoding";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { workflowModelWaits, workflowRuns } from "../db/core/schema.ts";
import type { ModelShare } from "../model-admission.ts";
import { queueLiveMs } from "./admission.ts";

// A workflow run whose step's model call waits in the model ledger's queue
// for a share of the model requests in flight (model-admission.ts) shows
// as `queued` in its summary and its run lists, as one waiting for a share
// of the workflow attempts running at once does (admission.ts): with the
// share and when its call asks again at the latest. Throttling, not a
// fault: the run goes on by itself.
//
// The gateway tells the run's host each time the call asks again, and once
// it stops (models.ts, `onQueued`); the host writes it here, each write
// moving the run's summary on. A call whose isolate died stops asking: its
// row lapses as a queued step's place does (`queueLiveMs`), shown no more,
// and is pruned with the next write.
//
// Only what the run's own summary shows is kept: the share and the time,
// never who else waits, nor how many.

/** The statements that prune the waits that stopped asking by `now`, moving their runs' summaries on. */
const pruned = (db: DrizzleD1Database, now: number) => {
  const stale = lte(workflowModelWaits.seenAt, new Date(now - queueLiveMs));
  return [
    db
      .update(workflowRuns)
      .set({ summaryRevision: sql`${workflowRuns.summaryRevision} + 1` })
      .where(
        inArray(
          workflowRuns.id,
          db
            .select({ id: workflowModelWaits.runId })
            .from(workflowModelWaits)
            .where(stale)
        )
      ),
    db.delete(workflowModelWaits).where(stale),
  ] as const;
};

/**
 * Records where step `step` of run `runId` stands as its model call
 * `owner` (an ID each call of the step takes) waits for a share: `queued`,
 * the share and when it asks again (ms since the epoch), or `null` once it
 * stopped waiting. The run's summary takes its next revision with each
 * change.
 *
 * A call's notes can land late (the gateway waits for a note a moment at
 * most), after a newer call of the step wrote its own: a call clears only
 * its own row, and overwrites another call's only with a note asking no
 * sooner than that call's, so a late note of an older call never changes
 * a newer call's standing.
 */
export const modelWaitRecorded = async (
  db: DrizzleD1Database,
  runId: string,
  step: string,
  owner: string,
  queued: { waitingFor: ModelShare; retryAt: number } | null
): Promise<void> => {
  const now = Date.now();
  const stepHash = await sha256Hex(step);
  const mine = and(
    eq(workflowModelWaits.runId, runId),
    eq(workflowModelWaits.stepHash, stepHash),
    eq(workflowModelWaits.owner, owner)
  );
  const moved = db
    .update(workflowRuns)
    .set({ summaryRevision: sql`${workflowRuns.summaryRevision} + 1` })
    .where(eq(workflowRuns.id, runId));
  if (queued === null) {
    await db.batch([
      ...pruned(db, now),
      db
        .update(workflowRuns)
        .set({ summaryRevision: sql`${workflowRuns.summaryRevision} + 1` })
        .where(
          and(
            eq(workflowRuns.id, runId),
            sql`EXISTS (SELECT 1 FROM ${workflowModelWaits} WHERE ${mine})`
          )
        ),
      db.delete(workflowModelWaits).where(mine),
    ]);
    return;
  }
  const retryAt = new Date(queued.retryAt);
  await db.batch([
    ...pruned(db, now),
    db
      .insert(workflowModelWaits)
      .values({
        runId,
        stepHash,
        owner,
        waitingFor: queued.waitingFor,
        retryAt,
        seenAt: new Date(now),
      })
      .onConflictDoUpdate({
        target: [workflowModelWaits.runId, workflowModelWaits.stepHash],
        set: {
          owner,
          waitingFor: queued.waitingFor,
          retryAt,
          seenAt: new Date(now),
        },
        setWhere: sql`${workflowModelWaits.owner} = ${owner} OR ${workflowModelWaits.retryAt} <= ${retryAt.getTime()}`,
      }),
    moved,
  ]);
};
