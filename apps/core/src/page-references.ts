import { isPageFile } from "@grasp-os/compiler";
import type { AppId } from "@grasp-os/shared/ids";
import { pageErrors } from "@grasp-os/shared/pages";

import {
  isSealed,
  sealedPage,
  versionReferenceSource,
} from "./app-releases.ts";
import { withReferencesFrom } from "./draft-references.ts";
import { versionPages } from "./pages.ts";
import type { BuiltPage } from "./pages.ts";

// The `@server/_generated/api` references a version's pages import (draft-references.ts
// says what they are). A version's pages get the very bytes its release
// seals (`sealRelease` generates them from the same manifest, identity and
// bound workflows), sealed or not yet: a sealed version's manifest and
// bound workflows are read back from its release, so a binding changed
// since changes nothing; an unsealed one's come from inspecting its code
// and reading the App's bindings as sealing would
// (`versionReferenceSource`). The references become part of the
// page's built code, so the hash an admin approves covers them.

/**
 * `files` (version `version` of `app`), with the references its pages
 * import as `@server/_generated/api` when its pages name them. An App whose server code doesn't inspect gets none, and a page
 * that imports them is told so by the build.
 */
export const withPageReferences = async (
  env: Env,
  app: AppId,
  version: number,
  files: Record<string, string>
): Promise<Record<string, string>> =>
  await withReferencesFrom(
    app,
    version,
    files,
    async () => await versionReferenceSource(env, app, version, files)
  );

/**
 * The code of the pages of `app`'s `version` (its `files`), for whoever
 * opens or reviews them. A version with a sealed release gives only what
 * the release sealed (`sealedPage`): never a build, so pages whose sealed
 * bytes are missing are refused, not compiled. One not sealed yet (a
 * version to review before it is made current) has no release: its pages
 * are built (`versionPages`), given `unsealed: "build"`; given `"refuse"`,
 * it is refused as `version.not_sealed`, which is what opening it does.
 */
export const versionPageCodes = async (
  env: Env,
  app: AppId,
  version: number,
  files: Record<string, string>,
  { unsealed }: { unsealed: "build" | "refuse" }
): Promise<BuiltPage> => {
  if (unsealed === "refuse" || (await isSealed(env, app, version))) {
    if (!Object.keys(files).some((path) => isPageFile(path))) {
      throw pageErrors.create("page.not_found");
    }
    return await sealedPage(env, app, version);
  }
  return await versionPages(
    env,
    await withPageReferences(env, app, version, files),
    version,
    app,
    "production"
  );
};
