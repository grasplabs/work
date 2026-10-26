import { brainErrors } from "@grasp-os/brain/contract";
import type { ConsolidationScope } from "@grasp-os/brain/lessons";
import {
  audienceMembersMax,
  eraseOutcome,
  eraseOutcomes,
  recordOutcome,
} from "@grasp-os/brain/outcomes";
import type { TaskOutcome } from "@grasp-os/brain/outcomes";
import { errorFields, log } from "@grasp-os/shared/log";
import { waitUntil } from "cloudflare:workers";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { memberRole } from "./auth/identity.ts";
import { scheduleConsolidation } from "./brain-consolidation.ts";
import { apps, brainCaptureIntents, workflowRuns } from "./db/core/schema.ts";
import { brainOf } from "./knowledge/ports.ts";

// Settled task outcomes, captured for the Brain without a learning step in
// any task (GRA-300; the Brain design's "Automatic platform operation"):
// core observes its own execution boundaries, decides what is eligible and
// whose experience it is, and records each outcome through the Brain's
// host-only runtime API (`recordOutcome`), never through anything an App,
// a screen or a model can call.
//
// Durable at the owning boundary: the write that settles a task writes
// its capture intent with it. A workflow run's intent goes in core's
// database in the batch that ends the run (workflows/runs.ts,
// `projectStatus`); a chat turn's in its Workspace object's storage as
// the turn settles (workspace.ts). The Brain's database shares no
// transaction with either, so delivery is at least once: right after the
// settle, in the background, and again by the clock (runs) or the
// object's alarm (turns) for whatever is left, which repairs a crash or
// an outage between the two. The Brain keeps an event ID once, so a
// delivery made again is one event, and keeps each source's cursor: the
// highest intent sequence it recorded.
//
// What is captured, and what isn't (the policy, in one place):
// - Production work only. A run of a draft App is its builder trying it,
//   an App's tests run under a pin of their own and an internal job
//   (indexing, and the learning jobs to come) has no run row, so none of
//   them reaches an intent: evaluation, test and learning-job work never
//   trains production behaviour. The Brain refuses any other purpose too.
// - Consent and revocation: the outcome is built when it is delivered, from
//   the task's own records as they are then, so a person who is no longer
//   a member, a chat in restricted mode, a deleted chat or a run whose
//   details are gone is dropped, never delivered.
// - Audience: a person's own work is their experience alone. A chat others
//   share is one experience for exactly its members as the chat kept them
//   for the turn (Nick, GRA-300): the Brain reaches one of them only while
//   the chat still counts them and they are still a member (the Brain's
//   `audiences` port, knowledge/access.ts `audiencesOf`).
// - Minimal and erasable: an outcome holds identifiers and states, never
//   inputs, outputs or messages, and names the record it rests on. When
//   that record goes (a chat deleted, a run's details past retention), its
//   events and intents go too (`eraseCaptured`), and a delivery that
//   landed meanwhile is erased by the check after it.
//
// What a task's model says of its result is never an outcome: execution
// states come from the host's records (the run's row, as the engine's
// journal set it; the turn's end, as the host saw it), and a task counts
// as a success only where a check the host trusts says so, which none
// does yet: completing is `unknown`, failing is `failure`.

/** Intents one drain of a store takes at a time. */
const takePerBatch = 50;

/** Batches one drain takes before it leaves the rest for the next. */
const batchesPerDrain = 10;

/** An intent as a drain reads it. */
export interface PendingCapture {
  seq: number;
  eventId: string;
  evidenceId: string;
  /** What the settle said, for a store that keeps it; null otherwise. */
  facts: string | null;
  attempts: number;
}

/** What a store's outcome holds: all but where it came from. */
export type CapturedOutcome = Omit<TaskOutcome, "source" | "sourceSeq">;

/** One store of capture intents, as a drain reads and settles it. */
export interface CaptureStore {
  /** The Brain's name for this source: its cursor's. */
  source: string;
  /** Pending intents, the least tried first, then oldest. */
  pending: (limit: number) => Promise<PendingCapture[]>;
  /** Removes an intent: delivered, or no longer eligible. */
  settled: (seq: number) => Promise<void>;
  /**
   * Records a failed delivery: tried again later, or, `dead`, never: the
   * Brain refused it for good.
   */
  failed: (seq: number, code: string, dead: boolean) => Promise<void>;
  /**
   * The outcome `intent` stands for, as its records are now; undefined
   * once it may no longer be learned from.
   */
  outcomeOf: (intent: PendingCapture) => Promise<CapturedOutcome | undefined>;
}

