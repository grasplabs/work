import { z } from "zod";

import type { BrainBucket } from "./bucket.ts";
import { accessSchema } from "./contract.ts";
import type {
  Access,
  ExportFileRequest,
  ExportRequest,
  ExportScope,
  ExportStatus,
} from "./contract.ts";
import { erasuresSoFar, subjectOf } from "./erasure.ts";
import { fileKeyOf, hashOf } from "./files.ts";
import { readerSetKeyOf } from "./reader-sets.ts";
import { defineWork, enqueueWork } from "./work.ts";
import type { WorkContext } from "./work.ts";

// Exports: what a scope holds, written as files in the store's own part of
// the bucket, under `exports/<id>/`: parts of JSON Lines, a version a
// line, and a manifest written last, naming each part with its SHA-256
// and how many versions it holds. So an export whose manifest is there is
// whole, and a restore (restore.ts) checks each part against it.
//
// Whose:
//
// - The company's, from the shared store: every version, current or
//   history, with its readers, but those one person alone may read (a
//   set of readers that is one person and nothing else), and every version
//   of a source whose current version is such or that has none (no one
//   else may read its history), left out in the statement that selects
//   them. A person's own store holds nothing else, so it never takes part
//   in one.
// - A person's: only the versions they alone may read, of sources whose
//   current version they alone may read, from the shared store or from
//   their own store, each export of its own; the host starts both, for
//   the person it verified.
//
// What it takes is what the store held as it started (`up_to`, the last
// version's row), written by the work queue a part a run (`exportWork`),
// so it goes on across restarts and never holds the store long.
//
// Erasure: an export records where the store's record of erasures was as
// it started. Any erasure recorded after that (a source's, a person's, or
// one a replay of the ledger applied) makes it stale: its files may hold
// what was erased. A stale export is never served (`exportFile` asks before
// and after it reads), a restore refuses it, and the tick marks it erased
// and puts the deletion of its files on the queue (`markStaleExports`,
// `dropWork`). Re-checking each file against the ledger as it is read was
// the other way: it would leave erased content in the bucket until then,
// and filtering a checked part breaks its checksum. So a stale export is
// deleted and a new one made instead. A version's row can only be used
// again after an erasure deleted it, which makes the export stale first.

/** Where exports are kept in the store's part of the bucket. */
export const exportsPrefix = "exports/";

/** Most versions one part holds. */
export const exportPartVersions = 50;

/**
 * Most bytes of text one part holds before it ends, at least one version:
 * a part is read whole into memory by a download and by a restore.
 */
const exportPartBytes = 8_000_000;

/** Reads of the bucket in flight at once, writing a part. */
const readsAtOnce = 6;

/** Most keys one run of the deletion of an export's files deletes. */
const dropPage = 1000;

/** Where `id`'s files are in the store's part of the bucket. */
const exportPrefixOf = (id: string): string => `${exportsPrefix}${id}/`;

/** The key of `id`'s file `file`. */
export const exportKeyOf = (id: string, file: string): string =>
  `${exportPrefixOf(id)}${file}`;

/** The name of part `index`. */
const partFileOf = (index: number): string =>
  `part-${String(index).padStart(4, "0")}.jsonl`;

/** The manifest's file. */
export const manifestFile = "manifest.json";

/** What a line of a part holds: one version. */
export const exportLineSchema = z.strictObject({
  source: z.string(),
  version: z.int().positive(),
  /** When it was added, in milliseconds. */
  addedAt: z.int().nonnegative(),
  access: accessSchema,
  /** Whether it was its source's current version. */
  current: z.boolean(),
  /** Whether its text is cut into chunks and indexed: an instruction file's isn't. */
  indexed: z.boolean(),
  /** The change keys its producer added it with. */
  changes: z.array(z.string()),
  text: z.string(),
});
export type ExportLine = z.infer<typeof exportLineSchema>;

/** An export's manifest, as written last. */
export const manifestSchema = z.strictObject({
  format: z.literal(1),
  id: z.uuid(),
  scope: z.enum(["company", "person"]),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  versions: z.int().nonnegative(),
  parts: z.array(
    z.strictObject({
      file: z.string().regex(/^part-\d{4}\.jsonl$/u),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
      versions: z.int().positive(),
    })
  ),
});
export type Manifest = z.infer<typeof manifestSchema>;

