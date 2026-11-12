import { z } from "zod";

import type { BrainBucket } from "./bucket.ts";
import {
  accessSchema,
  exportKeptMs,
  restoringNow,
  shippedSkillsPrefix,
} from "./contract.ts";
import type {
  Access,
  ExportFileRequest,
  ExportRequest,
  ExportScope,
  ExportStatus,
} from "./contract.ts";
import { subjectOf } from "./erasure.ts";
import { fileKeyOf, hashOf } from "./files.ts";
import { readerSetKeyOf } from "./reader-sets.ts";
import { isRestoring } from "./restoring.ts";
import { defineWork, enqueueWork, workParksMax } from "./work.ts";
import type { WorkContext } from "./work.ts";

// Exports: what a scope holds, written as files in the store's own part of
// the bucket, under `exports/<id>/`: parts of JSON Lines, a version a
// line, and a manifest written last, naming the deployment, where the
// erasure ledger was as it started, and each part with its SHA-256, size
// and how many versions it holds. So an export whose manifest is there is
// whole, and a restore (restore.ts) checks each part against it.
//
// Whose:
//
// - The company's, from the shared store: every version, current or
//   history, with its readers, but those one person alone may read (a set
//   of readers that is one person and nothing else) and those no one is
//   known to read (a set with no one in it: an admin is not a reader of
//   it), and every version of a source whose current version is such or
//   that has none (no one else may read its history), left out in the
//   statement that selects them; and the skills Grasp ships (contract.ts
//   `shippedSkillsPrefix`), which each release adds again. It holds the
//   company's instruction files and its own skills. An admin's export holds
//   every group's content, those they are not in among them: that is what
//   a company's backup is for. A person's own store never takes part in one.
// - A person's: only the versions they alone may read, of sources whose
//   current version they alone may read, from the shared store or from
//   their own store, each export of its own.
//
// What it takes is what the store held as it started (`up_to`, the last
// version's row), written by the work queue a part a run (`exportWork`),
// so it goes on across restarts and never holds the store long. A part is
// read a few versions at a time until its encoded lines reach
// `exportPartBytes`, so neither writing it nor reading it back holds more.
// (A version's row is used again only when an erasure deleted the last one;
// an add after the export started may then take a row it still reads. It
// is the scope's to read as any version the scope selects.)
//
// Erasure: an export is stale only once it holds what was erased. Each
// part records the sources it holds by their keys as the erasure ledger
// names them (`export_sources`), so an erasure past the ledger's place as
// the export started (`ledger_mark`) of a source it holds makes it stale,
// and so does the erasure of the person whose own export it is. A company
// export holds nothing one person alone may read, so a person's erasure
// never touches it; an erasure of a source it doesn't hold neither: the
// erasures retention makes all day leave it be. A stale export is never
// served (`exportFile` asks before and after it reads), a restore refuses
// it, and the tick marks it erased and puts the deletion of its files on
// the queue (`exportsStep`, `dropWork`). Re-checking each file against the
// ledger as it is read was the other way: it would leave erased content in
// the bucket, and filtering a checked part breaks its checksum. A copy
// someone already downloaded is outside the Brain's reach, and so outside
// its erasure.
//
// The files outlive the store's record of them when its storage is lost or
// rolled back and its bucket kept. So each erasure the store records past
// its last sweep starts a sweep of `exports/` (`sweepWork`), which deletes
// every export it has no row of whose manifest is gone, or whose ledger
// place is behind an entry the store holds now: nothing better is known
// of what such files hold. A restore records the export it restores, its
// sources as it checks them, so from then on the rule above holds for it;
// and while its restore runs, or failed and may start again, its files are
// never deleted.
//
// Nothing piles up or stays put: a done export is deleted `exportKeptMs`
// after it is done, or once a newer one of its scope is done; an export
// being written whose item of the queue is parked for good, or gone, is
// settled as failed and its files deleted (`settleStuck`); a restore
// likewise (restore.ts).

/** Where exports are kept in the store's part of the bucket. */
export const exportsPrefix = "exports/";

/** Most versions one part holds. */
const exportPartVersions = 50;

/**
 * Most bytes of encoded lines one part holds, at least one version: a part
 * is read whole into memory by a download, over RPC, and by a restore. A
 * version is at most 1 MB of text (contract.ts `sourceTextMaxBytes`), so a
 * part is at most some 5 MB, well inside both.
 */
export const exportPartBytes = 4_000_000;