/** The scope an outcome's lessons are consolidated in: its own, exactly. */
const scopeOfOutcome = (outcome: CapturedOutcome): ConsolidationScope =>
  outcome.audience === undefined
    ? { scope: "person", scopeId: outcome.ownerId }
    : { scope: "session", scopeId: outcome.audience.id };

/**
 * Delivers one intent: built from its records now, recorded in the Brain
 * (once, whatever came before), checked again, then removed. A failure is
 * recorded on the intent and left for the next drain.
 */
const deliver = async (
  env: Env,
  store: CaptureStore,
  intent: PendingCapture
): Promise<void> => {
  const brain = brainOf(env);
  const outcome = await store.outcomeOf(intent);
  if (outcome === undefined) {
    // No longer eligible: and a delivery before this one may have recorded
    // it and stopped short of its check after (a lost reply, a restart),
    // so it is taken back first. The intent stays until that worked.
    try {
      await eraseOutcome(brain, intent.eventId);
    } catch (error) {
      const code = brainErrors.codeOf(error) ?? "unavailable";
      log.warn("brain.capture.failed", {
        source: store.source,
        seq: intent.seq,
        code,
        ...errorFields(error),
      });
      await store.failed(intent.seq, code, false);
      return;
    }
    await store.settled(intent.seq);
    return;
  }
  try {
    const { recorded } = await recordOutcome(brain, {
      ...outcome,
      source: store.source,
      sourceSeq: intent.seq,
    });
    // An erasure or revocation that landed while it was recorded didn't
    // find this yet: it goes now, and nothing else of its record.
    if ((await store.outcomeOf(intent)) === undefined) {
      await eraseOutcome(brain, outcome.eventId);
    } else if (recorded) {
      // Learning from it, once its scope has enough new: in the background.
      await scheduleConsolidation(env, scopeOfOutcome(outcome));
    }
  } catch (error) {
    const code = brainErrors.codeOf(error) ?? "unavailable";
    // Only a refusal of the outcome itself is for good: anything else (the
    // Brain's database out of reach, say) is tried again.
    const dead = code === "brain.invalid";
    log[dead ? "error" : "warn"]("brain.capture.failed", {
      source: store.source,
      seq: intent.seq,
      code,
      ...errorFields(error),
    });
    await store.failed(intent.seq, code, dead);
    return;
  }
  await store.settled(intent.seq);
};

/**
 * Delivers `store`'s pending intents, the least tried first, a bounded
 * number of batches; never throws. Returns whether any are left pending,
 * so its caller tries again later.
 */
export const drainCaptures = async (
  env: Env,
  store: CaptureStore
): Promise<boolean> => {
  try {
    for (let batch = 0; batch < batchesPerDrain; batch += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one bounded batch after another
      const intents = await store.pending(takePerBatch);
      for (const intent of intents) {
        // oxlint-disable-next-line no-await-in-loop -- in order, each once
        await deliver(env, store, intent);
      }
      if (intents.length < takePerBatch) {
        break;
      }
    }
    const left = await store.pending(1);
    return left.length > 0;
  } catch (error) {
    log.error("brain.capture.drain_failed", {
      source: store.source,
      ...errorFields(error),
    });
    return true;
  }
};

/** How a run's row ended, as an outcome says it. */
const executions = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
} as const;

/** The Brain's source of workflow runs' outcomes. */
export const runSource = "workflow.run";

/** A run's event ID: one per run, however often it is delivered. */
const runEventId = (runId: string): string => `${runSource}:${runId}`;

/**
 * The statement that writes run `runId`'s capture intent, for the batch
 * that ends it (runs.ts, `projectStatus`): only if that batch left the run
 * ended, and only for a published App's run, production work. Once per
 * run, whatever the batch is run again for.
 */
