import { providerTroubles } from "@grasp-os/shared/ai-providers";
import type { ProviderTrouble } from "@grasp-os/shared/ai-providers";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { errorFields, log } from "@grasp-os/shared/log";
import type { RunAiProviderWait } from "@grasp-os/shared/workflows";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import {
  workflowAiWaits,
  workflowResourceRuns,
  workflowRuns,
} from "../db/core/schema.ts";
import { oweWake, sendWake } from "./wakes.ts";
import type { Wake } from "./wakes.ts";

// Workflow runs, App runs and independent ones, held because a model call
// of a step failed on the
// organization's own key for what its provider showed, by the HTTP class
// seen (`ProviderTrouble`): it refused the key, it isn't answering (an
// outage, most often), or it is limiting requests. A step bound to its
// model never falls back to another, so rather than fail, the run waits
// (host.ts, `keyRound`), and its step runs again once calls work.
//
// - What the run's summary shows: a row per held step, from its first
//   failed call until it runs again: the provider, what it showed last,
//   and since when (summary.ts). Never which key or what the provider said.
// - What ends the wait: replacing a key wakes every held run at once
//   (`wakeAiWaits`, from ai-providers.ts), through the wakes core already
//   owes runs (wakes.ts), sent again by the per-minute repair until the
//   engine takes them. A provider that answers again, or lifts its limit,
//   is found by the run's timed tries, a minute first, doubling up to 15
//   minutes. A wake only makes the step try again: the provider's answer
//   decides.
// - Billing holds per request: one the provider didn't answer is charged
//   in full as unknown (model-ledger.ts), and never sent again within its
//   attempt; the run's next try, after a wait, is a request of its own. An
//   independent run's call is tried once, so it waits only when the
//   gateway saw that its call provably billed nothing (models.ts,
//   `provablyUnbilled`); any other failure fails it (resource-host.ts).
// - A forged or stray wake of its type costs the run one try.
// - A row of a run that ended (cancelled, or failed past its hold) is
//   never shown, and is pruned with the next wake.

/** What a held step's provider showed, as its row keeps it. */
const troubleSchema = z.enum(providerTroubles);

/** The event type that wakes a run held for its AI provider key. */
export const aiWakeType = "grasp-ai-provider";

/** The most held runs one key replacement wakes at once; the repair sends the rest. */
const wakesAtOnce = 50;

/** The most held runs one key replacement owes a wake to. */
const wakesOwed = 1000;

/** Wakes owed in one batch of statements. */
const owedPerBatch = 100;

/** Which runs a row names: an App's (`workflow_runs`) or an independent one's. */
export interface AiWaitRun {
  kind: "app" | "resource";
  runId: string;
}

/**
 * The statement that moves run `runId`'s summary on; an independent run's
 * keeps none.
 */
const movedOn = (db: ReturnType<typeof drizzle>, runId: string) =>
  db
    .update(workflowRuns)
    .set({ summaryRevision: sql`${workflowRuns.summaryRevision} + 1` })
    .where(eq(workflowRuns.id, runId));

/** Whether `run` hasn't ended, as SQL: a wake is owed only then. */
const goesOn = ({ kind, runId }: AiWaitRun) =>
  kind === "resource"
    ? sql`EXISTS (SELECT 1 FROM ${workflowResourceRuns} WHERE ${and(
        eq(workflowResourceRuns.id, runId),
        isNull(workflowResourceRuns.endedAt)
      )})`
    : sql`EXISTS (SELECT 1 FROM ${workflowRuns} WHERE ${and(
        eq(workflowRuns.id, runId),
        isNull(workflowRuns.endedAt)
      )})`;

/** What a held step waits for: its provider, and what it showed last. */
export interface AiWait {
  provider: string;
  trouble: ProviderTrouble;
}

/**
 * Records that step `step` of run `runId` waits for its provider, as
 * `wait` says, since `since` (ms since the epoch): the first time, and
 * again when what the provider shows changes, keeping since when.
 */
