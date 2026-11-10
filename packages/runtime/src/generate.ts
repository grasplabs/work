import { canonicalText } from "@grasp-os/shared/json";

import type { AppManifest } from "./app-types.ts";
import { declaredWorkflows } from "./bound-workflows.ts";
import type { WorkflowBindingExtras } from "./bound-workflows.ts";
import {
  pageFunctionsText,
  referencesText,
  serverReferencesText,
} from "./codegen-api.ts";
import {
  contractFingerprints,
  contractsFormatVersion,
  generatedPaths,
} from "./codegen-contracts.ts";
import { dataModelSource, serverModuleSource } from "./codegen-server.ts";

// The modules the host generates for an App, as Convex
// generates `convex/_generated/`, from its manifest as the host read it
// (app-manifest.ts):
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
//   (`permissions.files`, `permissions.links`). What a browser gets: data,
//   with no handler, schema or server code in it.
//
//   `api` and `internal` hold each function's name alone, typed from the
//   function's own code (`typeof import("../tasks.ts").list`, imported
//   for its type only), so they depend on the server files' paths and
//   exports' names and nothing of a release. `workflows` holds each
//   workflow's names, typed as the App declares it (`permission.workflow`
//   in `grasp.config.ts`): printed from the declaration, since a run's,
//   history's and inbox's types are built from its schemas
//   (workflow-functions.ts), which a type-level copy would repeat.
// - `.grasp/functions.ts`: the release's public functions by name, as
//   data (page-functions.ts), built into the pages beside their route
//   tree: what a form checks a submission with and a grid reads its
//   columns from.
// - `.grasp/contracts.json`: the App's manifest, each function's
//   fingerprint and the workflow version each binding pinned, canonical:
//   what the release's contract hash covers.
//
// Generation is deterministic: the same manifest (and, for
// `contracts.json`, the same pins) always make the same bytes, so a
// release's artifacts can be compared and reused by their hashes.
/**
 * Every module the host generates for an App, by path (`generatedPaths`),
 * from its `manifest` as the host read it (`readAppManifest`) and the
 * versions the host resolved its workflow bindings to, `bound`
 * (`WorkflowBindingExtras`), which only `contracts.json` seals.
 */
export const generateModules = async (
  manifest: AppManifest,
  bound: readonly WorkflowBindingExtras[] = []
): Promise<Record<string, string>> => {
  const workflows = declaredWorkflows(manifest, bound);
  const contracts = canonicalText({
    formatVersion: contractsFormatVersion,
    manifest,
    fingerprints: await contractFingerprints(manifest),
    workflows: Object.fromEntries(
      workflows.flatMap(({ alias, pinned }) =>
        pinned === undefined ? [] : [[alias, { alias, pinned }]]
      )
    ),
  });
  return {
    [generatedPaths.server]: serverModuleSource,
    [generatedPaths.dataModel]: dataModelSource,
    [generatedPaths.internal]: serverReferencesText(manifest),
    [generatedPaths.api]: referencesText(manifest, workflows),
    [generatedPaths.contracts]: `${contracts}\n`,
    [generatedPaths.functions]: pageFunctionsText(manifest, workflows),
  };
};
