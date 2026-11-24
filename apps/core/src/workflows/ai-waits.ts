import { providerTroubles } from "@grasp-os/shared/ai-providers";
import type { ProviderTrouble } from "@grasp-os/shared/ai-providers";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { errorFields, log } from "@grasp-os/shared/log";
import type { RunAiProviderWait } from "@grasp-os/shared/workflows";
import {
  and,
  asc,
  desc,
  gt,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { workflowAiWaits, workflowResourceRuns } from "../db/core/schema.ts";
import { oweWake, sendWake } from "./wakes.ts";
import type { Wake } from "./wakes.ts";

// Workflow runs held because a model call of a step failed on the
// organization's own key for what its provider showed, by the HTTP class
// seen (`ProviderTrouble`): it refused the key, it isn't answering (an
// outage, most often), or it is limiting requests. A step bound to its
// model never falls back to another, so rather than fail, the run waits
// (host.ts, `keyRound`), and its step runs again once calls work.
//
// - What the run shows: a row per held step, from its first failed call
//   until it runs again: the provider, what it showed last, and since
//   when (`aiWaitsOf`). Never which key or what the provider said.
// - What ends the wait: replacing a key wakes every held run at once
//   (`wakeAiWaits`, from ai-providers.ts), through the wakes core already
//   owes runs (wakes.ts), sent again by the per-minute repair until the
//   engine takes them. A provider that answers again, or lifts its limit,
//   is found by the run's timed tries, a minute first, doubling up to 15
//   minutes. A wake only makes the step try again: the provider's answer
//   decides.
// - Billing holds per request: one the provider didn't answer may have
//   been billed, and is never sent again within its attempt; the run's next try, after a wait, is a request of its own. An
//   independent run's call is tried once, so it waits only when the
//   gateway saw that its call provably billed nothing (models.ts,
//   `provablyUnbilled`); any other failure fails it (sealed-run.ts, `#sent`).
// - A forged or stray wake of its type costs the run one try.
// - A row of a run that ended (cancelled, or failed past its hold) is
//   never shown, and is pruned with the next wake.

/** What a held step's provider showed, as its row keeps it. */
const troubleSchema = z.enum(providerTroubles);

/** The event type that wakes a run held for its AI provider key. */
export const aiWakeType = "grasp-ai-provider";

/** The most held runs one key replacement wakes at once; the repair sends the rest. */
const wakesAtOnce = 50;

/** Held runs read at a time as a key replacement owes each a wake: all of them, a page at a time. */
const wakePage = 1000;

/** Wakes owed in one batch of statements. */
const owedPerBatch = 100;

/** The run a held step is of. */
export interface AiWaitRun {
  runId: string;
}

/** Whether `run` hasn't ended, as SQL: a wake is owed only then. */
const goesOn = ({ runId }: AiWaitRun) =>
  sql`EXISTS (SELECT 1 FROM ${workflowResourceRuns} WHERE ${and(
    eq(workflowResourceRuns.id, runId),
    isNull(workflowResourceRuns.endedAt)
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
  { runId }: AiWaitRun,
  step: string,
  { provider, trouble }: AiWait,
  since: number
): Promise<void> => {
  const stepHash = await sha256Hex(step);
  await drizzle(env.DB)
    .insert(workflowAiWaits)
    .values({
      runId,
      runKind: "resource",
      stepHash,
      provider,
      trouble,
      since: new Date(since),
    })
    .onConflictDoUpdate({
      target: [workflowAiWaits.runId, workflowAiWaits.stepHash],
      set: { provider, trouble },
    });
};

/** Records that step `step` of run `runId` waits no more: it ran again. */
export const aiWaitEnded = async (
  env: Env,
  runId: string,
  step: string
): Promise<void> => {
  const stepHash = await sha256Hex(step);
  await drizzle(env.DB)
    .delete(workflowAiWaits)
    .where(
      and(
        eq(workflowAiWaits.runId, runId),
        eq(workflowAiWaits.stepHash, stepHash)
      )
    );
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

/** Owes each of `wakes` to its run, a batch of statements at a time. */
const owe = async (
  db: DrizzleD1Database,
  wakes: readonly (Wake & AiWaitRun)[]
): Promise<void> => {
  const owed = wakes.map((wake) => oweWake(db, wake, goesOn(wake)));
  for (let at = 0; at < owed.length; at += owedPerBatch) {
    const [first, ...rest] = owed.slice(at, at + owedPerBatch);
    if (first !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- one batch at a time
      await db.batch([first, ...rest]);
    }
  }
};

/**
 * Wakes every run held for its AI provider key that hasn't ended, as the
 * organization replaced a key: each is owed a wake (wakes.ts), however
 * many, read `pageSize` at a time; the first {@link wakesAtOnce} sent now,
 * the rest by the per-minute repair. Never throws: a run not woken tries
 * again at its next timed try.
 */
export const wakeAiWaits = async (
  env: Env,
  pageSize = wakePage
): Promise<void> => {
  try {
    const db = drizzle(env.DB);
    await db
      .delete(workflowAiWaits)
      .where(
        inArray(
          workflowAiWaits.runId,
          db
            .select({ id: workflowResourceRuns.id })
            .from(workflowResourceRuns)
            .where(isNotNull(workflowResourceRuns.endedAt))
        )
      );
    const sendNow: string[] = [];
    // Every held run, in pages by run ID: none left out however many.
    for (let after = ""; ;) {
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      const held = await db
        .selectDistinct({ runId: workflowAiWaits.runId })
        .from(workflowAiWaits)
        .where(gt(workflowAiWaits.runId, after))
        .orderBy(asc(workflowAiWaits.runId))
        .limit(pageSize);
      const wakes: (Wake & AiWaitRun)[] = held.map(({ runId }) => ({
        id: `ai:${crypto.randomUUID()}`,
        runId,
        type: aiWakeType,
      }));
      // oxlint-disable-next-line no-await-in-loop -- one page at a time
      await owe(db, wakes);
      sendNow.push(
        ...wakes.slice(0, wakesAtOnce - sendNow.length).map(({ id }) => id)
      );
      const last = held.at(-1);
      if (last === undefined || held.length < pageSize) {
        break;
      }
      after = last.runId;
    }
    await Promise.all(
      sendNow.map(async (id) => {
        await sendWake(env, id);
      })
    );
  } catch (error) {
    log.warn("workflow.ai_wake_failed", errorFields(error));
  }
};
