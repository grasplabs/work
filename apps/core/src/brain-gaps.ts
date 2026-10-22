import { actorOf } from "@grasp-os/shared/audit";
import type { Gap } from "@grasp-os/shared/brain";
import {
  brainGapAnswerSchema,
  brainGapErrors,
  brainRecordIdSchema,
  brainRecordSchema,
} from "@grasp-os/shared/brain-records";
import { issuesOf } from "@grasp-os/shared/errors";
import { isMemberAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxed, outboxedIfChanged } from "./audit-outbox.ts";
import type { GapRecord } from "./brain-records.ts";
import { brainGapStates, brainRecords, users } from "./db/core/schema.ts";

// What became of the Playbook's gaps (`brain.askAboutGap`, `answerGap`,
// `closeGap`): the gap record itself is never written over (brain-records
// .ts); its ask, answer and close are kept beside it, in
// `brain_gap_states`, each set once. Threat model, and how each is closed
// (the design is on GRA-527, the chat that answers from it on GRA-531):
//
// - Someone asking about or closing a gap who shouldn't: the company's own
//   admins alone ask (Grasp sends the question to its owner), close one
//   unanswered and redact an answer; Grasp staff, admins too, never decide
//   a client's gaps. Every member may answer, in their own words, as the
//   brain is theirs to fill in; staff may not. Each answer is audited.
// - An answerer's name frozen at write: an answer keeps who gave it by
//   user id, and the brain shows that person's name as it is now.
// - An answer that can't be erased: an admin redacts one; a content purge
//   rewrites every answer holding its terms; a personal purge forgets the
//   person as anyone's answerer (knowledge/purge.ts).
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

/** The names people have now, by user id, among `ids`. */
const namesOf = async (
  env: Env,
  ids: readonly string[]
): Promise<Map<string, string>> => {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) {
    return new Map();
  }
  const rows = await drizzle(env.DB)
    .select({ id: users.id, name: users.name })
    .from(users)
    // Every id as one bound parameter: D1 binds at most 100 to a statement.
    .where(
      sql`${users.id} IN (SELECT value FROM json_each(${JSON.stringify(wanted)}))`
    );
  return new Map(rows.map(({ id, name }) => [id, name]));
};

/**
 * `gap` with what became of it, as the brain reads it: who answered by
 * their name now, from `names`; none once they are gone.
 */
