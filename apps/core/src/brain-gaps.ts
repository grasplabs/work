import { actorOf } from "@grasp-os/shared/audit";
import type { Gap } from "@grasp-os/shared/brain";
import {
  brainGapAnswerSchema,
  brainGapErrors,
  brainRecordIdSchema,
  brainRecordSchema,
} from "@grasp-os/shared/brain-records";
import { issuesOf } from "@grasp-os/shared/errors";
import { requireAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import type { GapRecord } from "./brain-records.ts";
import { brainGapStates, brainRecords } from "./db/core/schema.ts";

// What became of the Playbook's gaps (`brain.askAboutGap`, `answerGap`,
// `closeGap`): the gap record itself is never written over (brain-records
// .ts); its ask, answer and close are kept beside it, in
// `brain_gap_states`, each set once. Threat model, and how each is closed
// (the design is on GRA-527, the chat that answers from it on GRA-531):
//
// - Someone asking about or closing a gap who shouldn't: admins alone ask
//   (Grasp sends the question to its owner) and close one unanswered.
//   Every member may answer, in their own words and name, as the brain is
//   theirs to fill in; each answer is audited.
// - An answer written over, or a closed gap reopened: every close is
//   guarded in SQL (`closed_at IS NULL`), so of two racing answers one
//   lands and the other is refused, and nothing reopens a gap.
// - An answer in the audit log: events name the gap, never its answer.
// - An agent answering for a person: these are a person's own calls on
//   `/rpc`, never on App or agent stubs.

type GapState = typeof brainGapStates.$inferSelect;

/** The ISO date of `at`: `YYYY-MM-DD`. */
const dayOf = (at: Date): string => at.toISOString().slice(0, 10);

/** What became of each gap among `ids`, by gap. */
export const gapStatesOf = async (
  env: Env,
  ids: readonly string[]
): Promise<Map<string, GapState>> => {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await drizzle(env.DB)
    .select()
    .from(brainGapStates)
    // Every id as one bound parameter: D1 binds at most 100 to a statement.
    .where(
      sql`${brainGapStates.gapId} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`
    );
  return new Map(rows.map((row) => [row.gapId, row]));
};

/** `gap` with what became of it, as the brain reads it. */
export const gapWith = (gap: GapRecord, state: GapState | undefined): Gap => {
  const asked = state?.askedAt ?? null;
  const closed = state?.closedAt ?? null;
  const answer = state?.answer ?? null;
  const answeredBy = state?.answeredBy ?? null;
  return {
    ...gap,
    ...(asked === null ? {} : { askedAt: dayOf(asked) }),
    ...(closed === null ? {} : { closedAt: dayOf(closed) }),
    ...(answer === null ? {} : { answer }),
    ...(answeredBy === null ? {} : { answeredBy }),
  };
};

/** The gap `gapId` names, as added; refuses one the brain doesn't have. */
const gapOf = async (env: Env, gapId: unknown): Promise<GapRecord> => {
  const id = brainRecordIdSchema.safeParse(gapId);
  if (!id.success) {
    throw brainGapErrors.create("brain.gap_not_found");
  }
  const row = await drizzle(env.DB)
    .select({ body: brainRecords.body })
    .from(brainRecords)
    .where(and(eq(brainRecords.type, "gap"), eq(brainRecords.id, id.data)))
    .get();
  if (row === undefined) {
    throw brainGapErrors.create("brain.gap_not_found");
  }
  const record = brainRecordSchema.parse(JSON.parse(row.body));
  if (record.type !== "gap") {
    throw brainGapErrors.create("brain.gap_not_found");
  }
  const { type: _gap, ...gap } = record;
  return gap;
};

/** What became of `gap`, as kept now. */
const stateOf = async (
  env: Env,
  gap: GapRecord
): Promise<GapState | undefined> => {
  const states = await gapStatesOf(env, [gap.id]);
  return states.get(gap.id);
};

/**
 * Records that `gapId`'s owner was asked, once, as `person`: for admins.
 * Asking again changes nothing; a closed gap is refused.
 */
export const askAboutGap = async (
  env: Env,
  person: Identity,
  gapId: unknown
): Promise<Gap> => {
  requireAdmin(person);
  const gap = await gapOf(env, gapId);
  const before = await stateOf(env, gap);
  if ((before?.closedAt ?? null) !== null) {
    throw brainGapErrors.create("brain.gap_closed");
  }
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .insert(brainGapStates)
      .values({ gapId: gap.id, askedAt: new Date() })
      .onConflictDoUpdate({
        target: brainGapStates.gapId,
        set: { askedAt: sql`excluded.asked_at` },
        setWhere: sql`${brainGapStates.askedAt} IS NULL AND ${brainGapStates.closedAt} IS NULL`,
      }),
    outboxedIfChanged(db, {
      actor: actorOf(person),
      action: "brain.gap.asked",
      target: { type: "brain_gap", id: gap.id },
    }),
  ]);
  return gapWith(gap, await stateOf(env, gap));
};

/**
 * Closes `gap` as `person`, with `answer` in their words and name, or
 * none; refuses a gap closed already, whoever closed it first.
 */
const close = async (
  env: Env,
  person: Identity,
  gap: GapRecord,
  answer: string | null
): Promise<Gap> => {
  const db = drizzle(env.DB);
  const answeredBy = answer === null ? null : person.name;
  const [closed] = await auditedBatch(env, db, [
    db
      .insert(brainGapStates)
      .values({ gapId: gap.id, closedAt: new Date(), answer, answeredBy })
      .onConflictDoUpdate({
        target: brainGapStates.gapId,
        set: {
          closedAt: sql`excluded.closed_at`,
          answer: sql`excluded.answer`,
          answeredBy: sql`excluded.answered_by`,
        },
        setWhere: sql`${brainGapStates.closedAt} IS NULL`,
      }),
    outboxedIfChanged(db, {
      actor: actorOf(person),
      action: answer === null ? "brain.gap.closed" : "brain.gap.answered",
      target: { type: "brain_gap", id: gap.id },
    }),
  ]);
  // Closed by this call only if its guarded write changed the row: of two
  // racing closes, the second changes nothing.
  if (closed.meta.changes === 0) {
    throw brainGapErrors.create("brain.gap_closed");
  }
  return gapWith(gap, await stateOf(env, gap));
};

/** Answers the open gap `gapId` in `person`'s words and name, and closes it. */
export const answerGap = async (
  env: Env,
  person: Identity,
  gapId: unknown,
  answer: unknown
): Promise<Gap> => {
  const parsed = brainGapAnswerSchema.safeParse(answer);
  if (!parsed.success) {
    throw brainGapErrors.create("brain.gap_invalid", {
      issues: issuesOf(parsed.error),
    });
  }
  const gap = await gapOf(env, gapId);
  return await close(env, person, gap, parsed.data);
};

/** Closes the open gap `gapId` without an answer: for admins. */
export const closeGap = async (
  env: Env,
  person: Identity,
  gapId: unknown
): Promise<Gap> => {
  requireAdmin(person);
  const gap = await gapOf(env, gapId);
  return await close(env, person, gap, null);
};
