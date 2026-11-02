import { canonicalJson } from "@grasp-os/shared/json";

import type { BuiltinBlueprint } from "#blueprints";

// What the release's fingerprint (builtins.ts) holds of its built-in
// blueprints: the SHA-256 of this text, which the build works out once
// (build-blueprints.ts) and embeds as `#blueprints-digest`. Core then
// fingerprints a release without loading the blueprints, so an isolate
// never reads them unless it installs them.

/** The text whose SHA-256 is the blueprints' digest: what the install writes. */
export const blueprintsDigestText = (
  blueprints: readonly BuiltinBlueprint[]
): string =>
  canonicalJson(
    blueprints.map(
      ({
        id,
        name,
        description,
        collections,
        permissions,
        contracts,
        workflows,
        files,
      }) => ({
        id,
        name,
        description,
        collections: [...collections],
        permissions: [...permissions],
        contracts: [...contracts],
        workflows: [...workflows],
        files: { ...files },
      })
    )
  );
