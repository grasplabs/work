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
 * deployed to it, or could be rolled back to it. Blobs are content-addressed and
 * shared between releases, so only those no kept release names leave.
 *
 * Runs on the admin's cron (src/server.ts), a few releases a run.
 */
import { blobKeys, releaseManifestSchema } from "@grasp-os/shared/release";
import { and, eq, isNull, lt, notInArray, sql } from "drizzle-orm";

import { actIfChanged } from "../db/act.ts";
import type { AdminDatabase } from "../db/act.ts";
import {
  auditEvents,
  channels,
  clientDeploys,
  clientProvisions,
  clients,
  clientWorkers,
  releases,
} from "../db/schema.ts";

/** How long a release never promoted past Edge keeps its bundle. */
export const unpromotedRetentionMs = 14 * 24 * 60 * 60 * 1000;

/** Most releases one run deletes the bundle of. */
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

/**
 * Deletes the bundles of releases never promoted past Edge, imported
 * before `now` less 14 days, that nothing may still deploy: their blobs no
 * kept release names, from `store`, then each release recorded
 * (`bundleDeletedAt`), audited. Returns their ids.
 */
export const deleteExpiredBundles = async (
  db: AdminDatabase,
  store: BundleStore,
  now: Date
): Promise<string[]> => {
  const expired = await db
    .select({ id: releases.id, manifest: releases.manifest })
    .from(releases)
    .where(
      and(
        isNull(releases.bundleDeletedAt),
        lt(
          releases.importedAt,
          new Date(now.getTime() - unpromotedRetentionMs)
        ),
        ...inUse.map((names) => sql`${releases.id} NOT IN (${names})`),
        sql`${releases.id} NOT IN (${promoted})`
      )
    )
    .limit(perRun);
  if (expired.length === 0) {
    return [];
  }
  const going = expired.map(({ id }) => id);
  const kept = await db
    .select({ manifest: releases.manifest })
    .from(releases)
    .where(
      and(isNull(releases.bundleDeletedAt), notInArray(releases.id, going))
    );
  const keep = new Set(
    kept.flatMap(({ manifest }) =>
      blobKeys(releaseManifestSchema.parse(JSON.parse(manifest)))
    )
  );
  const keys = [
    ...new Set(
      expired.flatMap(({ manifest }) =>
        blobKeys(releaseManifestSchema.parse(JSON.parse(manifest)))
      )
    ),
  ].filter((key) => !keep.has(key));
  for (let at = 0; at < keys.length; at += deleteBatch) {
    // oxlint-disable-next-line no-await-in-loop -- one batch at a time
    await store.delete(keys.slice(at, at + deleteBatch));
  }
  const deletedAt = new Date();
  for (const id of going) {
    // oxlint-disable-next-line no-await-in-loop -- one audited record each
    await actIfChanged(
      db,
      "system",
      db
        .update(releases)
        .set({ bundleDeletedAt: deletedAt })
        .where(and(eq(releases.id, id), isNull(releases.bundleDeletedAt))),
      { action: "release.bundle_delete", target: id }
    );
  }
  return going;
};
