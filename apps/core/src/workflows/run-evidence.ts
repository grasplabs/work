import type { PermissionId } from "@grasp-os/shared/ids";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import {
  runBrainMemories,
  runBrainVersions,
  runStateWriters,
} from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";

// What a workflow run recalled stays pinned to the run (GRA-299, kept on
// the new Brain by GRA-1731): every version its recalls handed it, and
// every skill version it selected or read (GRA-1830), is kept with the
// run, by its source and number, only ever added to, with the permission
// to read the Brain it came through. Before the run lets
// anything leave it (a model call, a connection call, an App function
// call, a decision opened for people, its output), the host checks the
// run may still read them all (resource-reads.ts): each permission still
// the run's, and each version still one the whole company may read, as
// its recalls read them (brain-recall.ts). A run that
// lost read of something it recalled is refused from then on: its
// journaled steps still hold that text, so no later recall can lift the
// refusal. Recovery is a new run.
//
// A version never changes, and an erased source's key is never added
// again, so a pin means the same text for as long as it is kept; an
// erased one is no longer readable, and refuses the run as a revoked one
// does.
//
// What its entity reads handed it rests on memories too, and a person's
// erasure takes memories (their card, their word: GRA-1985), while the
// documents they were drawn from stay. So every memory an entity read
// rests on (the Brain's `restsOnMemories`) is kept with the run as well,
// by id (`runBrainMemories`), and checked the same way: still one the
// company may read and its writer hasn't retired, as a chat's history
// checks it. No bound of its own: the check pages through them, 500 a
// Brain call.

/**
 * Most versions one run keeps (one per version and permission). A recall's
 * pack keeps one per passage it hands on; a page of entities up to about
 * 300, and a card about 200, when every memory has a source of its own. So a run that loops over
 * entities' cards reaches it in a handful of calls. Past it, a run is
 * refused what would add more (`brain.budget_exceeded`) rather than kept
 * growing, so each check before something leaves the run stays bounded.
 */
export const runEvidenceMaxRows = 1000;

/**
 * Adds `versions`, handed to run `runId` through the permission
 * `permissionId`, to the run's evidence: never replacing, never narrowing.
 * No versions add nothing. Refuses, as `brain.budget_exceeded` and adding
 * nothing, versions that would take the run past `runEvidenceMaxRows`:
 * counted and added in one statement, so recalls running side by side
 * can't each fit under it and together pass it.
 */
export const recordRunVersions = async (
  env: Env,
  runId: string,
  permissionId: PermissionId,
  versions: readonly {
    readonly source: { readonly producer: string; readonly id: string };
    readonly version: number;
  }[]
): Promise<void> => {
  const unique = [
    ...new Map(
      versions.map(({ source, version }) => [
        JSON.stringify([source.producer, source.id, version]),
        [source.producer, source.id, version] as const,
      ])
    ).values(),
  ];
  if (unique.length === 0) {
    return;
  }
  const refs = JSON.stringify(unique);
  const db = drizzle(env.DB);
  await db
    .insert(runBrainVersions)
    .select(
      sql`SELECT ${runId}, json_extract(handed.value, '$[0]'), json_extract(handed.value, '$[1]'), json_extract(handed.value, '$[2]'), ${permissionId}, ${Date.now()} FROM json_each(${refs}) AS handed WHERE (SELECT count(*) FROM ${runBrainVersions} WHERE ${runBrainVersions.runId} = ${runId}) + (SELECT count(*) FROM json_each(${refs}) AS fresh WHERE NOT EXISTS (SELECT 1 FROM ${runBrainVersions} AS kept WHERE kept.run_id = ${runId} AND kept.producer = json_extract(fresh.value, '$[0]') AND kept.source_id = json_extract(fresh.value, '$[1]') AND kept.version = json_extract(fresh.value, '$[2]') AND kept.permission_id = ${permissionId})) <= ${runEvidenceMaxRows}`
    )
    .onConflictDoNothing();
  // Every version kept, now or before: otherwise the cap held it back.
  const [kept] = await db
    .select({ count: sql<number>`count(*)` })
    .from(runBrainVersions)
    .where(
      and(
        eq(runBrainVersions.runId, runId),
        eq(runBrainVersions.permissionId, permissionId),
        sql`EXISTS (SELECT 1 FROM json_each(${refs}) AS handed WHERE json_extract(handed.value, '$[0]') = ${runBrainVersions.producer} AND json_extract(handed.value, '$[1]') = ${runBrainVersions.sourceId} AND json_extract(handed.value, '$[2]') = ${runBrainVersions.version})`
      )
    );
  if ((kept?.count ?? 0) < unique.length) {
    throw workflowResourceErrors.create("brain.budget_exceeded");
  }
};

