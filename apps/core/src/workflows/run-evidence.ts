import { brainErrors } from "@grasp-os/brain/contract";
import type { MemoryPack } from "@grasp-os/brain/contract";
import { knowledgeErrors } from "@grasp-os/brain/knowledge";
import { d1BrainStore } from "@grasp-os/brain/recall-store";
import { permissionIdSchema } from "@grasp-os/shared/ids";
import type { AppId, PermissionId, RunId } from "@grasp-os/shared/ids";
import type { Authority } from "@grasp-os/shared/permissions";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { eq, sql } from "drizzle-orm";
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
 * Adds what `pack`, recalled through the binding of `permissionId`, cites
 * to the run's evidence: never replacing, never narrowing. An empty pack
 * adds nothing and clears nothing.
 */
export const recordRunEvidence = async (
  env: Env,
  run: EvidenceRun,
  permissionId: PermissionId,
  pack: MemoryPack
): Promise<void> => {
  const refs = pack.sourceVersions.flatMap((ref) =>
    ref.kind === "document" ? [[ref.documentId, ref.collectionId]] : []
  );
  if (refs.length === 0) {
    return;
  }
  await drizzle(env.DB)
    .insert(runBrainEvidence)
    .select(
      sql`SELECT ${run.runId}, json_extract(cited.value, '$[0]'), json_extract(cited.value, '$[1]'), ${permissionId}, ${Date.now()} FROM json_each(${JSON.stringify(refs)}) AS cited WHERE 1`
    )
    .onConflictDoNothing();
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
