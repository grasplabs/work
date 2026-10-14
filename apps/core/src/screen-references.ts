import type { AppId } from "@grasp-os/shared/ids";

import { versionManifest } from "./app-releases.ts";
import { withReferencesFrom } from "./draft-references.ts";

// The `#grasp` references a version's screens import (draft-references.ts
// says what they are). A version's screens get the very bytes its release
// seals (`sealRelease` generates them from the same manifest and
// identity), sealed or not yet: a sealed version's manifest is read back
// from its release; an unsealed one's comes from inspecting its code as
// sealing would (`versionManifest`). The references become part of the
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
    async () => await versionManifest(env, app, version, files)
  );