/** An export's row, as the store keeps it. */
interface ExportRow extends Record<string, SqlStorageValue> {
  id: string;
  scope: "company" | "person";
  subject: string | null;
  reader_set: number | null;
  up_to: number;
  cursor: number;
  erasure_mark: number;
  state: "writing" | "done" | "failed" | "erased";
  parts: number;
  versions: number;
  started_at: number;
}

const rowOf = (sql: SqlStorage, id: string): ExportRow | undefined =>
  sql.exec<ExportRow>("SELECT * FROM exports WHERE id = ?", id).toArray().at(0);

/** Whether an erasure was recorded after `row` started: its files may hold it. */
const isStale = (sql: SqlStorage, row: ExportRow): boolean =>
  erasuresSoFar(sql) > row.erasure_mark;

/** Whose an export is, as its row keeps it: the scope and the person's subject. */
interface Whose {
  scope: "company" | "person";
  subject: string | null;
}

/** `scope` as rows keep it. */
export const whoseOf = async (scope: ExportScope): Promise<Whose> =>
  scope.kind === "company"
    ? { scope: "company", subject: null }
    : { scope: "person", subject: await subjectOf(scope.person) };

/** `id`'s row, if it is an export of `whose`: none for any other, alike. */
const rowFor = (
  sql: SqlStorage,
  id: string,
  whose: Whose
): ExportRow | undefined => {
  const row = rowOf(sql, id);
  return row !== undefined &&
    row.scope === whose.scope &&
    row.subject === whose.subject
    ? row
    : undefined;
};

/** `id`'s items of the queue are under this key. */
const keyOf = (id: string): string => `export:${id}`;

/** The versions a scope selects: `?1` the export's set of readers, for a person's. */
const scopeSql = {
  // One person alone may read a set that is one principal, a person.
  // A source whose current version is such, or that has none, is left
  // out whole: no one but that person may read its history (sources.ts
  // `readVersion`), and a person's erasure takes it whole.
  company: `source_versions.reader_set NOT IN (SELECT reader_set FROM alone)
    AND EXISTS (
      SELECT 1 FROM current_versions AS now
      JOIN source_versions AS current ON current.row = now.version_row
      WHERE now.source = source_versions.source
        AND current.reader_set NOT IN (SELECT reader_set FROM alone)
    )`,
  // As the company's: a source whose current version others may read
  // now, or that has none, is left out whole (`readVersion` hides its
  // history from whoever isn't among its current readers).
  person: `source_versions.reader_set = ?1
    AND EXISTS (
      SELECT 1 FROM current_versions AS now
      JOIN source_versions AS current ON current.row = now.version_row
      WHERE now.source = source_versions.source AND current.reader_set = ?1
    )`,
} as const;

/** A version, as a run selects it for a part. */
interface Selected extends Record<string, SqlStorageValue> {
  row: number;
  source: string;
  version: number;
  file: string;
  added_at: number;
  readers: string;
  current: number;
  indexed: number;
  changes: string;
}

/**
 * `?2` the cursor, `?3` up to, `?4` how many: the next versions of the
 * scope after the cursor, in order of their rows, none an erasure hid.
 * Current: the version its source's current pointer names, or, where that
 * is a version added after the export started, the last one before it.
 */
const selectSql = (scope: "company" | "person"): string => `
WITH alone AS (
  SELECT reader_set FROM reader_set_members
  GROUP BY reader_set HAVING count(*) = 1 AND max(kind) = 'person'
)
SELECT source_versions.row AS row, source_versions.source AS source,
  source_versions.version AS version, source_versions.file AS file,
  source_versions.added_at AS added_at, reader_sets.key AS readers,
  coalesce(
    current_versions.version_row = source_versions.row
    OR (current_versions.version_row > ?3 AND source_versions.row = (
      SELECT max(before.row) FROM source_versions AS before
      WHERE before.source = source_versions.source AND before.row <= ?3
    )),
    0
  ) AS current,
  EXISTS (SELECT 1 FROM chunks WHERE chunks.version_row = source_versions.row) AS indexed,
  (SELECT json_group_array(change) FROM source_changes
    WHERE source_changes.version_row = source_versions.row) AS changes
FROM source_versions
JOIN reader_sets ON reader_sets.id = source_versions.reader_set
LEFT JOIN current_versions ON current_versions.source = source_versions.source
WHERE source_versions.row > ?2 AND source_versions.row <= ?3
  AND source_versions.row NOT IN (SELECT version_row FROM erasing_versions)
  AND ${scopeSql[scope]}
ORDER BY source_versions.row
LIMIT ?4`;

