import { and, asc, count, desc, eq, gt, lt, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { z } from "zod";

import { auditedBatch, outboxedWhere } from "./audit.ts";
import type { Brain, LessonFacts } from "./brain.ts";
import { brainErrors } from "./contract.ts";
import { inList } from "./db/d1.ts";
import {
  brainConsolidationDue,
  brainConsolidationMarks,
  brainEpisodes,
  brainForgottenPeople,
  brainLessonEvidence,
  brainLessons,
  brainLessonVersions,
} from "./db/schema.ts";
import { toHex } from "./encoding.ts";
import type { IndexStep, StepConfig } from "./indexing.ts";
import type { Json } from "./json.ts";
import { canonicalJson } from "./json.ts";
import { lessonMinFailures, scopeKeyOf } from "./lesson-orphans.ts";
import type { ConsolidationScope } from "./lesson-orphans.ts";
import { executionRefSchema } from "./outcomes.ts";

// Lesson candidates (GRA-301; the Brain design's "Keep episodes and lessons
// as different records" and "Consolidate in the background with
// controlled authority"): consolidation reads a scope's verified episodes
// (outcomes.ts) and keeps small lessons derived from them, each a patch
// against the revision it was made from.
//
// This policy is deterministic: an episode holds identifiers and states,
// never what a task said or did, so a lesson is built from those alone.
// A task type that keeps failing on the same versions becomes a
// `failure_pattern` candidate, its failures supporting it and its
// completed runs contradicting it. No model is called; model-written
// lessons are a later policy, under their own budget.
//
// What consolidation may never do: widen a scope (a lesson is in exactly
// its episodes' scope, a person's own or a shared session's), accept or
// publish anything (it writes candidates only, and nothing reads them
// into a prompt), outrank its owner (a lesson its owner retired is never
// patched or recreated), or outlive its evidence (an erased episode is no
// longer evidence, and a lesson left without enough is retired).

/** Consolidation's bounds: per job, and per scope. */
export const consolidationLimits = {
  /** New episodes one job reads. */
  episodesPerJob: 200,
  /** Episodes of one group a lesson rests on: the newest. */
  episodesPerGroup: 100,
  /** Rounds one job makes against a lesson that moved under it. */
  roundsPerJob: 3,
  /** Lessons one job patches. */
  patchesPerJob: 20,
  /** Candidates one scope holds open; past it, no new ones. */
  openPerScope: 50,
  /** Failures a pattern needs before it is a lesson, and to stay one. */
  minFailures: lessonMinFailures,
} as const;

/** The Brain's own, as its events name it. */
const system: Json = { type: "system" };

export { scopeKeyOf } from "./lesson-orphans.ts";
export type { ConsolidationScope } from "./lesson-orphans.ts";

/** The episodes of `scope`, as a condition. */
const inScope = ({ scope, scopeId }: ConsolidationScope): SQL | undefined =>
  scope === "person"
    ? and(eq(brainEpisodes.scope, "person"), eq(brainEpisodes.ownerId, scopeId))
    : and(
        eq(brainEpisodes.scope, "session"),
        eq(brainEpisodes.audience, scopeId)
      );

/**
 * Where a scope's consolidation got to: the `seq` of the last episode it
 * read, in the order episodes were recorded (outcomes.ts); 0 before its
 * first job.
 */
const markOf = async <C>(
  { db }: Brain<C>,
  scopeKey: string
): Promise<number> => {
  const row = await db
    .select({ seq: brainConsolidationMarks.seq })
    .from(brainConsolidationMarks)
    .where(eq(brainConsolidationMarks.scopeKey, scopeKey))
    .get();
  return row?.seq ?? 0;
};

/** Episodes recorded after `mark`, as a condition. */
const afterMark = (mark: number): SQL => gt(brainEpisodes.seq, mark);

/**
 * How many of `scope`'s episodes consolidation hasn't read yet, counted up
 * to `upTo`: what its host schedules a job by.
 */
export const consolidationBacklog = async <C>(
  brain: Brain<C>,
  scope: ConsolidationScope,
  upTo: number = consolidationLimits.episodesPerJob
): Promise<number> => {
  const mark = await markOf(brain, scopeKeyOf(scope));
  const rows = await brain.db
    .select({ id: brainEpisodes.id })
    .from(brainEpisodes)
    .where(and(inScope(scope), afterMark(mark)))
    .limit(upTo);
  return rows.length;
};

/**
 * Scopes whose consolidation has been due since before `olderThan`, at
 * most `limit`, longest due first: what its host's clock catches up on.
 * Read from the scopes marked due (outcomes.ts, lesson-orphans.ts), so an
 * idle sweep reads no history.
 */
export const scopesBehind = async <C>(
  { db }: Brain<C>,
  olderThan: Date,
  limit: number
): Promise<ConsolidationScope[]> => {
  const rows = await db
    .select({
      scope: brainConsolidationDue.scope,
      scopeId: brainConsolidationDue.scopeId,
    })
    .from(brainConsolidationDue)
    .where(lt(brainConsolidationDue.since, olderThan))
    .orderBy(asc(brainConsolidationDue.since))
    .limit(limit);
  return rows;
};

const versionRefsSchema = z.array(executionRefSchema);

/** Version lists of one task type a group read looks through, at most. */
const versionListsMax = 200;

/** What a group of episodes is about: a task type, on these versions. */
const groupKeyOf = (taskType: string, versionRefs: string): string => {
  const versions = versionRefsSchema
    .parse(JSON.parse(versionRefs))
    .map(({ kind, id, version }) => `${kind}:${id}@${version ?? ""}`)
    .toSorted();
  return canonicalJson([taskType, versions]);
};

/** A lesson's content at one revision: what its versions keep. */
interface LessonContent {
  applicability: { taskType: string; versions: string[] };
  exclusions: string[];
  instruction: string;
  evidenceStatus: "supported" | "contested";
  supporting: string[];
  contradicting: string[];
  /**
   * How many episodes its text was written from, for content read back
   * from a version: a patch that carries the text forward keeps it, so
   * erased episodes still count against it (lesson-reads.ts).
   */
  recorded?: number;
}

/** The ID of the lesson of `scopeKey`'s group `groupKey`: one per group. */
const lessonIdOf = async (
  scopeKey: string,
  groupKey: string
): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson([scopeKey, groupKey]))
  );
  return `lesson-${toHex(new Uint8Array(digest)).slice(0, 32)}`;
};

