import { sha256Hex } from "@grasp-os/shared/encoding";
import { errorFields, log } from "@grasp-os/shared/log";
import { runOfStepKey } from "@grasp-os/shared/workflows";
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { workflowRunWakes, workflowRuns } from "../db/core/schema.ts";
import { runEngine } from "./engine.ts";

// The wakes core owes runs that wait on a person: an answer to one of
// their decisions (src/decisions/), or a decision on a side effect one of
// their steps had held (src/pending-actions.ts, src/unknown-outcomes.ts).
// A wake is an engine event that carries nothing: it only tells the run
// to look again, at the decision's row or at connect, so whatever sends
// it, nothing it carries is taken. Threat model:
//
// - A lost wake must never be a lost decision. A wake is owed from the
//   moment the decision is recorded: its row is written in the same D1
//   batch as a decision's answer, so no answer stands without it. A held
//   side effect's decision is connect's, in another database: its wake is
//   written before connect is asked, and replaced by one that is sent
//   once connect answered. A crash in between leaves the first, which
//   the repair sends again, each time as a new delivery, for a day: it
//   can't know when connect decided. A wake whose decision
//   never happened (connect refused it) costs the run one look, nothing
//   more.
// - Each row is sent at once, and again by the per-minute repair
//   (`repairWakes`) until the engine takes it: a crash, a deploy or an
//   engine that can't be reached delays a wake, never loses it.
// - A wake taken twice is one event: the row's ID is the engine's
//   delivery key, and the engine takes a key once (`duplicate`).
// - A run that has ended, or that the engine has no record of, takes no
//   wake, which settles it: a wake can't revive a cancelled run, and the
//   engine refuses its effects after its end anyway.
// - A forged or stray event of a wake's type wakes a run for nothing: the
//   run finds nothing decided, and waits again for the time it had left
//   (`RunHost.waitForDecision`, `#waitWhileHeld`).
// - The timed checks of a held wait stay, longer apart, as the backstop
//   for holds connect ends by itself (a disconnect, a person removed, a
//   binding revoked, an unknown outcome connect may now recover), and for
//   holds of an App function's call, whose key names no step.

/** A wake a run is owed. */
export interface Wake {
  /** The delivery's key: the engine takes it once. */
  id: string;
  runId: string;
  /** The event type the run's wait waits for. */
  type: string;
}

/** How long a wake is left to the request that owed it. */
const repairAfterMs = 30_000;

/** The longest the repair waits before sending a wake again. */
const maxRepairMs = 60 * 60 * 1000;

/**
 * How long a wake owed before its decision is known (`resendUntil`) is
 * sent again: past it, the run's timed checks are left to find it.
 */
const resendMs = 24 * 60 * 60 * 1000;

/** Most wakes one repair sends. */
const wakesPerRepair = 50;

const heldWakePrefix = "grasp-held-";

/**
 * The event type that wakes a run waiting on a held side effect of its
 * step `step`: one per step, so two steps held at once each get their own.
 */
export const heldWakeType = async (step: string): Promise<string> => {
  const digest = await sha256Hex(step);
  return `${heldWakePrefix}${digest.slice(0, 16)}`;
};

/**
 * The step and run a held side effect's idempotency key names, if it is a
 * step's own key (`stepIdempotencyKey`): an App function's calls carry
 * keys of their own, which name none.
 */
const stepOfKey = (
  idempotencyKey: string
): { runId: string; step: string } | undefined => {
  const runId = runOfStepKey(idempotencyKey);
  const colon = idempotencyKey.indexOf(":");
  if (runId === undefined || colon === -1) {
    return undefined;
  }
  return { runId, step: idempotencyKey.slice(colon + 1) };
};

/**
 * The statement that owes `wake`, if `when` holds as it runs; for a batch
 * with what the wake is for. Owed once: the same wake owed again is the
 * row that stands.
 */
export const oweWake = (
  db: DrizzleD1Database,
  wake: Wake,
  when: SQL,
  { now = Date.now(), resend = false }: { now?: number; resend?: boolean } = {}
) =>
  db
    .insert(workflowRunWakes)
    .select(
      sql`SELECT ${wake.id}, ${wake.runId}, ${wake.type}, ${now}, ${now + repairAfterMs}, 0, ${resend ? now + resendMs : null} WHERE ${when}`
    )
    .onConflictDoNothing();

/**
 * Sends the wake `id`, if it is still owed, and settles it once the
 * engine took it (or its run takes none). One to send again until its
 * decision is known (`resendUntil`) isn't settled, and goes as a new
 * delivery each time, so an earlier one the run took doesn't swallow it.
 * Never throws: a failure, of the
 * engine or of the database, is logged, and the row stays for the repair,
 * so the request that owed it answers as what it recorded.
 */
