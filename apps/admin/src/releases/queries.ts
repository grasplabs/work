/** Reading imported releases from the admin's database. */
import { releaseManifestSchema } from "@grasp-os/shared/release";
import type { ReleaseManifest } from "@grasp-os/shared/release";
import { and, count, desc, eq, gt, lte, sql } from "drizzle-orm";

import type { AdminDatabase } from "../db/act.ts";
import { releases } from "../db/schema.ts";
import { diffReleases } from "./diff.ts";
import type { ReleaseDiff } from "./diff.ts";

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
  /** Its version (src/releases/version.ts); null for one imported before versions. */
  versionMajor: number | null;
  versionMinor: number | null;
}

/** A release with its whole manifest. */
interface StoredRelease extends ReleaseSummary {
  manifestSha256: string;
  manifest: ReleaseManifest;
}

/** One Worker of a release, as its page shows it. */
export interface WorkerView {
  app: string;
  name: string;
  mainModule: string;
  compatibilityFlags: string[];
  crons: string[];
  requiredSecrets: string[];
  /** Their tags, in order. */
  durableObjectMigrations: string[];
  modules: { name: string; type: string; size: number; sha256: string }[];
  d1Databases: {
    binding: string;
    databaseName: string;
    /** Their file names, in order. */
    migrations: string[];
  }[];
  assetCount: number;
}

/** A release as its page shows it. */
export interface ReleaseView extends ReleaseSummary {
  manifestSha256: string;
  compatibilityDate: string;
  wranglerVersion: string;
  packages: Record<string, string>;
  workers: WorkerView[];
}

const summaryColumns = {
  id: releases.id,
  commitSha: releases.commitSha,
  notes: sql<string>`coalesce(json_extract(${releases.manifest}, '$.notes'), '')`,
  builtAt: releases.builtAt,
  importedAt: releases.importedAt,
};

/** A release's version (src/releases/version.ts). */
export interface ReleaseVersion {
  versionMajor: number;
  versionMinor: number;
}

/**
 * The versions of releases `ids`, by id, counted over every imported
 * release in the order they were built (src/releases/version.ts): each
 * feature starts the next major at .0, anything else is the next minor,
 * and those before the first feature are v0.1 onwards. Only each
 * release's flag is read, never a manifest. A release missing from the
 * answer isn't imported.
 */
export const versionsOf = async (
  db: AdminDatabase,
  ids: readonly string[]
): Promise<Map<string, ReleaseVersion>> => {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) {
    return new Map();
  }
  const rows = await db.all<{ id: string; major: number; minor: number }>(sql`
    WITH ordered AS (
      SELECT id, coalesce(feature, 0) AS feature,
        row_number() OVER (ORDER BY built_at, id) AS n
      FROM releases
    ), majored AS (
      SELECT id, n, sum(feature) OVER (ORDER BY n) AS major FROM ordered
    ), versioned AS (
      SELECT id, major,
        n - min(n) OVER (PARTITION BY major) + CASE WHEN major = 0 THEN 1 ELSE 0 END AS minor
      FROM majored
    )
    -- Filtered only once every release is counted, and the ids as one
    -- JSON parameter: D1 binds at most 100.
    SELECT id, major, minor FROM versioned
    WHERE id IN (SELECT value FROM json_each(${JSON.stringify(wanted)}))`);
  return new Map(
    rows.map(({ id, major, minor }) => [
      id,
      { versionMajor: major, versionMinor: minor },
    ])
  );
};

/** `rows`, each with its version; null for one not imported. */
const withVersions = async <T extends { id: string }>(
  db: AdminDatabase,
  rows: readonly T[]
): Promise<
  (T & { versionMajor: number | null; versionMinor: number | null })[]
> => {
  const versions = await versionsOf(
    db,
    rows.map(({ id }) => id)
  );
  return rows.map((row) => ({
    ...row,
    versionMajor: versions.get(row.id)?.versionMajor ?? null,
    versionMinor: versions.get(row.id)?.versionMinor ?? null,
  }));
};

/**
 * The newest releases, newest first, and the release before the oldest of
 * them, if there is one: the list's last "since" link, and the sign that
 * there are more.
 */
export const listReleases = async (
  db: AdminDatabase
): Promise<{ releases: ReleaseSummary[]; older: ReleaseSummary | null }> => {
  const rows = await withVersions(
    db,
    await db
      .select(summaryColumns)
      .from(releases)
      .orderBy(desc(releases.builtAt), desc(releases.id))
      .limit(RELEASE_LIST_LIMIT + 1)
  );
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
  const [versioned = { ...row, versionMajor: null, versionMinor: null }] =
    await withVersions(db, [row]);
  return {
    ...versioned,
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
    wranglerVersion: manifest.wranglerVersion,
    packages: manifest.packages,
    workers: Object.entries(manifest.workers).map(([app, worker]) => ({
      app,
      name: worker.name,
      mainModule: worker.mainModule,
      compatibilityFlags: worker.compatibilityFlags,
      crons: worker.crons,
      requiredSecrets: worker.requiredSecrets,
      durableObjectMigrations: worker.durableObjectMigrations.map(
        (migration) => migration.tag
      ),
      modules: worker.modules.map(({ name, type, size, sha256 }) => ({
        name,
        type,
        size,
        sha256,
      })),
      d1Databases: worker.d1Databases.map((database) => ({
        binding: database.binding,
        databaseName: database.databaseName,
        migrations: database.migrations.map((migration) => migration.name),
      })),
      assetCount: Object.keys(worker.assets?.manifest ?? {}).length,
    })),
  };
};

const summaryOf = ({
  manifest: _manifest,
  manifestSha256: _manifestSha256,
  ...summary
}: StoredRelease): ReleaseSummary => summary;

/** Two releases compared, and the releases that lead from one to the other. */
export interface ReleaseComparison {
  from: ReleaseSummary;
  to: ReleaseSummary;
  diff: ReleaseDiff;
  /**
   * The releases built after the older one, up to and including the newer
   * one, newest first, at most {@link RELEASE_LIST_LIMIT}: their notes are
   * what changes between the two.
   */
  between: ReleaseSummary[];
  /** How many more releases lie between them than `between` holds. */
  moreBetween: number;
}

/**
 * Compares releases `fromId` and `toId`, in that direction (a newer
 * `fromId` shows what going back removes). Null when either isn't imported.
 */
export const compareReleases = async (
  db: AdminDatabase,
  fromId: string,
  toId: string
): Promise<ReleaseComparison | null> => {
  const [from, to] = await Promise.all([
    getStoredRelease(db, fromId),
    getStoredRelease(db, toId),
  ]);
  if (from === null || to === null) {
    return null;
  }
  const [older, newer] =
    from.builtAt.getTime() <= to.builtAt.getTime() ? [from, to] : [to, from];
  const inBetween = and(
    gt(releases.builtAt, older.builtAt),
    lte(releases.builtAt, newer.builtAt)
  );
  const [between, [counted]] = await Promise.all([
    (async () =>
      await withVersions(
        db,
        await db
          .select(summaryColumns)
          .from(releases)
          .where(inBetween)
          .orderBy(desc(releases.builtAt), desc(releases.id))
          .limit(RELEASE_LIST_LIMIT)
      ))(),
    db.select({ total: count() }).from(releases).where(inBetween),
  ]);
  return {
    from: summaryOf(from),
    to: summaryOf(to),
    diff: diffReleases(from.manifest, to.manifest),
    between,
    moreBetween: Math.max((counted?.total ?? 0) - between.length, 0),
  };
};
