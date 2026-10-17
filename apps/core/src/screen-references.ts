import type { AppId } from "@grasp-os/shared/ids";

import { versionReferenceSource } from "./app-releases.ts";
import { withReferencesFrom } from "./draft-references.ts";

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
