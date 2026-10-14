import { generatedPaths, generateModules } from "@grasp-os/sdk/host";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { AppId } from "@grasp-os/shared/ids";

import { versionManifest } from "./app-releases.ts";

// What an App's screens import as `#grasp` (spec 8, 10.1): the public
// references the host generates from its server code, for the version the
// screens belong to. They are data (each function's contract ID, exact
// fingerprint, kind and argument descriptors) and grant nothing: core
// resolves every call against the sealed release that runs and refuses a
// reference that doesn't match it exactly (app-functions.ts).
//
// Generation is deterministic, so a version's screens get the very bytes
// its release seals (`sealRelease` generates them from the same manifest
// and identity), sealed or not yet: a sealed version's manifest is read
// back from its release; an unsealed one's comes from inspecting its code
// as sealing would (`versionManifest`). The references become part of the
// screen's built code, so the hash an admin approves covers them.

/** Whether any of `files` names the references, so a build could import them. */
const mentionsReferences = (files: Readonly<Record<string, string>>): boolean =>
  Object.entries(files).some(
    ([path, source]) =>
      (path.startsWith("screens/") || path.startsWith("components/")) &&
      source.includes("#grasp")
  );

/**
 * `files` (version `version` of `app`), with the references its screens
 * import as `#grasp` when it is of spec 8's layout and its screens name
 * them. An App whose server code doesn't inspect gets none, and a screen
 * that imports them is told so by the build.
 */
export const withScreenReferences = async (
  env: Env,
  app: AppId,
  version: number,
  files: Record<string, string>
): Promise<Record<string, string>> => {
  if (!mentionsReferences(files)) {
    return files;
  }
  let manifest: Awaited<ReturnType<typeof versionManifest>>;
  try {
    manifest = await versionManifest(env, app, version, files);
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
