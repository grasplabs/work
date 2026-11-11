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
import { z } from "zod";

import { memberRole } from "./auth/identity.ts";
import { scheduleConsolidation } from "./brain-consolidation.ts";
import { brainOf } from "./knowledge/ports.ts";

// Settled task outcomes, captured for the Brain without a learning step in
// any task (GRA-300; the Brain design's "Automatic platform operation"):
// core observes its own execution boundaries, decides what is eligible and
// whose experience it is, and records each outcome through the Brain's
// host-only runtime API (`recordOutcome`), never through anything an App,
// a page or a model can call.
//
// Durable at the owning boundary: the write that settles a task writes
// its capture intent with it: a chat turn's in its Workspace object's
// storage as the turn settles (workspace.ts). The Brain's database shares
// no transaction with it, so delivery is at least once: right after the
// settle, in the background, and again by the object's alarm for
// whatever is left, which repairs a crash or an outage between the two. The Brain keeps an event ID once, so a
// delivery made again is one event, and keeps each source's cursor: the
// highest intent sequence it recorded.
//
// What is captured, and what isn't (the policy, in one place):
// - Production work only: evaluation, test and learning-job work never
//   trains production behaviour. The Brain refuses any other purpose too.
// - Consent and revocation: the outcome is built when it is delivered, from
//   the task's own records as they are then, so a person who is no longer
//   a member, a chat in restricted mode or a deleted chat is dropped, never
//   delivered.
// - Audience: a person's own work is their experience alone. A chat others
//   share is one experience for exactly its members as the chat kept them
//   for the turn (Nick, GRA-300): the Brain reaches one of them only while
//   the chat still counts them and they are still a member (the Brain's
//   `audiences` port, knowledge/access.ts `audiencesOf`).
// - Minimal and erasable: an outcome holds identifiers and states, never
//   inputs, outputs or messages, and names the record it rests on. When
//   that record goes (a chat deleted), its events and intents go too (`eraseCaptured`), and a delivery that
//   landed meanwhile is erased by the check after it.
//
// What a task's model says of its result is never an outcome: execution
// states come from the host's records (the turn's end, as the host saw
// it), and a task counts
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

/**
 * Erases the Brain's events resting on the records `evidenceIds` (chats),
 * their records going: run before the records go, so an erasure
 * cut short is made again.
 */
export const eraseCaptured = async (
  env: Env,
  evidenceIds: readonly string[]
): Promise<void> => {
  await eraseOutcomes(brainOf(env), evidenceIds);
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