const gapWith = (
  gap: GapRecord,
  state: GapState | undefined,
  names: ReadonlyMap<string, string>
): Gap => {
  const asked = state?.askedAt ?? null;
  const closed = state?.closedAt ?? null;
  const answer = state?.answer ?? null;
  const answerer = state?.answeredBy ?? null;
  const answeredBy = answerer === null ? undefined : names.get(answerer);
  return {
    ...gap,
    ...(asked === null ? {} : { askedAt: dayOf(asked) }),
    ...(closed === null ? {} : { closedAt: dayOf(closed) }),
    ...(answer === null ? {} : { answer }),
    ...(answeredBy === undefined ? {} : { answeredBy }),
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

/** `gaps`, each with what became of it, as the brain reads them. */
export const gapsWith = async (
  env: Env,
  gaps: readonly GapRecord[]
): Promise<Gap[]> => {
  const states = await gapStatesOf(
    env,
    gaps.map(({ id }) => id)
  );
  const names = await namesOf(
    env,
    [...states.values()].flatMap(({ answeredBy }) => answeredBy ?? [])
  );
  return gaps.map((gap) => gapWith(gap, states.get(gap.id), names));
};

/** `gap` with what became of it now. */
const readGap = async (env: Env, gap: GapRecord): Promise<Gap> => {
  const [read] = await gapsWith(env, [gap]);
  return read ?? gapWith(gap, undefined, new Map());
};

/** Refuses anyone but the company's own admins: never Grasp staff. */
const requireMemberAdmin = (person: Identity): void => {
  if (!isMemberAdmin(person)) {
    throw roleErrors.create("role.forbidden");
  }
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
  requireMemberAdmin(person);
  const gap = await gapOf(env, gapId);
  const before = await readGap(env, gap);
  if (before.closedAt !== undefined) {
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
  return await readGap(env, gap);
};

/**
 * Closes `gap` as `person`, with `answer` in their words, or
 * none; refuses a gap closed already, whoever closed it first.
 */
const close = async (
  env: Env,
  person: Identity,
  gap: GapRecord,
  answer: string | null
): Promise<Gap> => {
  const db = drizzle(env.DB);
  const answeredBy = answer === null ? null : person.userId;
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
  return await readGap(env, gap);
};

/** Answers the open gap `gapId` in `person`'s words and name, and closes it. */
export const answerGap = async (
  env: Env,
  person: Identity,
  gapId: unknown,
  answer: unknown
): Promise<Gap> => {
  // Grasp's staff never answer for the company.
  if (person.staff) {
    throw roleErrors.create("role.forbidden");
  }
  const parsed = brainGapAnswerSchema.safeParse(answer);
  if (!parsed.success) {
    throw brainGapErrors.create("brain.gap_invalid", {
      issues: issuesOf(parsed.error),
    });
  }
  const gap = await gapOf(env, gapId);
  // GRA-328: an answer is canonical Brain storage, so it passes the
  // admission gate (knowledge/admission.ts, #863) here, before it is kept.
  return await close(env, person, gap, parsed.data);
};

/** Closes the open gap `gapId` without an answer: for admins. */
export const closeGap = async (
  env: Env,
  person: Identity,
  gapId: unknown
): Promise<Gap> => {
  requireMemberAdmin(person);
  const gap = await gapOf(env, gapId);
  return await close(env, person, gap, null);
};

/**
 * Takes the answer of the gap `gapId` away, and who gave it, keeping it
 * closed: for the company's admins.
 */
export const redactGapAnswer = async (
  env: Env,
  person: Identity,
  gapId: unknown
): Promise<Gap> => {
  requireMemberAdmin(person);
  const gap = await gapOf(env, gapId);
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .update(brainGapStates)
      .set({ answer: null, answeredBy: null })
      .where(
        and(eq(brainGapStates.gapId, gap.id), isNotNull(brainGapStates.answer))
      ),
    outboxedIfChanged(db, {
      actor: actorOf(person),
      action: "brain.gap.redacted",
      target: { type: "brain_gap", id: gap.id },
    }),
  ]);
  return await readGap(env, gap);
};

/**
 * How many gap answers `holds` is true of: those a content purge's terms
 * are in, which it would rewrite (its plan) or failed to (its check).
 */
export const countGapAnswers = async (
  env: Env,
  holds: (text: string) => boolean
): Promise<number> => {
  const answered = await drizzle(env.DB)
    .select({ answer: brainGapStates.answer })
    .from(brainGapStates)
    .where(isNotNull(brainGapStates.answer));
  return answered.filter(({ answer }) => answer !== null && holds(answer))
    .length;
};

/**
 * Rewrites every gap answer with `rewrite` (a content purge's: its terms
 * replaced), as `person`; an answer it leaves as it is isn't written.
 * Returns how many it rewrote.
 */
export const rewriteGapAnswers = async (
  env: Env,
  person: Identity,
  rewrite: (text: string) => string
): Promise<number> => {
  const db = drizzle(env.DB);
  const answered = await db
    .select({ gapId: brainGapStates.gapId, answer: brainGapStates.answer })
    .from(brainGapStates)
    .where(isNotNull(brainGapStates.answer));
  const changed = answered.flatMap(({ gapId, answer }) => {
    if (answer === null) {
      return [];
    }
    const now = rewrite(answer);
    return now === answer ? [] : [{ gapId, answer, now }];
  });
  const [first, ...rest] = changed;
  if (first === undefined) {
    return 0;
  }
  const update = ({ gapId, answer, now }: (typeof changed)[number]) =>
    db
      .update(brainGapStates)
      .set({ answer: now })
      // Only the answer read: one answered since is left to a purge again.
      .where(
        and(eq(brainGapStates.gapId, gapId), eq(brainGapStates.answer, answer))
      );
  await auditedBatch(env, db, [
    update(first),
    ...rest.map(update),
    outboxed(db, {
      actor: actorOf(person),
      action: "brain.gap.answers_purged",
      target: { type: "brain", id: "playbook" },
      detail: { gaps: changed.length },
    }),
  ]);
  return changed.length;
};

/**
 * Forgets `userId` as anyone's answerer (a personal purge), as `person`:
 * their answers stay, as the company's, said by no one.
 */
export const eraseGapAnswerer = async (
  env: Env,
  person: Identity,
  userId: string
): Promise<void> => {
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .update(brainGapStates)
      .set({ answeredBy: null })
      .where(inArray(brainGapStates.answeredBy, [userId])),
    outboxedIfChanged(db, {
      actor: actorOf(person),
      action: "brain.gap.answerer_erased",
      target: { type: "user", id: userId },
    }),
  ]);
};
