import { z } from "zod";

import type { BrainBucket } from "./bucket.ts";
import {
  accessSchema,
  exportPartNameOf,
  exportPartOf,
  restoringNow,
  shippedSkillsPrefix,
} from "./contract.ts";
import type {
  Access,
  ExportFileRequest,
  ExportRequest,
  ExportStatus,
} from "./contract.ts";
import { subjectOf } from "./erasure.ts";
import { fileKeyOf, hashOf } from "./files.ts";
import { readerSetKeyOf } from "./reader-sets.ts";
import { isRestoring, restoreFailedSql } from "./restoring.ts";
import { defineWork, enqueueWork, workParksMax } from "./work.ts";
import type { WorkContext } from "./work.ts";

// Exports: the company's Brain, written as files in the shared store's
// part of the bucket, under `exports/<id>/`: parts of JSON Lines, a version
// a line, each beside the versions it holds (`partHoldsFileOf`), and a
// manifest written last, naming the deployment and each part with its
// SHA-256, size and how many versions it holds. So an export whose manifest
// is there is whole, and a restore (restore.ts) checks each part against
// it.
//
// What it holds: every version, current or history, with its readers, but
// those one person alone may read (a set of readers that is one person and
// nothing else) and those no one is known to read (a set with no one in it:
// an admin is not a reader of it), and every version of a source whose
// current version is such or that has none (no one else may read its
// history), left out in the statement that selects them; and the skills
// Grasp ships (contract.ts `shippedSkillsPrefix`), which each release adds
// again. It holds the company's instruction files and its own skills. An
// admin's export holds every group's content, those they are not in among
// them: that is what a company's backup is for. A person's own store never
// takes part in one; a person's own export is for later, with the store per
// person.
//
// What it takes is what the store held as it started (`up_to`, the last
// version's row), written by the work queue a part a run (`exportWork`),
// so it goes on across restarts and never holds the store long. A part is
// read a few versions at a time until its encoded lines reach
// `exportPartBytes`, so neither writing it nor reading it back holds more.
// (A version's row is used again only when an erasure deleted the last one;
// an add after the export started may then take a row it still reads. It
// is the company's to read as any version the export selects.)
//
// Erasure, one rule: an export is stale exactly when the erasure ledger
// names a version it holds. Each part records the versions it holds, by
// their source's key as the ledger names it and their number
// (`export_sources`); a source's erasure names every version of its source,
// a person's names each version it hid (`erased_versions`), whoever's export
// it is. So retention's erasures of what an export doesn't hold leave it be,
// and a person's erasure that hid a team source's history makes the
// company export holding that history stale. A stale export is never served
// (`exportFile` asks before and after it reads), a restore refuses it, and
// its files are deleted by the queue (`dropFiles`). The same rule is asked
// of a part's holdings before its files are put, and of a part as it is
// recorded, of an export as it finishes, of a restored export once its
// restore is done, of every export the store has a row of once per new
// erasure (the `checked` marker), and of export files the store has no
// record of. Re-checking each file against
// the ledger as it is read was the other way: it would leave erased content
// in the bucket, and filtering a checked part breaks its checksum. A copy
// someone already downloaded is outside the Brain's reach, and so outside
// its erasure. What an export holds stays on record (`export_sources`)
// until its files are gone; nothing yet reads that record to say whether an
// erasure is finished (the staff's erasure lookup is to, once it lands).
//
// The files outlive the store's record of them when its storage is lost or
// rolled back and its bucket kept. So each part's holdings are written
// beside it (`partHoldsFileOf`), and the sweep of `exports/` (`sweepWork`)
// deletes every export it has no row of whose manifest or holdings are
// gone, or whose holdings the ledger names: the same rule. A pass of the
// sweep is never restarted: it keeps the erasure it started for
// (`through`) and its place, and when it ends past a newer erasure the tick
// starts another; a pass whose item went (parked for good) goes on from its
// place. So each pass ends, and every erasure is covered by the first whole
// pass after it. A restore
// records the export it restores, its versions as it checks them; while its
// restore runs, or failed and may start again, its files are never deleted.
//
// Nothing stays put: a done export is replaced once a newer one of its
// scope is done; an export being written whose item of the queue is parked
// for good, or gone, is settled as failed and its files deleted
// (`settleStuck`); a restore likewise (restore.ts).

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