/** A set of readers' key (reader-sets.ts) as the access it names. */
const accessOfKey = (key: string): Access | undefined => {
  const principals = z
    .array(z.tuple([z.enum(["person", "group"]), z.string()]))
    .parse(JSON.parse(key));
  const [first, ...rest] = principals;
  let access: Access = { kind: "none" };
  if (first?.[0] === "person") {
    access = { kind: "owner", person: first[1] };
  } else if (first?.[0] === "group") {
    access = { kind: "audience", group: first[1] };
  }
  return rest.length === 0 && readerSetKeyOf(access) === key
    ? access
    : undefined;
};

/** The payload of an export's items. */
const exportPayload = z.strictObject({ id: z.uuid() });

/** The key of a person's set of readers, for a person's export. */
export const personKeyOf = (scope: ExportScope): string | null =>
  scope.kind === "person"
    ? readerSetKeyOf({ kind: "owner", person: scope.person })
    : null;

/** `id`'s state as said: a stale export is erased, whatever the tick did yet. */
const stateOf = (sql: SqlStorage, row: ExportRow): ExportStatus["state"] =>
  (row.state === "writing" || row.state === "done") && isStale(sql, row)
    ? "erased"
    : row.state;

/** The files of a done export: the manifest first, then its parts. */
const filesOf = (row: ExportRow): string[] => [
  manifestFile,
  ...Array.from({ length: row.parts }, (_, index) => partFileOf(index)),
];

/** Where the export of `request` is: null when there is none of its scope. */
export const exportStatus = (
  sql: SqlStorage,
  { id }: ExportRequest,
  whose: Whose
): ExportStatus | null => {
  const row = rowFor(sql, id, whose);
  if (row === undefined) {
    return null;
  }
  const state = stateOf(sql, row);
  return {
    id,
    state,
    versions: row.versions,
    files: state === "done" ? filesOf(row) : [],
  };
};

/**
 * A file of a done export of `whose`, as written: null for an export of
 * another scope, one not done or stale, and a file it doesn't have, alike.
 * Asked again once the file is read: an erasure may have landed while it
 * was.
 */
export const exportFile = async (
  sql: SqlStorage,
  bucket: BrainBucket,
  { id, file }: ExportFileRequest,
  whose: Whose
): Promise<string | null> => {
  const servable = (): boolean => {
    const row = rowFor(sql, id, whose);
    return (
      row !== undefined &&
      stateOf(sql, row) === "done" &&
      filesOf(row).includes(file)
    );
  };
  if (!servable()) {
    return null;
  }
  const object = await bucket.get(exportKeyOf(id, file));
  const text = object === null ? null : await object.text();
  return text !== null && servable() ? text : null;
};

/**
 * Deleting the files of an export an erasure made stale: a page a run,
 * again while more are left.
 */
const dropWork = defineWork({
  kind: "brain.export_drop",
  payload: exportPayload,
  run: async ({ id }, { bucket, again }) => {
    const page = await bucket.list({
      prefix: exportPrefixOf(id),
      limit: dropPage,
    });
    if (page.objects.length === 0) {
      return;
    }
    await bucket.delete(page.objects.map(({ key }) => key));
    if (page.truncated) {
      again(page.objects.length);
    }
  },
});

const enqueueDrop = (storage: DurableObjectStorage, id: string): void => {
  enqueueWork(storage, dropWork, {
    key: keyOf(id),
    payload: { id },
    priority: "asked",
  });
};

/**
 * Marks every export an erasure made stale as erased, and puts the
 * deletion of its files on the queue, in one transaction: the tick's step,
 * whose rule `exportsToDrop` is.
 */
export const markStaleExports = (storage: DurableObjectStorage): void => {
  storage.transactionSync(() => {
    const stale = storage.sql
      .exec<{ id: string }>(
        `UPDATE exports SET state = 'erased', finished_at = ?
        WHERE state IN ('writing', 'done')
          AND erasure_mark < (SELECT coalesce(max(rowid), 0) FROM erasures)
        RETURNING id`,
        Date.now()
      )
      .toArray();
    for (const { id } of stale) {
      storage.sql.exec("DELETE FROM export_parts WHERE export = ?", id);
      enqueueDrop(storage, id);
    }
  });
};

