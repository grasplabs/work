import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import {
  brainConsolidationDue,
  brainEpisodes,
  brainLessonEvidence,
  brainLessons,
  brainLessonVersions,
} from "./db/schema.ts";

// What erasing episodes does to the lessons resting on them (GRA-301): in
// the erasure's own batch, never waiting for a consolidation job that may
// never come. Apart from lessons.ts so outcomes.ts, which erases, can use
// it without the two importing each other.

/** Failures a pattern needs to be a lesson, and to stay one. */
export const lessonMinFailures = 3;

/**
 * The statements that retire every open lesson the erasure of the
 * episodes `erased` (a condition on `brain_episodes`) leaves with fewer
 * than {@link lessonMinFailures} supporting episodes: a new revision,
 * retired, with the content it had, so a job that read the lesson before
 * the erasure finds it moved and its patch conflicts. Run before the
 * erasure's delete, in its batch.
 */
export const retiringOrphans = (
  db: DrizzleD1Database,
  erased: SQL,
  now: Date
) => {
  const atRevision = sql`${brainLessonEvidence.lessonId} = ${brainLessons.id} AND ${brainLessonEvidence.revision} = ${brainLessons.revision}`;
  const orphaned = and(
    eq(brainLessons.state, "candidate"),
    // Resting on something this erasure takes,
    sql`EXISTS (SELECT 1 FROM ${brainLessonEvidence} JOIN ${brainEpisodes} ON ${brainEpisodes.id} = ${brainLessonEvidence.episodeId} WHERE ${atRevision} AND ${erased})`,
    // and left with too little support once it has.
    sql`(SELECT count(*) FROM ${brainLessonEvidence} JOIN ${brainEpisodes} ON ${brainEpisodes.id} = ${brainLessonEvidence.episodeId} WHERE ${atRevision} AND ${brainLessonEvidence.role} = 'supporting' AND NOT (${erased})) < ${lessonMinFailures}`
  );
  return [
    db
      .insert(brainLessonVersions)
      .select(
        sql`SELECT ${brainLessons.id}, ${brainLessons.revision} + 1, ${brainLessons.revision}, ${brainLessonVersions.content}, 'erased:' || ${brainLessons.id} || '@' || (${brainLessons.revision} + 1), ${now.getTime()}, ${brainLessonVersions.wording}, ${brainLessonVersions.wordingState} FROM ${brainLessons} JOIN ${brainLessonVersions} ON ${brainLessonVersions.lessonId} = ${brainLessons.id} AND ${brainLessonVersions.revision} = ${brainLessons.revision} WHERE ${orphaned}`
      )
      .onConflictDoNothing(),
    // The links it keeps: its evidence that this erasure leaves, carried
    // into the retired revision, so what it rested on stays inspectable.
    db
      .insert(brainLessonEvidence)
      .select(
        sql`SELECT ${brainLessonEvidence.lessonId}, ${brainLessonEvidence.revision} + 1, ${brainLessonEvidence.episodeId}, ${brainLessonEvidence.role} FROM ${brainLessonEvidence} JOIN ${brainLessons} ON ${atRevision} JOIN ${brainEpisodes} ON ${brainEpisodes.id} = ${brainLessonEvidence.episodeId} WHERE ${brainLessons.state} = 'candidate' AND EXISTS (SELECT 1 FROM ${brainLessonVersions} WHERE ${brainLessonVersions.lessonId} = ${brainLessons.id} AND ${brainLessonVersions.revision} = ${brainLessons.revision} + 1 AND ${brainLessonVersions.patchKey} = 'erased:' || ${brainLessons.id} || '@' || (${brainLessons.revision} + 1)) AND NOT (${erased})`
      )
      .onConflictDoNothing(),
    db
      .update(brainLessons)
      .set({
        state: "retired",
        retiredBy: "evidence",
        revision: sql`${brainLessons.revision} + 1`,
        updatedAt: now,
      })
      .where(orphaned),
    // One left open, with enough support but some of it erased: its text
    // and status still count what went, so its scope's consolidation is
    // due at once, to write it again from what is left.
    db
      .insert(brainConsolidationDue)
      .select(
        sql`SELECT DISTINCT ${brainLessons.scope} || ':' || ${brainLessons.scopeId}, ${brainLessons.scope}, ${brainLessons.scopeId}, 0, ${now.getTime()} FROM ${brainLessons} WHERE ${brainLessons.state} = 'candidate' AND EXISTS (SELECT 1 FROM ${brainLessonEvidence} JOIN ${brainEpisodes} ON ${brainEpisodes.id} = ${brainLessonEvidence.episodeId} WHERE ${atRevision} AND ${erased})`
      )
      .onConflictDoUpdate({
        target: brainConsolidationDue.scopeKey,
        set: { since: sql`0`, touchedAt: sql`excluded.touched_at` },
      }),
  ] as const;
};

/** A scope consolidation reads, as episodes name it. */
export interface ConsolidationScope {
  scope: "person" | "session";
  /** The owner's user ID for `person`, the audience's ID for `session`. */
  scopeId: string;
}

/** A scope's key: its marks, its due marker and its jobs are named by it. */
export const scopeKeyOf = ({ scope, scopeId }: ConsolidationScope): string =>
  `${scope}:${scopeId}`;
