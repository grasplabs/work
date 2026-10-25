import { and, desc, eq, exists, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxedWhere } from "./audit.ts";
import type { Brain } from "./brain.ts";
import { brainErrors } from "./contract.ts";
import { inList } from "./db/d1.ts";
import {
  brainCaptureCursors,
  brainConsolidationDue,
  brainEpisodeMembers,
  brainEpisodes,
  brainErasedEvidence,
  brainForgottenPeople,
  brainSequences,
} from "./db/schema.ts";
import { idSchema } from "./ids.ts";
import type { Json } from "./json.ts";
import { retiringOrphans, scopeKeyOf } from "./lesson-orphans.ts";

// The Brain's runtime API for its host (GRA-300; the Brain design's
// "Automatic platform operation"): `recordOutcome` keeps a settled task's
// outcome as a learning event. Host-only: no SDK, binding or tool form
// reaches it, so nothing a model writes becomes one.
//
// The Brain decides nothing about content here. The host observes its own
// settled executions, decides what is eligible and whose experience it is
// (its scope and owner), and derives the event's ID from what settled, so
// a delivery made again, after a crash or a lost reply, is the same event:
// recorded once, answered as a duplicate after. An event holds references
// to the host's execution records, never their payloads, and goes when
// the record it rests on is erased (`eraseOutcomes`) or its person is
// purged (memories.ts `forgetPerson`).
//
// Only production work trains production behaviour: an evaluation, test,
// replay or learning-job event is refused here as well as never captured
// by the host, so a learning job can't feed on its own output.
//
// Who reaches an event is the Brain's audience rule, as for everything it
// holds: the host records who it is for, and decides at every read who the
// reader is now (its ports). A `person` event reaches its owner. A
// `session` event (a chat others share) is for its audience's members as
// they were when it was recorded, exactly, and reaches one of them only
// while the host still counts them in that audience (`ports.audiences`):
// a member who left the chat, or the company, reaches it no more, and
// someone who joined after never did.

/** A reference to one of the host's execution records: opaque here. */
export const executionRefSchema = z.strictObject({
  /** What kind of record, in the host's words, such as `workflow_run`. */
  kind: z.string().min(1).max(64),
  id: idSchema,
  /** The record's version, where it has one. */
  version: z.string().min(1).max(64).optional(),
});
export type ExecutionRef = z.infer<typeof executionRefSchema>;

/** Most references one event holds, of evidence and of versions each. */
export const executionRefsMax = 20;

/** Most members one event's audience names. */
export const audienceMembersMax = 1000;

/**
 * How the execution ended, from the host's own records (a run's journal, a
 * turn's end): never what the task's model said of it.
 */