/** Reads of the bucket in flight at once, writing a part. */
const readsAtOnce = 4;

/** Most keys one run of the deletion of an export's files deletes. */
const dropPage = 1000;

/** Most keys one run of the sweep lists. */
const sweepPage = 1000;

/** Most manifests one run of the sweep reads. */
const sweepReads = 20;

const encoder = new TextEncoder();

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
  /**
   * The deployment it is of, as its host names it. On-prem every install
   * is named `local` (core's brain-next.ts), so there it tells little.
   */
  deployment: z.string().min(1),
  /** The key of the last erasure the store had applied as it started: "" for none. */
  ledger: z.string(),
  scope: z.enum(["company", "person"]),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  versions: z.int().nonnegative(),
  parts: z.array(
    z.strictObject({
      file: z.string().regex(/^part-\d{4}\.jsonl$/u),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
      versions: z.int().positive(),
      bytes: z.int().positive(),
    })
  ),
});
export type Manifest = z.infer<typeof manifestSchema>;

/** An export's row, as the store keeps it. */
interface ExportRow extends Record<string, SqlStorageValue> {
  id: string;
  scope: "company" | "person";
  subject: string | null;
  deployment: string;
  reader_set: number | null;
  up_to: number;
  cursor: number;
  ledger_mark: string;
  state: "writing" | "done" | "failed" | "erased" | "expired";
  parts: number;
  versions: number;
  started_at: number;
  finished_at: number | null;
}

const rowOf = (sql: SqlStorage, id: string): ExportRow | undefined =>
  sql.exec<ExportRow>("SELECT * FROM exports WHERE id = ?", id).toArray().at(0);

/**
 * Of a row of `exports`: whether an erasure past its ledger place took
 * something it holds (above).
 */
const staleSql = `EXISTS (
  SELECT 1 FROM erasures
  WHERE erasures.key > exports.ledger_mark
    AND (
      (erasures.kind = 'source' AND EXISTS (
        SELECT 1 FROM export_sources
        WHERE export_sources.export = exports.id
          AND export_sources.subject = erasures.subject
      ))
      OR (erasures.kind = 'person' AND exports.scope = 'person'
        AND erasures.subject = exports.subject)
    )
)`;

/** Of a row of `exports`: whether a restore of it runs, or failed and may start again. */
const heldSql = `exports.id IN (
  SELECT export FROM restores WHERE state IN ('running', 'failed')
)`;

/** Whether export `id` holds what an erasure since it started took. */
export const isStale = (sql: SqlStorage, id: string): boolean =>
  sql
    .exec(`SELECT 1 FROM exports WHERE exports.id = ? AND ${staleSql}`, id)
    .toArray().length > 0;

/** The last erasure the store holds: the ledger's place, "" for none. */
const ledgerPlace = (sql: SqlStorage): string =>
  sql
    .exec<{ key: string }>("SELECT coalesce(max(key), '') AS key FROM erasures")
    .one().key;

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

/**
 * The versions a scope selects: `?1` the export's set of readers, for a
 * person's. `unreadable` is every set one person alone, or no one known,
 * may read.
 */
