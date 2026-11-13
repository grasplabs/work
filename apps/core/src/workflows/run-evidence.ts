import { brainErrors } from "@grasp-os/brain/contract";
import { knowledgeErrors } from "@grasp-os/brain/knowledge";
import type { PermissionId } from "@grasp-os/shared/ids";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { runBrainVersions } from "../db/core/schema.ts";

// What a workflow run recalled stays pinned to the run (GRA-299, kept on
// the new Brain by GRA-1731): every version its recalls handed it is kept
// with the run, by its source and number, only ever added to, with the
// permission to read the Brain it came through. Before the run lets
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

/**
 * Most versions one run keeps (one per version and permission): far above
 * what a run's recalls hand it, so a run past it is recalling in a loop.
 * It is refused further recalls rather than kept growing, and each check
 * before something leaves the run stays bounded.
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
    throw brainErrors.create("brain.budget_exceeded");
  }
};

/** What run `runId` was handed, as its evidence keeps it. */
export const evidenceOf = async (env: Env, runId: string) =>
  await drizzle(env.DB)
    .select({
      producer: runBrainVersions.producer,
      sourceId: runBrainVersions.sourceId,
      version: runBrainVersions.version,
      permissionId: runBrainVersions.permissionId,
    })
    .from(runBrainVersions)
    .where(eq(runBrainVersions.runId, runId));

/** Whether `error` is a refusal of access, rather than a passing failure. */
export const isAccessRefusal = (error: unknown): boolean => {
  const brain = brainErrors.codeOf(error);
  const knowledge = knowledgeErrors.codeOf(error);
  return (
    workflowResourceErrors.codeOf(error) === "workflow.call_denied" ||
    brain === "brain.denied" ||
    brain === "brain.not_found" ||
    knowledge === "knowledge.not_found" ||
    permissionErrors.codeOf(error) === "permission.denied"
  );
};
