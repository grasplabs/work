import { isAppLayout, isGeneratedPath } from "@grasp-os/compiler";
import {
  generatedPaths,
  generateModules,
  symbolicModules,
} from "@grasp-os/runtime/host";
import type { AppManifest } from "@grasp-os/runtime/host";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { AppId } from "@grasp-os/shared/ids";

import { serverFunctionsIn } from "./app-definition.ts";
import { filesManifest } from "./app-inspection.ts";
import type { BuildOptions } from "./pages.ts";

// What an App's pages import as `@server/_generated/api` (spec 8, 10.1): the public
// references the host generates from its server code, each function's
// name alone; and beside them `.grasp/functions.ts`, the release's public
// functions as data, which the page runtime gives its client for forms
// and grids (page-functions.ts). Both grant nothing: core resolves every
// call by name in the release that answers it, the App's current one,
// refuses a name it doesn't hold or a function of another kind, and
// checks the arguments with that function's own validator
// (app-functions.ts, `publicOperationOf`).
//
// Generation is deterministic: the same files make the same references
// (from the functions their syntax declares, as every save writes them
// into `server/_generated/`, app-definition.ts), and the same manifest the
// same functions, whatever the App binds: a binding's pin is sealed only
// in `.grasp/contracts.json`, which no page imports. This module makes
// them from files as they are, never from their copy of
// `server/_generated/`, which is what a save and a draft's check build
// (save-builds.ts): nothing of them is sealed. A running version's pages
// get them from its release (page-references.ts).

/** Whether any of `files` names the references, so a build could import them. */
const mentionsReferences = (files: Readonly<Record<string, string>>): boolean =>
  Object.entries(files).some(
    ([path, source]) =>
      path.startsWith("src/") && source.includes("@server/_generated/api")
  );

/**
 * The modules of what the host generates that a page's build holds, by
 * path: the references (`@server/_generated/api`), the `internal` tree
 * the server code their types read imports, and the release's functions
 * (`.grasp/functions.ts`).
 */
export type PageModules = Readonly<Record<string, string>>;

const pageModulePaths: readonly string[] = [
  generatedPaths.api,
  generatedPaths.internal,
  generatedPaths.functions,
];

/** Whether `value` is page modules, as `pageModulesOf` makes them. */
export const isPageModules = (value: unknown): value is PageModules => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entries = Object.entries(value);
  return (
    entries.length === pageModulePaths.length &&
    entries.every(
      ([path, text]) =>
        pageModulePaths.includes(path) && typeof text === "string"
    )
  );
};

/** `generated`'s page modules, or undefined when it has no references. */
export const pageModulesOf = (
  generated: Readonly<Record<string, string>>
): PageModules | undefined => {
  const modules: Record<string, string> = {};
  for (const path of pageModulePaths) {
    const text = Object.hasOwn(generated, path) ? generated[path] : undefined;
    if (text === undefined) {
      return undefined;
    }
    modules[path] = text;
  }
  return modules;
};

/**
 * `files` with the page modules (`PageModules`) as `referencesOf`
 * answers them: unchanged when no page names the references, when the
 * files aren't of spec 8's layout, or when there are none (their server
 * code doesn't build or inspect: an expected error). A page that imports
 * them then fails its build and says so, and the server build says why.
 */
export const withReferencesText = async (
  files: Record<string, string>,
  referencesOf: () => Promise<PageModules | undefined>
): Promise<Record<string, string>> => {
  if (!(mentionsReferences(files) && isAppLayout(files))) {
    return files;
  }
  let references: PageModules | undefined;
  try {
    references = await referencesOf();
  } catch (error) {
    if (isExpectedError(error)) {
      return files;
    }
    throw error;
  }
  return references === undefined ? files : { ...files, ...references };
};

/**
 * The page modules `manifest` and `files`, the code it was inspected
 * from, generate: the references from the functions its syntax declares
 * (app-definition.ts), the release's functions from the manifest.
 */
const referencesOf = async (
  manifest: AppManifest,
  files: Readonly<Record<string, string>>
): Promise<PageModules | undefined> =>
  pageModulesOf(await generateModules(manifest, serverFunctionsIn(files)));

/**
 * `files` with the references their pages import as
 * `@server/_generated/api`, generated from the manifest `manifestOf`
 * reads (see `withReferencesText`).
 */
export const withReferencesFrom = async (
  files: Record<string, string>,
  manifestOf: () => Promise<AppManifest>
): Promise<Record<string, string>> =>
  await withReferencesText(
    files,
    async () => await referencesOf(await manifestOf(), files)
  );

/**
 * How inspecting a draft's server code went (`inspectDraft`): what it
 * registers, or the expected error it was refused with (it doesn't
 * build, its registration threw, or the sandbox ended it).
 */
export type DraftInspection =
  | { readonly manifest: AppManifest }
  | { readonly failed: Error };

/**
 * Inspects the server code of `files` once (`filesManifest`, without
 * whatever they hold under `.grasp/`, which is the host's to generate).
 * A draft's pages and its server check read the same inspection
 * (agent-builds.ts, `checkFiles`), so they can never disagree on whether
 * the server code registered: a sandbox ending one of two inspections
 * would otherwise check the pages against stand-ins while the server
 * passed. Throws what isn't an expected error.
 */
export const inspectDraft = async (
  env: Env,
  app: AppId,
  files: Readonly<Record<string, string>>,
  options?: BuildOptions
): Promise<DraftInspection> => {
  const code = Object.fromEntries(
    Object.entries(files).filter(([path]) => !isGeneratedPath(path))
  );
  try {
    return { manifest: await filesManifest(env, code, app, options) };
  } catch (error) {
    if (error instanceof Error && isExpectedError(error)) {
      return { failed: error };
    }
    throw error;
  }
};

/**
 * `files` as saved or drafted, for `app`, with the references their own
 * server code generates, from `inspection` (`inspectDraft`, run only when
 * a page imports them): never read from a sealed release, which may hold
 * other code.
 *
 * While that server code doesn't build or register (an expected error),
 * its pages import the symbolic stand-ins inspection loads, typed
 * permissively (`symbolicModules`), and `standIn` says so: the server
 * build names the one reason, and a page is checked for everything else
 * rather than failing on each import of `@server/_generated/api`. Checked against
 * stand-ins, a page is never passed (agent-builds.ts, `buildPassed`).
 */
export const withDraftReferences = async (
  env: Env,
  app: AppId,
  files: Record<string, string>,
  /** Its build profile: `preview` for a chat's draft. */
  options?: BuildOptions,
  inspection: () => Promise<DraftInspection> = async () =>
    await inspectDraft(env, app, files, options)
): Promise<{ files: Record<string, string>; standIn: boolean }> => {
  let standIn = false;
  const withReferences = await withReferencesText(files, async () => {
    const inspected = await inspection();
    if ("manifest" in inspected) {
      try {
        return await referencesOf(inspected.manifest, files);
      } catch (error) {
        if (!isExpectedError(error)) {
          throw error;
        }
      }
    }
    standIn = true;
    return pageModulesOf(symbolicModules());
  });
  return { files: withReferences, standIn };
};