/** Most exports one run of the sweep reads the files of: each read is a page of R2's own. */
const sweepReads = 20;

const encoder = new TextEncoder();

/** Where `id`'s files are in the store's part of the bucket. */
const exportPrefixOf = (id: string): string => `${exportsPrefix}${id}/`;

/** The key of `id`'s file `file`. */
export const exportKeyOf = (id: string, file: string): string =>
  `${exportPrefixOf(id)}${file}`;

/** The name of part `index`. */
const partFileOf = (index: number): string => exportPartNameOf(index, "jsonl");

/** The manifest's file. */
export const manifestFile = "manifest.json";

/**
 * The versions part `index` holds, beside it: each by its source's key as
 * the ledger names it and its number. Written with the part, a part's
 * worth; for the sweep, which judges export files the store has no record
 * of by them (above); never served.
 */
const partHoldsFileOf = (index: number): string =>
  exportPartNameOf(index, "holds.json");

const holdsSchema = z.array(
  z.tuple([z.string().regex(/^[0-9a-f]{64}$/u), z.int().positive()])
);

/**
 * What part `index` of export `id` holds, by its holdings file: undefined
 * when it is missing or can't be read, which a restore counts as a damaged
 * part (restore.ts `checkPart`).
 */
export const partHoldingsOf = async (
  bucket: BrainBucket,
  id: string,
  index: number
): Promise<Held[] | undefined> => {
  const object = await bucket.get(exportKeyOf(id, partHoldsFileOf(index)));
  if (object === null) {
    return undefined;
  }
  try {
    const held = holdsSchema.safeParse(JSON.parse(await object.text()));
    return held.success ? held.data : undefined;
  } catch {
    return undefined;
  }
};

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
  scope: z.literal("company"),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  versions: z.int().nonnegative(),
  parts: z.array(
    z.strictObject({
      file: z.string().refine((name) => exportPartOf(name)?.holds === false, {
        message: "Not a part's file",
      }),
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
  deployment: string;
  up_to: number;
  cursor: number;
  state: "writing" | "restoring" | "done" | "failed" | "erased" | "expired";
  parts: number;
  versions: number;
  started_at: number;
  finished_at: number | null;
}

const rowOf = (sql: SqlStorage, id: string): ExportRow | undefined =>
  sql.exec<ExportRow>("SELECT * FROM exports WHERE id = ?", id).toArray().at(0);

/**
 * Whether the erasure ledger, as the store holds it, names the version
 * `version` of the source whose key's subject is `subject` (SQL
 * expressions): a source's erasure names every version, a person's those it
 * hid. The one rule of staleness (above).
 */
const namedSql = (subject: string, version: string): string => `(
  EXISTS (
    SELECT 1 FROM erasures
    WHERE erasures.kind = 'source' AND erasures.subject = ${subject}
  )
  OR EXISTS (
    SELECT 1 FROM erased_versions
    WHERE erased_versions.subject = ${subject}
      AND erased_versions.version = ${version}
  )
)`;

/** Of a row of `exports`: whether the ledger names a version it holds. */
const staleSql = `EXISTS (
  SELECT 1 FROM export_sources AS held
  WHERE held.export = exports.id
    AND ${namedSql("held.subject", "held.version")}
)`;

/** `?1` versions as JSON (`[subject, version]` each): whether the ledger names one. */
export const namesAnySql = `SELECT 1 FROM json_each(?1) AS pair
WHERE ${namedSql("pair.value ->> 0", "pair.value ->> 1")}
LIMIT 1`;

/** Of a row of `exports`: whether a restore of it runs, or failed and may start again. */
const heldSql = `exports.id IN (
  SELECT export FROM restores WHERE state IN ('running', 'failed')
)`;

/** Whether export `id` holds what an erasure since it started took. */
export const isStale = (sql: SqlStorage, id: string): boolean =>
  sql
    .exec(`SELECT 1 FROM exports WHERE exports.id = ? AND ${staleSql}`, id)
    .toArray().length > 0;

/** `id`'s items of the queue are under this key. */
const keyOf = (id: string): string => `export:${id}`;

/**
 * The versions an export selects. `unreadable` is every set one person
 * alone, or no one known, may read.
 */
const selectedSql = `source_versions.reader_set NOT IN (SELECT id FROM unreadable)
  AND substr(source_versions.source, 1, ${shippedSkillsPrefix.length})
    != '${shippedSkillsPrefix}'
  AND EXISTS (
    SELECT 1 FROM current_versions AS now
    JOIN source_versions AS current ON current.row = now.version_row
    WHERE now.source = source_versions.source
      AND current.reader_set NOT IN (SELECT id FROM unreadable)
  )`;

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
 * `?1` the cursor, `?2` up to, `?3` how many: the next versions it selects
 * after the cursor, in order of their rows, none an erasure hid.
 * Current: the version its source's current pointer names, or, where that
 * is a version added after the export started, the last one before it.
 */
const selectSql = `
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
    OR (current_versions.version_row > ?2 AND source_versions.row = (
      SELECT max(before.row) FROM source_versions AS before
      WHERE before.source = source_versions.source AND before.row <= ?2
    )),
    0
  ) AS current,
  EXISTS (SELECT 1 FROM chunks WHERE chunks.version_row = source_versions.row) AS indexed,
  (SELECT json_group_array(change) FROM source_changes
    WHERE source_changes.version_row = source_versions.row) AS changes
FROM source_versions
JOIN reader_sets ON reader_sets.id = source_versions.reader_set
LEFT JOIN current_versions ON current_versions.source = source_versions.source
WHERE source_versions.row > ?1 AND source_versions.row <= ?2
  AND source_versions.row NOT IN (SELECT version_row FROM erasing_versions)
  AND ${selectedSql}
ORDER BY source_versions.row
LIMIT ?3`;

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

/** Where the export of `request` is: null when there is none. */
export const exportStatus = (
  sql: SqlStorage,
  { id }: ExportRequest
): ExportStatus | null => {
  const row = rowOf(sql, id);
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
 * A file of a done export, as written: null for an export not done or
 * stale, one that doesn't exist, and a file it doesn't have, alike.
 * Asked again once the file is read: an erasure may have landed while it
 * was.
 */
export const exportFile = async (
  sql: SqlStorage,
  bucket: BrainBucket,
  { id, file }: ExportFileRequest
): Promise<string | null> => {
  const servable = (): boolean => {
    const row = rowOf(sql, id);
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
 * One page of export `id`'s files deleted, when they may go (`droppable`,
 * asked again after the listing: a restore may have recorded it meanwhile),
 * and once none is left, the record of what they held, with what kept an
 * erasure of it unfinished. Again while more are left. Part of an export's
 * one kind of work (`exportWork`), so never while a run of the same export
 * still writes a file.
 */
const dropFiles = async (
  id: string,
  { storage, bucket, again }: WorkContext
): Promise<void> => {
  if (!droppable(storage.sql, id)) {
    return;
  }
  const page = await bucket.list({
    prefix: exportPrefixOf(id),
    limit: dropPage,
  });
  if (!droppable(storage.sql, id)) {
    return;
  }
  if (page.objects.length > 0) {
    await bucket.delete(page.objects.map(({ key }) => key));
  }
  if (page.truncated) {
    again(page.objects.length);
    return;
  }
  storage.transactionSync(() => {
    if (droppable(storage.sql, id)) {
      storage.sql.exec("DELETE FROM export_sources WHERE export = ?", id);
    }
  });
};

/**
 * Puts export `id`'s work on the queue: writing it while it is being
 * written, deleting its files once it is not (`exportWork`). Set where that
 * kind is defined, below: its run writes and retires, and retiring puts
 * this work on the queue again.
 */
let enqueueExport: (storage: DurableObjectStorage, id: string) => void = () => {
  throw new Error("The export's work is not defined yet");
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
  // What they hold stays on record until their files are gone (`dropFiles`).
  for (const { id } of retired) {
    sql.exec("DELETE FROM export_parts WHERE export = ?", id);
    enqueueExport(storage, id);
  }
};

/** Of a row of `exports`: written or done, and stale. */
const staleNowSql = `exports.state IN ('writing', 'done') AND ${staleSql}`;

/**
 * Retires export `id` as erased when the ledger names a version it holds,
 * unless a restore holds it: for a restore that is done (restore.ts). In
 * the caller's transaction.
 */
export const retireIfStale = (
  storage: DurableObjectStorage,
  id: string
): void => {
  retire(storage, "erased", `exports.id = ?2 AND ${staleNowSql}`, id);
};

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

/**
 * `?1` the parks that make an item parked for good: whether a pass of the
 * sweep is on the queue.
 */
const sweepQueuedSql = `EXISTS (
  SELECT 1 FROM work_items
  WHERE work_items.kind = 'brain.export_sweep'
    AND (work_items.parked_at IS NULL OR work_items.parks < ?1)
)`;

/**
 * `?1` the parks that make an item parked for good: whether the tick has
 * an erasure to check every export against (recorded since it last did,
 * `checked`), or a pass of the sweep to start while none is on the queue:
 * an erasure past the one the last pass started for (`through`), or a pass
 * whose item went before it ended (its place saved).
 */
const sweepDueSql = `SELECT 1 WHERE
  ${lastErasureSql} > coalesce((SELECT checked FROM export_sweep WHERE id = 1), 0)
  OR (
    (
      ${lastErasureSql} > coalesce((SELECT through FROM export_sweep WHERE id = 1), 0)
      OR (SELECT cursor FROM export_sweep WHERE id = 1) IS NOT NULL
    )
    AND NOT ${sweepQueuedSql}
  )`;

/** Whether the tick has an erasure to check exports against, or a pass to start (`sweepDueSql`). */
const sweepDue = (sql: SqlStorage): boolean =>
  sql.exec(sweepDueSql, workParksMax).toArray().length > 0;

/**
 * Whether the export files `key` names, of an export the store has no row
 * of, may be dropped, by what that one file says (a run reads only it, and
 * for a part's holdings whether the manifest is there): a manifest that
 * can't be read or isn't a company's (nothing can serve or restore it); a
 * part's holdings without a manifest beside them (an export never
 * finished), or that can't be read, or that the ledger names; a part
 * without its holdings beside it (it can't be judged). Answers how
 * many reads it took, too. Other files say nothing: their export is judged
 * by these.
 */
const orphanFileDrops = async (
  sql: SqlStorage,
  bucket: BrainBucket,
  id: string,
  file: string
): Promise<{ drop: boolean; reads: number }> => {
  if (file === manifestFile) {
    const object = await bucket.get(exportKeyOf(id, file));
    if (object === null) {
      return { drop: true, reads: 1 };
    }
    try {
      const manifest = manifestSchema.safeParse(
        JSON.parse(await object.text())
      );
      return {
        drop: !manifest.success || manifest.data.scope !== "company",
        reads: 1,
      };
    } catch {
      return { drop: true, reads: 1 };
    }
  }
  // A part without its holdings beside it can't be judged: it goes.
  const part = exportPartOf(file);
  if (part === undefined) {
    return { drop: false, reads: 0 };
  }
  if (!part.holds) {
    const holds = await bucket.head(
      exportKeyOf(id, partHoldsFileOf(part.index))
    );
    return { drop: holds === null, reads: 1 };
  }
  const [manifest, holds] = await Promise.all([
    bucket.head(exportKeyOf(id, manifestFile)),
    bucket.get(exportKeyOf(id, file)),
  ]);
  if (manifest === null || holds === null) {
    return { drop: true, reads: 2 };
  }
  try {
    const held = holdsSchema.safeParse(JSON.parse(await holds.text()));
    return {
      drop:
        !held.success ||
        sql.exec(namesAnySql, JSON.stringify(held.data)).toArray().length > 0,
      reads: 2,
    };
  } catch {
    return { drop: true, reads: 2 };
  }
};

/**
 * The sweep's place saved at `key`, in one transaction with the deletion
 * of export `id`'s files put on the queue when `drop` says so and the store
 * still has no row of it (a restore may have recorded it meanwhile).
 */
const sweptKey = (
  storage: DurableObjectStorage,
  id: string,
  key: string,
  drop: boolean
): void => {
  storage.transactionSync(() => {
    if (drop && rowOf(storage.sql, id) === undefined) {
      enqueueExport(storage, id);
    }
    storage.sql.exec("UPDATE export_sweep SET cursor = ? WHERE id = 1", key);
  });
};

/**
 * The sweep of `exports/` (above), a key at a time from where the last run
 * stopped: each file of an export the store has no row of that says its
 * export may go (`orphanFileDrops`) puts the deletion of that export's
 * files on the queue. Its place is saved after each key, with what it
 * decided; it makes at most `sweepReads` reads a run, and goes on again
 * while the listing does. A pass is never started over: an erasure that
 * lands during it is checked against the exports it already passed by the
 * next pass, which the tick starts once this one is through, so each pass
 * ends and every erasure is covered by the first whole pass after it.
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
    let reads = 0;
    for (const { key } of page.objects) {
      if (reads >= sweepReads) {
        again(reads);
        return;
      }
      const [id = "", file = ""] = key.slice(exportsPrefix.length).split("/");
      const unknown = id !== "" && file !== "" && rowOf(sql, id) === undefined;
      let judged = { drop: false, reads: 0 };
      if (unknown) {
        // oxlint-disable-next-line no-await-in-loop -- a file at a time, a run's few reads
        judged = await orphanFileDrops(sql, bucket, id, file);
      }
      reads += judged.reads;
      sweptKey(storage, id, key, judged.drop);
    }
    if (page.truncated) {
      again(Math.max(reads, 1));
      return;
    }
    // The pass is through: the tick starts another if an erasure was
    // recorded past the one it started for.
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
    `UPDATE restores SET ${restoreFailedSql} WHERE ${stuckRestoreSql}`,
    Date.now(),
    0,
    workParksMax
  );
};

/**
 * Of a row of `restores`: a failed one to give up, as it failed before its
 * export was wholly checked (still `restoring`: what its files hold is not
 * all on record, so they go), the store took something since it failed
 * (`held_to`, but Grasp's own skills), or the ledger names a version its
 * export holds.
 */
const givenUpSql = `restores.state = 'failed' AND (
  EXISTS (
    SELECT 1 FROM exports
    WHERE exports.id = restores.export AND exports.state = 'restoring'
  )
  OR
  EXISTS (
    SELECT 1 FROM source_versions
    WHERE source_versions.row > coalesce(restores.held_to, 0)
      AND substr(source_versions.source, 1, ${shippedSkillsPrefix.length})
        != '${shippedSkillsPrefix}'
  )
  OR EXISTS (
    SELECT 1 FROM exports WHERE exports.id = restores.export AND ${staleSql}
  )
)`;

/**
 * Every failed restore to give up (`givenUpSql`) settled as abandoned, its
 * export no longer held: retired at once when the ledger names a version
 * it holds. In the caller's transaction.
 */
const giveUpRestores = (storage: DurableObjectStorage): void => {
  const given = storage.sql
    .exec<{ export: string }>(
      `UPDATE restores SET state = 'abandoned' WHERE ${givenUpSql} RETURNING export`
    )
    .toArray();
  for (const restore of given) {
    // Adopted and never wholly checked: what its files hold is not all on
    // record, so they go.
    retire(
      storage,
      "failed",
      "exports.id = ?2 AND exports.state = 'restoring'",
      restore.export
    );
    retireIfStale(storage, restore.export);
  }
};

/**
 * The tick's step for exports and restores, in one transaction: the stuck
 * settled as failed and failed restores given up; once per new erasure
 * (the `checked` marker), every export the ledger now makes stale retired
 * (`staleSql`); and, when no pass of the sweep is on the queue, a pass
 * started: from the first key when an erasure was recorded past the one
 * the last pass started for (`through`), or from its saved place when a
 * pass's item went before it ended. A pass is never restarted. Its rule is
 * `exportsDue`. Between erasures nothing can make an export stale: a part
 * and a restore done are asked as they land (`writePart`, `retireIfStale`).
 */
export const exportsStep = (storage: DurableObjectStorage): void => {
  storage.transactionSync(() => {
    const { sql } = storage;
    settleStuck(storage);
    giveUpRestores(storage);
    const at = sql
      .exec<{
        last: number;
        checked: number;
        through: number;
        cursor: string | null;
      }>(
        `SELECT ${lastErasureSql} AS last,
          coalesce((SELECT checked FROM export_sweep WHERE id = 1), 0) AS checked,
          coalesce((SELECT through FROM export_sweep WHERE id = 1), 0) AS through,
          (SELECT cursor FROM export_sweep WHERE id = 1) AS cursor`
      )
      .one();
    sql.exec(
      "INSERT OR IGNORE INTO export_sweep (id, through, checked, cursor) VALUES (1, 0, 0, NULL)"
    );
    if (at.last > at.checked) {
      retire(storage, "erased", staleNowSql);
      sql.exec("UPDATE export_sweep SET checked = ? WHERE id = 1", at.last);
    }
    const queued =
      sql.exec(`SELECT 1 WHERE ${sweepQueuedSql}`, workParksMax).toArray()
        .length > 0;
    if (queued) {
      return;
    }
    if (at.last > at.through) {
      sql.exec(
        "UPDATE export_sweep SET through = ?, cursor = NULL WHERE id = 1",
        at.last
      );
    }
    // A new pass, or one whose item went before it ended, from its place.
    if (at.last > at.through || at.cursor !== null) {
      enqueueWork(storage, sweepWork, {
        key: "exports",
        payload: {},
        priority: "asked",
      });
    }
  });
};

/**
 * Whether the tick's step for exports has something to do (`exportsStep`):
 * an erasure recorded since it last looked, a failed restore to give up,
 * or an export or a restore stuck.
 */
export const exportsDue = (sql: SqlStorage): boolean =>
  sweepDue(sql) ||
  sql.exec(`SELECT 1 FROM restores WHERE ${givenUpSql} LIMIT 1`).toArray()
    .length > 0 ||
  sql
    .exec(
      `SELECT 1 FROM exports WHERE ${stuckExportSql.replaceAll("?3", "?1")}
      UNION ALL SELECT 1 FROM restores WHERE ${stuckRestoreSql.replaceAll("?3", "?1")}
      LIMIT 1`,
      workParksMax
    )
    .toArray().length > 0;

/**
 * The lines of `selected`, read a few at a time, up to `exportPartBytes` of
 * encoded lines (at least one): each with its row and source, or null for
 * one whose file is gone, or whose readers the contract can't name (the
 * run ends there).
 */
const linesOf = async (
  bucket: BrainBucket,
  selected: readonly Selected[]
): Promise<
  { row: number; source: string; version: number; line: Uint8Array | null }[]
> => {
  const read: {
    row: number;
    source: string;
    version: number;
    line: Uint8Array | null;
  }[] = [];
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
        read.push({
          row: version.row,
          source: version.source,
          version: version.version,
          line: null,
        });
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
      read.push({
        row: version.row,
        source: version.source,
        version: version.version,
        line: encoded,
      });
      bytes += encoded.byteLength;
    }
  }
  return read;
};

/** A version an export holds: its source's key as the ledger names it, and its number. */
export type Held = readonly [subject: string, version: number];

/**
 * Records that export `id` holds `held`. In the caller's transaction.
 */
export const recordExportSources = (
  sql: SqlStorage,
  id: string,
  held: readonly Held[]
): void => {
  for (const [subject, version] of held) {
    sql.exec(
      `INSERT OR IGNORE INTO export_sources (export, subject, version)
      VALUES (?, ?, ?)`,
      id,
      subject,
      version
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
 * Deletes every part file, and its holdings, numbered `parts` or past:
 * what a run wrote before the store stopped and a later run, finding other
 * versions, didn't write again. Before the manifest makes the export
 * whole, so it holds nothing it doesn't name.
 */
const dropPartsBeyond = async (
  bucket: BrainBucket,
  id: string,
  parts: number
): Promise<void> => {
  let startAfter: string | undefined;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a page after a page
    const page = await bucket.list({
      prefix: exportPrefixOf(id),
      ...(startAfter === undefined ? {} : { startAfter }),
      limit: dropPage,
    });
    const beyond = page.objects
      .map(({ key }) => key)
      .filter((key) => {
        const part = exportPartOf(key.slice(exportPrefixOf(id).length));
        return part !== undefined && part.index >= parts;
      });
    if (beyond.length > 0) {
      // oxlint-disable-next-line no-await-in-loop -- a page after a page
      await bucket.delete(beyond);
    }
    startAfter = page.objects.at(-1)?.key;
    if (!page.truncated || startAfter === undefined) {
      return;
    }
  }
};

/**
 * Writes `row`'s manifest, from its parts, and settles it done, in one
 * transaction with expiring the done one of its scope it replaces: unless
 * it is stale by then (retired as erased) or a restore began since it
 * started (retired as failed), and then the one before stays.
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
    scope: "company",
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
  await dropPartsBeyond(bucket, row.id, parts.length);
  await bucket.put(
    exportKeyOf(row.id, manifestFile),
    JSON.stringify(manifest),
    { httpMetadata: { contentType: "application/json" } }
  );
  storage.transactionSync(() => {
    const { sql } = storage;
    if (rowOf(sql, row.id)?.state !== "writing") {
      return;
    }
    // Stale as it finished: never done, and the one it would replace stays.
    if (isStale(sql, row.id)) {
      retire(storage, "erased", "exports.id = ?2", row.id);
      return;
    }
    // A restore began since it started (or runs): what it holds is of the
    // store before, and must not replace the restored backup.
    const restoredSince =
      isRestoring(sql) ||
      sql
        .exec(
          "SELECT 1 FROM restores WHERE started_at >= ? LIMIT 1",
          row.started_at
        )
        .toArray().length > 0;
    if (restoredSince) {
      retire(storage, "failed", "exports.id = ?2", row.id);
      return;
    }
    const done = sql
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
        "exports.state = 'done' AND exports.id != ?2",
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
  const selected = sql
    .exec<Selected>(selectSql, row.cursor, row.up_to, exportPartVersions)
    .toArray();
  if (selected.length === 0) {
    await finish(storage, bucket, row);
    return;
  }
  const read = await linesOf(bucket, selected);
  const lines: Uint8Array[] = [];
  const versions: { source: string; version: number }[] = [];
  let last = row.cursor;
  for (const { row: versionRow, source, version, line } of read) {
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
    versions.push({ source, version });
    last = versionRow;
  }
  const held: Held[] = await Promise.all(
    versions.map(
      async ({ source, version }) => [await subjectOf(source), version] as const
    )
  );
  // Written ahead: what the part holds is on record before any of its
  // files are put, so a store that stops between the puts and the part's
  // record leaves files an erasure of what they hold still reaches (the
  // deletion lists the export's prefix). The ledger is asked here too.
  const ahead = storage.transactionSync(() => {
    const now = rowOf(sql, id);
    if (now?.state !== "writing" || now.cursor !== row.cursor) {
      return false;
    }
    recordExportSources(sql, id, held);
    if (sql.exec(namesAnySql, JSON.stringify(held)).toArray().length > 0) {
      retire(storage, "erased", "exports.id = ?2", id);
      return false;
    }
    return true;
  });
  if (!ahead) {
    return;
  }
  const body = joined(lines);
  const hash = await hashOf(body);
  await bucket.put(
    exportKeyOf(id, partHoldsFileOf(row.parts)),
    JSON.stringify(held),
    { httpMetadata: { contentType: "application/json" } }
  );
  await bucket.put(exportKeyOf(id, partFileOf(row.parts)), body, {
    sha256: hash,
    httpMetadata: { contentType: "application/x-ndjson" },
  });
  const recorded = storage.transactionSync(() => {
    const now = rowOf(sql, id);
    if (now?.state !== "writing" || now.cursor !== row.cursor) {
      return false;
    }
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
    // The part as it lands: an erasure that came while it was written, of
    // one of its versions, makes the export stale now.
    if (sql.exec(namesAnySql, JSON.stringify(held)).toArray().length > 0) {
      retire(storage, "erased", "exports.id = ?2", id);
      return false;
    }
    return true;
  });
  if (recorded) {
    again(lines.length);
  }
};

/**
 * An export's one kind of work, under one key: a part written a run while
 * it is being written (`writePart`), and its files deleted once it is not
 * (`dropFiles`: stale, failed, replaced, or unknown to the store). The
 * queue never runs two of one kind and key at once, so no file of a run
 * still writing lands after its files were deleted.
 */
const exportWork = defineWork({
  kind: "brain.export",
  payload: exportPayload,
  run: async ({ id }, context) => {
    if (rowOf(context.storage.sql, id)?.state === "writing") {
      await writePart(id, context);
      if (rowOf(context.storage.sql, id)?.state === "writing") {
        return;
      }
    }
    await dropFiles(id, context);
  },
});

enqueueExport = (storage, id) => {
  enqueueWork(storage, exportWork, {
    key: keyOf(id),
    payload: { id },
    priority: "asked",
  });
};

/**
 * Starts an export for `deployment` of what the store holds now: or
 * answers with the one being written. Refused while a restore runs
 * (restoring.ts). One transaction.
 */
export const startExport = (
  storage: DurableObjectStorage,
  deployment: string
): string =>
  storage.transactionSync(() => {
    const { sql } = storage;
    if (isRestoring(sql)) {
      throw new Error(restoringNow);
    }
    const running = sql
      .exec<{ id: string }>(
        `SELECT id FROM exports WHERE state = 'writing' AND NOT ${staleSql}`
      )
      .toArray()
      .at(0);
    if (running !== undefined) {
      return running.id;
    }
    const id = crypto.randomUUID();
    const upTo = sql
      .exec<{ last: number }>(
        "SELECT coalesce(max(row), 0) AS last FROM source_versions"
      )
      .one().last;
    sql.exec(
      `INSERT INTO exports (id, deployment, up_to, cursor, state, parts,
        versions, started_at)
      VALUES (?, ?, ?, 0, 'writing', 0, 0, ?)`,
      id,
      deployment,
      upTo,
      Date.now()
    );
    enqueueExport(storage, id);
    return id;
  });

/**
 * Records `manifest`'s export as one the store has, as a restore of it
 * starts (restore.ts): `restoring` until the restore has checked every part
 * and recorded what each holds, then `done` (restore.ts `checkPart`). Until
 * then nothing could tell whether the ledger names what its files hold, so
 * it is neither served (`exportFile`) nor restored again by another
 * restore; it stays held while its restore runs or failed, and its files go
 * if that restore is given up before its check ends. The sweep no longer
 * looks at it, as at any export the store has a row of. In the caller's
 * transaction.
 */
export const recordRestoredExport = (
  sql: SqlStorage,
  manifest: Manifest
): void => {
  sql.exec(
    `INSERT OR IGNORE INTO exports (id, deployment, up_to, cursor, state,
      parts, versions, started_at, finished_at)
    VALUES (?, ?, 0, 0, 'restoring', ?, ?, ?, ?)`,
    manifest.id,
    manifest.deployment,
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
