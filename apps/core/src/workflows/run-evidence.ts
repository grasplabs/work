import { brainErrors } from "@grasp-os/brain/contract";
import type { MemoryPack } from "@grasp-os/brain/contract";
import { knowledgeErrors } from "@grasp-os/brain/knowledge";
import { d1BrainStore } from "@grasp-os/brain/recall-store";
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
// recalls cite is kept with the run, only ever added to, and before the
// run lets anything leave it (a model call, a connection call, an App
// function call, a decision opened for people, its output), the host
// checks the run may still read them all, as it reads them now, under the
// permission of the binding each came through. A run that lost read of
// something it recalled is refused from then on: its journaled steps still
// hold that text, so no later recall can lift the refusal. Recovery is a
// new run.

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

/**
 * Adds what `pack`, recalled through the binding of `permissionId`, cites
 * to the run's evidence: never replacing, never narrowing. An empty pack
 * adds nothing and clears nothing. Refuses, as `brain.budget_exceeded`
 * and adding nothing, a pack that would take the run past
 * `runEvidenceMaxRows`: counted and added in one statement, so recalls
 * running side by side can't each fit under it and together pass it.
 */
export const recordRunEvidence = async (
  env: Env,
  run: EvidenceRun,
  permissionId: PermissionId,
  pack: MemoryPack
): Promise<void> => {
  const cited = new Map<string, string>();
  for (const ref of pack.sourceVersions) {
    if (ref.kind === "document") {
      cited.set(ref.documentId, ref.collectionId);
    }
  }
  if (cited.size === 0) {
    return;
  }
  const refs = JSON.stringify([...cited]);
  const db = drizzle(env.DB);
  await db
    .insert(runBrainEvidence)
    .select(
      sql`SELECT ${run.runId}, json_extract(cited.value, '$[0]'), json_extract(cited.value, '$[1]'), ${permissionId}, ${Date.now()} FROM json_each(${refs}) AS cited WHERE (SELECT count(*) FROM ${runBrainEvidence} WHERE ${runBrainEvidence.runId} = ${run.runId}) + (SELECT count(*) FROM json_each(${refs}) AS fresh WHERE NOT EXISTS (SELECT 1 FROM ${runBrainEvidence} AS kept WHERE kept.run_id = ${run.runId} AND kept.document_id = json_extract(fresh.value, '$[0]') AND kept.permission_id = ${permissionId})) <= ${runEvidenceMaxRows}`
    )
    .onConflictDoNothing();
  // Every ref kept, now or before: otherwise the cap held it back.
  const [kept] = await db
    .select({ count: sql<number>`count(*)` })
    .from(runBrainEvidence)
    .where(
      and(
        eq(runBrainEvidence.runId, run.runId),
        eq(runBrainEvidence.permissionId, permissionId),
        sql`${runBrainEvidence.documentId} IN (SELECT json_extract(value, '$[0]') FROM json_each(${refs}))`
      )
    );
  if ((kept?.count ?? 0) < cited.size) {
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
 * it may no longer read: under each binding's own `brain` permission, and
 * the App's grants and its person's access, as they are now. A passing
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