const scopeSql = {
  company: `source_versions.reader_set NOT IN (SELECT id FROM unreadable)
    AND substr(source_versions.source, 1, ${shippedSkillsPrefix.length})
      != '${shippedSkillsPrefix}'
    AND EXISTS (
      SELECT 1 FROM current_versions AS now
      JOIN source_versions AS current ON current.row = now.version_row
      WHERE now.source = source_versions.source
        AND current.reader_set NOT IN (SELECT id FROM unreadable)
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
WITH unreadable AS (
  SELECT reader_set AS id FROM reader_set_members
  GROUP BY reader_set HAVING count(*) = 1 AND max(kind) = 'person'
  UNION
  SELECT id FROM reader_sets
  WHERE id NOT IN (SELECT reader_set FROM reader_set_members)
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

/** A set of readers' key (reader-sets.ts) as the access it names, if the contract can name it. */
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
  (row.state === "writing" || row.state === "done") && isStale(sql, row.id)
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
 * Whether export `id`'s files may be deleted now, as a deletion of them
 * runs: never while it is written or done (a drop queued before a restore
 * recorded it, say), nor while a restore of it runs or failed.
 */
const droppable = (sql: SqlStorage, id: string): boolean =>
  sql
    .exec(
      `SELECT 1 FROM exports
      WHERE exports.id = ?
        AND (exports.state IN ('writing', 'done') OR ${heldSql})`,
      id
    )
    .toArray().length === 0;

/**
 * Deleting the files of an export that is stale, failed, expired, or that
 * the store has no record of: a page a run, again while more are left;
 * asked first whether they may still go (`droppable`).
 */
const dropWork = defineWork({
  kind: "brain.export_drop",
  payload: exportPayload,
  run: async ({ id }, { storage, bucket, again }) => {
    if (!droppable(storage.sql, id)) {
      return;
    }
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

/** Puts the deletion of export `id`'s files on the queue. */
const enqueueDrop = (storage: DurableObjectStorage, id: string): void => {
  enqueueWork(storage, dropWork, {
    key: keyOf(id),
    payload: { id },
    priority: "asked",
  });
};

/**
 * Sets every export `where` names (a condition on a row of `exports`, its
 * parameters after `?1`, the time) to `state`, but those a restore holds,
 * and puts the deletion of their files on the queue. In the caller's
 * transaction.
 */
const retire = (
  storage: DurableObjectStorage,
  state: "erased" | "failed" | "expired",
  where: string,
  ...params: SqlStorageValue[]
): void => {
  const { sql } = storage;
  const retired = sql
    .exec<{ id: string }>(
      `UPDATE exports SET state = '${state}', finished_at = ?1
      WHERE (${where}) AND NOT ${heldSql}
      RETURNING id`,
      Date.now(),
      ...params
    )
    .toArray();
  for (const { id } of retired) {
    sql.exec("DELETE FROM export_parts WHERE export = ?", id);
    sql.exec("DELETE FROM export_sources WHERE export = ?", id);
    enqueueDrop(storage, id);
  }
};

/** Of a row of `exports`: written or done, and stale. */
const staleNowSql = `exports.state IN ('writing', 'done') AND ${staleSql}`;

/** `?2` the time before which a done export is past its time. */
const pastItsTimeSql = "exports.state = 'done' AND exports.finished_at <= ?2";

/**
 * Whether an item of the queue of `kind` for the key `prefix` followed by
 * `subject` (a column of the outer row, named with its table) is still
 * there and not parked for good: `?3` the parks that make one so.
 */
const liveItemSql = (kind: string, prefix: string, subject: string): string =>
  `EXISTS (
  SELECT 1 FROM work_items
  WHERE work_items.kind = '${kind}' AND work_items.key = '${prefix}' || ${subject}
    AND (work_items.parked_at IS NULL OR work_items.parks < ?3)
)`;

/** An export being written whose item is parked for good or gone. */
const stuckExportSql = `exports.state = 'writing'
  AND NOT ${liveItemSql("brain.export", "export:", "exports.id")}`;

/** A restore running whose item is parked for good or gone. */
const stuckRestoreSql = `restores.state = 'running'
  AND NOT ${liveItemSql("brain.restore", "restore:", "restores.export")}`;

/** The last erasure the store recorded: where a sweep is due past. */
const lastErasureSql = "(SELECT coalesce(max(rowid), 0) FROM erasures)";

/** Whether a sweep of `exports/` is due: an erasure recorded since the last. */
const sweepDue = (sql: SqlStorage): boolean =>
  sql
    .exec(
      `SELECT 1 WHERE ${lastErasureSql} >
        coalesce((SELECT through FROM export_sweep WHERE id = 1), 0)`
    )
    .toArray().length > 0;

/** Where export `id`'s manifest says the ledger was as it started: none when it can't be read. */
const manifestLedgerOf = async (
  bucket: BrainBucket,
  id: string
): Promise<string | undefined> => {
  const object = await bucket.get(exportKeyOf(id, manifestFile));
  if (object === null) {
    return undefined;
  }
  try {
    const manifest = manifestSchema.safeParse(JSON.parse(await object.text()));
    return manifest.success ? manifest.data.ledger : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The sweep of `exports/` (above), from where the last run stopped: each
 * export listed that the store has no row of, whose manifest is gone or
 * whose ledger place is behind an entry the store holds, has the deletion
 * of its files put on the queue. Its place is saved after each export it
 * decides, with what it decided; it reads at most `sweepReads` manifests a
 * run, and goes on again while the listing does.
 */
const sweepWork = defineWork({
  kind: "brain.export_sweep",
  payload: z.strictObject({}),
  run: async (_payload, { storage, bucket, again }) => {
    const { sql } = storage;
    const cursor =
      sql
        .exec<{ cursor: string | null }>(
          "SELECT cursor FROM export_sweep WHERE id = 1"
        )
        .toArray()
        .at(0)?.cursor ?? null;
    const page = await bucket.list({
      prefix: exportsPrefix,
      ...(cursor === null ? {} : { startAfter: cursor }),
      limit: sweepPage,
    });
    // Each export listed, in order, with the last of its keys on the page.
    const lastKeys = new Map<string, string>();
    for (const { key } of page.objects) {
      const [id] = key.slice(exportsPrefix.length).split("/");
      if (id !== undefined && id !== "") {
        lastKeys.set(id, key);
      }
    }
    let reads = 0;
    for (const [id, lastKey] of lastKeys) {
      if (reads >= sweepReads) {
        again(reads);
        return;
      }
      const known = rowOf(sql, id) !== undefined;
      let ledger: string | undefined = "";
      if (!known) {
        reads += 1;
        // oxlint-disable-next-line no-await-in-loop -- one manifest at a time, a run's few
        ledger = await manifestLedgerOf(bucket, id);
      }
      storage.transactionSync(() => {
        // Asked again: a restore may have recorded it meanwhile.
        const orphan =
          !known &&
          rowOf(sql, id) === undefined &&
          (ledger === undefined ||
            sql
              .exec("SELECT 1 FROM erasures WHERE key > ? LIMIT 1", ledger)
              .toArray().length > 0);
        if (orphan) {
          enqueueDrop(storage, id);
        }
        sql.exec("UPDATE export_sweep SET cursor = ? WHERE id = 1", lastKey);
      });
    }
    if (page.truncated) {
      again(Math.max(reads, 1));
      return;
    }
    sql.exec("UPDATE export_sweep SET cursor = NULL WHERE id = 1");
  },
});

/**
 * Every export being written whose item of the queue is parked for good,
 * or gone, settled as failed and its files' deletion put on the queue; and
 * every restore running likewise settled as failed (restore.ts). So nothing
 * stays `writing` or `running` for ever, holding up the next. In the
 * caller's transaction.
 */
const settleStuck = (storage: DurableObjectStorage): void => {
  retire(storage, "failed", stuckExportSql, Date.now(), workParksMax);
  storage.sql.exec(
    `UPDATE restores SET state = 'failed', finished_at = ?1
    WHERE ${stuckRestoreSql}`,
    Date.now(),
    0,
    workParksMax
  );
};

/**
 * The tick's step for exports and restores at `now`, in one transaction:
 * the stale marked erased, those past their time expired, the stuck
 * settled as failed, and a sweep of `exports/` started when an erasure was
 * recorded since the last. Its rule is `exportsDueAt`.
 */
export const exportsStep = (
  storage: DurableObjectStorage,
  now: number
): void => {
  storage.transactionSync(() => {
    retire(storage, "erased", staleNowSql);
    retire(storage, "expired", pastItsTimeSql, now - exportKeptMs);
    settleStuck(storage);
    if (sweepDue(storage.sql)) {
      storage.sql.exec(
        `INSERT INTO export_sweep (id, through, cursor) VALUES (1, ${lastErasureSql}, NULL)
        ON CONFLICT (id) DO UPDATE SET through = excluded.through, cursor = NULL`
      );
      enqueueWork(storage, sweepWork, {
        key: "exports",
        payload: {},
        priority: "asked",
      });
    }
  });
};

/**
 * When the tick's step for exports next has something to do
 * (`exportsStep`), in milliseconds, or null: now for an export to mark
 * stale, an export or a restore stuck, or a sweep due; otherwise when the
 * first done export is past its time.
 */
export const exportsDueAt = (sql: SqlStorage, now: number): number | null => {
  const dueNow =
    sql
      .exec(
        `SELECT 1 FROM exports WHERE ${staleNowSql} AND NOT ${heldSql}
        UNION ALL SELECT 1 FROM exports WHERE ${stuckExportSql.replaceAll("?3", "?1")}
        UNION ALL SELECT 1 FROM restores WHERE ${stuckRestoreSql.replaceAll("?3", "?1")}
        LIMIT 1`,
        workParksMax
      )
      .toArray().length > 0 || sweepDue(sql);
  if (dueNow) {
    return now;
  }
  const first = sql
    .exec<{ at: number | null }>(
      `SELECT min(finished_at) AS at FROM exports
      WHERE state = 'done' AND NOT ${heldSql}`
    )
    .one().at;
  return first === null ? null : first + exportKeptMs;
};

/**
 * The lines of `selected`, read a few at a time, up to `exportPartBytes` of
 * encoded lines (at least one): each with its row and source, or null for
 * one whose file is gone, or whose readers the contract can't name (the
 * run ends there).
 */
const linesOf = async (
  bucket: BrainBucket,
  selected: readonly Selected[]
): Promise<{ row: number; source: string; line: Uint8Array | null }[]> => {
  const read: { row: number; source: string; line: Uint8Array | null }[] = [];
  let bytes = 0;
  for (let at = 0; at < selected.length; at += readsAtOnce) {
    // oxlint-disable-next-line no-await-in-loop -- a few at a time, until the part is full
    const texts = await Promise.all(
      selected.slice(at, at + readsAtOnce).map(async (version) => {
        const object = await bucket.get(fileKeyOf(version.file));
        return { version, text: object === null ? null : await object.text() };
      })
    );
    for (const { version, text } of texts) {
      const access = accessOfKey(version.readers);
      if (text === null || access === undefined) {
        read.push({ row: version.row, source: version.source, line: null });
        return read;
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
      const encoded = encoder.encode(`${JSON.stringify(line)}\n`);
      if (read.length > 0 && bytes + encoded.byteLength > exportPartBytes) {
        return read;
      }
      read.push({ row: version.row, source: version.source, line: encoded });
      bytes += encoded.byteLength;
    }
  }
  return read;
};

/**
 * Records that export `id` holds the sources of `subjects` (their keys as
 * the ledger names them). In the caller's transaction.
 */
export const recordExportSources = (
  sql: SqlStorage,
  id: string,
  subjects: Iterable<string>
): void => {
  for (const subject of subjects) {
    sql.exec(
      "INSERT OR IGNORE INTO export_sources (export, subject) VALUES (?, ?)",
      id,
      subject
    );
  }
};

/** Settles export `id`, still being written, as failed: its files deleted. */
const fail = (storage: DurableObjectStorage, id: string): void => {
  storage.transactionSync(() => {
    retire(
      storage,
      "failed",
      "exports.id = ?2 AND exports.state = 'writing'",
      id
    );
  });
};

/**
 * Writes the manifest of `row`, from its parts, and settles it done, in one
 * transaction with expiring the done one of its scope it replaces.
 */
const finish = async (
  storage: DurableObjectStorage,
  bucket: BrainBucket,
  row: ExportRow
): Promise<void> => {
  const parts = storage.sql
    .exec<{ part: number; hash: string; versions: number; bytes: number }>(
      "SELECT part, hash, versions, bytes FROM export_parts WHERE export = ? ORDER BY part",
      row.id
    )
    .toArray();
  const manifest: Manifest = {
    format: 1,
    id: row.id,
    deployment: row.deployment,
    ledger: row.ledger_mark,
    scope: row.scope,
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: new Date().toISOString(),
    versions: row.versions,
    parts: parts.map(({ part, hash, versions, bytes }) => ({
      file: partFileOf(part),
      sha256: hash,
      versions,
      bytes,
    })),
  };
  await bucket.put(
    exportKeyOf(row.id, manifestFile),
    JSON.stringify(manifest),
    { httpMetadata: { contentType: "application/json" } }
  );
  storage.transactionSync(() => {
    const done = storage.sql
      .exec(
        `UPDATE exports SET state = 'done', finished_at = ?
        WHERE id = ? AND state = 'writing' RETURNING id`,
        Date.now(),
        row.id
      )
      .toArray();
    if (done.length > 0) {
      retire(
        storage,
        "expired",
        `exports.state = 'done' AND exports.scope = ?2
          AND exports.subject IS ?3 AND exports.id != ?4`,
        row.scope,
        row.subject,
        row.id
      );
    }
  });
};

/** `parts` joined into one body. */
const joined = (parts: readonly Uint8Array[]): Uint8Array => {
  const body = new Uint8Array(
    parts.reduce((sum, part) => sum + part.byteLength, 0)
  );
  let at = 0;
  for (const part of parts) {
    body.set(part, at);
    at += part.byteLength;
  }
  return body;
};

/**
 * One run of an export: the next part written and recorded with the
 * sources it holds, or, once none is left, its manifest. A part that holds
 * what was erased meanwhile makes the export stale, which the tick then
 * retires (`exportsStep`), deleting its files, this part's among them.
 */
const writePart = async (
  id: string,
  { storage, bucket, again }: WorkContext
): Promise<void> => {
  const { sql } = storage;
  const row = rowOf(sql, id);
  if (row?.state !== "writing" || isStale(sql, id)) {
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
  const read = await linesOf(bucket, selected);
  const lines: Uint8Array[] = [];
  const sources = new Set<string>();
  let last = row.cursor;
  for (const { row: versionRow, source, line } of read) {
    if (line === null) {
      // Gone: only an erasure deletes a held file, and then its source is
      // hidden and left out of the next select; otherwise it fails, never
      // written as whole without it. A set the contract can't name (more
      // than one principal) fails it too, rather than be written as
      // something it isn't. What was read before it is written first.
      if (lines.length > 0) {
        break;
      }
      fail(storage, id);
      return;
    }
    lines.push(line);
    sources.add(source);
    last = versionRow;
  }
  const subjects = await Promise.all([...sources].map(subjectOf));
  const body = joined(lines);
  const hash = await hashOf(body);
  await bucket.put(exportKeyOf(id, partFileOf(row.parts)), body, {
    sha256: hash,
    httpMetadata: { contentType: "application/x-ndjson" },
  });
  const recorded = storage.transactionSync(() => {
    const now = rowOf(sql, id);
    if (now?.state !== "writing" || now.cursor !== row.cursor) {
      return false;
    }
    recordExportSources(sql, id, subjects);
    sql.exec(
      `INSERT INTO export_parts (export, part, hash, versions, bytes)
      VALUES (?, ?, ?, ?, ?)`,
      id,
      row.parts,
      hash,
      lines.length,
      body.byteLength
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
  if (recorded) {
    again(lines.length);
  }
};

/** Writing an export, a part a run (`writePart`). */
const exportWork = defineWork({
  kind: "brain.export",
  payload: exportPayload,
  run: async ({ id }, context) => {
    await writePart(id, context);
  },
});

/**
 * Starts an export of `whose` for `deployment`, of what the store holds
 * now: or answers with the one of the same scope being written. Refused
 * while a restore runs (restoring.ts). `personKey` is the person's set of
 * readers' key, for a person's. One transaction.
 */
export const startExport = (
  storage: DurableObjectStorage,
  whose: Whose,
  personKey: string | null,
  deployment: string
): string =>
  storage.transactionSync(() => {
    const { sql } = storage;
    if (isRestoring(sql)) {
      throw new Error(restoringNow);
    }
    const running = sql
      .exec<{ id: string }>(
        `SELECT id FROM exports WHERE state = 'writing' AND scope = ?
        AND subject IS ? AND NOT ${staleSql}`,
        whose.scope,
        whose.subject
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
      `INSERT INTO exports (id, scope, subject, deployment, reader_set, up_to,
        cursor, ledger_mark, state, parts, versions, started_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'writing', 0, 0, ?)`,
      id,
      whose.scope,
      whose.subject,
      deployment,
      readerSet,
      upTo,
      ledgerPlace(sql),
      Date.now()
    );
    enqueueWork(storage, exportWork, {
      key: keyOf(id),
      payload: { id },
      priority: "asked",
    });
    return id;
  });

/**
 * Records `manifest`'s export as one the store has, done as of now (its
 * time is kept from then), as a restore of it starts (restore.ts): the
 * sources it holds are recorded as the restore checks each part, so an
 * erasure of one of them makes it stale, as any export's. In the caller's
 * transaction.
 */
export const recordRestoredExport = (
  sql: SqlStorage,
  manifest: Manifest
): void => {
  sql.exec(
    `INSERT OR IGNORE INTO exports (id, scope, subject, deployment, reader_set,
      up_to, cursor, ledger_mark, state, parts, versions, started_at, finished_at)
    VALUES (?, 'company', NULL, ?, NULL, 0, 0, ?, 'done', ?, ?, ?, ?)`,
    manifest.id,
    manifest.deployment,
    manifest.ledger,
    manifest.parts.length,
    manifest.versions,
    Date.parse(manifest.startedAt),
    Date.now()
  );
  sql.exec("DELETE FROM export_parts WHERE export = ?", manifest.id);
  for (const [part, { sha256, versions, bytes }] of manifest.parts.entries()) {
    sql.exec(
      `INSERT INTO export_parts (export, part, hash, versions, bytes)
      VALUES (?, ?, ?, ?, ?)`,
      manifest.id,
      part,
      sha256,
      versions,
      bytes
    );
  }
};