export const aiWaitStarted = async (
  env: Env,
  { kind, runId }: AiWaitRun,
  step: string,
  { provider, trouble }: AiWait,
  since: number
): Promise<void> => {
  const db = drizzle(env.DB);
  const stepHash = await sha256Hex(step);
  await db.batch([
    db
      .insert(workflowAiWaits)
      .values({
        runId,
        runKind: kind,
        stepHash,
        provider,
        trouble,
        since: new Date(since),
      })
      .onConflictDoUpdate({
        target: [workflowAiWaits.runId, workflowAiWaits.stepHash],
        set: { provider, trouble },
      }),
    movedOn(db, runId),
  ]);
};

/** Records that step `step` of run `runId` waits no more: it ran again. */
export const aiWaitEnded = async (
  env: Env,
  runId: string,
  step: string
): Promise<void> => {
  const db = drizzle(env.DB);
  const stepHash = await sha256Hex(step);
  await db.batch([
    db
      .delete(workflowAiWaits)
      .where(
        and(
          eq(workflowAiWaits.runId, runId),
          eq(workflowAiWaits.stepHash, stepHash)
        )
      ),
    movedOn(db, runId),
  ]);
};

/**
 * Of the runs `runs`, each one a step of which waits for its AI provider:
 * the provider, what it showed and since when, its earliest held step's.
 */
export const aiWaitsOf = async (
  db: DrizzleD1Database,
  runs: readonly string[]
): Promise<Map<string, RunAiProviderWait>> => {
  if (runs.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      runId: workflowAiWaits.runId,
      since: workflowAiWaits.since,
      provider: workflowAiWaits.provider,
      trouble: workflowAiWaits.trouble,
    })
    .from(workflowAiWaits)
    // One bound list: D1 binds at most 100 parameters.
    .where(
      sql`${workflowAiWaits.runId} IN (SELECT value FROM json_each(${JSON.stringify(runs)}))`
    )
    .orderBy(desc(workflowAiWaits.since));
  return new Map(
    rows.flatMap(({ runId, since, provider, trouble }) => {
      const shown = troubleSchema.safeParse(trouble);
      return shown.success
        ? [
            [
              runId,
              { since: since.toISOString(), provider, trouble: shown.data },
            ] as const,
          ]
        : [];
    })
  );
};

/**
 * Wakes every run held for its AI provider key that hasn't ended, as the
 * organization replaced a key: each is owed a wake (wakes.ts), the first
 * {@link wakesAtOnce} sent now, the rest by the per-minute repair. Never
 * throws: a run not woken tries again at its next timed try.
 */
export const wakeAiWaits = async (env: Env): Promise<void> => {
  try {
    const db = drizzle(env.DB);
    const ended = (kind: AiWaitRun["kind"]) =>
      and(
        eq(workflowAiWaits.runKind, kind),
        inArray(
          workflowAiWaits.runId,
          kind === "resource"
            ? db
                .select({ id: workflowResourceRuns.id })
                .from(workflowResourceRuns)
                .where(isNotNull(workflowResourceRuns.endedAt))
            : db
                .select({ id: workflowRuns.id })
                .from(workflowRuns)
                .where(isNotNull(workflowRuns.endedAt))
        )
      );
    await db.delete(workflowAiWaits).where(or(ended("app"), ended("resource")));
    const held = await db
      .selectDistinct({
        runId: workflowAiWaits.runId,
        kind: workflowAiWaits.runKind,
      })
      .from(workflowAiWaits)
      .limit(wakesOwed);
    const wakes: (Wake & AiWaitRun)[] = held.map(({ runId, kind }) => ({
      id: `ai:${crypto.randomUUID()}`,
      runId,
      kind: kind === "resource" ? "resource" : "app",
      type: aiWakeType,
    }));
    const owed = wakes.map((wake) => oweWake(db, wake, goesOn(wake)));
    for (let at = 0; at < owed.length; at += owedPerBatch) {
      const [first, ...rest] = owed.slice(at, at + owedPerBatch);
      if (first !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- one batch at a time
        await db.batch([first, ...rest]);
      }
    }
    await Promise.all(
      wakes.slice(0, wakesAtOnce).map(async ({ id }) => {
        await sendWake(env, id);
      })
    );
  } catch (error) {
    log.warn("workflow.ai_wake_failed", errorFields(error));
  }
};