export const runCaptured = (db: DrizzleD1Database, runId: string, now: Date) =>
  db
    .insert(brainCaptureIntents)
    .select(
      sql`SELECT NULL, ${runEventId(runId)}, ${runId}, 'pending', 0, NULL, ${now.getTime()} FROM ${workflowRuns} INNER JOIN ${apps} ON ${apps.id} = ${workflowRuns.appId} WHERE ${workflowRuns.id} = ${runId} AND ${workflowRuns.endedAt} IS NOT NULL AND ${apps.status} = 'published'`
    )
    .onConflictDoNothing({ target: brainCaptureIntents.eventId });

/** A settled run's outcome as its row is now; undefined if not eligible. */
const runOutcome = async (
  env: Env,
  runId: string
): Promise<CapturedOutcome | undefined> => {
  const row = await drizzle(env.DB)
    .select({
      appId: workflowRuns.appId,
      workflowId: workflowRuns.workflowId,
      version: workflowRuns.version,
      status: workflowRuns.status,
      endedAt: workflowRuns.endedAt,
      // A run acts for whoever started it, or its App's owner (runs.ts).
      ownerId: sql<string>`COALESCE(${workflowRuns.startedBy}, ${apps.ownerId})`,
    })
    .from(workflowRuns)
    .innerJoin(apps, eq(apps.id, workflowRuns.appId))
    .where(
      and(
        eq(workflowRuns.id, runId),
        isNotNull(workflowRuns.endedAt),
        sql`${workflowRuns.detailsRemovedAt} IS NULL`
      )
    )
    .get();
  if (row?.endedAt === null || row === undefined) {
    return undefined;
  }
  const { endedAt, status } = row;
  if (
    !(
      status === "completed" ||
      status === "failed" ||
      status === "cancelled"
    ) ||
    (await memberRole(env.DB, row.ownerId)) === undefined
  ) {
    return undefined;
  }
  const execution = executions[status];
  return {
    eventId: runEventId(runId),
    purpose: "production",
    ownerId: row.ownerId,
    scope: "person",
    taskType: `workflow:${row.appId}/${row.workflowId}`,
    execution,
    result: execution === "failed" ? "failure" : "unknown",
    evidenceId: runId,
    evidenceRefs: [{ kind: "workflow_run", id: runId }],
    versionRefs: [
      { kind: "app", id: row.appId, version: String(row.version) },
      { kind: "workflow", id: row.workflowId },
    ],
    occurredAt: endedAt.toISOString(),
  };
};

/** Pending intents in core's database, the least tried first. */
const pendingIn = async (
  db: DrizzleD1Database,
  limit: number
): Promise<PendingCapture[]> =>
  await db
    .select({
      seq: brainCaptureIntents.seq,
      eventId: brainCaptureIntents.eventId,
      evidenceId: brainCaptureIntents.evidenceId,
      facts: sql<null>`NULL`,
      attempts: brainCaptureIntents.attempts,
    })
    .from(brainCaptureIntents)
    .where(eq(brainCaptureIntents.state, "pending"))
    .orderBy(asc(brainCaptureIntents.attempts), asc(brainCaptureIntents.seq))
    .limit(limit);

/** Core's store of workflow runs' capture intents. */
export const runCaptures = (env: Env): CaptureStore => {
  const db = drizzle(env.DB);
  return {
    source: runSource,
    pending: async (limit) => await pendingIn(db, limit),
    settled: async (seq) => {
      await db
        .delete(brainCaptureIntents)
        .where(eq(brainCaptureIntents.seq, seq));
    },
    failed: async (seq, code, dead) => {
      await db
        .update(brainCaptureIntents)
        .set({
          attempts: sql`${brainCaptureIntents.attempts} + 1`,
          lastError: code,
          ...(dead ? { state: "dead" as const } : {}),
        })
        .where(eq(brainCaptureIntents.seq, seq));
    },
    outcomeOf: async ({ evidenceId }) => await runOutcome(env, evidenceId),
  };
};

/** Delivers runs' pending intents soon, in the background. */
export const deliverRunCapturesSoon = (env: Env): void => {
  waitUntil(drainCaptures(env, runCaptures(env)));
};

/** Delivers runs' pending intents now: the clock's catch-up. */
export const reconcileRunCaptures = async (env: Env): Promise<void> => {
  await drainCaptures(env, runCaptures(env));
};

