import type { AuditEvent } from "@grasp-os/shared/audit";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { brainHandOvers, personErasures } from "./db/core/schema.ts";
import { chunks } from "./db/d1.ts";

// What core has still to hand over to the new Brain: a source by its
// producer and id, never its content (brain-sources.ts reads that when the
// Brain's queue runs the hand-over).
//
// Each is noted from the audit event of the change that touched it, which
// core writes in the same batch as the change (core's outbox). The drain
// that takes the event to the log notes the hand-over before the event
// leaves its outbox, and a drain that fails to note it keeps the event for
// the next drain (audit-outbox.ts). So every change that was made is noted
// at least once, and nothing else is: no person, App or agent can note
// one. Noting the same source again is one intent.
//
// A producer is registered here, by the audit events that note it, and in
// brain-sources.ts, by its source's key and how it is read (`producers`,
// which must name every producer here). Its kind is one of core's Brain's
// (brain-next.ts `producerKinds`).

/**
 * Every producer: the audit actions whose event notes one of its sources,
 * and the target type that event names the source by (its id is the
 * source's).
 */
export const handOverProducers = {
  // An independent workflow run that ended (workflows/resource-runs.ts).
  // A test run's end names its workflow, not a run, so none is noted.
  run: {
    actions: [
      "workflow.run.completed",
      "workflow.run.failed",
      "workflow.run.cancelled",
    ],
    target: "workflow_run",
  },
  // A turn of a person's own chat, answered (workspace.ts `captureTurn`):
  // noted, not yet kept, only for a turn that may be handed over; its
  // hand-over ends in handed over, refused or skipped, with why.
  chat: {
    actions: ["chat.turn_noted"],
    target: "chat_turn",
  },
} as const satisfies Record<
  string,
  { actions: readonly string[]; target: string }
>;
export type HandOverProducer = keyof typeof handOverProducers;

/** A source to hand over: its producer and that producer's id for it. */
export interface HandOverIntent {
  producer: HandOverProducer;
  sourceId: string;
}

/**
 * An intent as the relay took it: removed only as it was noted then. Its
 * producer as stored, which may be one no longer registered.
 */
export interface TakenHandOver {
  producer: string;
  sourceId: string;
  noting: string;
}

/** The producer each noting audit action is for, and its target type. */
const notedBy: ReadonlyMap<
  string,
  { producer: HandOverProducer; target: string }
> = new Map(
  Object.entries(handOverProducers).flatMap(([producer, { actions, target }]) =>
    actions.map((action) => [
      action,
      // SAFETY: `producer` is a key of `handOverProducers`, which
      // `Object.entries` widens to string.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      { producer: producer as HandOverProducer, target },
    ])
  )
);

/** The hand-overs `events` note, each source once. */
const intentsOf = (events: readonly AuditEvent[]): HandOverIntent[] => {
  const intents = new Map<string, HandOverIntent>();
  for (const { action, target } of events) {
    const noted = notedBy.get(action);
    if (noted === undefined || target?.type !== noted.target) {
      continue;
    }
    intents.set(JSON.stringify([noted.producer, target.id]), {
      producer: noted.producer,
      sourceId: target.id,
    });
  }
  return [...intents.values()];
};

/** Rows per insert: four bound parameters each, within D1's 100. */
const rowsPerInsert = 25;

/**
 * Notes the hand-overs `events` (audit events the log now has) call for,
 * each in place of one noted before. Safe to repeat: a drain cut short
 * notes them again. Throws when they can't be noted, so the drain keeps
 * the events for the next one.
 */
export const noteHandOvers = async (
  env: Pick<Env, "DB">,
  events: readonly AuditEvent[]
): Promise<void> => {
  const intents = intentsOf(events);
  if (intents.length === 0) {
    return;
  }
  const db = drizzle(env.DB);
  const notedAt = new Date();
  const [first, ...rest] = chunks(intents, rowsPerInsert).map((part) =>
    db
      .insert(brainHandOvers)
      .values(
        part.map((intent) => ({
          ...intent,
          noting: crypto.randomUUID(),
          notedAt,
        }))
      )
      .onConflictDoUpdate({
        target: [brainHandOvers.producer, brainHandOvers.sourceId],
        set: {
          noting: sql`excluded.noting`,
          notedAt: sql`excluded.noted_at`,
        },
      })
  );
  if (first !== undefined) {
    await db.batch([first, ...rest]);
  }
};

/** The hand-overs noted longest ago, at most `limit`. */
export const pendingHandOvers = async (
  env: Pick<Env, "DB">,
  limit: number
): Promise<TakenHandOver[]> =>
  await drizzle(env.DB)
    .select({
      producer: brainHandOvers.producer,
      sourceId: brainHandOvers.sourceId,
      noting: brainHandOvers.noting,
    })
    .from(brainHandOvers)
    .orderBy(asc(brainHandOvers.notedAt))
    .limit(limit);

/**
 * Removes `taken`, each only while it is still as noted when it was taken:
 * one noted again since stays, to be handed over again.
 */
export const removeHandOvers = async (
  env: Pick<Env, "DB">,
  taken: readonly TakenHandOver[]
): Promise<void> => {
  const db = drizzle(env.DB);
  const [first, ...rest] = taken.map(({ producer, sourceId, noting }) =>
    db
      .delete(brainHandOvers)
      .where(
        and(
          eq(brainHandOvers.producer, producer),
          eq(brainHandOvers.sourceId, sourceId),
          eq(brainHandOvers.noting, noting)
        )
      )
  );
  if (first !== undefined) {
    await db.batch([first, ...rest]);
  }
};

/** Whether core's records say `personId`'s erasure has begun. */
export const erasureBegun = async (
  env: Pick<Env, "DB">,
  personId: string
): Promise<boolean> => {
  const erasure = await drizzle(env.DB)
    .select({ userId: personErasures.userId })
    .from(personErasures)
    .where(eq(personErasures.userId, personId))
    .get();
  return erasure !== undefined;
};
