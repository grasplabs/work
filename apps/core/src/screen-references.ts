import { isAppLayout } from "@grasp-os/compiler";
import type { AppId } from "@grasp-os/shared/ids";
import { screenErrors, screenNameSchema } from "@grasp-os/shared/screens";

import {
  isSealed,
  sealedScreen,
  versionReferenceSource,
} from "./app-releases.ts";
import { withReferencesFrom } from "./draft-references.ts";
import { versionScreens } from "./screens.ts";
import type { VersionScreens } from "./screens.ts";

// The `#grasp` references a version's screens import (draft-references.ts
// says what they are). A version's screens get the very bytes its release
// seals (`sealRelease` generates them from the same manifest, identity and
// bound workflows), sealed or not yet: a sealed version's manifest and
// bound workflows are read back from its release, so a binding changed
// since changes nothing; an unsealed one's come from inspecting its code
// and reading the App's bindings as sealing would
// (`versionReferenceSource`). The references become part of the
// screen's built code, so the hash an admin approves covers them.

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
): Promise<Record<string, string>> =>
  await withReferencesFrom(
    app,
    version,
    files,
    async () => await versionReferenceSource(env, app, version, files)
  );

/**
 * The code of the screens of `app`'s `version` (its `files`), for whoever
 * opens or reviews them. A version of spec 8's layout with a sealed
 * release gives only what the release sealed (`sealedScreen`): never a
 * build, so a screen whose sealed bytes are missing is refused, not
 * compiled. A version of the earlier layout has no release to seal them
 * in, and one not sealed yet (a version to review before it is made
 * current) has none either: they are built (`versionScreens`), given
 * `unsealed: "build"`; given `"refuse"`, an unsealed version of spec 8's
 * layout is refused as `version.not_sealed`, which is what opening it
 * does.
 */
export const versionScreenCodes = async (
  env: Env,
  app: AppId,
  version: number,
  files: Record<string, string>,
  { unsealed }: { unsealed: "build" | "refuse" }
): Promise<VersionScreens> => {
  if (
    isAppLayout(files) &&
    (unsealed === "refuse" || (await isSealed(env, app, version)))
  ) {
    return async (screen) => {
      const name = screenErrors.parse(
        "screen.invalid",
        screenNameSchema,
        screen
      );
      if (!Object.hasOwn(files, `screens/${name}.tsx`)) {
        throw screenErrors.create("screen.not_found");
      }
      return await sealedScreen(env, app, version, name);
    };
  }
  return await versionScreens(
    env,
    await withScreenReferences(env, app, version, files),
    version,
    app
  );
};
