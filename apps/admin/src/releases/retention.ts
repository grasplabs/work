/**
 * How long a release's bundle stays in the releases bucket: for good once
 * it was promoted past Edge, and 14 days otherwise. Only the bundle files
 * go, never the record: a release's id, commit, timestamps and the
 * channels it was on stay in the admin for good, and the release can be
 * built again from its commit. Its manifest stays in the bucket too, so the
 * id CI claimed is never claimed again.
 *
 * A bundle stays, whatever its age, while anything may still deploy it:
 * a channel points at it, a client runs it, is pinned to it, is being
 * deployed to it, or could be rolled back to it. A release is claimed for
 * deletion (`bundleDeletedAt`) by one write that checks all of that, and
 * pins and promotions write only while a release isn't claimed
 * (src/rollout/channels.ts), so of the two that race, one wins.
 *
 * Blobs are content-addressed and shared between releases, so a claimed
 * release's blob leaves only once no other release names it that still
 * keeps its bundle, or that is still being imported (`release_blobs`,
 * src/releases/blobs.ts): an indexed look-up per release, never a read of
 * every manifest. A claimed release's references go once its blobs are
 * deleted, so one whose deletion stopped part way is finished next run.
 *
 * Runs on the admin's cron (src/server.ts), a few releases a run, only
 * once the import has read every release published (`caughtUp`).
 */
import { releaseManifestSchema } from "@grasp-os/shared/release";
import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";

import { actIfChanged } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import {
  auditEvents,
  channels,
  clientDeploys,
  clientProvisions,
  clients,
  clientWorkers,
  releaseBlobs,
  releases,
} from "../db/schema.ts";
import { recordBlobs } from "./blobs.ts";

/** How long a release never promoted past Edge keeps its bundle. */
export const unpromotedRetentionMs = 14 * 24 * 60 * 60 * 1000;

/** Most releases one run claims, deletes the blobs of, or records the blobs of. */
const perRun = 5;

/** Most keys one R2 delete takes. */
const deleteBatch = 1000;

/** The releases bucket, as retention uses it. */
export type BundleStore = Pick<R2Bucket, "delete">;

/**
 * Each place that names a release something may still deploy, as SQL
 * subqueries: what retention keeps. Separate conditions, as D1 caps the
 * terms of one compound SELECT.
 */
const inUse = [
  sql`SELECT ${channels.releaseId} FROM ${channels}`,
  sql`SELECT ${clients.pinnedReleaseId} FROM ${clients} WHERE ${clients.pinnedReleaseId} IS NOT NULL`,
  sql`SELECT ${clientWorkers.releaseId} FROM ${clientWorkers} WHERE ${clientWorkers.releaseId} IS NOT NULL`,
  sql`SELECT ${clientProvisions.releaseId} FROM ${clientProvisions}`,
  sql`SELECT ${clientProvisions.previousReleaseId} FROM ${clientProvisions} WHERE ${clientProvisions.previousReleaseId} IS NOT NULL`,
  sql`SELECT ${clientDeploys.releaseId} FROM ${clientDeploys}`,
];

/** Every release that was ever Beta's or Stable's, as SQL. */
const promoted = sql`
  SELECT ${auditEvents.target} FROM ${auditEvents}
  WHERE ${auditEvents.action} = 'channel.promote'
    AND json_extract(${auditEvents.detail}, '$.channel') IN ('beta', 'stable')`;

/** Whether a release may lose its bundle as of `cutoff`, as one SQL condition. */
const expiredBy = (cutoff: Date) =>
  and(
    isNull(releases.bundleDeletedAt),
    lt(releases.importedAt, cutoff),
    ...inUse.map((names) => sql`${releases.id} NOT IN (${names})`),
    sql`${releases.id} NOT IN (${promoted})`
  );

/**
 * Records the blobs of kept releases whose blobs aren't on record yet,
 * `perRun` of them: those imported before the import kept them. Returns
 * whether any may be left, when nothing may be deleted yet.
 */
