import { canonicalText } from "@grasp-os/shared/json";

import type { AppManifest } from "./app-types.ts";
import { declaredWorkflows } from "./bound-workflows.ts";
import type { WorkflowBindingExtras } from "./bound-workflows.ts";
import {
  pageFunctionsText,
  referencesText,
  serverReferencesText,
} from "./codegen-api.ts";
import type { ServerFunctions } from "./codegen-api.ts";
import {
  contractFingerprints,
  contractsFormatVersion,
  generatedPaths,
} from "./codegen-contracts.ts";
import { dataModelSource, serverModuleSource } from "./codegen-server.ts";

// The modules the host generates for an App, as Convex generates
// `convex/_generated/`:
//
// - `server/_generated/`, part of the App's own files: regenerated on
//   every save, from the App's code and definition alone
//   (`generateServerModules`), never from running the code, so it is the
//   same bytes for the same files and definition. Nothing builds from the
//   copy: a seal generates it again (core's app-releases.ts).
//   - `server.ts` (`@server/_generated/server`): the server constructors
//     and `doc`, specialized to the App's schema and permissions. Its code
//     is the same for every App (`serverModule(schema, config)`); the
//     specialization is in its types, which come from `server/schema.ts`
//     and `grasp.config.ts`.
//   - `dataModel.ts` (`@server/_generated/dataModel`): the data model's
//     types (`Doc`, `Id`, `TableNames`), from the schema too.
//   - `internal.ts` (`@server/_generated/internal`): the `internal` tree,
//     for the App's own server code only.
//   - `api.ts` (`@server/_generated/api`): the public `api`, `workflows`
//     and the permissions its pages use (`permissions.files`,
//     `permissions.links`). What a browser gets: data, with no handler,
//     schema or server code in it.
//
//   `api` and `internal` hold each function's name alone (`{ name }`),
//   the functions each module's syntax declares (`ServerFunctions`):
//   `export const list = query(…)`, `mutation(…)` or `action(…)` in
//   `api`, their `internal…` builders' in `internal`, so no internal
//   function's name reaches a browser. Each is typed per name, from the
//   function's own code (`typeof import("../tasks.ts").list`, imported
//   for its type only): its kind, arguments and answer. Typed per name,
//   never by filtering a module's exports by type (Convex's `FilterApi`),
//   which makes every handler that calls a sibling through `api` or
//   `internal` a circular type. A function registered some other way (an
//   alias of a builder, a wrapper) has no reference, and a seal refuses
//   it (core's app-releases.ts). `workflows` holds each workflow's
//   names, typed as the App's definition declares it
//   (`permission.workflow` in `grasp.config.ts`): printed from the
//   declaration, since a run's, history's and inbox's types are built
//   from its schemas (workflow-functions.ts), which a type-level copy
//   would repeat.
// - `.grasp/`, the host's alone, made as a release is sealed, from its
//   manifest as the host read it (app-manifest.ts):
//   - `functions.ts`: the release's public functions by name, as data
//     (page-functions.ts), built into the pages beside their route tree:
//     what a form checks a submission with and a grid reads its columns
//     from.
//   - `contracts.json`: the App's manifest, each function's fingerprint
//     and the workflow each binding names, canonical: what the
//     release's contract hash covers.

/**
 * `server/_generated/`, by path (`generatedPaths`): from the functions
 * the App's server modules declare (`functions`, read from their syntax)
 * and the permissions its definition declares (`declared`, its
 * workflows, files and links), nothing else.
 */
export const generateServerModules = (
  functions: ServerFunctions,
  declared: Pick<AppManifest, "permissions">
): Record<string, string> => ({
  [generatedPaths.server]: serverModuleSource,
  [generatedPaths.dataModel]: dataModelSource,
  [generatedPaths.internal]: serverReferencesText(functions),
  [generatedPaths.api]: referencesText(
    functions,
    declared,
    declaredWorkflows(declared, [])
  ),
});

/**
 * `.grasp/`, by path (`generatedPaths`), the host's own for a release:
 * from its `manifest` as the host read it (`readAppManifest`) and the
 * workflows the host resolved its workflow bindings to, `bound`
 * (`WorkflowBindingExtras`), which only `contracts.json` seals.
 */
const generateReleaseModules = async (
  manifest: AppManifest,
  bound: readonly WorkflowBindingExtras[] = []
): Promise<Record<string, string>> => {
  const contracts = canonicalText({
    formatVersion: contractsFormatVersion,
    manifest,
    fingerprints: await contractFingerprints(manifest),
    workflows: Object.fromEntries(
      bound.map(({ alias, workflowId }) => [alias, { alias, workflowId }])
    ),
  });
  return {
    [generatedPaths.contracts]: `${contracts}\n`,
    [generatedPaths.functions]: pageFunctionsText(
      manifest,
      declaredWorkflows(manifest, bound)
    ),
  };
};

/**
 * Every module the host generates for a release of an App, by path:
 * `server/_generated/` (`generateServerModules`) and `.grasp/`
 * (`generateReleaseModules`).
 */
export const generateModules = async (
  manifest: AppManifest,
  functions: ServerFunctions,
  bound: readonly WorkflowBindingExtras[] = []
): Promise<Record<string, string>> => ({
  ...generateServerModules(functions, manifest),
  ...(await generateReleaseModules(manifest, bound)),
});
