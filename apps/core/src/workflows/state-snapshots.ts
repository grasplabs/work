import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import {
  workflowCandidateRuns,
  workflowStartReceipts,
  workflowStateSnapshots,
} from "../db/core/schema.ts";

// The snapshot of what a workflow kept between its runs, frozen as a run
// starts (workflow-state.ts, `workflowStateOf`), which every activation of
// the run reads (sealed-run.ts). Each is stored once, by the SHA-256 of
// its canonical JSON (`workflow_state_snapshots`), and a start's receipt or
// a test run's row names it by that hash: runs of a workflow whose state
// didn't change between them share one row, so a frequent workflow's
// starts don't copy its whole state each. A snapshot is written in the
// same batch as the row that names it, so one named is always there, and
// retention removes those nothing names any more (`orphanedSnapshotsRemoved`)
// in a statement of its own, which a batch naming one again either runs
// before (it stays) or after (it is written again).

/** A snapshot, as its run freezes it: its hash, and its canonical JSON. */
export interface StateSnapshot {
  readonly hash: string;
  readonly body: string;
}

/** The most snapshots one sweep removes. */
const snapshotsPerSweep = 500;

/**
 * `state`, what a workflow keeps now (workflow-state.ts,
 * `workflowStateOf`), as a snapshot to freeze.
 */
export const snapshotFrom = async (
  state: Readonly<Record<string, Json>>
): Promise<StateSnapshot> => {
  const body = canonicalJson(state);
  return { hash: await sha256Hex(body), body };
};

/**
 * The statement that stores `snapshot`, for the batch that writes the row
 * naming it: once, whoever stored the same before.
 */
export const snapshotStored = (
  db: DrizzleD1Database,
  snapshot: StateSnapshot,
  at: Date
) =>
  db
    .insert(workflowStateSnapshots)
    .values({ hash: snapshot.hash, body: snapshot.body, createdAt: at })
    .onConflictDoNothing();

const snapshotSchema = z.record(z.string(), z.json());

/** The snapshot `hash` names, if it is stored. */
export const snapshotOf = async (
  env: Env,
  hash: string
): Promise<Record<string, Json> | undefined> => {
  const row = await drizzle(env.DB)
    .select({ body: workflowStateSnapshots.body })
    .from(workflowStateSnapshots)
    .where(eq(workflowStateSnapshots.hash, hash))
    .get();
  return row === undefined
    ? undefined
    : snapshotSchema.parse(JSON.parse(row.body));
};

/**
 * Removes up to `snapshotsPerSweep` snapshots that no start's receipt and
 * no test run names any more (their details removed, or their rows
 * swept), checked as the statement runs.
 */
export const orphanedSnapshotsRemoved = async (
  db: DrizzleD1Database
): Promise<void> => {
  const snapshots = workflowStateSnapshots;
  const unnamed = sql`NOT EXISTS (SELECT 1 FROM ${workflowStartReceipts}
      WHERE ${workflowStartReceipts.stateHash} = ${snapshots.hash})
    AND NOT EXISTS (SELECT 1 FROM ${workflowCandidateRuns}
      WHERE ${workflowCandidateRuns.stateHash} = ${snapshots.hash})`;
  await db.delete(snapshots).where(
    sql`${snapshots.hash} IN (SELECT ${snapshots.hash} FROM ${snapshots}
        WHERE ${unnamed} LIMIT ${snapshotsPerSweep})
      AND ${unnamed}`
  );
};
