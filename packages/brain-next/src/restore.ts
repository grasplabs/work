import { drizzle } from "drizzle-orm/durable-sqlite";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { z } from "zod";

import type { BrainBucket } from "./bucket.ts";
import { chunksOf } from "./chunks.ts";
import {
  changeKeySchema,
  newSourceSchema,
  sourceIdSchema,
} from "./contract.ts";
import type { RestoreStatus } from "./contract.ts";
import { enqueueEmbedding } from "./embedding.ts";
import { erasuresSoFar, isErased, keepSubject, subjectOf } from "./erasure.ts";
import {
  exportKeyOf,
  exportLineSchema,
  manifestFile,
  manifestSchema,
} from "./exports.ts";
import type { ExportLine, Manifest } from "./exports.ts";
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
// a shared store that holds no version, a part a run of the queue, so it
// goes on across restarts.
//
// - Checked first: the manifest as written, each part's SHA-256 and count
//   against it before anything of the part is written, and each line by
//   the contract's own rules for a source, its text and its readers. A
//   part that fails any of these fails the restore, writing nothing of it.
// - Every version comes back as it was: its number, when it was added,
//   its readers, its change keys, whether it was current, indexed as it
//   was (an instruction file isn't).
// - The erasure ledger, applied as it is written: each version is left
//   out when the store's record of erasures names it (its source erased,
//   so its key is closed; or this version, named by a person's erasure),
//   asked again in the transaction that writes it. That record is the
//   whole ledger: the store answers nothing until it has read the ledger
//   through (store.ts), and an erasure that lands during the restore
//   covers what was restored before it as it covers any content. So the
//   ledger is replayed over all that comes back, and nothing erased does.
// - A version already there is passed over, so a run repeated after a
//   stop finds what the last one wrote and ends the same.

/** What a restore refuses to start, and why. */
const refusals = {
  notEmpty:
    "The Brain refused it: a restore goes only into a store that holds nothing",
  running: "The Brain refused it: a restore is under way",
  notFound: "The Brain refused it: no whole company export has that id",
} as const;

/** A restore's row, as the store keeps it. */
interface RestoreRow extends Record<string, SqlStorageValue> {
  export: string;
  manifest: string;
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

/** Whether the store holds any version, or a restore is under way: refusals.*. */
const refusalOf = (sql: SqlStorage): string | undefined => {
  if (
    sql.exec("SELECT 1 FROM restores WHERE state = 'running' LIMIT 1").toArray()
      .length > 0
  ) {
    return refusals.running;
  }
  return sql.exec("SELECT 1 FROM source_versions LIMIT 1").toArray().length > 0
    ? refusals.notEmpty
    : undefined;
};

/**
 * Whether this store's own record of export `id` says it may not be
 * restored: a person's, not done, or made stale by an erasure since. An
 * export it has no record of (its record lost with the store's storage) is
 * checked by the ledger alone, version by version.
 */
const unrestorable = (sql: SqlStorage, id: string): boolean => {
  const row = sql
    .exec<{ scope: string; state: string; erasure_mark: number }>(
      "SELECT scope, state, erasure_mark FROM exports WHERE id = ?",
      id
    )
    .toArray()
    .at(0);
  return (
    row !== undefined &&
    (row.scope !== "company" ||
      row.state !== "done" ||
      erasuresSoFar(sql) > row.erasure_mark)
  );
};

/** The key of the restore of `id` on the queue. */
const keyOf = (id: string): string => `restore:${id}`;

/** `id`'s manifest from the bucket, if it is a whole company export's. */
const manifestOf = async (
  bucket: BrainBucket,
  id: string
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
    manifest.data.scope === "company"
    ? manifest.data
    : undefined;
};

/** A line of a part, by the contract's own rules for what an add takes. */
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
    !z.array(changeKeySchema).safeParse(line.changes).success
  ) {
    context.addIssue({ code: "custom", message: "Not a version to restore" });
  }
});