export const sendWake = async (env: Env, id: string): Promise<void> => {
  try {
    const db = drizzle(env.DB);
    const wake = await db
      .select()
      .from(workflowRunWakes)
      .where(eq(workflowRunWakes.id, id))
      .get();
    if (wake === undefined) {
      return;
    }
    if (wake.resendUntil !== null) {
      await runEngine(env).sendEvent(
        wake.runId,
        wake.type,
        `${wake.id}:${wake.retries}`
      );
      return;
    }
    await runEngine(env).sendEvent(wake.runId, wake.type, wake.id);
    await db.delete(workflowRunWakes).where(eq(workflowRunWakes.id, wake.id));
  } catch (error) {
    log.warn("workflow.wake_failed", { wake: id, ...errorFields(error) });
  }
};

/**
 * Owes, and sends after `decide`, the wake of the run whose step's side
 * effect `idempotencyKey` names, when a person decides on it: confirms,
 * declines or resolves it (connect keeps the decision). Owed only to a run
 * of App `appId` that hasn't ended; a key of no step owes nothing, and its
 * run finds the decision at its next check. Answers what `decide` does,
 * which is sent even when `decide` throws: it may have decided.
 */
export const wakingHeld = async <T>(
  env: Env,
  held: { appId: string | null; idempotencyKey: string },
  decide: () => Promise<T>
): Promise<T> => {
  const named = stepOfKey(held.idempotencyKey);
  if (held.appId === null || named === undefined) {
    return await decide();
  }
  const db = drizzle(env.DB);
  const type = await heldWakeType(named.step);
  const runGoesOn = sql`EXISTS (SELECT 1 FROM ${workflowRuns} WHERE ${and(
    eq(workflowRuns.id, named.runId),
    eq(workflowRuns.appId, held.appId),
    isNull(workflowRuns.endedAt)
  )})`;
  // Each decision its own deliveries: one that was refused, and then made
  // again, wakes again. Owed first for a crash while connect decides
  // (`pending`): the repair sends it again, each time anew, until a day
  // has passed, as it can't know whether connect decided. Once `decide`
  // is done, a wake that settles once taken takes its place (`decided`),
  // in one batch, and that one is sent.
  const id = crypto.randomUUID();
  const pending: Wake = { id: `held:${id}`, runId: named.runId, type };
  const decided: Wake = { ...pending, id: `held:${id}:decided` };
  await db.batch([oweWake(db, pending, runGoesOn, { resend: true })]);
  try {
    return await decide();
  } finally {
    try {
      await db.batch([
        db.delete(workflowRunWakes).where(eq(workflowRunWakes.id, pending.id)),
        oweWake(db, decided, runGoesOn),
      ]);
    } catch (error) {
      // The pending wake stands, for the repair.
      log.warn("workflow.wake_failed", {
        wake: decided.id,
        ...errorFields(error),
      });
    }
    await sendWake(env, decided.id);
  }
};

/**
 * Sends every wake that is due again, oldest due first: one the request
 * that owed it didn't get through (a crash, an engine that couldn't be
 * reached). Each is put off before it is sent, further each time, so one
 * the engine keeps refusing falls behind newer ones. From the per-minute
 * cron, for the minute `at` it runs for.
 */
export const repairWakes = async (env: Env, at = new Date()): Promise<void> => {
  const db = drizzle(env.DB);
  const now = at.getTime();
  // Wakes sent again for as long as they may be (`resendUntil`) are done.
  await db
    .delete(workflowRunWakes)
    .where(lte(workflowRunWakes.resendUntil, new Date(now)));
  const due = await db
    .select()
    .from(workflowRunWakes)
    .where(lte(workflowRunWakes.retryAt, new Date(now)))
    .orderBy(asc(workflowRunWakes.retryAt), asc(workflowRunWakes.id))
    .limit(wakesPerRepair);
  await Promise.all(
    due.map(async (wake) => {
      try {
        await db
          .update(workflowRunWakes)
          .set({
            retries: wake.retries + 1,
            retryAt: new Date(
              now + Math.min(repairAfterMs * 2 ** wake.retries, maxRepairMs)
            ),
          })
          .where(eq(workflowRunWakes.id, wake.id));
        await sendWake(env, wake.id);
      } catch (error) {
        log.error("workflow.wake_repair_failed", {
          runId: wake.runId,
          wake: wake.id,
          ...errorFields(error),
        });
      }
    })
  );
};
