/** Reading imported releases from the admin's database. */
import { releaseManifestSchema } from "@grasp-os/shared/release";
import type { ReleaseManifest } from "@grasp-os/shared/release";
import { desc, eq, sql } from "drizzle-orm";

import type { AdminDatabase } from "../db/act.ts";
import { releases } from "../db/schema.ts";

/** How many releases the list shows: the newest. */
export const RELEASE_LIST_LIMIT = 100;

/** A release as the list shows it. */
export interface ReleaseSummary {
  id: string;
  commitSha: string;
  /** Its release note: the merged pull request's title. */
  notes: string;
  builtAt: Date;
  importedAt: Date;
  /**
   * When its bundle files were deleted, as a release that was never
   * promoted past Edge is after 14 days (src/releases/retention.ts); null
   * while they're kept. Its record stays for good.
   */
  bundleDeletedAt: Date | null;
}

/** A release with its whole manifest. */
interface StoredRelease extends ReleaseSummary {
  manifestSha256: string;
  manifest: ReleaseManifest;
}

/** One Worker of a release, as its page shows it: what deploying it changes. */
export interface WorkerView {
  app: string;
  modules: number;
  /** Its D1 databases' migrations, counted. */
  d1Migrations: number;
  /** Its Durable Object migrations' tags, in order. */
  durableObjectMigrations: string[];
}

/** A release as its page shows it. */
export interface ReleaseView extends ReleaseSummary {
  manifestSha256: string;
  compatibilityDate: string;
  workers: WorkerView[];
}

const summaryColumns = {
  id: releases.id,
  commitSha: releases.commitSha,
  notes: sql<string>`coalesce(json_extract(${releases.manifest}, '$.notes'), '')`,
  builtAt: releases.builtAt,
  importedAt: releases.importedAt,
  bundleDeletedAt: releases.bundleDeletedAt,
};

/**
 * The newest releases, newest first, and the release before the oldest of
 * them, if there is one: the list's last "since" link, and the sign that
 * there are more.
 */
export const listReleases = async (
  db: AdminDatabase
): Promise<{ releases: ReleaseSummary[]; older: ReleaseSummary | null }> => {
  const rows = await db
    .select(summaryColumns)
    .from(releases)
    .orderBy(desc(releases.builtAt), desc(releases.id))
    .limit(RELEASE_LIST_LIMIT + 1);
  return {
    releases: rows.slice(0, RELEASE_LIST_LIMIT),
    older: rows[RELEASE_LIST_LIMIT] ?? null,
  };
};

/** Release `id` with its manifest, or null when it isn't imported. */
const getStoredRelease = async (
  db: AdminDatabase,
  id: string
): Promise<StoredRelease | null> => {
  const [row] = await db
    .select({
      ...summaryColumns,
      manifestSha256: releases.manifestSha256,
      manifest: releases.manifest,
    })
    .from(releases)
    .where(eq(releases.id, id));
  if (row === undefined) {
    return null;
  }
  return {
    ...row,
    manifest: releaseManifestSchema.parse(JSON.parse(row.manifest)),
  };
};

/** Release `id` as its page shows it, or null when it isn't imported. */
export const getRelease = async (
  db: AdminDatabase,
  id: string
): Promise<ReleaseView | null> => {
  const stored = await getStoredRelease(db, id);
  if (stored === null) {
    return null;
  }
  const { manifest, ...release } = stored;
  return {
    ...release,
    compatibilityDate: manifest.compatibilityDate,
    workers: Object.entries(manifest.workers).map(([app, worker]) => ({
      app,
      modules: worker.modules.length,
      d1Migrations: worker.d1Databases.reduce(
        (sum, database) => sum + database.migrations.length,
        0
      ),
      durableObjectMigrations: worker.durableObjectMigrations.map(
        (migration) => migration.tag
      ),
    })),
  };
};