/** Whether an export an erasure made stale is still to mark (`markStaleExports`). */
export const exportsToDrop = (sql: SqlStorage): boolean =>
  sql
    .exec(
      `SELECT 1 FROM exports WHERE state IN ('writing', 'done')
        AND erasure_mark < (SELECT coalesce(max(rowid), 0) FROM erasures)
      LIMIT 1`
    )
    .toArray().length > 0;

/** The text of each of `selected`'s files, a few at a time: null for one gone. */
const textsOf = async (
  bucket: BrainBucket,
  selected: readonly Selected[]
): Promise<(string | null)[]> => {
  const texts: (string | null)[] = [];
  for (let at = 0; at < selected.length; at += readsAtOnce) {
    // oxlint-disable-next-line no-await-in-loop -- a few at a time
    const read = await Promise.all(
      selected.slice(at, at + readsAtOnce).map(async ({ file }) => {
        const object = await bucket.get(fileKeyOf(file));
        return object === null ? null : await object.text();
      })
    );
    texts.push(...read);
  }
  return texts;
};

/**
 * The export's state set to `state`, in a transaction of its own, if it is
 * still being written and no erasure made it stale since. A failed one is
 * served to no one, so its files are deleted as a stale one's are: none of
 * an export's content stays in the bucket where no erasure would reach it.
 */
const settle = (
  storage: DurableObjectStorage,
  id: string,
  state: "done" | "failed"
): void => {
  storage.transactionSync(() => {
    const row = rowOf(storage.sql, id);
    if (row?.state === "writing" && !isStale(storage.sql, row)) {
      storage.sql.exec(
        "UPDATE exports SET state = ?, finished_at = ? WHERE id = ?",
        state,
        Date.now(),
        id
      );
      if (state === "failed") {
        storage.sql.exec("DELETE FROM export_parts WHERE export = ?", id);
        enqueueDrop(storage, id);
      }
    }
  });
};

/** Writes the manifest of `row`, from its parts, and settles it done. */
const finish = async (
  storage: DurableObjectStorage,
  bucket: BrainBucket,
  row: ExportRow
): Promise<void> => {
  const parts = storage.sql
    .exec<{ part: number; hash: string; versions: number }>(
      "SELECT part, hash, versions FROM export_parts WHERE export = ? ORDER BY part",
      row.id
    )
    .toArray();
  const manifest: Manifest = {
    format: 1,
    id: row.id,
    scope: row.scope,
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: new Date().toISOString(),
    versions: row.versions,
    parts: parts.map(({ part, hash, versions }) => ({
      file: partFileOf(part),
      sha256: hash,
      versions,
    })),
  };
  await bucket.put(
    exportKeyOf(row.id, manifestFile),
    JSON.stringify(manifest),
    { httpMetadata: { contentType: "application/json" } }
  );
  settle(storage, row.id, "done");
};

/**
 * One run of an export: the next part written and recorded, or, once none
 * is left, its manifest. A run that finds it stale, or that wrote a part
 * an erasure made stale meanwhile, puts the deletion of its files on the
 * queue again, so a part written after a deletion listed the files is
 * deleted too.
 */