const recordMissing = async (db: AdminDatabase): Promise<boolean> => {
  const missing = await db
    .select({ id: releases.id, manifest: releases.manifest })
    .from(releases)
    .where(
      and(
        isNull(releases.bundleDeletedAt),
        sql`NOT EXISTS (SELECT 1 FROM ${releaseBlobs} WHERE ${releaseBlobs.releaseId} = ${releases.id})`
      )
    )
    .limit(perRun);
  for (const { id, manifest } of missing) {
    // oxlint-disable-next-line no-await-in-loop -- one release at a time
    await recordBlobs(
      db,
      id,
      releaseManifestSchema.parse(JSON.parse(manifest))
    );
  }
  return missing.length === perRun;
};

/**
 * Claims each release that may lose its bundle as of `now`, `perRun` of
 * them, audited: one write each, which checks again that nothing may
 * deploy it. Returns those claimed.
 */
const claimExpired = async (
  db: AdminDatabase,
  now: Date
): Promise<string[]> => {
  const cutoff = new Date(now.getTime() - unpromotedRetentionMs);
  const candidates = await db
    .select({ id: releases.id })
    .from(releases)
    .where(expiredBy(cutoff))
    .limit(perRun);
  const claimed: string[] = [];
  for (const { id } of candidates) {
    // oxlint-disable-next-line no-await-in-loop -- one audited claim each
    const won = await actIfChanged(
      db,
      "system",
      db
        .update(releases)
        .set({ bundleDeletedAt: new Date() })
        .where(and(eq(releases.id, id), expiredBy(cutoff))),
      { action: "release.bundle_delete", target: id }
    );
    if (won) {
      claimed.push(id);
    }
  }
  return claimed;
};

/**
 * Deletes from `store` the blobs of claimed releases that no other
 * release keeping its bundle, or still being imported, names, `perRun`
 * releases of them; then their references.
 */
const deleteClaimedBlobs = async (
  db: AdminDatabase,
  store: BundleStore
): Promise<void> => {
  const claimed = await db
    .selectDistinct({ id: releaseBlobs.releaseId })
    .from(releaseBlobs)
    .innerJoin(releases, eq(releases.id, releaseBlobs.releaseId))
    .where(isNotNull(releases.bundleDeletedAt))
    .limit(perRun);
  for (const { id } of claimed) {
    // oxlint-disable-next-line no-await-in-loop -- one release at a time
    const rows = await db
      .select({ key: releaseBlobs.blobKey })
      .from(releaseBlobs)
      .where(
        and(
          eq(releaseBlobs.releaseId, id),
          sql`NOT EXISTS (SELECT 1 FROM ${releaseBlobs} AS other LEFT JOIN ${releases} AS kept ON kept.id = other.release_id WHERE other.blob_key = ${releaseBlobs.blobKey} AND other.release_id <> ${id} AND kept.bundle_deleted_at IS NULL)`
        )
      );
    const keys = rows.map(({ key }) => key);
    for (let at = 0; at < keys.length; at += deleteBatch) {
      // oxlint-disable-next-line no-await-in-loop -- one batch at a time
      await store.delete(keys.slice(at, at + deleteBatch));
    }
    // oxlint-disable-next-line no-await-in-loop -- one release at a time
    await db.delete(releaseBlobs).where(eq(releaseBlobs.releaseId, id));
  }
};

/**
 * Deletes the bundles of releases never promoted past Edge, imported
 * before `now` less 14 days, that nothing may still deploy: each claimed
 * (`bundleDeletedAt`), audited, then its blobs no other release still
 * needs deleted from `store`. Nothing while a kept release's blobs aren't
 * on record yet. Returns the releases claimed.
 */
export const deleteExpiredBundles = async (
  db: AdminDatabase,
  store: BundleStore,
  now: Date
): Promise<string[]> => {
  if (await recordMissing(db)) {
    return [];
  }
  const claimed = await claimExpired(db, now);
  await deleteClaimedBlobs(db, store);
  return claimed;
};
