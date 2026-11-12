import { brainErrors } from "@grasp-os/brain/contract";
import { knowledgeErrors } from "@grasp-os/brain/knowledge";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { runBrainEvidence } from "../db/core/schema.ts";

// What a workflow run read from today's Brain stays pinned to the run
// (GRA-299): before the run lets anything leave it, the host checks the
// run may still read it all (resource-reads.ts). A run's steps now recall
// from the new Brain (brain-calls.ts), which pins nothing here, so only
// evidence kept before stays to check, until the cutover (GRA-1735)
// removes today's Brain.

/**
 * Most document refs one run keeps (one per document and binding): far
 * above what a run's recalls cite, so a run past it is recalling in a
 * loop. It is refused further recalls rather than kept growing, and each
 * check before something leaves the run stays one bounded query.
 */
export const runEvidenceMaxRows = 1000;

/** What run `runId` was handed, as its evidence keeps it. */
export const evidenceOf = async (env: Env, runId: string) =>
  await drizzle(env.DB)
    .select({
      documentId: runBrainEvidence.documentId,
      collectionId: runBrainEvidence.collectionId,
      version: runBrainEvidence.version,
      text: runBrainEvidence.pinned,
      permissionId: runBrainEvidence.permissionId,
      recalled: runBrainEvidence.recalled,
    })
    .from(runBrainEvidence)
    .where(eq(runBrainEvidence.runId, runId));

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
