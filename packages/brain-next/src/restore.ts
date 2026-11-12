import { drizzle } from "drizzle-orm/durable-sqlite";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { z } from "zod";

import type { BrainBucket } from "./bucket.ts";
import { chunksOf } from "./chunks.ts";
import {
  changeKeySchema,
  isWholeKey,
  newSourceSchema,
  shippedSkillsPrefix,
  refusalPrefix,
  sourceIdSchema,
  storeBytesMax,
} from "./contract.ts";
import type { RestoreStatus } from "./contract.ts";
import { enqueueEmbedding } from "./embedding.ts";
import { isErased, keepSubject, subjectOf } from "./erasure.ts";
import {
  exportKeyOf,
  exportLineSchema,
  isStale,
  manifestFile,
  manifestSchema,
  recordExportSources,
  recordRestoredExport,
  retireIfStale,
} from "./exports.ts";
import type { ExportLine, Held, Manifest } from "./exports.ts";
import {
  fileKeyOf,
  hashOf,
  holdFile,
  isHeld,
  isInDoubt,
  noteWrite,
} from "./files.ts";
import { readerSetOf } from "./reader-sets.ts";
import { indexWords } from "./words.ts";
import type { WordMemo } from "./words.ts";
import { WorkError, defineWork, enqueueWork } from "./work.ts";
import type { WorkContext } from "./work.ts";

// A restore: a company export (exports.ts), read back from the bucket into
// a shared store that holds no version, by the work queue a part a run, so
// it goes on across restarts. In two passes:
//
// 1. Checking, before anything is written: each part's size, SHA-256 and
//    count against the manifest, and each line by the contract's own rules
//    for a source, its text and its readers, and by what a company export
//    holds: readers a group names (never one person, never no one), no
//    skill Grasp ships, and what is kept whole (an instruction file or a
//    skill, never indexed) only as itself, as the store takes them
//    (contract.ts `wholeKeyPrefixes`), so a file can't make a document into
//    one, nor one into a document. A part that fails any of these fails the
//    restore, and nothing of the export is written. The sources each part
//    holds are recorded for the export as it is checked (exports.ts).
// 2. Writing: every version as it was (its number, when it was added, its
//    readers, its change keys, whether it was current, indexed as it was).
//
// The erasure ledger is applied as each version is written: it is left out
// when the store's record of erasures names it (its source erased, so its
// key is closed; or this version, named by a person's erasure), asked again
// in the transaction that writes it. That record is the whole ledger: the
// store answers nothing until it has read the ledger through (store.ts),
// and an erasure that lands during the restore covers what was restored
// before it as it covers any content.
//
// While it runs, nothing is added to the store (restoring.ts): no add can
// meet a version it brings back. It never moves a current pointer that is
// there, and it counts only the versions it wrote. A version already there
// (written by a run the store stopped part-way) is passed over, so a run
// repeated finds what the last one wrote and ends the same, and a failed
// restore can always be started again from the same export, whose files
// are never deleted while its restore runs or failed. It fails rather than
// fill the store past its quota (contract.ts `storeBytesMax`). Its export
// is recorded as one the store has (exports.ts `recordRestoredExport`), so
// an erasure of what it holds deletes its files once the restore is done.
//
// While it runs or once it failed part-way, the store answers from what it
// holds so far, each row checked for its reader as always: a half-restored
// store shows less, never more. A restored source whose current version the
// ledger left out keeps its history, which no one can read without a
// current version (sources.ts `readVersion`); the overview counts such
// sources (`sourcesWithoutCurrent`).

/** What a restore refuses to start, and why: each a refusal (contract.ts `refusalPrefix`). */
const refusals = {
  notEmpty: `${refusalPrefix} a restore goes only into a store that holds nothing`,
  running: `${refusalPrefix} a restore is under way`,
  notFound: `${refusalPrefix} no whole company export of this deployment has that id`,
} as const;

/** A restore's row, as the store keeps it. */
interface RestoreRow extends Record<string, SqlStorageValue> {
  export: string;
  manifest: string;
  checked: number;
  part: number;
  restored: number;
  state: RestoreStatus["state"];
}

const rowOf = (sql: SqlStorage, id: string): RestoreRow | undefined =>
  sql
    .exec<RestoreRow>("SELECT * FROM restores WHERE export = ?", id)
    .toArray()
    .at(0);

const statusOf = (row: RestoreRow): RestoreStatus => ({
  export: row.export,
  state: row.state,
  restored: row.restored,
});

