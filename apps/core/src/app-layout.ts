import { generatedFiles } from "@grasp-os/sdk/definition";
import { appErrors } from "@grasp-os/shared/apps";

// Every version of an App is of the App layout: a config and a schema,
// generated from its definition (app-definition.ts). Only such a version
// seals, so every write that makes one (a commit, a chat's proposed draft,
// an App created or updated from a blueprint) refuses files without them,
// naming what's missing, and nothing downstream has a version that
// publishes unsealed.

/** Refuses with `app.layout_missing` files without the config or the schema. */
export const refuseWithoutLayout = (paths: Iterable<string>): void => {
  const held = new Set(paths);
  const missing = Object.values(generatedFiles).filter(
    (path) => !held.has(path)
  );
  if (missing.length > 0) {
    throw appErrors.create("app.layout_missing", { issues: missing });
  }
};