/**
 * The query of what the runs `ofRuns` picks (a condition on the run's ID
 * column) were handed, as their evidence keeps it: for a caller that
 * reads it in one batch with what names them (workflow-state.ts).
 */
export const versionEvidenceQuery = (
  db: DrizzleD1Database,
  ofRuns: (runId: typeof runBrainVersions.runId) => SQL | undefined
) =>
  db
    .select({
      runId: runBrainVersions.runId,
      producer: runBrainVersions.producer,
      sourceId: runBrainVersions.sourceId,
      version: runBrainVersions.version,
      permissionId: runBrainVersions.permissionId,
    })
    .from(runBrainVersions)
    .where(ofRuns(runBrainVersions.runId));

/** What each of runs `runIds` was handed, as their evidence keeps it. */
export const evidenceOfRuns = async (env: Env, runIds: readonly string[]) =>
  await versionEvidenceQuery(drizzle(env.DB), (runId) => inList(runId, runIds));

/**
 * Adds `memories` (of the shared store), what an entity read handed run
 * `runId` through the permission `permissionId` rests on, to the run's
 * evidence: never replacing, never narrowing. One statement however many,
 * the list bound as one JSON value. No memories add nothing.
 */
export const recordRunMemories = async (
  env: Env,
  runId: string,
  permissionId: PermissionId,
  memories: readonly string[]
): Promise<void> => {
  const unique = [...new Set(memories)];
  if (unique.length === 0) {
    return;
  }
  await drizzle(env.DB)
    .insert(runBrainMemories)
    .select(
      sql`SELECT ${runId}, handed.value, ${permissionId}, ${Date.now()} FROM json_each(${JSON.stringify(unique)}) AS handed WHERE true`
    )
    .onConflictDoNothing();
};

/** `versionEvidenceQuery` for what entity reads rested on. */
export const memoryEvidenceQuery = (
  db: DrizzleD1Database,
  ofRuns: (runId: typeof runBrainMemories.runId) => SQL | undefined
) =>
  db
    .select({
      runId: runBrainMemories.runId,
      memoryId: runBrainMemories.memoryId,
      permissionId: runBrainMemories.permissionId,
    })
    .from(runBrainMemories)
    .where(ofRuns(runBrainMemories.runId));

/**
 * What the entity reads of each of runs `runIds` rested on, as their
 * evidence keeps it.
 */
export const memoryEvidenceOfRuns = async (
  env: Env,
  runIds: readonly string[]
) =>
  await memoryEvidenceQuery(drizzle(env.DB), (runId) => inList(runId, runIds));

/**
 * Whether run `runId` keeps any evidence of what it read: a version its
 * recalls were handed, a memory its entity reads rested on (GRA-1985), or
 * what the chat that started it had read (`runChatSources`); or so does
 * a run whose kept state it started from (`runStateWriters`, one hop).
 * What it returned may then copy what can later be erased or narrowed, so
 * the Brain keeps only how it ended (brain-sources.ts, GRA-1996). One
 * statement.
 */
export const readAnything = async (
  env: Env,
  runId: string
): Promise<boolean> => {
  const [row] = await drizzle(env.DB).all<{ read: number }>(
    sql`WITH read_by(id) AS (SELECT ${runId}
        UNION SELECT writer_run_id FROM run_state_writers WHERE run_id = ${runId})
      SELECT (EXISTS (SELECT 1 FROM run_brain_versions WHERE run_id IN (SELECT id FROM read_by))
      OR EXISTS (SELECT 1 FROM run_brain_memories WHERE run_id IN (SELECT id FROM read_by))
      OR EXISTS (SELECT 1 FROM run_chat_sources WHERE run_id IN (SELECT id FROM read_by))) AS read`
  );
  return row?.read === 1;
};

/**
 * The runs whose keys each of runs `runIds` started from
 * (`runStateWriters`, GRA-1996): one statement, the list bound as one
 * value.
 */
export const stateWritersOfRuns = async (env: Env, runIds: readonly string[]) =>
  await drizzle(env.DB)
    .select({
      runId: runStateWriters.runId,
      writerRunId: runStateWriters.writerRunId,
    })
    .from(runStateWriters)
    .where(inList(runStateWriters.runId, runIds));