/**
 * What the group `groupKey` of `scope` says now, from its newest episodes:
 * a failure pattern if it failed often enough; undefined if not.
 */
const contentOf = async <C>(
  { db }: Brain<C>,
  scope: ConsolidationScope,
  groupKey: string,
  taskType: string
): Promise<LessonContent | undefined> => {
  // The group first, then its newest: the version lists this task ran on
  // in this scope (few), those that are this group's, and only then the
  // newest of its episodes, so other versions' episodes never crowd it out.
  const lists = await db
    .selectDistinct({ versionRefs: brainEpisodes.versionRefs })
    .from(brainEpisodes)
    .where(and(inScope(scope), eq(brainEpisodes.taskType, taskType)))
    .limit(versionListsMax);
  const ours = lists
    .map(({ versionRefs }) => versionRefs)
    .filter((versionRefs) => groupKeyOf(taskType, versionRefs) === groupKey);
  const group =
    ours.length === 0
      ? []
      : await db
          .select({
            id: brainEpisodes.id,
            execution: brainEpisodes.execution,
          })
          .from(brainEpisodes)
          .where(
            and(
              inScope(scope),
              eq(brainEpisodes.taskType, taskType),
              inList(brainEpisodes.versionRefs, ours)
            )
          )
          .orderBy(desc(brainEpisodes.occurredAt), desc(brainEpisodes.id))
          .limit(consolidationLimits.episodesPerGroup);
  const supporting = group
    .filter(({ execution }) => execution === "failed")
    .map(({ id }) => id)
    .toSorted();
  const contradicting = group
    .filter(({ execution }) => execution === "completed")
    .map(({ id }) => id)
    .toSorted();
  if (supporting.length < consolidationLimits.minFailures) {
    return undefined;
  }
  const [, versions] = z
    .tuple([z.string(), z.array(z.string())])
    .parse(JSON.parse(groupKey));
  const runs = supporting.length + contradicting.length;
  return {
    applicability: { taskType, versions },
    exclusions: [],
    instruction: `${taskType} failed ${supporting.length} of its last ${runs} finished runs on ${versions.length === 0 ? "its current versions" : versions.join(", ")}.`,
    evidenceStatus: contradicting.length === 0 ? "supported" : "contested",
    supporting,
    contradicting,
  };
};

/** A lesson as consolidation reads it before patching it. */
interface LessonAt {
  id: string;
  revision: number;
  state: "candidate" | "retired";
  retiredBy: "owner" | "admin" | "evidence" | null;
  content: LessonContent | undefined;
}

/**
 * What a version keeps of its content: all but its evidence, which is
 * `brain_lesson_evidence`'s, so an erased episode leaves no trace of its
 * ID in any version.
 */
const storedContentSchema = z.strictObject({
  applicability: z.strictObject({
    taskType: z.string(),
    versions: z.array(z.string()),
  }),
  exclusions: z.array(z.string()),
  instruction: z.string(),
  evidenceStatus: z.enum(["supported", "contested"]),
  /**
   * How many episodes it rested on when it was written: a reader sees its
   * text only while every one of them is still there and theirs, so an
   * erased episode counts as one they weren't part of (lesson-reads.ts).
   */
  episodes: z.int().min(0),
});

/** A stored content without its episode count: what a lesson says. */
const omitEpisodes = ({
  episodes: _episodes,
  ...said
}: z.infer<typeof storedContentSchema>) => said;

/** `content` as a version stores it. */
const storedOf = ({
  supporting,
  contradicting,
  recorded,
  ...stored
}: LessonContent): string =>
  canonicalJson({
    ...stored,
    episodes: recorded ?? supporting.length + contradicting.length,
  });

