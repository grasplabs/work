import { isAppLayout } from "@grasp-os/compiler";
import { generatedPaths, generateModules } from "@grasp-os/sdk/host";
import type { AppManifest, WorkflowBindingExtras } from "@grasp-os/sdk/host";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { AppId } from "@grasp-os/shared/ids";

import { filesManifest } from "./app-inspection.ts";
import { boundWorkflowsOf } from "./bound-workflows.ts";

// What an App's screens import as `#grasp` (spec 8, 10.1): the public
// references the host generates from its server code. They are data (each
// function's contract ID, exact fingerprint, kind and argument
// descriptors) and grant nothing: core resolves every call against the
// sealed release that runs and refuses a reference that doesn't match it
// exactly (app-functions.ts).
//
// Generation is deterministic: the same manifest and identity always make
// the same bytes. This module makes them from files as they are, which is
// what a save and a draft's check build (save-builds.ts): nothing of them
// is sealed. A running version's screens get them from its release
// (screen-references.ts).

/** Whether any of `files` names the references, so a build could import them. */
const mentionsReferences = (files: Readonly<Record<string, string>>): boolean =>
  Object.entries(files).some(
    ([path, source]) =>
      (path.startsWith("screens/") || path.startsWith("components/")) &&
      source.includes("#grasp")
  );

/**
 * `files` with the references their screens import as `#grasp`, as
 * `referencesOf` answers them: unchanged when no screen names them, when
 * the files aren't of spec 8's layout, or when there are none (their
 * server code doesn't build or inspect: an expected error). A screen that
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
    : { ...files, [generatedPaths.references]: references };
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
  return Object.hasOwn(generated, generatedPaths.references)
    ? generated[generatedPaths.references]
    : undefined;
};

/**
 * `files` with the references their screens import as `#grasp`, generated
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
 * `files` as saved or drafted, for `app`'s `version` (a draft's base), with
 * the references their own server code generates: inspected as they are,
 * never read from a sealed release, which may hold other code, with the
 * workflows they declare as the App binds them now.
 */
export const withDraftReferences = async (
  env: Env,
  app: AppId,
  version: number,
  files: Record<string, string>,
  /**
   * Given up on (a build job's lease lost): generating them starts no
   * compile nor inspection, and it throws its reason.
   */
  signal?: AbortSignal
): Promise<Record<string, string>> =>
  await withReferencesFrom(app, version, files, async () => {
    const manifest = await filesManifest(env, files, app, signal);
    return {
      manifest,
      workflows: await boundWorkflowsOf(env, app, manifest),
    };
  });