/** Where the restore of `id` is: null when none was started. */
export const restoreStatus = (
  sql: SqlStorage,
  id: string
): RestoreStatus | null => {
  const row = rowOf(sql, id);
  return row === undefined ? null : statusOf(row);
};

/**
 * Why a restore of `id` may not start now, if it may not: one is under
 * way, or the store holds a version (but for a failed restore of `id`
 * started again, which finds what it wrote).
 */
const refusalOf = (sql: SqlStorage, id: string): string | undefined => {
  if (
    sql.exec("SELECT 1 FROM restores WHERE state = 'running' LIMIT 1").toArray()
      .length > 0
  ) {
    return refusals.running;
  }
  // A failed restore of `id` starts again, whatever it wrote.
  if (rowOf(sql, id)?.state === "failed") {
    return undefined;
  }
  // Grasp's own skills, which a release installs, don't count: no export
  // holds them, so a restore never meets them.
  return sql
    .exec(
      `SELECT 1 FROM source_versions
      WHERE substr(source, 1, ?1) != ?2 LIMIT 1`,
      shippedSkillsPrefix.length,
      shippedSkillsPrefix
    )
    .toArray().length > 0
    ? refusals.notEmpty
    : undefined;
};

/**
 * Whether this store's own record of export `id` says it may not be
 * restored: a person's, not done, or holding what an erasure took. An
 * export it has no record of (its record lost with the store's storage) is
 * checked by the ledger alone, version by version.
 */
const unrestorable = (sql: SqlStorage, id: string): boolean => {
  // Its own failed restore holds it as it was: it starts again.
  if (rowOf(sql, id)?.state === "failed") {
    return false;
  }
  const row = sql
    .exec<{ scope: string; state: string }>(
      "SELECT scope, state FROM exports WHERE id = ?",
      id
    )
    .toArray()
    .at(0);
  return (
    row !== undefined &&
    (row.scope !== "company" || row.state !== "done" || isStale(sql, id))
  );
};

/** The key of the restore of `id` on the queue. */
const keyOf = (id: string): string => `restore:${id}`;

/** `id`'s manifest from the bucket, if it is a whole company export of `deployment`. */
const manifestOf = async (
  bucket: BrainBucket,
  id: string,
  deployment: string
): Promise<Manifest | undefined> => {
  const object = await bucket.get(exportKeyOf(id, manifestFile));
  if (object === null) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await object.text());
  } catch {
    return undefined;
  }
  const manifest = manifestSchema.safeParse(parsed);
  return manifest.success &&
    manifest.data.id === id &&
    manifest.data.scope === "company" &&
    manifest.data.deployment === deployment
    ? manifest.data
    : undefined;
};

/**
 * A line of a part: by the contract's own rules for what an add takes, and
 * by what a company export holds (above).
 */
const lineSchema = exportLineSchema.superRefine((line, context) => {
  const asAdd = newSourceSchema.safeParse({
    source: line.source,
    change: "restore",
    text: line.text,
    access: line.access,
  });
  if (
    !asAdd.success ||
    !sourceIdSchema.safeParse(line.source).success ||
    !z.array(changeKeySchema).safeParse(line.changes).success ||
    line.access.kind !== "audience" ||
    line.source.startsWith(shippedSkillsPrefix) ||
    isWholeKey(line.source) === line.indexed
  ) {
    context.addIssue({ code: "custom", message: "Not a version to restore" });
  }
});

/**
 * The lines of part `part` read from the bucket, if it is the part the
 * manifest names, whole: its size first, from the bucket's own record,
 * before its body is read; then its SHA-256, count and every line.
 */
const partLinesOf = async (
  bucket: BrainBucket,
  id: string,
  part: Manifest["parts"][number]
): Promise<ExportLine[] | undefined> => {
  const object = await bucket.get(exportKeyOf(id, part.file));
  if (object === null || object.size !== part.bytes) {
    return undefined;
  }
  const body = await object.arrayBuffer();
  if ((await hashOf(new Uint8Array(body))) !== part.sha256) {
    return undefined;
  }
  const lines = new TextDecoder().decode(body).split("\n");
  // Written with a newline after each line.
  if (lines.pop() !== "" || lines.length !== part.versions) {
    return undefined;
  }
  const parsed: ExportLine[] = [];
  for (const line of lines) {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return undefined;
    }
    const checked = lineSchema.safeParse(json);
    if (!checked.success) {
      return undefined;
    }
    parsed.push(checked.data);
  }
  return parsed;
};

/**
 * Why `line` is not to be written, if it isn't: the store's record of the
 * ledger names it (above), or it is there already (written by a run of
 * this restore before, stopped part-way or failed: nothing else adds while
 * a restore runs). Asked again in the transaction that writes it.
 */