/**
 * A stored version's content, with the evidence it still has; undefined
 * for one not of this shape (none after the lessons' hard cut, 0008):
 * read as no content, never as content missing a field.
 */
const contentFrom = (
  stored: string,
  evidence: readonly { episodeId: string; role: string }[]
): LessonContent | undefined => {
  const parsed = storedContentSchema.safeParse(JSON.parse(stored));
  if (!parsed.success) {
    return undefined;
  }
  return {
    ...omitEpisodes(parsed.data),
    recorded: parsed.data.episodes,
    supporting: evidence
      .filter(({ role }) => role === "supporting")
      .map(({ episodeId }) => episodeId)
      .toSorted(),
    contradicting: evidence
      .filter(({ role }) => role === "contradicting")
      .map(({ episodeId }) => episodeId)
      .toSorted(),
  };
};

const lessonAt = async <C>(
  { db }: Brain<C>,
  lessonId: string
): Promise<LessonAt | undefined> => {
  const row = await db
    .select({
      id: brainLessons.id,
      revision: brainLessons.revision,
      state: brainLessons.state,
      retiredBy: brainLessons.retiredBy,
      content: brainLessonVersions.content,
    })
    .from(brainLessons)
    .leftJoin(
      brainLessonVersions,
      and(
        eq(brainLessonVersions.lessonId, brainLessons.id),
        eq(brainLessonVersions.revision, brainLessons.revision)
      )
    )
    .where(eq(brainLessons.id, lessonId))
    .get();
  if (row === undefined) {
    return undefined;
  }
  const evidence =
    row.content === null
      ? []
      : await db
          .select({
            episodeId: brainLessonEvidence.episodeId,
            role: brainLessonEvidence.role,
          })
          .from(brainLessonEvidence)
          .where(
            and(
              eq(brainLessonEvidence.lessonId, lessonId),
              eq(brainLessonEvidence.revision, row.revision)
            )
          );
  return {
    id: row.id,
    revision: row.revision,
    state: row.state,
    retiredBy: row.retiredBy,
    content:
      row.content === null ? undefined : contentFrom(row.content, evidence),
  };
};

