import { canonicalText } from "@grasp-os/shared/json";

import type { AppManifest } from "./app-types.ts";
import {
  checkBoundWorkflows,
  declaredWorkflows,
  sortedListens,
} from "./bound-workflows.ts";
import type { WorkflowBindingExtras } from "./bound-workflows.ts";
import { referencesText, serverReferencesText } from "./codegen-api.ts";
import {
  contractFingerprints,
  contractsFormatVersion,
  generatedPaths,
  workflowFingerprint,
} from "./codegen-contracts.ts";
import type { ReleaseIdentity } from "./codegen-contracts.ts";
import { dataModelSource, serverModuleSource } from "./codegen-server.ts";

// The modules the host generates for an App, as Convex
// generates `convex/_generated/`, from its manifest as the host read it
// (app-manifest.ts), never from its code:
//
// - `server/_generated/server.ts` (`@server/_generated/server`): the
//   server constructors and `doc`, specialized to the App's schema and
//   permissions. Its code is the same for every App
//   (`serverModule(schema, config)`); the specialization is in its types,
//   which come from `server/schema.ts` and `grasp.config.ts`.
// - `server/_generated/dataModel.ts` (`@server/_generated/dataModel`): the
//   data model's types (`Doc`, `Id`, `TableName`), from the schema too.
// - `server/_generated/internal.ts` (`@server/_generated/internal`): the
//   `internal` tree, for the App's own server code only.
// - `server/_generated/api.ts` (`@server/_generated/api`): the public
//   `api`, `workflows` and the permissions its pages use
//   (`permissions.files`, `permissions.links`). What a browser gets: data and
//   types, extracted from descriptors, with no handler, schema or server
//   code in it.
// - `.grasp/contracts.json`: the App's manifest, each function's
//   fingerprint and the workflows it binds with theirs, canonical: what
//   the release's contract hash covers.
//
// Generation is deterministic: the same manifest and identity always
// make the same bytes, so a release's artifacts can be compared and
// reused by their hashes.
/**
 * Every module the host generates for an App, by path (`generatedPaths`),
 * for the release `identity`, from its `manifest` as the host read it
 * (`readAppManifest`) and what the host resolved of the workflows it
 * declares, `bound` (`WorkflowBindingExtras`).
 */
export const generateModules = async (
  manifest: AppManifest,
  identity: ReleaseIdentity,
  bound: readonly WorkflowBindingExtras[] = []
): Promise<Record<string, string>> => {
  const declared = declaredWorkflows(manifest, bound);
  checkBoundWorkflows(declared);
  const workflows = declared.map((workflow) => ({
    ...workflow,
    listens: sortedListens(workflow.listens),
  }));
  const fingerprints = await contractFingerprints(manifest);
  const workflowFingerprints: Record<string, string> = {};
  for (const workflow of workflows) {
    // oxlint-disable-next-line no-await-in-loop -- one digest at a time, as above
    workflowFingerprints[workflow.alias] = await workflowFingerprint(workflow);
  }
  const contracts = canonicalText({
    formatVersion: contractsFormatVersion,
    resourceId: identity.resourceId,
    resourceVersion: identity.resourceVersion,
    manifest,
    fingerprints,
    workflows: Object.fromEntries(
      workflows.map((workflow) => [workflow.alias, workflow])
    ),
    workflowFingerprints,
  });
  return {
    [generatedPaths.server]: serverModuleSource,
    [generatedPaths.dataModel]: dataModelSource,
    [generatedPaths.internal]: serverReferencesText(manifest),
    [generatedPaths.api]: await referencesText(manifest, identity, workflows),
    [generatedPaths.contracts]: `${contracts}\n`,
  };
};
