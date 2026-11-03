/**
 * Which blobs each published release names (`release_blobs`): what
 * retention keeps (src/releases/retention.ts). Written when the import
 * reads a release's manifest (src/releases/import.ts), before it's
 * verified, so a release still being imported keeps its blobs too, those
 * of a manifest replaced since included; and,
 * for a release imported before these were kept, by retention itself.
 */
import { blobKeys } from "@grasp-os/shared/release";
import type { ReleaseManifest } from "@grasp-os/shared/release";
import { eq } from "drizzle-orm";

import type { AdminDatabase } from "../db/act.ts";
import { releaseBlobs } from "../db/schema.ts";

/** Rows one insert writes: two parameters each, within D1's hundred. */
const rowsPerInsert = 40;

/**
 * Records the blobs `manifest` names as release `releaseId`'s, in place of
 * any it had: a manifest replaced before its import finished (a broken
 * upload put right) names others. One batch, so a release has all its
 * rows or none, and nothing when they're recorded already.
 */
export const recordBlobs = async (
  db: AdminDatabase,
  releaseId: string,
  manifest: ReleaseManifest
): Promise<void> => {
  const keys = [...new Set(blobKeys(manifest))];
  const known = await db
    .select({ key: releaseBlobs.blobKey })
    .from(releaseBlobs)
    .where(eq(releaseBlobs.releaseId, releaseId));
  const recorded = new Set(known.map(({ key }) => key));
  if (recorded.size === keys.length && keys.every((key) => recorded.has(key))) {
    return;
  }
  const inserts = [];
  for (let at = 0; at < keys.length; at += rowsPerInsert) {
    inserts.push(
      db
        .insert(releaseBlobs)
        .values(
          keys
            .slice(at, at + rowsPerInsert)
            .map((blobKey) => ({ releaseId, blobKey }))
        )
        .onConflictDoNothing()
    );
  }
  await db.batch([
    db.delete(releaseBlobs).where(eq(releaseBlobs.releaseId, releaseId)),
    ...inserts,
  ]);
};
