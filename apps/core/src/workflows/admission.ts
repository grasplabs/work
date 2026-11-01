import { platformLimits } from "@grasp-os/shared/platform-limits";
import type { RunAiProviderWait, RunQueue } from "@grasp-os/shared/workflows";
import { and, gt, isNotNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { workflowModelWaits } from "../db/core/schema.ts";
import { aiWaitsOf } from "./ai-waits.ts";
import type { QuotaLimits } from "./quotas.ts";

// How many workflow attempts run at once: a fixed limit for the whole
// deployment (`workflowClientAttempts`), and a lower one for each App
// (`workflowAppAttempts`), so one busy App always leaves room for the
// others. Core runs once per client, so these are the client's. An
// attempt's lineage receipt (quotas.ts, `run_lineage_attempts`) is its
// slot, taken by the one conditional statement that counts the slots
// held as it runs: two admissions never both take the last one.
//
// A slot counts while its receipt is unsettled, and never past an
// attempt's wall time after its admission, so an attempt that died gives
// its slot back within a minute; one the engine fenced (its run paused,
// ended, cancelled or taken over) gives it back as the run's object says
// so (quotas.ts, `sharesReleased`). An attempt with no slot free is
// refused (`workflow.queued`) and its step asks again after its backoff
// (host.ts, `askAgainMs`): nothing is queued, and nothing is ordered.

/** The seconds a refusal for a full slot limit tells the step to wait. */
export const busyRetryAfterSeconds = 5;

/** The longest a step that kept waiting waits between asks, in seconds. */
const maxBackedOffSeconds = 60;

/**
 * The longest a step waits before it asks again once it has waited
 * `waited` rounds: five seconds, doubling each round to a minute at most,
 * so a step that waits long adds a round to its run's journal a minute at
 * most. It starts again from five seconds at the step's next wait.
 */
const askAgainSeconds = (waited: number): number =>
  Math.min(
    busyRetryAfterSeconds * 2 ** Math.max(0, waited),
    maxBackedOffSeconds
  );

/** What decides when a waiting step asks again (`askAgainMs`). */
export interface AskingAgain {
  /** The rounds it waited for load in a row before this one. */
  waited: number;
  /**
   * How long it has waited for load since it was last admitted: the sum
   * of its rounds' waits, never the time between, so a pause or a wait
   * for its person counts for none of it (host.ts).
   */
  waitedMs: number;
  /** How long a step may wait for load in all, in ms. */
  maxWaitMs: number;
}

/**
 * How long a waiting step waits before it asks again, in ms: its backoff
 * (`askAgainSeconds`), or what is left of the time a step may wait,
 * whichever is sooner. One rule for the host's sleep and the timeout.
 */
export const askAgainMs = ({
  waited,
  waitedMs,
  maxWaitMs,
}: AskingAgain): number =>
  Math.max(0, Math.min(askAgainSeconds(waited) * 1000, maxWaitMs - waitedMs));

/**
 * How long a model call's wait row lasts after its call last asked
 * (model-waits.ts): longer than a waiting step waits between asks (a
 * minute at most, `askAgainSeconds`), with room for an engine slow to
 * wake it.
 */
export const queueLiveMs = 90_000;

/** A whole number of core's own, as a literal. */
const literal = (value: number): SQL => sql.raw(String(Math.trunc(value)));

/**
 * The slots held at `now` that `where` takes, counted: unsettled
 * receipts, each until its hold ends, an attempt's wall time after its
 * admission at most.
 */
const running = (now: number, where: SQL): SQL =>
  sql`(SELECT count(*) FROM run_lineage_attempts AS h WHERE h.settled_at IS NULL AND h.admitted_at > ${literal(now - platformLimits.workflowAttemptWallMs)} AND h.admitted_at + h.reserved_ms > ${literal(now)} AND ${where})`;

/**
 * That an attempt of App `app` has a slot at `now`, under both limits, as
 * SQL: a condition of the statement that takes its receipt (quotas.ts).
 */
export const slotFree = (app: string, now: number, limits: QuotaLimits): SQL =>
  sql`(${running(now, sql`1`)} < ${literal(limits.workflowClientAttempts)} AND ${running(now, sql`h.resource = ${app}`)} < ${literal(Math.min(limits.workflowAppAttempts, limits.workflowClientAttempts))})`;

/**
 * What a run that goes on by itself waits for, as its status shows it: a
 * share of the model requests in flight (`queued`), or its AI provider
 * (`aiProvider`, ai-waits.ts).
 */
export type RunWait = { queued: RunQueue } | { aiProvider: RunAiProviderWait };

/**
 * Of the runs `runs`, each one a step of which waits at `now`: for a
 * share of the model requests in flight (model-waits.ts), and when it
 * asks again; or held for a working AI provider key, since when
 * (ai-waits.ts). A wait that stopped asking doesn't count.
 */
export const queuedRuns = async (
  db: DrizzleD1Database,
  runs: readonly string[],
  now: number
): Promise<Map<string, RunWait>> => {
  if (runs.length === 0) {
    return new Map();
  }
  // One bound list: D1 binds at most 100 parameters.
  const listed = JSON.stringify(runs);
  const modelWaits = await db
    .select({
      runId: workflowModelWaits.runId,
      waitingFor: workflowModelWaits.waitingFor,
      retryAt: workflowModelWaits.retryAt,
    })
    .from(workflowModelWaits)
    .where(
      and(
        sql`${workflowModelWaits.runId} IN (SELECT value FROM json_each(${listed}))`,
        gt(workflowModelWaits.seenAt, new Date(now - queueLiveMs)),
        isNotNull(workflowModelWaits.waitingFor)
      )
    );
  // A step held for its AI provider (ai-waits.ts): shown first, as it
  // waits for someone.
  const aiWaits = await aiWaitsOf(db, runs);
  const rows = modelWaits.toSorted(
    (one, other) => one.retryAt.getTime() - other.retryAt.getTime()
  );
  const byRun = new Map<string, RunWait>(
    [...aiWaits].map(([runId, aiProvider]) => [runId, { aiProvider }])
  );
  for (const { runId, waitingFor, retryAt } of rows) {
    if (waitingFor !== null && !byRun.has(runId)) {
      byRun.set(runId, {
        queued: { waitingFor, retryAt: retryAt.toISOString() },
      });
    }
  }
  return byRun;
};