const passedOver = (
  sql: SqlStorage,
  line: ExportLine,
  subject: string
): "erased" | "there" | undefined => {
  if (
    isErased(sql, subject) ||
    sql
      .exec(
        "SELECT 1 FROM erased_versions WHERE subject = ? AND version = ? LIMIT 1",
        subject,
        line.version
      )
      .toArray().length > 0
  ) {
    return "erased";
  }
  return sql
    .exec(
      "SELECT 1 FROM source_versions WHERE source = ? AND version = ? LIMIT 1",
      line.source,
      line.version
    )
    .toArray().length > 0
    ? "there"
    : undefined;
};

/** What a restore of a version that must be made again says. */
const restoreAgain = "The restore lost a file while writing it: run it again";

/**
 * Writes `line` back as the version it was (above): its file first, then
 * the version whole, in one transaction, unless it is passed over. Answers
 * whether it is restored: written now, or by a run of this restore before,
 * so `restored` counts the whole restore across its restarts.
 */
const restoreVersion = async (
  storage: DurableObjectStorage,
  db: DrizzleSqliteDODatabase,
  bucket: BrainBucket,
  line: ExportLine
): Promise<boolean> => {
  const encoder = new TextEncoder();
  const subject = await subjectOf(line.source);
  const before = passedOver(storage.sql, line, subject);
  if (before !== undefined) {
    return before === "there";
  }
  const body = encoder.encode(line.text);
  const hash = await hashOf(body);
  const chunks = await Promise.all(
    (line.indexed ? chunksOf(line.text) : []).map(async (text) => ({
      text,
      hash: await hashOf(encoder.encode(text)),
    }))
  );
  if (isInDoubt(db, hash)) {
    throw new WorkError("failed");
  }
  if (!isHeld(db, hash)) {
    noteWrite(db, hash);
    await bucket.put(fileKeyOf(hash), body, {
      sha256: hash,
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    });
  }
  return storage.transactionSync(() => {
    const { sql } = storage;
    const now = passedOver(sql, line, subject);
    if (now !== undefined) {
      return now === "there";
    }
    if (isInDoubt(db, hash)) {
      throw new WorkError("failed");
    }
    if (!holdFile(db, hash)) {
      noteWrite(db, hash);
      throw new Error(restoreAgain);
    }
    const readerSet = readerSetOf(db, line.access);
    const { row } = sql
      .exec<{ row: number }>(
        `INSERT INTO source_versions (source, version, file, reader_set, added_at)
        VALUES (?, ?, ?, ?, ?) RETURNING row`,
        line.source,
        line.version,
        hash,
        readerSet,
        line.addedAt
      )
      .one();
    const memo: WordMemo = new Map();
    for (const [position, chunk] of chunks.entries()) {
      const written = sql
        .exec<{ row: number }>(
          `INSERT INTO chunks (version_row, position, text, hash)
          VALUES (?, ?, ?, ?) RETURNING row`,
          row,
          position,
          chunk.text,
          chunk.hash
        )
        .one();
      indexWords(sql, written.row, chunk.text, memo);
    }
    for (const change of line.changes) {
      sql.exec(
        `INSERT OR IGNORE INTO source_changes (source, change, version_row)
        VALUES (?, ?, ?)`,
        line.source,
        change,
        row
      );
    }
    keepSubject(sql, line.source, subject);
    // Never moves a pointer that is there.
    const pointed =
      line.current &&
      sql
        .exec(
          `INSERT INTO current_versions (source, version_row) VALUES (?, ?)
          ON CONFLICT (source) DO NOTHING RETURNING source`,
          line.source,
          row
        )
        .toArray().length > 0;
    if (pointed && chunks.length > 0) {
      enqueueEmbedding(storage, line.source, line.version);
    }
    return true;
  });
};

/** The restore's state set to `state`, once it is still running. In the caller's transaction. */
const settle = (
  storage: DurableObjectStorage,
  id: string,
  state: "done" | "failed"
): void => {
  const { sql } = storage;
  const settled = sql
    .exec(
      `UPDATE restores SET state = ?, finished_at = ?
      WHERE export = ? AND state = 'running' RETURNING export`,
      state,
      Date.now(),
      id
    )
    .toArray();
  // Done, its export is no longer held: the ledger may name what its files
  // hold (an erasure before or during the restore).
  if (settled.length > 0 && state === "done") {
    retireIfStale(storage, id);
  }
};

