/**
 * Which blobs each published release names (`release_blobs`): what
 * retention keeps (src/releases/retention.ts). Written when the import
 * first reads a release's manifest (src/releases/import.ts), before it's
 * verified, so a release still being imported keeps its blobs too; and,
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
 * Records the blobs `manifest` names as release `releaseId`'s, unless
 * they're recorded already: one batch, so a release has all its rows or
 * none.
 */
export const recordBlobs = async (
  db: AdminDatabase,
  releaseId: string,
  manifest: ReleaseManifest
): Promise<void> => {
  const known = await db
    .select({ releaseId: releaseBlobs.releaseId })
    .from(releaseBlobs)
    .where(eq(releaseBlobs.releaseId, releaseId))
    .limit(1);
  const keys = blobKeys(manifest);
  if (known.length > 0 || keys.length === 0) {
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
  const [first, ...rest] = inserts;
  if (first !== undefined) {
    await db.batch([first, ...rest]);
  }
};
