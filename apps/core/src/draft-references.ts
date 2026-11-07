import { isAppLayout, isGeneratedPath } from "@grasp-os/compiler";
import {
  generatedPaths,
  generateModules,
  symbolicModules,
} from "@grasp-os/sdk/host";
import type { AppManifest, WorkflowBindingExtras } from "@grasp-os/sdk/host";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { AppId } from "@grasp-os/shared/ids";

import { filesManifest } from "./app-inspection.ts";
import { boundWorkflowsOf } from "./bound-workflows.ts";
import type { BuildOptions } from "./pages.ts";

// What an App's pages import as `@server/_generated/api` (spec 8, 10.1): the public
// references the host generates from its server code. They are data (each
// function's name, and a mutation's or an action's kind and argument
// descriptors) and grant nothing: core resolves every call by name in the
// release that answers it, the App's current one, refuses a name it
// doesn't hold or a function of another kind, and checks the arguments
// with that function's own validator (app-functions.ts,
// `publicOperationOf`).
//
// Generation is deterministic: the same manifest and identity always make
// the same bytes. This module makes them from files as they are, which is
// what a save and a draft's check build (save-builds.ts): nothing of them
// is sealed. A running version's pages get them from its release
// (page-references.ts).

/** Whether any of `files` names the references, so a build could import them. */
const mentionsReferences = (files: Readonly<Record<string, string>>): boolean =>
  Object.entries(files).some(
    ([path, source]) =>
      path.startsWith("src/") && source.includes("@server/_generated/api")
  );

/**
 * `files` with the references their pages import as `@server/_generated/api`, as
 * `referencesOf` answers them: unchanged when no page names them, when
 * the files aren't of spec 8's layout, or when there are none (their
 * server code doesn't build or inspect: an expected error). A page that
 * imports them then fails its build and says so, and the server build
 * says why.
 */
export const withReferencesText = async (
  files: Record<string, string>,
  referencesOf: () => Promise<string | undefined>
): Promise<Record<string, string>> => {
  if (!(mentionsReferences(files) && isAppLayout(files))) {
    return files;
  }
  let references: string | undefined;
  try {
    references = await referencesOf();
  } catch (error) {
    if (isExpectedError(error)) {
      return files;
    }
    throw error;
  }
  return references === undefined
    ? files
    : { ...files, [generatedPaths.api]: references };
};

/** What references are generated from: a manifest, and its bound workflows. */
export interface ReferenceSource {
  readonly manifest: AppManifest;
  readonly workflows: readonly WorkflowBindingExtras[];
}

/** The references `source` generates for `app`'s `version`, if any. */
const referencesOf = async (
  app: AppId,
  version: number,
  source: ReferenceSource | undefined
): Promise<string | undefined> => {
  const generated =
    source === undefined
      ? {}
      : await generateModules(
          source.manifest,
          { resourceId: app, resourceVersion: version },
          source.workflows
        );
  return Object.hasOwn(generated, generatedPaths.api)
    ? generated[generatedPaths.api]
    : undefined;
};

/**
 * `files` with the references their pages import as `@server/_generated/api`, generated
 * for `app`'s `version` from what `sourceOf` reads (see
 * `withReferencesText`).
 */
export const withReferencesFrom = async (
  app: AppId,
  version: number,
  files: Record<string, string>,
  sourceOf: () => Promise<ReferenceSource | undefined>
): Promise<Record<string, string>> =>
  await withReferencesText(
    files,
    async () => await referencesOf(app, version, await sourceOf())
  );

/** `withReferencesFrom`, for a source read already. */
export const withReferencesOf = async (
  app: AppId,
  version: number,
  files: Record<string, string>,
  source: ReferenceSource | undefined
): Promise<Record<string, string>> =>
  await withReferencesText(
    files,
    async () => await referencesOf(app, version, source)
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
 * `files` as saved or drafted, for `app`'s `version` (a draft's base), with
 * the references their own server code generates, from `inspection`
 * (`inspectDraft`, run only when a page imports them): never read from
 * a sealed release, which may hold other code, with the workflows they
 * declare as the App binds them now.
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
  version: number,
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
        return await referencesOf(app, version, {
          manifest: inspected.manifest,
          workflows: await boundWorkflowsOf(env, app, inspected.manifest),
        });
      } catch (error) {
        if (!isExpectedError(error)) {
          throw error;
        }
      }
    }
    standIn = true;
    return symbolicModules()[generatedPaths.api];
  });
  return { files: withReferences, standIn };
};