/** The restore's state settled in a transaction of its own. */
const settleNow = (
  storage: DurableObjectStorage,
  id: string,
  state: "done" | "failed"
): void => {
  storage.transactionSync(() => {
    settle(storage, id, state);
  });
};

/**
 * One run of a restore: the next part checked, while any is unchecked;
 * then the next part written back.
 */
const restorePart = async (
  id: string,
  { storage, bucket, again }: WorkContext,
  db: DrizzleSqliteDODatabase
): Promise<void> => {
  const { sql } = storage;
  const row = rowOf(sql, id);
  if (row?.state !== "running") {
    return;
  }
  const manifest = manifestSchema.parse(JSON.parse(row.manifest));
  const checking = row.checked < manifest.parts.length;
  const index = checking ? row.checked : row.part;
  const part = manifest.parts[index];
  if (part === undefined) {
    settleNow(storage, id, "done");
    return;
  }
  const lines = await partLinesOf(bucket, id, part);
  if (lines === undefined) {
    settleNow(storage, id, "failed");
    return;
  }
  if (checking) {
    const held: Held[] = await Promise.all(
      lines.map(
        async ({ source, version }) =>
          [await subjectOf(source), version] as const
      )
    );
    storage.transactionSync(() => {
      recordExportSources(sql, id, held);
      sql.exec(
        `UPDATE restores SET checked = checked + 1
        WHERE export = ? AND checked = ? AND state = 'running'`,
        id,
        index
      );
    });
    again(1);
    return;
  }
  // A store at its quota fails every write (contract.ts `storeBytesMax`).
  if (sql.databaseSize >= storeBytesMax) {
    settleNow(storage, id, "failed");
    return;
  }
  let restored = 0;
  for (const line of lines) {
    // oxlint-disable-next-line no-await-in-loop -- a version at a time, each its own transaction
    if (await restoreVersion(storage, db, bucket, line)) {
      restored += 1;
    }
  }
  const last = index + 1 >= manifest.parts.length;
  storage.transactionSync(() => {
    sql.exec(
      `UPDATE restores SET part = part + 1, restored = restored + ?
      WHERE export = ? AND part = ? AND state = 'running'`,
      restored,
      id,
      index
    );
    if (last) {
      settle(storage, id, "done");
    }
  });
  if (!last) {
    again(lines.length);
  }
};

/** Restoring an export, a part a run (`restorePart`). */
const restoreWork = defineWork({
  kind: "brain.restore",
  payload: z.strictObject({ id: z.uuid() }),
  run: async ({ id }, context) => {
    await restorePart(id, context, drizzle(context.storage));
  },
});

/**
 * Starts restoring the company export `id` of `deployment` (above), or
 * answers with the restore of it under way or done; a failed one starts
 * again. Throws, starting nothing, when the store holds a version, a
 * restore is under way, or the export isn't a whole company export of
 * this deployment in the bucket. Asked again in the transaction that
 * records it, after the manifest was read.
 */
export const startRestore = async (
  storage: DurableObjectStorage,
  bucket: BrainBucket,
  id: string,
  deployment: string
): Promise<RestoreStatus> => {
  const { sql } = storage;
  const before = rowOf(sql, id);
  if (before !== undefined && before.state !== "failed") {
    return statusOf(before);
  }
  const refused = refusalOf(sql, id);
  if (refused !== undefined) {
    throw new Error(refused);
  }
  if (unrestorable(sql, id)) {
    throw new Error(refusals.notFound);
  }
  const manifest = await manifestOf(bucket, id, deployment);
  if (manifest === undefined) {
    throw new Error(refusals.notFound);
  }
  return storage.transactionSync(() => {
    const started = rowOf(sql, id);
    if (started !== undefined && started.state !== "failed") {
      return statusOf(started);
    }
    const now = refusalOf(sql, id);
    if (now !== undefined) {
      throw new Error(now);
    }
    if (unrestorable(sql, id)) {
      throw new Error(refusals.notFound);
    }
    sql.exec(
      `INSERT INTO restores (export, manifest, checked, part, restored, state, started_at)
      VALUES (?, ?, 0, 0, 0, 'running', ?)
      ON CONFLICT (export) DO UPDATE SET manifest = excluded.manifest,
        checked = 0, part = 0, restored = 0, state = 'running',
        started_at = excluded.started_at, finished_at = NULL`,
      id,
      JSON.stringify(manifest),
      Date.now()
    );
    recordRestoredExport(sql, manifest);
    enqueueWork(storage, restoreWork, {
      key: keyOf(id),
      payload: { id },
      priority: "asked",
    });
    return { export: id, state: "running", restored: 0 };
  });
};