/**
 * Erases the Brain's events resting on the records `evidenceIds` (runs,
 * chats), their records going: run before the records go, so an erasure
 * cut short is made again.
 */
export const eraseCaptured = async (
  env: Env,
  evidenceIds: readonly string[]
): Promise<void> => {
  await eraseOutcomes(brainOf(env), evidenceIds);
};

/**
 * Erases what was captured of the runs `runIds`, their details going
 * (workflows/retention.ts): their events in the Brain first, then their
 * intents, so a sweep cut short in between erases again.
 */
export const eraseRunCaptures = async (
  env: Env,
  runIds: readonly string[]
): Promise<void> => {
  if (runIds.length === 0) {
    return;
  }
  await eraseCaptured(env, runIds);
  await drizzle(env.DB)
    .delete(brainCaptureIntents)
    .where(inArray(brainCaptureIntents.evidenceId, [...runIds]));
};

/** How each way a chat turn ends is an execution's end. */
const turnExecutions = {
  answered: "completed",
  cancelled: "cancelled",
  failed: "failed",
  max_steps: "failed",
} as const;

/**
 * What a settled chat turn's intent keeps (workspace.ts): identifiers and
 * how it ended, never the question, the answer or what its code returned.
 */
const turnFactsSchema = z.strictObject({
  chatId: z.string().min(1),
  turnId: z.string().min(1),
  personId: z.string().min(1),
  agentId: z.string().min(1),
  /**
   * Who shares the chat, for one others share: its members as the chat
   * kept them for the turn. Null for a person's own chat.
   */
  audience: z.array(z.string().min(1)).nullable(),
  outcome: z.enum(["answered", "cancelled", "failed", "max_steps"]),
  /** The message the turn answered with, if it kept one. */
  answerId: z.int().nullable(),
  model: z.string().min(1),
  occurredAt: z.iso.datetime({ offset: true }),
});
export type TurnFacts = z.infer<typeof turnFactsSchema>;

/** The Brain's source of a Workspace object's turns: one per object. */
export const turnSource = (workspaceId: string): string =>
  `chat.turn:${workspaceId}`;

/** A turn's event ID: one per turn, however often it is delivered. */
export const turnEventId = ({ chatId, turnId }: TurnFacts): string =>
  `chat.turn:${chatId}:${turnId}`;

/**
 * A settled turn's outcome, from what its intent kept and its chat as it
 * is now (`chatOpen`: still there, and not in restricted mode); undefined
 * if not eligible, its person no longer a member included.
 */
export const turnOutcome = async (
  env: Env,
  stored: string | null,
  chatOpen: (chatId: string) => boolean
): Promise<CapturedOutcome | undefined> => {
  let json: unknown;
  try {
    json = JSON.parse(stored ?? "null");
  } catch {
    return undefined;
  }
  const parsed = turnFactsSchema.safeParse(json);
  if (!parsed.success) {
    return undefined;
  }
  const facts = parsed.data;
  if (
    !chatOpen(facts.chatId) ||
    // An audience too large to name each member is no one's experience.
    (facts.audience?.length ?? 0) > audienceMembersMax ||
    (await memberRole(env.DB, facts.personId)) === undefined
  ) {
    return undefined;
  }
  const execution = turnExecutions[facts.outcome];
  return {
    eventId: turnEventId(facts),
    purpose: "production",
    ownerId: facts.personId,
    ...(facts.audience === null
      ? { scope: "person" as const }
      : {
          // One experience, for exactly the chat's members.
          scope: "session" as const,
          audience: { id: facts.chatId, members: facts.audience },
        }),
    taskType: "chat.turn",
    execution,
    result: execution === "failed" ? "failure" : "unknown",
    evidenceId: facts.chatId,
    evidenceRefs: [
      { kind: "chat", id: facts.chatId },
      { kind: "chat_turn", id: facts.turnId },
      ...(facts.answerId === null
        ? []
        : [{ kind: "chat_message", id: String(facts.answerId) }]),
    ],
    versionRefs: [
      { kind: "agent", id: facts.agentId },
      { kind: "model", id: facts.model },
    ],
    occurredAt: facts.occurredAt,
  };
};
