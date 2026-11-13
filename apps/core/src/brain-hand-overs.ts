import type { AuditEvent } from "@grasp-os/shared/audit";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { brainHandOvers, personErasures } from "./db/core/schema.ts";
import { statementsWithin } from "./db/d1.ts";

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
// one. A source noted again while its hand-over is open is one intent: by
// the same event, nothing changes; by another, the newer noting takes its
// place, and its hand-over reads the source as it is then.
//
// A noting stays until its hand-over ends, and it ends in the same batch
// as the one event that says how (brain-sources.ts `producersOf`): handed
// over, refused or skipped. So it ends once, however often its attempt
// runs or its answer is lost, and never without its event.
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
 * An intent as the relay took it: marked only as it was noted then. Its
 * producer as stored, which may be one no longer registered.
 */
export interface TakenHandOver {
  producer: string;
  sourceId: string;
  /** The ID of the audit event that noted it. */
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

/** The hand-overs `events` note, each source once, by the last event noting it. */
const intentsOf = (
  events: readonly AuditEvent[]
): (HandOverIntent & { noting: string })[] => {
  const intents = new Map<string, HandOverIntent & { noting: string }>();
  for (const { id, action, target } of events) {
    const noted = notedBy.get(action);
    if (noted === undefined || target?.type !== noted.target) {
      continue;
    }
    intents.set(JSON.stringify([noted.producer, target.id]), {
      producer: noted.producer,
      sourceId: target.id,
      noting: id,
    });
  }
  return [...intents.values()];
};

/**
 * Notes the hand-overs `events` (audit events the log now has) call for,
 * each in place of one of its source noted before by another event, to be
 * relayed again. Safe to repeat: a drain cut short notes them again, and
 * an event that noted a hand-over still open changes nothing. Throws when
 * they can't be noted, so the drain keeps the events for the next one.
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
  // As many rows an insert as D1 binds, counted from the insert itself.
  const [first, ...rest] = statementsWithin(intents, (part) =>
    db
      .insert(brainHandOvers)
      .values(part.map((intent) => ({ ...intent, notedAt })))
      .onConflictDoUpdate({
        target: [brainHandOvers.producer, brainHandOvers.sourceId],
        set: {
          noting: sql`excluded.noting`,
          notedAt: sql`excluded.noted_at`,
          // SQL, not a bound value: the conflict clause binds nothing.
          relayedAt: sql`NULL`,
        },
        setWhere: sql`${brainHandOvers.noting} <> excluded.noting`,
      })
  );
  if (first !== undefined) {
    await db.batch([first, ...rest]);
  }
};

/** The hand-overs noted longest ago and not yet relayed, at most `limit`. */
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
    .where(isNull(brainHandOvers.relayedAt))
    .orderBy(asc(brainHandOvers.notedAt))
    .limit(limit);

/** `taken`'s row, only while it is still as noted when it was taken. */
const stillNoted = ({ producer, sourceId, noting }: TakenHandOver): SQL =>
  sql`${brainHandOvers.producer} = ${producer} AND ${brainHandOvers.sourceId} = ${sourceId} AND ${brainHandOvers.noting} = ${noting}`;

/**
 * Marks `relayed` as on the Brain's queue, and removes `dropped`, which
 * never will be (a producer core no longer registers, an id the Brain
 * can't key): each only while it is still as noted when it was taken, so
 * one noted anew since is relayed again.
 */
export const settleRelay = async (
  env: Pick<Env, "DB">,
  relayed: readonly TakenHandOver[],
  dropped: readonly TakenHandOver[]
): Promise<void> => {
  const db = drizzle(env.DB);
  const relayedAt = new Date();
  const [first, ...rest] = [
    ...relayed.map((taken) =>
      db.update(brainHandOvers).set({ relayedAt }).where(stillNoted(taken))
    ),
    ...dropped.map((taken) =>
      db.delete(brainHandOvers).where(stillNoted(taken))
    ),
  ];
  if (first !== undefined) {
    await db.batch([first, ...rest]);
  }
};

/**
 * The noting of `intent` whose hand-over is open: the ID of the event that
 * noted it, or `undefined` when none is (its hand-over ended).
 */
export const openNoting = async (
  env: Pick<Env, "DB">,
  intent: HandOverIntent
): Promise<string | undefined> => {
  const row = await drizzle(env.DB)
    .select({ noting: brainHandOvers.noting })
    .from(brainHandOvers)
    .where(
      and(
        eq(brainHandOvers.producer, intent.producer),
        eq(brainHandOvers.sourceId, intent.sourceId)
      )
    )
    .get();
  return row?.noting;
};

/** That `taken`'s hand-over is still open, as noted then, as SQL. */
export const stillOpen = (taken: TakenHandOver): SQL =>
  sql`EXISTS (SELECT 1 FROM ${brainHandOvers} WHERE ${stillNoted(taken)})`;

/** The statement that ends `taken`'s hand-over, if it is still open as noted then. */
export const endedHandOver = (db: DrizzleD1Database, taken: TakenHandOver) =>
  db.delete(brainHandOvers).where(stillNoted(taken));

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