const writePart = async (
  id: string,
  { storage, bucket, again }: WorkContext
): Promise<void> => {
  const { sql } = storage;
  const row = rowOf(sql, id);
  if (row === undefined || row.state !== "writing") {
    if (row?.state === "erased") {
      enqueueDrop(storage, id);
    }
    return;
  }
  if (isStale(sql, row)) {
    markStaleExports(storage);
    return;
  }
  const selected =
    row.scope === "person" && row.reader_set === null
      ? []
      : sql
          .exec<Selected>(
            selectSql(row.scope),
            row.reader_set,
            row.cursor,
            row.up_to,
            exportPartVersions
          )
          .toArray();
  if (selected.length === 0) {
    await finish(storage, bucket, row);
    return;
  }
  const texts = await textsOf(bucket, selected);
  const lines: string[] = [];
  let bytes = 0;
  let last = row.cursor;
  for (const [index, version] of selected.entries()) {
    const text = texts[index];
    if (text === null || text === undefined) {
      // Gone: only an erasure deletes a held file, which makes the export
      // stale; otherwise it fails, never written as whole without it.
      if (isStale(sql, row)) {
        markStaleExports(storage);
      } else {
        settle(storage, id, "failed");
      }
      return;
    }
    if (lines.length > 0 && bytes + text.length > exportPartBytes) {
      break;
    }
    const access = accessOfKey(version.readers);
    if (access === undefined) {
      // A set the contract can't name (more than one principal): the
      // export fails, rather than write it as something it isn't.
      settle(storage, id, "failed");
      return;
    }
    const line: ExportLine = {
      source: version.source,
      version: version.version,
      addedAt: version.added_at,
      access,
      current: version.current === 1,
      indexed: version.indexed === 1,
      changes: z.array(z.string()).parse(JSON.parse(version.changes)),
      text,
    };
    lines.push(JSON.stringify(line));
    bytes += text.length;
    last = version.row;
  }
  const body = new TextEncoder().encode(`${lines.join("\n")}\n`);
  const hash = await hashOf(body);
  await bucket.put(exportKeyOf(id, partFileOf(row.parts)), body, {
    sha256: hash,
    httpMetadata: { contentType: "application/x-ndjson" },
  });
  const recorded = storage.transactionSync(() => {
    const now = rowOf(sql, id);
    // Moved on by another run, or made stale while the part was written.
    if (
      now?.state !== "writing" ||
      now.cursor !== row.cursor ||
      isStale(sql, now)
    ) {
      return false;
    }
    sql.exec(
      "INSERT INTO export_parts (export, part, hash, versions) VALUES (?, ?, ?, ?)",
      id,
      row.parts,
      hash,
      lines.length
    );
    sql.exec(
      `UPDATE exports SET cursor = ?, parts = parts + 1, versions = versions + ?
      WHERE id = ?`,
      last,
      lines.length,
      id
    );
    return true;
  });
  if (!recorded) {
    markStaleExports(storage);
    // Stale: its files, this part among them, deleted (again). The queue
    // never runs two of one kind and key, so no other run moved it on.
    if (rowOf(sql, id)?.state === "erased") {
      enqueueDrop(storage, id);
    }
    return;
  }
  again(lines.length);
};

/** Writing an export, a part a run (`writePart`). */
const exportWork = defineWork({
  kind: "brain.export",
  payload: exportPayload,
  run: async ({ id }, context) => {
    await writePart(id, context);
  },
});

/** Puts the writing of export `id` on the queue. */
const enqueueExport = (storage: DurableObjectStorage, id: string): void => {
  enqueueWork(storage, exportWork, {
    key: keyOf(id),
    payload: { id },
    priority: "asked",
  });
};

/**
 * Starts an export of `whose`, of what the store holds now: or answers
 * with the one of the same scope being written. `readerSet` is the
 * person's set of readers, for a person's. Run while nothing else writes
 * between the read of the store and the row (one transaction).
 */
export const startExport = (
  storage: DurableObjectStorage,
  whose: Whose,
  personKey: string | null
): string =>
  storage.transactionSync(() => {
    const { sql } = storage;
    const running = sql
      .exec<{ id: string }>(
        `SELECT id FROM exports WHERE state = 'writing' AND scope = ?
        AND subject IS ? AND erasure_mark = ?`,
        whose.scope,
        whose.subject,
        erasuresSoFar(sql)
      )
      .toArray()
      .at(0);
    if (running !== undefined) {
      return running.id;
    }
    const id = crypto.randomUUID();
    const readerSet =
      personKey === null
        ? null
        : (sql
            .exec<{ id: number }>(
              "SELECT id FROM reader_sets WHERE key = ?",
              personKey
            )
            .toArray()
            .at(0)?.id ?? null);
    const upTo = sql
      .exec<{ last: number }>(
        "SELECT coalesce(max(row), 0) AS last FROM source_versions"
      )
      .one().last;
    sql.exec(
      `INSERT INTO exports (id, scope, subject, reader_set, up_to, cursor,
        erasure_mark, state, parts, versions, started_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, 'writing', 0, 0, ?)`,
      id,
      whose.scope,
      whose.subject,
      readerSet,
      upTo,
      erasuresSoFar(sql),
      Date.now()
    );
    enqueueExport(storage, id);
    return id;
  });
