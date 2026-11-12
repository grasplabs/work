import { listPageMax, openingMaxLength } from "./contract.ts";
import type {
  SourceList,
  SourceListRequest,
  VersionList,
  VersionListRequest,
} from "./contract.ts";
import { readableSql, readerSetKeyOf } from "./reader-sets.ts";

// Listings: which sources a reader may read, and which versions of one.
// Each is one statement, the reader's sets of readers inside it, so
// nothing they may not read takes a place in a page, its order, a count,
// or whether more follow. Nothing hidden by an erasure is listed. A page's
// place is kept by what the reader read on the page before (a time and a
// key, or a version's number), never by a row of the store, whose number
// would count what others added.
//
// A listed source says whether it is the reader's alone (`personal`): its
// current version's readers are that one person, so nobody else sees it,
// admins included. Said only of what the reader may read. When the Brain
// keeps a store per person beside the shared one, a host lists both with
// the same page place (a time and a key, the same order in each) and
// merges them: nothing here depends on which store a row is in.

/**
 * `?1` the prefixes (JSON), `?2` the reader's person, `?3` their groups
 * (JSON), `?4` and `?5` the time (ms) and key a page starts after, or
 * null, `?6` the most rows, `?7` the most characters of an opening, `?8`
 * the key of the set of the reader alone: the
 * current versions the reader may read whose source starts with a prefix,
 * newest first, then by key. A source's versions are counted among those
 * the reader may read.
 */
const sourcesSql = `
WITH ${readableSql},
listed AS (
  SELECT current_versions.source AS source, source_versions.row AS row,
    source_versions.version AS version, source_versions.added_at AS added_at,
    source_versions.reader_set AS reader_set
  FROM current_versions
  JOIN source_versions ON source_versions.row = current_versions.version_row
  WHERE source_versions.reader_set IN (SELECT reader_set FROM readable)
    AND source_versions.row NOT IN (SELECT version_row FROM erasing_versions)
    AND EXISTS (
      SELECT 1 FROM json_each(?1) AS prefix
      WHERE substr(current_versions.source, 1, length(prefix.value)) = prefix.value
    )
    AND (?4 IS NULL
      OR source_versions.added_at < ?4
      OR (source_versions.added_at = ?4 AND current_versions.source < ?5))
  ORDER BY source_versions.added_at DESC, current_versions.source DESC
  LIMIT ?6
)
SELECT listed.source AS source, listed.version AS version,
  listed.added_at AS added_at,
  coalesce((
    SELECT substr(chunks.text, 1, ?7) FROM chunks
    WHERE chunks.version_row = listed.row AND chunks.position = 0
  ), '') AS opening,
  coalesce((
    SELECT reader_sets.key = ?8 FROM reader_sets
    WHERE reader_sets.id = listed.reader_set
  ), 0) AS personal,
  (
    SELECT count(*) FROM source_versions AS each
    WHERE each.source = listed.source
      AND each.reader_set IN (SELECT reader_set FROM readable)
      AND each.row NOT IN (SELECT version_row FROM erasing_versions)
  ) AS versions
FROM listed
ORDER BY listed.added_at DESC, listed.source DESC`;

/**
 * A page of the sources `reader` may read among `prefixes`, newest first,
 * after `after` when given.
 */
export const listSources = (
  sql: SqlStorage,
  { reader, prefixes, after, limit = listPageMax }: SourceListRequest
): SourceList => {
  const rows = sql
    .exec<{
      source: string;
      version: number;
      added_at: number;
      opening: string;
      personal: number;
      versions: number;
    }>(
      sourcesSql,
      JSON.stringify(prefixes),
      reader.person,
      JSON.stringify(reader.groups),
      after?.addedAt.getTime() ?? null,
      after?.source ?? null,
      // One more than the page, to tell whether more follow.
      limit + 1,
      openingMaxLength,
      readerSetKeyOf({ kind: "owner", person: reader.person })
    )
    .toArray();
  return {
    sources: rows.slice(0, limit).map((row) => ({
      source: row.source,
      version: row.version,
      addedAt: new Date(row.added_at),
      opening: row.opening,
      personal: row.personal === 1,
      versions: row.versions,
    })),
    more: rows.length > limit,
  };
};

/**
 * `?1` the source, `?2` the reader's person, `?3` their groups (JSON), `?4`
 * the version a page starts below, or null, `?5` the most rows: the
 * source's versions the reader may read, newest first, while they may read
 * its current version (sources.ts `versionSql`, the same rule).
 */
const versionsSql = `
WITH ${readableSql}
SELECT version, added_at FROM source_versions
WHERE source = ?1
  AND row NOT IN (SELECT version_row FROM erasing_versions)
  AND reader_set IN (SELECT reader_set FROM readable)
  AND (?4 IS NULL OR version < ?4)
  AND EXISTS (
    SELECT 1 FROM current_versions
    JOIN source_versions AS current ON current.row = current_versions.version_row
    WHERE current_versions.source = ?1
      AND current.reader_set IN (SELECT reader_set FROM readable)
  )
ORDER BY version DESC
LIMIT ?5`;

/** A page of the versions of `source` that `reader` may read, newest first. */
export const listVersions = (
  sql: SqlStorage,
  { source, reader, before, limit = listPageMax }: VersionListRequest
): VersionList => {
  const rows = sql
    .exec<{ version: number; added_at: number }>(
      versionsSql,
      source,
      reader.person,
      JSON.stringify(reader.groups),
      before ?? null,
      limit + 1
    )
    .toArray();
  return {
    versions: rows.slice(0, limit).map((row) => ({
      version: row.version,
      addedAt: new Date(row.added_at),
    })),
    more: rows.length > limit,
  };
};
