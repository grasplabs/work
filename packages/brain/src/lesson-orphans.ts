import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import {
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
        sql`SELECT ${brainLessons.id}, ${brainLessons.revision} + 1, ${brainLessons.revision}, ${brainLessonVersions.content}, 'erased:' || ${brainLessons.id} || '@' || (${brainLessons.revision} + 1), ${now.getTime()} FROM ${brainLessons} JOIN ${brainLessonVersions} ON ${brainLessonVersions.lessonId} = ${brainLessons.id} AND ${brainLessonVersions.revision} = ${brainLessons.revision} WHERE ${orphaned}`
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
  ] as const;
};
