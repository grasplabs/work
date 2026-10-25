import { and, desc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { z } from "zod";

import type { Brain } from "./brain.ts";
import { brainErrors } from "./contract.ts";
import type { LessonLineage, LessonSummary } from "./contract.ts";
import { inList } from "./db/d1.ts";
import {
  brainEpisodeMembers,
  brainEpisodes,
  brainLessonEvidence,
  brainLessons,
  brainLessonVersions,
} from "./db/schema.ts";
import { retireLessonAt } from "./lessons.ts";

// Lessons as a person inspects and corrects them (GRA-301, slice 2; the
// threat model is on the issue): the first reader of what consolidation
// keeps (lessons.ts). Who sees a lesson is decided in the query, before
// any limit:
// - a person lesson, by its owner alone;
// - a session lesson, by someone the host counts in its audience now who
//   was also a member of every episode its current revision rests on, so
//   nobody who joined later, or missed some of its turns, reads it.
// A lesson anyone else asks for is `brain.not_found`, as one that doesn't
// exist. Lineage shows, of each version, only the episodes its reader was
// part of; an older session version resting on any they weren't shows
// its revision and link alone, never its text, which holds counts.

/** Most lessons one list answers. */
export const lessonsPageMax = 100;

/** Most versions of one lesson its lineage shows: the newest. */
export const lessonVersionsMax = 50;

/** Most evidence episodes one version shows. */
export const lessonEvidenceMax = 100;

/**
 * The lessons `userId`, in the audiences `audiences` now, may see, as a
 * condition on `brain_lessons`.
 */
const visibleTo = (userId: string, audiences: readonly string[]): SQL => {
  const own = and(
    eq(brainLessons.scope, "person"),
    eq(brainLessons.scopeId, userId)
  );
  if (audiences.length === 0) {
    return own ?? sql`0`;
  }
  // Every episode of its current revision had them as a member: there is
  // one, and none without them.
  const current = sql`${brainLessonEvidence.lessonId} = ${brainLessons.id} AND ${brainLessonEvidence.revision} = ${brainLessons.revision}`;
  // And every episode it was written from is still there: one erased
  // counts as one they weren't part of (its version recorded how many).
  const whole = sql`(SELECT count(*) FROM ${brainLessonEvidence} WHERE ${current}) = (SELECT json_extract(${brainLessonVersions.content}, '$.episodes') FROM ${brainLessonVersions} WHERE ${brainLessonVersions.lessonId} = ${brainLessons.id} AND ${brainLessonVersions.revision} = ${brainLessons.revision})`;
  const shared = sql`${brainLessons.scope} = 'session' AND ${inList(brainLessons.scopeId, audiences)} AND EXISTS (SELECT 1 FROM ${brainLessonEvidence} WHERE ${current}) AND ${whole} AND NOT EXISTS (SELECT 1 FROM ${brainLessonEvidence} WHERE ${current} AND NOT EXISTS (SELECT 1 FROM ${brainEpisodeMembers} WHERE ${brainEpisodeMembers.episodeId} = ${brainLessonEvidence.episodeId} AND ${brainEpisodeMembers.userId} = ${userId}))`;
  return sql`(${own}) OR (${shared})`;
};

const applicabilitySchema = z.object({
  taskType: z.string(),
  versions: z.array(z.string()),
});

const summaryOf = (row: typeof brainLessons.$inferSelect): LessonSummary => {
  const { taskType, versions } = applicabilitySchema.parse(
    JSON.parse(row.applicability)
  );
  return {
    id: row.id,
    revision: row.revision,
    scope: row.scope,
    state: row.state,
    retiredBy: row.retiredBy,
    instruction: row.instruction,
    evidenceStatus: row.evidenceStatus,
    taskType,
    versions,
    updatedAt: row.updatedAt.toISOString(),
  };
};

/** Who `reader` is to lessons: their person, and their audiences now. */
const readerOf = async <C>(
  brain: Brain<C>,
  reader: C
): Promise<{ userId: string; audiences: readonly string[] }> => {
  const userId = brain.ports.ownerOf(reader);
  const audiences = await brain.ports.audiences(reader);
  return { userId, audiences };
};

/** Notes a read of lessons, as every read of the Brain is noted. */
const noteRead = async <C>(
  brain: Brain<C>,
  reader: C,
  read: string,
  lessons: number
): Promise<void> => {
  await brain.ports.onRead(reader, {
    action: "knowledge.read",
    detail: { read, lessons },
  });
};

/**
 * The lessons `reader` may see, most recently changed first, at most
 * {@link lessonsPageMax}. A caller with no person is `brain.denied`.
 */
export const lessonsFor = async <C>(
  brain: Brain<C>,
  reader: C
): Promise<LessonSummary[]> => {
  const { userId, audiences } = await readerOf(brain, reader);
  const rows = await brain.db
    .select()
    .from(brainLessons)
    .where(visibleTo(userId, audiences))
    .orderBy(desc(brainLessons.updatedAt), desc(brainLessons.id))
    .limit(lessonsPageMax);
  await noteRead(brain, reader, "lessons", rows.length);
  return rows.map(summaryOf);
};

const lineageInputSchema = z.strictObject({
  lessonId: z.string().min(1).max(128),
});

const storedSchema = z.object({
  instruction: z.string(),
  evidenceStatus: z.enum(["supported", "contested"]),
  episodes: z.int().min(0),
});

/**
 * The lesson `input` names and its versions newest first, as `reader` may
 * see them: of each version, the episodes they were part of; of an older
 * session version resting on any they weren't, its revision and link
 * alone. A lesson they may not see is `brain.not_found`.
 */
export const lessonLineage = async <C>(
  brain: Brain<C>,
  reader: C,
  input: unknown
): Promise<LessonLineage> => {
  const { lessonId } = brainErrors.parse(
    "brain.invalid",
    lineageInputSchema,
    input
  );
  const { userId, audiences } = await readerOf(brain, reader);
  const { db } = brain;
  const row = await db
    .select()
    .from(brainLessons)
    .where(and(eq(brainLessons.id, lessonId), visibleTo(userId, audiences)))
    .get();
  if (row === undefined) {
    throw brainErrors.create("brain.not_found");
  }
  const versions = await db
    .select()
    .from(brainLessonVersions)
    .where(eq(brainLessonVersions.lessonId, lessonId))
    .orderBy(desc(brainLessonVersions.revision))
    .limit(lessonVersionsMax);
  const revisions = versions.map(({ revision }) => revision);
  const evidence =
    revisions.length === 0
      ? []
      : await db
          .select({
            revision: brainLessonEvidence.revision,
            episodeId: brainLessonEvidence.episodeId,
            role: brainLessonEvidence.role,
            taskType: brainEpisodes.taskType,
            execution: brainEpisodes.execution,
            result: brainEpisodes.result,
            occurredAt: brainEpisodes.occurredAt,
            // Whether the reader was part of it: theirs, for a person
            // lesson; a member of it, for a session one.
            seen:
              row.scope === "person"
                ? sql<number>`${brainEpisodes.ownerId} = ${userId}`
                : sql<number>`EXISTS (SELECT 1 FROM ${brainEpisodeMembers} WHERE ${brainEpisodeMembers.episodeId} = ${brainEpisodes.id} AND ${brainEpisodeMembers.userId} = ${userId})`,
          })
          .from(brainLessonEvidence)
          .innerJoin(
            brainEpisodes,
            eq(brainEpisodes.id, brainLessonEvidence.episodeId)
          )
          .where(
            and(
              eq(brainLessonEvidence.lessonId, lessonId),
              inList(
                sql`CAST(${brainLessonEvidence.revision} AS TEXT)`,
                revisions.map(String)
              )
            )
          )
          .orderBy(desc(brainEpisodes.occurredAt), desc(brainEpisodes.id));
  await noteRead(brain, reader, "lesson.lineage", 1);
  return {
    lesson: summaryOf(row),
    versions: versions.map((version) => {
      const of = evidence.filter(
        ({ revision }) => revision === version.revision
      );
      const seen = of.filter((each) => Boolean(each.seen));
      const stored = storedSchema.parse(JSON.parse(version.content));
      // A session version's text only for someone part of every episode it
      // was written from, none of them erased since; a person's own lesson
      // is theirs, whatever was erased of it.
      const whole =
        row.scope === "person" ||
        (seen.length === of.length && of.length === stored.episodes);
      return {
        revision: version.revision,
        supersedes: version.supersedes,
        instruction: whole ? stored.instruction : null,
        evidenceStatus: whole ? stored.evidenceStatus : null,
        episodes: seen.slice(0, lessonEvidenceMax).map((each) => ({
          episodeId: each.episodeId,
          role: each.role,
          taskType: each.taskType,
          execution: each.execution,
          result: each.result,
          occurredAt: each.occurredAt.toISOString(),
        })),
        createdAt: version.createdAt.toISOString(),
      };
    }),
  };
};

const retireInputSchema = z.strictObject({
  lessonId: z.string().min(1).max(128),
  expectedRevision: z.int().min(1),
});

/**
 * Retires the lesson `input` names, as `reader`'s correction, at its
 * expected revision: a person lesson by its owner, a session lesson by
 * someone who may see it and whom the host lets retire shared records
 * (`mayRetire`). Never patched or recreated after. One they may not see,
 * or not retire, is `brain.not_found`; a stale revision is
 * `brain.revision_conflict`.
 */
export const lessonsRetire = async <C>(
  brain: Brain<C>,
  reader: C,
  input: unknown
): Promise<void> => {
  const { lessonId, expectedRevision } = brainErrors.parse(
    "brain.invalid",
    retireInputSchema,
    input
  );
  const { userId, audiences } = await readerOf(brain, reader);
  const row = await brain.db
    .select({
      scope: brainLessons.scope,
      scopeId: brainLessons.scopeId,
      revision: brainLessons.revision,
    })
    .from(brainLessons)
    .where(and(eq(brainLessons.id, lessonId), visibleTo(userId, audiences)))
    .get();
  if (row === undefined) {
    throw brainErrors.create("brain.not_found");
  }
  // The revision they may see is the one they retire: one consolidation
  // moved since is a conflict, never a revision they never saw.
  if (row.revision !== expectedRevision) {
    throw brainErrors.create("brain.revision_conflict");
  }
  if (row.scope === "session") {
    // A shared lesson has no single owner: the host's rule for shared
    // records decides, with nobody counted as its publisher.
    await brain.ports.mayRetire(reader, {
      scope: "session",
      scopeId: row.scopeId,
      ownerId: "",
    });
  }
  await retireLessonAt(brain, lessonId, expectedRevision, {
    actor: brain.ports.actorOf(reader),
    as: row.scope === "session" ? "admin" : "owner",
  });
};
