import { brainErrors } from "@grasp-os/brain/contract";
import type { MemoryPack } from "@grasp-os/brain/contract";
import { knowledgeErrors } from "@grasp-os/brain/knowledge";
import { d1BrainStore } from "@grasp-os/brain/recall-store";
import type { PinnedVersion, VersionRef } from "@grasp-os/brain/recall-store";
import { permissionIdSchema } from "@grasp-os/shared/ids";
import type { AppId, PermissionId, RunId } from "@grasp-os/shared/ids";
import type { Authority } from "@grasp-os/shared/permissions";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { runBrainEvidence } from "../db/core/schema.ts";
import { readAsDelegate } from "../knowledge/binding.ts";
import { brainOf } from "../knowledge/ports.ts";
import { authorize } from "../permissions.ts";

// What a workflow run recalled stays pinned to the run (GRA-299; the threat
// model and its review are on the issue): every document version its
// recalls cite is kept with the run, as its text was, only ever added to,
// and before the run lets anything leave it (a model call, a connection
// call, an App function call, a decision opened for people, its output),
// the host checks the run may still read them all, as it reads them now,
// under the permission of the binding each came through, and that no purge
// rewrote them since. A run that lost read of something it recalled, or
// whose recalled text was purged, is refused from then on: its journaled
// steps still hold that text, so no later recall can lift the refusal.
// Recovery is a new run.
//
// The pins are read just after the recall, in the same read as its
// reader: a purge that lands between the two pins the text as purged.
// The purge's erasure records (GRA-1121) close that, from a mark taken
// before the recall; until they're on main, that gap stays open.

/** The run whose evidence is kept, as the host knows it. */
export interface EvidenceRun {
  runId: RunId;
  app: AppId;
  authority: Authority;
}

/** The run's context, as its reads name it. */
const contextOf = ({ app, runId }: EvidenceRun) =>
  ({ type: "run", appId: app, runId }) as const;

/**
 * Most document refs one run keeps (one per document and binding): far
 * above what a run's recalls cite, so a run past it is recalling in a
 * loop. It is refused further recalls rather than kept growing, and each
 * check before something leaves the run stays one bounded query.
 */
export const runEvidenceMaxRows = 1000;

/** The document versions `pack` cites, each once. */
export const citedVersions = (pack: MemoryPack): VersionRef[] => {
  const cited = new Map<string, VersionRef>();
  for (const ref of pack.sourceVersions) {
    if (ref.kind === "document") {
      const { documentId, collectionId, version } = ref;
      cited.set(JSON.stringify([documentId, version]), {
        documentId,
        collectionId,
        version,
      });
    }
  }
  return [...cited.values()];
};

/**
 * Adds `pins`, the versions a recall through the binding of `permissionId`
 * cited, pinned as their texts were (`pinsOf`, recall-store.ts), to the
 * run's evidence: never replacing, never narrowing. No pins add nothing
 * and clear nothing. Refuses, as `brain.budget_exceeded` and adding
 * nothing, pins that would take the run past `runEvidenceMaxRows`:
 * counted and added in one statement, so recalls running side by side
 * can't each fit under it and together pass it.
 */
export const recordRunEvidence = async (
  env: Env,
  run: EvidenceRun,
  permissionId: PermissionId,
  pins: readonly PinnedVersion[]
): Promise<void> => {
  if (pins.length === 0) {
    return;
  }
  const refs = JSON.stringify(
    pins.map(({ documentId, collectionId, version, text }) => [
      documentId,
      collectionId,
      version,
      text,
    ])
  );
  const db = drizzle(env.DB);
  await db
    .insert(runBrainEvidence)
    .select(
      sql`SELECT ${run.runId}, json_extract(cited.value, '$[0]'), json_extract(cited.value, '$[1]'), json_extract(cited.value, '$[2]'), json_extract(cited.value, '$[3]'), ${permissionId}, ${Date.now()} FROM json_each(${refs}) AS cited WHERE (SELECT count(*) FROM ${runBrainEvidence} WHERE ${runBrainEvidence.runId} = ${run.runId}) + (SELECT count(*) FROM json_each(${refs}) AS fresh WHERE NOT EXISTS (SELECT 1 FROM ${runBrainEvidence} AS kept WHERE kept.run_id = ${run.runId} AND kept.document_id = json_extract(fresh.value, '$[0]') AND kept.version = json_extract(fresh.value, '$[2]') AND kept.permission_id = ${permissionId})) <= ${runEvidenceMaxRows}`
    )
    .onConflictDoNothing();
  // Every pin kept, now or before: otherwise the cap held it back.
  const [kept] = await db
    .select({ count: sql<number>`count(*)` })
    .from(runBrainEvidence)
    .where(
      and(
        eq(runBrainEvidence.runId, run.runId),
        eq(runBrainEvidence.permissionId, permissionId),
        sql`EXISTS (SELECT 1 FROM json_each(${refs}) AS cited WHERE json_extract(cited.value, '$[0]') = ${runBrainEvidence.documentId} AND json_extract(cited.value, '$[2]') = ${runBrainEvidence.version})`
      )
    );
  if ((kept?.count ?? 0) < pins.length) {
    throw brainErrors.create("brain.budget_exceeded");
  }
};

/** Whether `error` is a refusal of access, rather than a passing failure. */
const isAccessRefusal = (error: unknown): boolean => {
  const brain = brainErrors.codeOf(error);
  const knowledge = knowledgeErrors.codeOf(error);
  return (
    brain === "brain.denied" ||
    brain === "brain.not_found" ||
    knowledge === "knowledge.not_found" ||
    permissionErrors.codeOf(error) === "permission.denied"
  );
};

/**
 * Refuses, as `brain.revoked`, anything leaving a run that recalled what
 * it may no longer read, or what a purge rewrote since: under each
 * binding's own `brain` permission, and the App's grants and its person's
 * access, as they are now. A passing
 * failure (the Brain out of reach, say) propagates as itself.
 */
export const requireRunEvidenceReadable = async (
  env: Env,
  run: EvidenceRun
): Promise<void> => {
  const rows = await drizzle(env.DB)
    .select({
      documentId: runBrainEvidence.documentId,
      collectionId: runBrainEvidence.collectionId,
      version: runBrainEvidence.version,
      text: runBrainEvidence.pinned,
      permissionId: runBrainEvidence.permissionId,
    })
    .from(runBrainEvidence)
    .where(eq(runBrainEvidence.runId, run.runId));
  if (rows.length === 0) {
    return;
  }
  const context = contextOf(run);
  try {
    for (const permissionId of new Set(rows.map((row) => row.permissionId))) {
      // oxlint-disable-next-line no-await-in-loop -- one per binding, few
      await authorize(
        env,
        run.authority,
        { type: "platform" },
        "brain",
        permissionIdSchema.parse(permissionId),
        context
      );
    }
    await readAsDelegate(
      env,
      run.authority,
      context,
      undefined,
      async (reader) => {
        await d1BrainStore(brainOf(env)).requireDocumentsReadable(reader, rows);
      }
    );
  } catch (error) {
    if (isAccessRefusal(error)) {
      throw brainErrors.create("brain.revoked");
    }
    throw error;
  }
};