/** A short digest of what a patch writes: part of its key. */
const digestOf = async (content: string, state: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${state}\n${content}`)
  );
  return toHex(new Uint8Array(digest)).slice(0, 32);
};

/** A patch: the lesson moved from `base` to `base + 1`, saying `content`. */
interface Patch {
  lessonId: string;
  scope: ConsolidationScope;
  groupKey: string;
  base: number;
  content: LessonContent;
  state: "candidate" | "retired";
  retiredBy: "owner" | "admin" | "evidence" | null;
  /** When the work that made it started: a purge since outranks it. */
  since: Date;
  /** Who made it, as the host's audit log names them: the Brain's own if none. */
  actor?: Json;
}

/**
 * Whether `scope` may still be written, for work started at `since`: not
 * a person a personal purge forgot since then. A job that read their
 * episodes before the purge writes nothing of them after it.
 */
const notForgotten = (scope: ConsolidationScope, since: Date): SQL =>
  scope.scope === "person"
    ? sql`NOT EXISTS (SELECT 1 FROM ${brainForgottenPeople} WHERE ${brainForgottenPeople.userId} = ${scope.scopeId} AND ${brainForgottenPeople.forgottenAt} >= ${since.getTime()})`
    : sql`1`;

/**
 * Applies `patch` in one batch, against its base: the version, its
 * evidence, and the lesson moved on, only if the lesson is still at its
 * base. A patch made again (a retried job) writes nothing: its key is
 * unique. Answers whether the lesson is now at the patch's revision.
 */
const applyPatch = async <C>(
  brain: Brain<C>,
  patch: Patch
): Promise<boolean> => {
  const { db } = brain;
  const now = brain.ports.clock();
  const revision = patch.base + 1;
  const content = storedOf(patch.content);
  const patchKey = `${patch.lessonId}@${revision}:${await digestOf(
    canonicalJson([
      content,
      patch.content.supporting,
      patch.content.contradicting,
    ]),
    patch.state
  )}`;
  // A candidate only while enough of its support still exists: one read
  // before an erasure never lands as a candidate after it.
  const supported =
    patch.state === "candidate"
      ? sql`(SELECT count(*) FROM ${brainEpisodes} WHERE ${inList(brainEpisodes.id, patch.content.supporting)}) >= ${lessonMinFailures}`
      : sql`1`;
  // Opening a candidate, or reopening a retired one, only while its scope
  // holds fewer than its cap, checked in the batch that opens it: jobs that
  // overlap can't open past it between them. A patch to one open already
  // passes.
  const withinCap =
    patch.state === "candidate"
      ? sql`(COALESCE((SELECT ${brainLessons.state} FROM ${brainLessons} WHERE ${brainLessons.id} = ${patch.lessonId}), 'retired') = 'candidate' OR (SELECT count(*) FROM ${brainLessons} WHERE ${brainLessons.scope} = ${patch.scope.scope} AND ${brainLessons.scopeId} = ${patch.scope.scopeId} AND ${brainLessons.state} = 'candidate') < ${consolidationLimits.openPerScope})`
      : sql`1`;
  const allowed = sql`${notForgotten(patch.scope, patch.since)} AND ${supported} AND ${withinCap}`;
  const atBase = sql`(SELECT ${brainLessons.revision} FROM ${brainLessons} WHERE ${brainLessons.id} = ${patch.lessonId}) = ${patch.base} AND ${allowed}`;
  const thisPatch = sql`EXISTS (SELECT 1 FROM ${brainLessonVersions} WHERE ${brainLessonVersions.patchKey} = ${patchKey})`;
  const evidence = [
    ...patch.content.supporting.map((id) => [id, "supporting"]),
    ...patch.content.contradicting.map((id) => [id, "contradicting"]),
  ];
  const statements = [
    // A new lesson starts at revision 0, before its first version, not yet
    // open (so it doesn't count against its scope's cap until it is): only
    // while its scope may be written and some of its support still exists.
    db
      .insert(brainLessons)
      .select(
        sql`SELECT ${patch.lessonId}, 0, ${patch.scope.scope}, ${patch.scope.scopeId}, ${patch.groupKey}, 'failure_pattern', ${canonicalJson(patch.content.applicability)}, ${canonicalJson(patch.content.exclusions)}, ${patch.content.instruction}, ${patch.content.evidenceStatus}, 'retired', NULL, ${now.getTime()}, ${now.getTime()} WHERE ${allowed} AND EXISTS (SELECT 1 FROM ${brainEpisodes} WHERE ${inList(brainEpisodes.id, patch.content.supporting)})`
      )
      .onConflictDoNothing(),
    db
      .insert(brainLessonVersions)
      .select(
        sql`SELECT ${patch.lessonId}, ${revision}, ${patch.base === 0 ? null : patch.base}, ${content}, ${patchKey}, ${now.getTime()}, NULL, NULL WHERE ${atBase}`
      )
      .onConflictDoNothing(),
    db
      .insert(brainLessonEvidence)
      .select(
        sql`SELECT ${patch.lessonId}, ${revision}, json_extract(held.value, '$[0]'), json_extract(held.value, '$[1]') FROM json_each(${JSON.stringify(evidence)}) AS held WHERE ${thisPatch} AND ${atBase} AND EXISTS (SELECT 1 FROM ${brainEpisodes} WHERE ${brainEpisodes.id} = json_extract(held.value, '$[0]'))`
      )
      .onConflictDoNothing(),
    outboxedWhere(
      brain,
      {
        actor: patch.actor ?? system,
        action:
          patch.state === "retired"
            ? "knowledge.lesson.retired"
            : "knowledge.lesson.proposed",
        target: { type: "lesson", id: patch.lessonId },
        detail: {
          revision,
          supporting: patch.content.supporting.length,
          contradicting: patch.content.contradicting.length,
        },
      },
      sql`${atBase} AND ${thisPatch}`
    ),
    db
      .update(brainLessons)
      .set({
        revision,
        applicability: canonicalJson(patch.content.applicability),
        exclusions: canonicalJson(patch.content.exclusions),
        instruction: patch.content.instruction,
        evidenceStatus: patch.content.evidenceStatus,
        state: patch.state,
        retiredBy: patch.retiredBy,
        updatedAt: now,
      })
      .where(
        and(
          eq(brainLessons.id, patch.lessonId),
          eq(brainLessons.revision, patch.base),
          thisPatch,
          allowed
        )
      ),
  ] as const;
  await auditedBatch(brain.ports, db, statements);
  // This patch's own version, not one another writer put at the same
  // revision: a retirement that lost the race is a conflict, never success.
  const written = await db
    .select({ patchKey: brainLessonVersions.patchKey })
    .from(brainLessonVersions)
    .innerJoin(
      brainLessons,
      and(
        eq(brainLessons.id, brainLessonVersions.lessonId),
        eq(brainLessons.revision, brainLessonVersions.revision)
      )
    )
    .where(
      and(
        eq(brainLessonVersions.lessonId, patch.lessonId),
        eq(brainLessonVersions.revision, revision)
      )
    )
    .get();
  return written?.patchKey === patchKey;
};

/** Whether two contents say the same, with the same evidence. */
const sameContent = (a: LessonContent | undefined, b: LessonContent): boolean =>
  a !== undefined &&
  storedOf(a) === storedOf(b) &&
  canonicalJson(a.supporting) === canonicalJson(b.supporting) &&
  canonicalJson(a.contradicting) === canonicalJson(b.contradicting);

/**
 * Brings the lesson of `scope`'s group `groupKey` up to date with its
 * episodes now, a round at a time against a lesson that moves under it.
 * Returns whether it patched.
 */
const consolidateGroup = async <C>(
  brain: Brain<C>,
  scope: ConsolidationScope,
  groupKey: string,
  taskType: string,
  mayOpen: boolean,
  since: Date
): Promise<boolean> => {
  const lessonId = await lessonIdOf(scopeKeyOf(scope), groupKey);
  for (let round = 0; round < consolidationLimits.roundsPerJob; round += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each round reads what the last left
    const [current, content] = await Promise.all([
      lessonAt(brain, lessonId),
      contentOf(brain, scope, groupKey, taskType),
    ]);
    // Its owner's correction outranks repetition: never patched again.
    if (current?.retiredBy === "owner" || current?.retiredBy === "admin") {
      return false;
    }
    let patch: Patch | undefined;
    if (content === undefined) {
      // Not enough failures (left), erased evidence included: an open
      // candidate is retired; none is opened.
      if (current?.state === "candidate" && current.content !== undefined) {
        patch = {
          lessonId,
          scope,
          groupKey,
          base: current.revision,
          content: current.content,
          state: "retired",
          retiredBy: "evidence",
          since,
        };
      }
    } else if (
      !(
        current?.state === "candidate" && sameContent(current.content, content)
      ) &&
      // Opening one, or reopening a retired one, counts against the
      // scope's open candidates; a patch to an open one doesn't.
      (current?.state === "candidate" || mayOpen)
    ) {
      patch = {
        lessonId,
        scope,
        groupKey,
        base: current?.revision ?? 0,
        content,
        state: "candidate",
        retiredBy: null,
        since,
      };
    }
    if (patch === undefined) {
      return false;
    }
    // oxlint-disable-next-line no-await-in-loop -- as above
    if (await applyPatch(brain, patch)) {
      return true;
    }
  }
  return false;
};

/** What one consolidation job did. */
export interface ConsolidationResult {
  /** New episodes it read. */
  read: number;
  /** Lessons it patched. */
  patched: number;
}

/**
 * Consolidates `scope`'s episodes recorded since its watermark, a bounded
 * number of them: each group they belong to brought up to date, and the
 * scope's open candidates checked against their evidence now. Moves the
 * watermark only forward, after its patches, so a job cut short is made
 * again from the same place and writes nothing twice.
 */
export const consolidate = async <C>(
  brain: Brain<C>,
  scope: ConsolidationScope
): Promise<ConsolidationResult> => {
  const { db } = brain;
  const since = brain.ports.clock();
  const scopeKey = scopeKeyOf(scope);
  const mark = await markOf(brain, scopeKey);
  const fresh = await db
    .select({
      id: brainEpisodes.id,
      taskType: brainEpisodes.taskType,
      versionRefs: brainEpisodes.versionRefs,
      seq: brainEpisodes.seq,
    })
    .from(brainEpisodes)
    .where(and(inScope(scope), afterMark(mark)))
    .orderBy(asc(brainEpisodes.seq))
    .limit(consolidationLimits.episodesPerJob);
  // The scope's open candidates, so one whose evidence was erased is
  // retired even when nothing new arrived in its group.
  const open = await db
    .select({
      groupKey: brainLessons.groupKey,
      applicability: brainLessons.applicability,
    })
    .from(brainLessons)
    .where(
      and(
        eq(brainLessons.scope, scope.scope),
        eq(brainLessons.scopeId, scope.scopeId),
        eq(brainLessons.state, "candidate")
      )
    )
    .limit(consolidationLimits.openPerScope);
  let opened = open.length;
  let patched = 0;
  const done = new Set<string>();
  const run = async (groupKey: string, taskType: string): Promise<void> => {
    done.add(groupKey);
    const mayOpen = opened < consolidationLimits.openPerScope;
    const existed = await lessonAt(brain, await lessonIdOf(scopeKey, groupKey));
    if (
      await consolidateGroup(brain, scope, groupKey, taskType, mayOpen, since)
    ) {
      patched += 1;
      if (existed?.state !== "candidate") {
        opened += 1;
      }
    }
  };
  // New episodes' groups in the order they arrived; the watermark moves to
  // the last episode whose group was brought up to date, so a job that
  // ran out of patches leaves the rest for the next.
  let last: (typeof fresh)[number] | undefined;
  // Whether it brought everything due in the scope up to date.
  let finished = fresh.length < consolidationLimits.episodesPerJob;
  for (const episode of fresh) {
    const groupKey = groupKeyOf(episode.taskType, episode.versionRefs);
    if (!done.has(groupKey)) {
      if (patched >= consolidationLimits.patchesPerJob) {
        finished = false;
        break;
      }
      // oxlint-disable-next-line no-await-in-loop -- one group at a time, bounded
      await run(groupKey, episode.taskType);
    }
    last = episode;
  }
  for (const { groupKey, applicability } of open) {
    if (patched >= consolidationLimits.patchesPerJob) {
      finished = false;
      break;
    }
    if (!done.has(groupKey)) {
      const { taskType } = z
        .object({ taskType: z.string() })
        .parse(JSON.parse(applicability));
      // oxlint-disable-next-line no-await-in-loop -- as above
      await run(groupKey, taskType);
    }
  }
  if (last?.seq !== undefined && last.seq !== null) {
    const now = brain.ports.clock();
    // Not for a person a purge forgot while this job ran: nothing of them
    // is kept, not even where it read to.
    await db
      .insert(brainConsolidationMarks)
      .select(
        sql`SELECT ${scopeKey}, ${last.seq}, ${now.getTime()} WHERE ${notForgotten(scope, since)}`
      )
      .onConflictDoUpdate({
        target: brainConsolidationMarks.scopeKey,
        set: {
          seq: sql`excluded.seq`,
          updatedAt: sql`excluded.updated_at`,
        },
        // Only forward: a job cut short and made again never moves it back.
        setWhere: gt(sql`excluded.seq`, brainConsolidationMarks.seq),
      });
  }
  // Up to date: no longer due, unless something touched it since it began.
  if (finished) {
    await db.delete(brainConsolidationDue).where(
      and(
        eq(brainConsolidationDue.scopeKey, scopeKey),
        lte(brainConsolidationDue.touchedAt, since),
        // And no episode arrived that it didn't read.
        sql`NOT EXISTS (SELECT 1 FROM ${brainEpisodes} WHERE ${and(inScope(scope), afterMark(last?.seq ?? mark))})`
      )
    );
  }
  return { read: fresh.length, patched };
};

/** Lessons one wording pass asks a model to word, at most. */
export const wordingsPerJob = 5;

/**
 * Wording passes one consolidation job makes, at most: as many as it can
 * patch lessons (`patchesPerJob`), so a job words what it patched.
 */
export const wordingPassesPerJob = Math.ceil(
  consolidationLimits.patchesPerJob / wordingsPerJob
);

/** The longest wording kept, in characters. */
export const wordingMaxLength = 500;

/**
 * Control characters (C0, DEL and C1) and Unicode format characters (such
 * as bidirectional overrides and zero-width joiners), which a wording never
 * keeps: it shows as the plain text it reads as.
 */
// oxlint-disable-next-line no-control-regex -- control characters on purpose
const controlCharacters = /[\u0000-\u001F\u007F-\u009F\p{Cf}]+/gu;

/** A model's answer as a lesson keeps it: one line of text, capped. */
const wordingOf = (answer: string): string =>
  answer.replaceAll(controlCharacters, " ").trim().slice(0, wordingMaxLength);

/**
 * One pass of `wordLessons`: how many lessons it asked to word, whether
 * written, failed or refused; how many it worded; and whether the budget
 * refused one, which the next pass would be refused too.
 */
const wordingPass = async <C>(
  brain: Brain<C>,
  scope: ConsolidationScope
): Promise<{ asked: number; worded: number; refused: boolean }> => {
  const { db } = brain;
  const unworded = await db
    .select({
      lessonId: brainLessons.id,
      revision: brainLessons.revision,
      applicability: brainLessons.applicability,
      instruction: brainLessons.instruction,
      evidenceStatus: brainLessons.evidenceStatus,
    })
    .from(brainLessons)
    .innerJoin(
      brainLessonVersions,
      and(
        eq(brainLessonVersions.lessonId, brainLessons.id),
        eq(brainLessonVersions.revision, brainLessons.revision)
      )
    )
    .where(
      and(
        eq(brainLessons.scope, scope.scope),
        eq(brainLessons.scopeId, scope.scopeId),
        eq(brainLessons.state, "candidate"),
        sql`${brainLessonVersions.wordingState} IS NULL`
      )
    )
    .orderBy(asc(brainLessons.updatedAt), asc(brainLessons.id))
    .limit(wordingsPerJob);
  let worded = 0;
  let refused = false;
  for (const lesson of unworded) {
    // oxlint-disable-next-line no-await-in-loop -- one bounded call at a time
    const counts = await db
      .select({ role: brainLessonEvidence.role, count: count() })
      .from(brainLessonEvidence)
      .where(
        and(
          eq(brainLessonEvidence.lessonId, lesson.lessonId),
          eq(brainLessonEvidence.revision, lesson.revision)
        )
      )
      .groupBy(brainLessonEvidence.role);
    const { taskType, versions } = z
      .object({ taskType: z.string(), versions: z.array(z.string()) })
      .parse(JSON.parse(lesson.applicability));
    const facts: LessonFacts = {
      taskType,
      versions,
      failures: counts.find(({ role }) => role === "supporting")?.count ?? 0,
      completions:
        counts.find(({ role }) => role === "contradicting")?.count ?? 0,
      evidenceStatus: lesson.evidenceStatus,
      instruction: lesson.instruction,
    };
    let written: {
      wording: string | null;
      state: "written" | "refused" | "failed";
    };
    try {
      // oxlint-disable-next-line no-await-in-loop -- as above
      const wording = wordingOf(await brain.ports.wordLesson(facts));
      written =
        wording === ""
          ? { wording: null, state: "failed" }
          : { wording, state: "written" };
    } catch (error) {
      written = {
        wording: null,
        state:
          brainErrors.codeOf(error) === "brain.budget_exceeded"
            ? "refused"
            : "failed",
      };
    }
    // oxlint-disable-next-line no-await-in-loop -- as above
    await db
      .update(brainLessonVersions)
      .set({ wording: written.wording, wordingState: written.state })
      .where(
        and(
          eq(brainLessonVersions.lessonId, lesson.lessonId),
          eq(brainLessonVersions.revision, lesson.revision),
          sql`${brainLessonVersions.wordingState} IS NULL`
        )
      );
    if (written.state === "written") {
      worded += 1;
    }
    refused ||= written.state === "refused";
  }
  return { asked: unworded.length, worded, refused };
};

/**
 * Asks the host to word `scope`'s open lessons whose current revision has
 * no wording yet, at most {@link wordingsPerJob}: each from what the lesson
 * holds alone, never a task's content or anyone's identity. The wording is
 * kept beside the lesson's text, never instead of it; a revision is worded
 * once (a job made again finds it worded and asks nothing), and a refusal
 * or failure is kept too, leaving the text as it is. Returns how many it
 * worded.
 */
export const wordLessons = async <C>(
  brain: Brain<C>,
  scope: ConsolidationScope
): Promise<number> => {
  const { worded } = await wordingPass(brain, scope);
  return worded;
};

/** A lesson as its host inspects it: every version, with its evidence. */
export interface Lesson {
  id: string;
  revision: number;
  scope: "person" | "session";
  scopeId: string;
  state: "candidate" | "retired";
  retiredBy: "owner" | "admin" | "evidence" | null;
  versions: {
    revision: number;
    supersedes: number | null;
    content: LessonContent;
    evidence: { episodeId: string; role: "supporting" | "contradicting" }[];
  }[];
}

/**
 * The lessons of `scope`, every version of each with the evidence it
 * still has: the host's own view, for inspection and checks, never a
 * reader's.
 */
export const lessonsOf = async <C>(
  { db }: Brain<C>,
  scope: ConsolidationScope
): Promise<Lesson[]> => {
  const lessons = await db
    .select()
    .from(brainLessons)
    .where(
      and(
        eq(brainLessons.scope, scope.scope),
        eq(brainLessons.scopeId, scope.scopeId)
      )
    )
    .orderBy(asc(brainLessons.createdAt), asc(brainLessons.id));
  if (lessons.length === 0) {
    return [];
  }
  const ids = lessons.map(({ id }) => id);
  const [versions, evidence] = await Promise.all([
    db
      .select()
      .from(brainLessonVersions)
      .where(inList(brainLessonVersions.lessonId, ids))
      .orderBy(asc(brainLessonVersions.revision)),
    db
      .select()
      .from(brainLessonEvidence)
      .where(inList(brainLessonEvidence.lessonId, ids)),
  ]);
  return lessons.map((lesson) => ({
    id: lesson.id,
    revision: lesson.revision,
    scope: lesson.scope,
    scopeId: lesson.scopeId,
    state: lesson.state,
    retiredBy: lesson.retiredBy,
    versions: versions
      .filter(({ lessonId }) => lessonId === lesson.id)
      .flatMap((version) => {
        const held = evidence
          .filter(
            ({ lessonId, revision }) =>
              lessonId === lesson.id && revision === version.revision
          )
          .map(({ episodeId, role }) => ({ episodeId, role }));
        const content = contentFrom(version.content, held);
        // One not of this shape is left out, never shown half read.
        return content === undefined
          ? []
          : [
              {
                revision: version.revision,
                supersedes: version.supersedes,
                content,
                evidence: held,
              },
            ];
      }),
  }));
};

/**
 * Retires the lesson `lessonId` at `expectedRevision` as a person's
 * correction, once its caller decided they may: never patched or recreated
 * after. One that doesn't exist is `brain.not_found`; a stale revision is
 * `brain.revision_conflict`.
 */
export const retireLessonAt = async <C>(
  brain: Brain<C>,
  lessonId: string,
  expectedRevision: number,
  by: { actor: Json; as: "owner" | "admin" }
): Promise<void> => {
  const current = await lessonAt(brain, lessonId);
  const row = await brain.db
    .select({
      scope: brainLessons.scope,
      scopeId: brainLessons.scopeId,
      groupKey: brainLessons.groupKey,
    })
    .from(brainLessons)
    .where(eq(brainLessons.id, lessonId))
    .get();
  if (
    current === undefined ||
    row === undefined ||
    current.content === undefined
  ) {
    throw brainErrors.create("brain.not_found");
  }
  if (current.revision !== expectedRevision) {
    throw brainErrors.create("brain.revision_conflict");
  }
  const moved = await applyPatch(brain, {
    lessonId,
    scope: { scope: row.scope, scopeId: row.scopeId },
    groupKey: row.groupKey,
    base: current.revision,
    content: current.content,
    state: "retired",
    retiredBy: by.as,
    since: brain.ports.clock(),
    actor: by.actor,
  });
  if (!moved) {
    throw brainErrors.create("brain.revision_conflict");
  }
};

/**
 * Retires the lesson `lessonId` at `expectedRevision` as its owner's
 * correction: the person whose own lessons they are (`ownerId`, the host's
 * caller). Never patched or recreated after. A lesson that isn't theirs,
 * or doesn't exist, is `brain.not_found`; a stale revision is
 * `brain.revision_conflict`.
 */
export const retireLesson = async <C>(
  brain: Brain<C>,
  reader: C,
  input: unknown
): Promise<void> => {
  const ownerId = brain.ports.ownerOf(reader);
  const { lessonId, expectedRevision } = brainErrors.parse(
    "brain.invalid",
    z.strictObject({
      lessonId: z.string().min(1).max(128),
      expectedRevision: z.int().min(1),
    }),
    input
  );
  const [own] = await brain.db
    .select({ id: brainLessons.id })
    .from(brainLessons)
    .where(
      and(
        eq(brainLessons.id, lessonId),
        eq(brainLessons.scope, "person"),
        eq(brainLessons.scopeId, ownerId)
      )
    );
  if (own === undefined) {
    throw brainErrors.create("brain.not_found");
  }
  await retireLessonAt(brain, lessonId, expectedRevision, {
    actor: brain.ports.actorOf(reader),
    as: "owner",
  });
};

/**
 * The statements that delete `userId`'s own lessons and consolidation's
 * place in their scope, for a personal purge: a shared session's lessons
 * lose their episodes' evidence with those episodes.
 */
export const forgetPersonLessons = (db: Brain<unknown>["db"], userId: string) =>
  [
    db
      .delete(brainLessons)
      .where(
        and(eq(brainLessons.scope, "person"), eq(brainLessons.scopeId, userId))
      ),
    db
      .delete(brainConsolidationMarks)
      .where(
        eq(
          brainConsolidationMarks.scopeKey,
          scopeKeyOf({ scope: "person", scopeId: userId })
        )
      ),
  ] as const;

/** How many lessons `scope` holds open. */
export const openLessons = async <C>(
  { db }: Brain<C>,
  scope: ConsolidationScope
): Promise<number> => {
  const [row] = await db
    .select({ open: count() })
    .from(brainLessons)
    .where(
      and(
        eq(brainLessons.scope, scope.scope),
        eq(brainLessons.scopeId, scope.scopeId),
        eq(brainLessons.state, "candidate")
      )
    );
  return row?.open ?? 0;
};

/** New episodes that start a job: as many as a lesson needs. */
export const consolidationThreshold = consolidationLimits.minFailures;

const consolidationInputSchema = z.strictObject({
  scope: z.enum(["person", "session"]),
  scopeId: z.string().min(1).max(256),
});

/**
 * The job that consolidates `scope` from where it is now: named by the
 * scope, its watermark and what is due in it, so starting it again before
 * anything changed is the same job, and any new work starts the next.
 */
export const consolidationJob = async <C>(
  brain: Brain<C>,
  scope: ConsolidationScope
): Promise<{ id: string; input: Json }> => {
  const scopeKey = scopeKeyOf(scope);
  const mark = await markOf(brain, scopeKey);
  // What there is to do now: the newest episode not read yet, and when the
  // scope was last marked due. Work that arrives after a job finished, or
  // after a purge cleared its watermark, is a new job, never the old one.
  const [newest] = await brain.db
    .select({ seq: sql<number | null>`max(${brainEpisodes.seq})` })
    .from(brainEpisodes)
    .where(and(inScope(scope), afterMark(mark)));
  const due = await brain.db
    .select({ touchedAt: brainConsolidationDue.touchedAt })
    .from(brainConsolidationDue)
    .where(eq(brainConsolidationDue.scopeKey, scopeKey))
    .get();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      canonicalJson([
        scopeKey,
        mark,
        newest?.seq ?? null,
        due?.touchedAt.getTime() ?? null,
      ])
    )
  );
  return {
    id: `consolidation-${toHex(new Uint8Array(digest)).slice(0, 32)}`,
    input: { scope: scope.scope, scopeId: scope.scopeId },
  };
};

/** How a job's one step retries: a consolidation is safe to make again. */
const consolidationConfig: StepConfig = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
  timeout: 5 * 60_000,
};

/** Runs (or resumes) one consolidation job, as its host's engine runs it. */
export const runConsolidation = async <C>(
  brain: Brain<C>,
  payload: unknown,
  step: IndexStep
): Promise<void> => {
  const scope = consolidationInputSchema.parse(payload);
  await step.do("consolidate", consolidationConfig, async () => {
    const result = await consolidate(brain, scope);
    return { ...result };
  });
  // Its own steps: a wording that fails or is refused never undoes a
  // patch. A bounded pass at a time, until one finds fewer to word than it
  // may (none left) or the budget refuses one, at most as many as it
  // patched. A wording that failed counts as asked, so it never ends the
  // passes before the lessons after it are worded.
  for (let pass = 0; pass < wordingPassesPerJob; pass += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one bounded pass after another
    const passed = await step.do(
      `word-${pass}`,
      consolidationConfig,
      async () => await wordingPass(brain, scope)
    );
    const done = z
      .object({ asked: z.int(), refused: z.boolean() })
      .safeParse(passed);
    if (
      !done.success ||
      done.data.refused ||
      done.data.asked < wordingsPerJob
    ) {
      break;
    }
  }
};
