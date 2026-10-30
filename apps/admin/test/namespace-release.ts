/**
 * A release a client in a Workers for Platforms namespace runs, imported
 * as the admin imports one: only the bindings Workers for Platforms
 * documents for user Workers, core binding its connect through the
 * gateway as the real one does, and no cron triggers. Shared by the
 * admin's tests and the browser journeys' seed.
 */
import type { ReleaseManifest, WorkerEntry } from "@grasp-os/shared/release";

import { releases } from "../src/db/schema.ts";
import { db } from "./hosting.ts";
import { buildRelease, putBlobs } from "./releases.ts";
import type { ReleaseSpec } from "./releases.ts";

/** The binding kinds Workers for Platforms documents for user Workers. */
const documentedForUsers = new Set([
  "d1",
  "r2_bucket",
  "durable_object_namespace",
  "assets",
]);

/** A release a client in the namespace runs, imported; `adjust` changes core. */
export const namespaceRelease = async (
  spec: Partial<ReleaseSpec> = {},
  adjust: (core: WorkerEntry) => WorkerEntry = (core) => core
): Promise<ReleaseManifest> => {
  // Core binds its connect, as the real one does: through the gateway.
  const bindsConnect = (entry: WorkerEntry): WorkerEntry => ({
    ...entry,
    bindings: [
      ...entry.bindings.filter(({ type }) => documentedForUsers.has(type)),
      { type: "service", name: "CONNECT", service: "grasp-os-connect" },
    ],
  });
  const built = await buildRelease({
    notes: "feat(core): checked",
    crons: [],
    ...spec,
  });
  const { core } = built.manifest.workers;
  if (core === undefined) {
    throw new Error("The test release has no core");
  }
  const manifest: ReleaseManifest = {
    ...built.manifest,
    workers: {
      ...built.manifest.workers,
      core: adjust(
        bindsConnect({
          ...core,
          durableObjectMigrations: [
            { tag: "v1", new_sqlite_classes: ["Workspace", "AuditLog"] },
          ],
        })
      ),
    },
  };
  await putBlobs(built);
  const now = new Date();
  await db.insert(releases).values({
    id: manifest.releaseId,
    commitSha: manifest.commit,
    manifest: JSON.stringify(manifest),
    manifestSha256: "0".repeat(64),
    limitEvidence: built.limitEvidenceText ?? null,
    builtAt: now,
    importedAt: now,
  });
  return manifest;
};
