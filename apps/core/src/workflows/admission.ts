import { platformLimits } from "@grasp-os/shared/platform-limits";
import type { RunAiProviderWait } from "@grasp-os/shared/workflows";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

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

/** What a run that goes on by itself waits for, as its status shows it: its AI provider (ai-waits.ts). */
export interface RunWait {
  aiProvider: RunAiProviderWait;
}

/**
 * Of the runs `runs`, each one a step of which is held for a working AI
 * provider key (ai-waits.ts), and since when.
 */
export const queuedRuns = async (
  db: DrizzleD1Database,
  runs: readonly string[]
): Promise<Map<string, RunWait>> => {
  if (runs.length === 0) {
    return new Map();
  }
  const aiWaits = await aiWaitsOf(db, runs);
  return new Map(
    [...aiWaits].map(([runId, aiProvider]) => [runId, { aiProvider }])
  );
};
