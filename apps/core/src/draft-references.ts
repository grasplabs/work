import { isAppLayout } from "@grasp-os/compiler";
import { generatedPaths, generateModules } from "@grasp-os/sdk/host";
import type { AppManifest } from "@grasp-os/sdk/host";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { AppId } from "@grasp-os/shared/ids";

import { filesManifest } from "./app-inspection.ts";

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
 * `files` with the references their screens import as `#grasp`, generated
 * for `app`'s `version` from the manifest `manifestOf` reads: unchanged
 * when no screen names them, when the files aren't of spec 8's layout, or
 * when their server code doesn't inspect. A screen that imports them then
 * fails its build and says so, and the server build says why.
 */
export const withReferencesFrom = async (
  app: AppId,
  version: number,
  files: Record<string, string>,
  manifestOf: () => Promise<AppManifest | undefined>
): Promise<Record<string, string>> => {
  if (!(mentionsReferences(files) && isAppLayout(files))) {
    return files;
  }
  let manifest: AppManifest | undefined;
  try {
    manifest = await manifestOf();
  } catch (error) {
    if (isExpectedError(error)) {
      return files;
    }
    throw error;
  }
  if (manifest === undefined) {
    return files;
  }
  const generated = await generateModules(manifest, {
    resourceId: app,
    resourceVersion: version,
  });
  const references = generated[generatedPaths.references];
  return references === undefined
    ? files
    : { ...files, [generatedPaths.references]: references };
};

/**
 * `files` as saved or drafted, for `app`'s `version` (a draft's base), with
 * the references their own server code generates: inspected as they are,
 * never read from a sealed release, which may hold other code.
 */
export const withDraftReferences = async (
  env: Env,
  app: AppId,
  version: number,
  files: Record<string, string>
): Promise<Record<string, string>> =>
  await withReferencesFrom(
    app,
    version,
    files,
    async () => await filesManifest(env, files)
  );
