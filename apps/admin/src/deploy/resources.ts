/**
 * The resources a release needs in a client's account, as its manifest
 * names them (the same in every account) and all in the EU, and whether
 * it sends mail: what provisioning (src/hosting/operation.ts) and Setup
 * read of a release.
 */
import type { ReleaseManifest } from "@grasp-os/shared/release";

import { DeployError } from "./errors.ts";

/** Every D1 database the release's Workers bind, by name, once each. */
export const databaseNames = (manifest: ReleaseManifest): string[] => [
  ...new Set(
    Object.values(manifest.workers).flatMap((worker) =>
      worker.d1Databases.map((database) => database.databaseName)
    )
  ),
];

/**
 * Every R2 bucket the release's Workers bind, by name, once each. The
 * manifest only lets EU buckets through, and this checks it again: a
 * bucket's jurisdiction is set when it's created.
 */
export const bucketNames = (manifest: ReleaseManifest): string[] => {
  const names = new Set<string>();
  for (const worker of Object.values(manifest.workers)) {
    for (const binding of worker.bindings) {
      if (binding.type !== "r2_bucket") {
        continue;
      }
      const { bucket_name: name, jurisdiction } = binding;
      if (typeof name !== "string" || jurisdiction !== "eu") {
        throw new DeployError(
          "bucket_outside_eu",
          `${worker.name} binds ${binding.name} to a bucket outside the EU`
        );
      }
      names.add(name);
    }
  }
  return [...names];
};

/** Whether any of the release's Workers sends mail (a `send_email` binding). */
export const sendsMail = (manifest: ReleaseManifest): boolean =>
  Object.values(manifest.workers).some((worker) =>
    worker.bindings.some(({ type }) => type === "send_email")
  );