/** The lines of part `body`, if it is the part the manifest names, whole. */
const linesOf = async (
  body: ArrayBuffer,
  part: Manifest["parts"][number]
): Promise<ExportLine[] | undefined> => {
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
 * Whether `line` is to be left out: a version of its source is there
 * already (this one, restored before), or the store's record of the
 * ledger names it (above). Asked in the transaction that writes it.
 */
const passedOver = (
  sql: SqlStorage,
  line: ExportLine,
  subject: string
): boolean =>
  isErased(sql, subject) ||
  sql
    .exec(
      `SELECT 1 FROM erased_versions WHERE subject = ? AND version = ?
      UNION ALL
      SELECT 1 FROM source_versions WHERE source = ? AND version = ?
      LIMIT 1`,
      subject,
      line.version,
      line.source,
      line.version
    )
    .toArray().length > 0;

/** What a restore of a version that must be made again says. */
const restoreAgain = "The restore lost a file while writing it: run it again";

/**
 * Writes `line` back as the version it was (above): its file first, then
 * the version whole, in one transaction, unless it is passed over.
 * Answers whether it was written.
 */
const restoreVersion = async (
  storage: DurableObjectStorage,
  db: DrizzleSqliteDODatabase,
  bucket: BrainBucket,
  line: ExportLine
): Promise<boolean> => {
  const encoder = new TextEncoder();
  const subject = await subjectOf(line.source);
  if (passedOver(storage.sql, line, subject)) {
    return false;
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
    if (passedOver(sql, line, subject)) {
      return false;
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
    if (line.current) {
      sql.exec(
        `INSERT INTO current_versions (source, version_row) VALUES (?, ?)
        ON CONFLICT (source) DO UPDATE SET version_row = excluded.version_row`,
        line.source,
        row
      );
      if (chunks.length > 0) {
        enqueueEmbedding(storage, line.source, line.version);
      }
    }
    return true;
  });
};

/** The restore's state set to `state`, once it is still running. */
const settle = (
  storage: DurableObjectStorage,
  id: string,
  state: "done" | "failed"
): void => {
  storage.sql.exec(
    `UPDATE restores SET state = ?, finished_at = ?
    WHERE export = ? AND state = 'running'`,
    state,
    Date.now(),
    id
  );
};

/** One run of a restore: the next part, checked, then written back. */
const restorePart = async (
  id: string,
  { storage, bucket, again }: WorkContext,
  db: DrizzleSqliteDODatabase
): Promise<void> => {
  const row = rowOf(storage.sql, id);
  if (row?.state !== "running") {
    return;
  }
  const manifest = manifestSchema.parse(JSON.parse(row.manifest));
  const part = manifest.parts[row.part];
  if (part === undefined) {
    settle(storage, id, "done");
    return;
  }
  const object = await bucket.get(exportKeyOf(id, part.file));
  const lines =
    object === null
      ? undefined
      : await linesOf(await object.arrayBuffer(), part);
  if (lines === undefined) {
    settle(storage, id, "failed");
    return;
  }
  let restored = 0;
  for (const line of lines) {
    // oxlint-disable-next-line no-await-in-loop -- a version at a time, each its own transaction
    if (await restoreVersion(storage, db, bucket, line)) {
      restored += 1;
    }
  }
  storage.transactionSync(() => {
    storage.sql.exec(
      `UPDATE restores SET part = part + 1, restored = restored + ?
      WHERE export = ? AND part = ? AND state = 'running'`,
      restored,
      id,
      row.part
    );
    if (row.part + 1 >= manifest.parts.length) {
      settle(storage, id, "done");
    }
  });
  if (row.part + 1 < manifest.parts.length) {
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
 * Starts restoring the company export `id` (above), or answers with the
 * restore of it started before. Throws, starting nothing, when the store
 * holds a version, a restore is under way, or the export isn't a whole
 * company export in the bucket. Asked again in the transaction that
 * records it, after the manifest was read.
 */
export const startRestore = async (
  storage: DurableObjectStorage,
  bucket: BrainBucket,
  id: string
): Promise<RestoreStatus> => {
  const { sql } = storage;
  const before = rowOf(sql, id);
  if (before !== undefined) {
    return statusOf(before);
  }
  const refused = refusalOf(sql);
  if (refused !== undefined) {
    throw new Error(refused);
  }
  if (unrestorable(sql, id)) {
    throw new Error(refusals.notFound);
  }
  const manifest = await manifestOf(bucket, id);
  if (manifest === undefined) {
    throw new Error(refusals.notFound);
  }
  return storage.transactionSync(() => {
    const started = rowOf(sql, id);
    if (started !== undefined) {
      return statusOf(started);
    }
    const now = refusalOf(sql);
    if (now !== undefined) {
      throw new Error(now);
    }
    if (unrestorable(sql, id)) {
      throw new Error(refusals.notFound);
    }
    sql.exec(
      `INSERT INTO restores (export, manifest, part, restored, state, started_at)
      VALUES (?, ?, 0, 0, 'running', ?)`,
      id,
      JSON.stringify(manifest),
      Date.now()
    );
    enqueueWork(storage, restoreWork, {
      key: keyOf(id),
      payload: { id },
      priority: "asked",
    });
    return { export: id, state: "running", restored: 0 };
  });
};