export const executionStateSchema = z.enum([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * Whether the task did what it was for: `success` only where a check the
 * host trusts verified it (completing isn't success), `failure` where the
 * execution failed, and `unknown` otherwise.
 */
export const taskResultSchema = z.enum(["success", "failure", "unknown"]);

/** A settled task's outcome, as the host records it. */
export const taskOutcomeSchema = z
  .strictObject({
    /** The host's, derived from what settled: the same for every delivery. */
    eventId: idSchema,
    /** The host's boundary it settled at, such as `workflow.run`. */
    source: z.string().min(1).max(128),
    /** Its capture's place in `source`'s sequence: 1 and up. */
    sourceSeq: z.int().min(1),
    /** Only production work is learned from. */
    purpose: z.literal("production"),
    /** The person whose experience it is. */
    ownerId: idSchema,
    /** Whose experience it is: the owner's alone, or a shared session's. */
    scope: z.enum(["person", "session"]),
    /**
     * A `session` event's audience: the host's ID for it, and its members
     * when the event settled. None for any other.
     */
    audience: z
      .strictObject({
        id: idSchema,
        members: z
          .array(idSchema)
          .min(1)
          .max(audienceMembersMax)
          .refine((ids) => new Set(ids).size === ids.length, {
            message: "Name each member once.",
          }),
      })
      .optional(),
    /** The host's name for the kind of task. */
    taskType: z.string().min(1).max(256),
    execution: executionStateSchema,
    result: taskResultSchema,
    /** The host's execution record whose erasure erases the event. */
    evidenceId: idSchema,
    evidenceRefs: z.array(executionRefSchema).min(1).max(executionRefsMax),
    versionRefs: z.array(executionRefSchema).max(executionRefsMax),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .refine(
    ({ scope, audience }) => (scope === "session") === (audience !== undefined),
    {
      message: "A session's outcome names its audience, and only a session's.",
    }
  );
export type TaskOutcome = z.input<typeof taskOutcomeSchema>;

/** What a delivery did: recorded the event, or found it recorded. */
export interface OutcomeReceipt {
  eventId: string;
  recorded: boolean;
}

/**
 * The key an event taken back on its own (`eraseOutcome`) is remembered
 * by in `brain_erased_evidence`, beside the execution records erased
 * whole. The host's run and chat IDs never start with `episode:`, and a
 * clash could only keep an event from being recorded, never record one.
 */
const erasedEventKey = (eventId: string): string => `episode:${eventId}`;

/** The system, as the Brain's own events name it. */
const system: Json = { type: "system" };

/**
 * Records `input`, a settled task's outcome, once: a delivery of an event
 * recorded already changes nothing and answers `recorded: false`. The
 * event, its audit event and its source's cursor commit together. Refuses
 * anything but production work, and a malformed outcome, as
 * `brain.invalid`.
 */
export const recordOutcome = async <C>(
  brain: Brain<C>,
  input: unknown
): Promise<OutcomeReceipt> => {
  const outcome = brainErrors.parse("brain.invalid", taskOutcomeSchema, input);
  const { db } = brain;
  const now = brain.ports.clock();
  const occurredAt = new Date(outcome.occurredAt);
  // A random mark of this delivery: the members below are written only if
  // it is the one that recorded the event.
  const delivery = crypto.randomUUID();
  // Forgotten by a personal purge after it happened: its work from before
  // the purge is never learned from again, however late it arrives.
  const forgotten = (userId: SQL | string) =>
    sql`EXISTS (SELECT 1 FROM ${brainForgottenPeople} WHERE ${brainForgottenPeople.userId} = ${userId} AND ${brainForgottenPeople.forgottenAt} >= ${occurredAt.getTime()})`;
  // Its record erased (a run's details past retention, a chat deleted), or
  // the event itself taken back (`eraseOutcome`): never recorded after,
  // however late a delivery lands.
  const erased = sql`EXISTS (SELECT 1 FROM ${brainErasedEvidence} WHERE ${brainErasedEvidence.evidenceId} IN (${outcome.evidenceId}, ${erasedEventKey(outcome.eventId)}))`;
  const isNew = sql`NOT EXISTS (SELECT 1 FROM ${brainEpisodes} WHERE ${brainEpisodes.id} = ${outcome.eventId}) AND NOT ${forgotten(outcome.ownerId)} AND NOT ${erased}`;
  const scope =
    outcome.audience === undefined
      ? { scope: "person" as const, scopeId: outcome.ownerId }
      : { scope: "session" as const, scopeId: outcome.audience.id };
  const recordedNow = sql`EXISTS (SELECT 1 FROM ${brainEpisodes} WHERE ${brainEpisodes.id} = ${outcome.eventId} AND ${brainEpisodes.delivery} = ${delivery})`;
  const [, _counted, inserted] = await auditedBatch(brain.ports, db, [
    // Before the insert, on its condition: recorded only if it is new.
    outboxedWhere(
      brain,
      {
        actor: system,
        action: "knowledge.episode.recorded",
        target: { type: "episode", id: outcome.eventId },
        detail: {
          source: outcome.source,
          execution: outcome.execution,
          result: outcome.result,
        },
      },
      isNew
    ),
    // The order it is recorded in, from one counter moved in this batch:
    // commit order, whatever the clock said (lessons.ts reads by it).
    db
      .insert(brainSequences)
      .values({ name: "episodes", value: 1 })
      .onConflictDoUpdate({
        target: brainSequences.name,
        set: { value: sql`${brainSequences.value} + 1` },
      }),
    db
      .insert(brainEpisodes)
      .select(
        sql`SELECT ${outcome.eventId}, ${outcome.source}, ${outcome.sourceSeq}, ${outcome.ownerId}, ${outcome.scope}, ${outcome.audience?.id ?? null}, ${outcome.taskType}, ${outcome.execution}, ${outcome.result}, ${outcome.evidenceId}, ${JSON.stringify(outcome.evidenceRefs)}, ${JSON.stringify(outcome.versionRefs)}, ${occurredAt.getTime()}, ${now.getTime()}, ${delivery}, (SELECT ${brainSequences.value} FROM ${brainSequences} WHERE ${brainSequences.name} = 'episodes') WHERE ${isNew}`
      )
      .onConflictDoNothing({ target: brainEpisodes.id })
      .returning({ id: brainEpisodes.id }),
    // Its audience, by the delivery that recorded it only, and never one
    // a personal purge forgot since: a delivery made again adds no one.
    db
      .insert(brainEpisodeMembers)
      .select(
        sql`SELECT ${outcome.eventId}, members.value FROM json_each(${JSON.stringify(outcome.audience?.members ?? [])}) AS members WHERE ${recordedNow} AND NOT ${forgotten(sql`members.value`)}`
      )
      .onConflictDoNothing(),
    // Its scope's consolidation is due (lessons.ts), if it was recorded.
    db
      .insert(brainConsolidationDue)
      .select(
        sql`SELECT ${scopeKeyOf(scope)}, ${scope.scope}, ${scope.scopeId}, ${now.getTime()}, ${now.getTime()} WHERE ${recordedNow}`
      )
      .onConflictDoUpdate({
        target: brainConsolidationDue.scopeKey,
        set: { touchedAt: sql`excluded.touched_at` },
      }),
    db
      .insert(brainCaptureCursors)
      .values({
        source: outcome.source,
        seq: outcome.sourceSeq,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: brainCaptureCursors.source,
        set: {
          seq: sql`max(${brainCaptureCursors.seq}, excluded.seq)`,
          updatedAt: now,
        },
      }),
  ]);
  return { eventId: outcome.eventId, recorded: inserted.length > 0 };
};

/** A recorded event, as the host reads it back. */
export interface Episode {
  eventId: string;
  source: string;
  ownerId: string;
  scope: string;
  /** A `session` event's audience, as the host named it. */
  audience: string | null;
  taskType: string;
  execution: z.infer<typeof executionStateSchema>;
  result: z.infer<typeof taskResultSchema>;
  evidenceId: string;
  evidenceRefs: ExecutionRef[];
  versionRefs: ExecutionRef[];
  occurredAt: string;
}

const refsSchema = z.array(executionRefSchema);

/** An event row as the host reads it. */
const episodeOf = (row: typeof brainEpisodes.$inferSelect): Episode => ({
  eventId: row.id,
  source: row.source,
  ownerId: row.ownerId,
  scope: row.scope,
  audience: row.audience,
  taskType: row.taskType,
  execution: row.execution,
  result: row.result,
  evidenceId: row.evidenceId,
  evidenceRefs: refsSchema.parse(JSON.parse(row.evidenceRefs)),
  versionRefs: refsSchema.parse(JSON.parse(row.versionRefs)),
  occurredAt: row.occurredAt.toISOString(),
});

/**
 * The events recorded of the execution record `evidenceId`, whoever's:
 * the host's own view, for its erasures and checks, never a reader's.
 */
export const outcomesOf = async <C>(
  { db }: Brain<C>,
  evidenceId: string
): Promise<Episode[]> => {
  const rows = await db
    .select()
    .from(brainEpisodes)
    .where(eq(brainEpisodes.evidenceId, evidenceId))
    .orderBy(brainEpisodes.occurredAt, brainEpisodes.id);
  return rows.map(episodeOf);
};

/** Most events one `outcomesFor` answers. */
export const outcomesPageMax = 100;

/**
 * The events `reader` reaches now, newest first, at most
 * `outcomesPageMax`: their own, and a shared session's while they were
 * among its members when it settled and the host still counts them in
 * its audience. A caller with no person is `brain.denied`.
 */
export const outcomesFor = async <C>(
  brain: Brain<C>,
  reader: C
): Promise<Episode[]> => {
  const userId = brain.ports.ownerOf(reader);
  const audiences = await brain.ports.audiences(reader);
  const { db } = brain;
  const member = exists(
    db
      .select({ one: sql`1` })
      .from(brainEpisodeMembers)
      .where(
        and(
          eq(brainEpisodeMembers.episodeId, brainEpisodes.id),
          eq(brainEpisodeMembers.userId, userId)
        )
      )
  );
  const rows = await db
    .select()
    .from(brainEpisodes)
    .where(
      or(
        and(
          eq(brainEpisodes.scope, "person"),
          eq(brainEpisodes.ownerId, userId)
        ),
        audiences.length === 0
          ? undefined
          : and(
              eq(brainEpisodes.scope, "session"),
              inList(brainEpisodes.audience, audiences),
              member
            )
      )
    )
    .orderBy(desc(brainEpisodes.occurredAt), desc(brainEpisodes.id))
    .limit(outcomesPageMax);
  return rows.map(episodeOf);
};

/** Each source's cursor: the highest capture sequence recorded from it. */
export const outcomeCursors = async <C>({
  db,
}: Brain<C>): Promise<{ source: string; seq: number }[]> =>
  await db
    .select({
      source: brainCaptureCursors.source,
      seq: brainCaptureCursors.seq,
    })
    .from(brainCaptureCursors)
    .orderBy(brainCaptureCursors.source);

/**
 * Erases the events where `column` is `id`, audited as one erasure of
 * `target`, with no more than its ID; nothing, and nothing recorded, when
 * none are left. How many it erased.
 */
const eraseWhere = async <C>(
  brain: Brain<C>,
  column: typeof brainEpisodes.id | typeof brainEpisodes.evidenceId,
  target: { type: string; id: string }
): Promise<number> => {
  const { db } = brain;
  const holds = sql`EXISTS (SELECT 1 FROM ${brainEpisodes} WHERE ${column} = ${target.id})`;
  const results = await auditedBatch(brain.ports, db, [
    outboxedWhere(
      brain,
      { actor: system, action: "knowledge.episode.erased", target },
      holds
    ),
    ...retiringOrphans(db, eq(column, target.id), brain.ports.clock()),
    db
      .delete(brainEpisodes)
      .where(eq(column, target.id))
      .returning({ id: brainEpisodes.id }),
    // The erasure is remembered, an execution record's or one event's, so
    // a delivery whose reply was lost, or one still on its way, landing
    // after it records nothing (`recordOutcome`).
    db
      .insert(brainErasedEvidence)
      .values({
        evidenceId:
          column === brainEpisodes.evidenceId
            ? target.id
            : erasedEventKey(target.id),
        erasedAt: brain.ports.clock(),
      })
      .onConflictDoNothing(),
  ]);
  const [, _versions, _links, _lessons, _due, deleted] = results;
  return deleted.length;
};

/**
 * Erases the events resting on the host's execution records
 * `evidenceIds`, as the host erases them. Erasing what holds none changes
 * nothing, so the host may erase again after a crash. Returns how many
 * events it erased.
 */
export const eraseOutcomes = async <C>(
  brain: Brain<C>,
  evidenceIds: readonly string[]
): Promise<number> => {
  let erased = 0;
  for (const id of new Set(evidenceIds)) {
    // oxlint-disable-next-line no-await-in-loop -- one small batch per record
    erased += await eraseWhere(brain, brainEpisodes.evidenceId, {
      type: "evidence",
      id,
    });
  }
  return erased;
};

/**
 * Erases the one event `eventId`: a host that recorded it as its person
 * lost the right to it takes it back, and nothing else of its record.
 * Remembered, whether or not the event was there yet, so a delivery of it
 * from before, landing after, records nothing.
 */
export const eraseOutcome = async <C>(
  brain: Brain<C>,
  eventId: string
): Promise<boolean> =>
  (await eraseWhere(brain, brainEpisodes.id, {
    type: "episode",
    id: eventId,
  })) > 0;

/**
 * The statements that delete `userId`'s events, take them out of every
 * shared session's audience, and remember they were forgotten now, for a
 * personal purge.
 */
export const forgetPersonOutcomes = (
  db: DrizzleD1Database,
  userId: string,
  now: Date
) =>
  [
    db
      .delete(brainEpisodeMembers)
      .where(eq(brainEpisodeMembers.userId, userId)),
    // A shared session's lessons resting on their episodes alone retire.
    ...retiringOrphans(db, eq(brainEpisodes.ownerId, userId), now),
    db.delete(brainEpisodes).where(eq(brainEpisodes.ownerId, userId)),
    // So a capture from before now, delivered again, stays forgotten; a
    // later purge only moves the boundary later.
    db
      .insert(brainForgottenPeople)
      .values({ userId, forgottenAt: now })
      .onConflictDoUpdate({
        target: brainForgottenPeople.userId,
        set: {
          forgottenAt: sql`max(${brainForgottenPeople.forgottenAt}, excluded.forgotten_at)`,
        },
      }),
  ] as const;
