import { drizzle } from "drizzle-orm/durable-sqlite";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { z } from "zod";

import type { BrainBucket } from "./bucket.ts";
import { chunksOf } from "./chunks.ts";
import {
  attributeRuleOf,
  changeKeySchema,
  isWholeKey,
  newMemoriesSchema,
  newSourceSchema,
  principalSchema,
  shippedSkillsPrefix,
  refusalPrefix,
  sourceIdSchema,
  storeBytesMax,
} from "./contract.ts";
import type { RestoreStatus } from "./contract.ts";
import { enqueueEmbedding } from "./embedding.ts";
import { keepNames } from "./entities.ts";
import { keepSubject, subjectOf } from "./erasure.ts";
import {
  changeLineSchema,
  confirmationLineSchema,
  dropPartsBeyond,
  exportKeyOf,
  exportFormat,
  exportLineSchema,
  extractionLineSchema,
  isStale,
  manifestFile,
  manifestPartsOf,
  manifestSchema,
  memoryLineSchema,
  namesAnySql,
  partHoldingsOf,
  recordExportSources,
  recordRestoredExport,
  retireIfStale,
} from "./exports.ts";
import type {
  ChangeLine,
  ConfirmationLine,
  ExportLine,
  ExtractionLine,
  Held,
  Manifest,
  MemoriesLine,
  MemoryLine,
} from "./exports.ts";
import {
  fileKeyOf,
  hashOf,
  holdFile,
  isHeld,
  isInDoubt,
  noteWrite,
} from "./files.ts";
import { lineageOfSource, lineageOfWriter } from "./memories.ts";
import { readerSetKeyOf, readerSetOf } from "./reader-sets.ts";
import { planOf, valueKeyFor } from "./remember.ts";
import { memoriesWrittenSinceSql, restoreFailedSql } from "./restoring.ts";
import { indexMemoryWords, indexWords } from "./words.ts";
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
//    A memory's line is checked by the add's own rules (contract.ts
//    `newMemoriesSchema` and its plan in remember.ts), as one group's.
// 2. Writing: every version as it was (its number, when it was added, its
//    readers, its change keys, whether it was current, indexed as it was);
//    then, in the order they were written, every memory (its id, the
//    entities it mentions by theirs, made where missing, the names it gave
//    them, when it was learned and retired), confirmation, extraction mark
//    and change key of memories (exports.ts). A memory or mark resting on
//    a version the store doesn't hold (the ledger left it out) is passed
//    over, and a confirmation naming a memory it doesn't hold. The store's
//    write stamp is raised to the export's as the restore starts, never
//    lowered (memories.ts `stampWrite`).
//
// The erasure ledger is applied as each version is written: it is left out
// when the store's record of erasures names it (its source erased, so its
// key is closed; or this version, named by a person's erasure), asked again
// in the transaction that writes it; and so as each memory and mark resting
// on one is. That record is the whole ledger: the
// store answers nothing until it has read the ledger through (store.ts),
// and an erasure that lands during the restore covers what was restored
// before it as it covers any content.
//
// While it runs, nothing is added to the store (restoring.ts): no add can
// meet a version it brings back. It never moves a current pointer that is
// there, and it counts only the versions it wrote. A version already there
// (written by a run the store stopped part-way) is passed over, so a run
// repeated finds what the last one wrote and ends the same, and a failed
// restore can be started again from the same export while the store holds
// nothing but what it wrote: once anything is added (a version, or any
// write of memories, which moves the write stamp), or the ledger names a
// version the export holds, the restore is given up (`abandoned`), and its
// export's files are no longer held (exports.ts `exportsStep`). It fails rather than
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
  // An export an older release made holds no memories: restored, it would
  // read as whole without them (exports.ts `exportFormat`).
  olderFormat: `${refusalPrefix} that export was made by an older release and holds no memories, so it can't be restored: make a new export`,
  // One a newer release made may hold what this one doesn't know.
  newerFormat: `${refusalPrefix} that export was made by a newer release, which this one can't restore`,
  // An abandoned restore's export id is refused for good: the store it
  // half-filled has been used since, or its export holds what the ledger
  // erased (its files are then deleted), so restoring it again would mix
  // what it wrote with what came after, or bring back nothing whole.
  givenUp: `${refusalPrefix} that restore was given up: the store took something since, or the ledger names what the export holds`,
} as const;

/** A restore's row, as the store keeps it. */
interface RestoreRow extends Record<string, SqlStorageValue> {
  export: string;
  checked: number;
  damaged: number;
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
 * `?1` a failed restore's export: whether the store took anything but
 * Grasp's own skills since it failed (`held_to`). Of SQL, so the tick asks
 * it too (exports.ts).
 */
export const addedSinceSql = `(EXISTS (
  SELECT 1 FROM source_versions
  WHERE source_versions.row > (
    SELECT coalesce(held_to, 0) FROM restores WHERE restores.export = ?1
  )
    AND substr(source_versions.source, 1, ${shippedSkillsPrefix.length})
      != '${shippedSkillsPrefix}'
) OR EXISTS (
  SELECT 1 FROM restores
  WHERE restores.export = ?1 AND ${memoriesWrittenSinceSql}
))`;

const addedSince = (sql: SqlStorage, id: string): boolean =>
  sql.exec(`SELECT 1 WHERE ${addedSinceSql}`, id).toArray().length > 0;

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
  // A failed restore of `id` starts again while the store holds nothing
  // but what it wrote.
  if (rowOf(sql, id)?.state === "failed") {
    return addedSince(sql, id) ? refusals.givenUp : undefined;
  }
  // Grasp's own skills, which a release installs, don't count: no export
  // holds them, so a restore never meets them. A memory does, with or
  // without a version (a writer's).
  return sql
    .exec(
      `SELECT 1 FROM source_versions
      WHERE substr(source, 1, ?1) != ?2
      UNION ALL SELECT 1 FROM memories
      LIMIT 1`,
      shippedSkillsPrefix.length,
      shippedSkillsPrefix
    )
    .toArray().length > 0
    ? refusals.notEmpty
    : undefined;
};

/**
 * Whether this store's own record of export `id` says it may not be
 * restored: not done, or holding what an erasure took. An
 * export it has no record of (its record lost with the store's storage) is
 * checked by the ledger alone, version by version.
 */
const unrestorable = (sql: SqlStorage, id: string): boolean => {
  // Its own failed restore holds it as it was: it starts again.
  if (rowOf(sql, id)?.state === "failed") {
    return false;
  }
  const row = sql
    .exec<{ state: string }>("SELECT state FROM exports WHERE id = ?", id)
    .toArray()
    .at(0);
  return row !== undefined && (row.state !== "done" || isStale(sql, id));
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
  // Another release's export of this deployment: refused for what it is.
  const other = z
    .looseObject({
      format: z.int(),
      id: z.literal(id),
      scope: z.literal("company"),
      deployment: z.literal(deployment),
    })
    .safeParse(parsed);
  if (other.success && other.data.format < exportFormat) {
    throw new Error(refusals.olderFormat);
  }
  if (other.success && other.data.format > exportFormat) {
    throw new Error(refusals.newerFormat);
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
 * A version's line: by the contract's own rules for what an add takes, and
 * by what a company export holds (above).
 */
const versionLineSchema = exportLineSchema.superRefine((line, context) => {
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
 * `line` as the add that would have made it: its entities by their ids,
 * its memory as given. Its entities' names and identifiers are left out:
 * the line holds them as stored, each checked by the contract's rule
 * (exports.ts `memoryLineSchema`), as many as one memory stored, which no
 * add's bound per entity (`namesPerEntityMax`) holds.
 */
const addOf = (line: MemoryLine): unknown => ({
  change: "restore",
  access: line.access,
  entities: line.entities.map(({ id, kind }) => ({ key: id, kind })),
  memories: [
    {
      about: line.about,
      ...(line.object === null ? {} : { object: line.object }),
      ...(line.attribute === null ? {} : { attribute: line.attribute }),
      ...(line.value === null ? {} : { value: line.value }),
      type: line.type,
      statement: line.statement,
      ...(line.validFrom === null
        ? {}
        : { validFrom: new Date(line.validFrom) }),
      ...(line.validUntil === null
        ? {}
        : { validUntil: new Date(line.validUntil) }),
      speaker: line.speaker,
      basis:
        line.writer === null
          ? {
              kind: "source",
              source: line.source,
              version: line.version,
              quote: line.quote,
            }
          : {
              kind: "writer",
              writer: line.writer,
              ...(line.quote === null ? {} : { quote: line.quote }),
            },
    },
  ],
});

/**
 * Whether `line` is a memory an add would take as one group's (the add's
 * own rules: contract.ts `newMemoriesSchema` and its plan), resting on a
 * version or a writer, never both.
 */
const isMemoryToRestore = (line: MemoryLine): boolean => {
  if (
    line.access.kind !== "audience" ||
    (line.writer === null) === (line.source === null) ||
    (line.source === null) !== (line.version === null)
  ) {
    return false;
  }
  const adding = newMemoriesSchema.safeParse(addOf(line));
  if (!adding.success) {
    return false;
  }
  try {
    planOf(adding.data);
  } catch {
    return false;
  }
  return true;
};

/** A line of a part (exports.ts): a version's, or one of the memories' steps'. */
const partLineSchema = z.union([
  versionLineSchema,
  memoryLineSchema.refine(isMemoryToRestore, {
    message: "Not a memory to restore",
  }),
  confirmationLineSchema.refine(
    ({ person }) => principalSchema.safeParse(person).success,
    { message: "Not a confirmation to restore" }
  ),
  extractionLineSchema.refine(
    ({ source, access }) =>
      sourceIdSchema.safeParse(source).success && access.kind === "audience",
    { message: "Not an extraction mark to restore" }
  ),
  changeLineSchema,
]);
type PartLine = z.infer<typeof partLineSchema>;

/** Whether `line` is a version's (it names no kind). */
const isVersionLine = (line: PartLine): line is ExportLine => !("kind" in line);

/**
 * The lines of part `part` read from the bucket, if it is the part the
 * manifest names, whole: its size first, from the bucket's own record,
 * before its body is read; then its SHA-256, count and every line.
 */
const partLinesOf = async (
  bucket: BrainBucket,
  id: string,
  part: Manifest["parts"][number]
): Promise<PartLine[] | undefined> => {
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
  if (lines.pop() !== "" || lines.length !== part.versions + part.memories) {
    return undefined;
  }
  const parsed: PartLine[] = [];
  for (const line of lines) {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return undefined;
    }
    const checked = partLineSchema.safeParse(json);
    if (!checked.success) {
      return undefined;
    }
    parsed.push(checked.data);
  }
  // As many of each as the manifest says.
  return parsed.filter(isVersionLine).length === part.versions
    ? parsed
    : undefined;
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
  // The one rule of what the ledger names (exports.ts `namesAnySql`).
  if (
    sql.exec(namesAnySql, JSON.stringify([[subject, line.version]])).toArray()
      .length > 0
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

/**
 * Whether the store holds version `version` of `source`, not hidden by an
 * erasure, and the ledger doesn't name it (`namesAnySql`): what a memory or
 * a mark resting on it needs to be written. In the caller's transaction.
 */
const holdsVersion = (
  sql: SqlStorage,
  source: string,
  subject: string,
  version: number
): boolean =>
  sql.exec(namesAnySql, JSON.stringify([[subject, version]])).toArray()
    .length === 0 &&
  sql
    .exec(
      `SELECT 1 FROM source_versions
      WHERE source = ? AND version = ?
        AND row NOT IN (SELECT version_row FROM erasing_versions)`,
      source,
      version
    )
    .toArray().length > 0;

/**
 * The row of each entity `line` mentions, by its id, made where the store
 * has none: undefined when one it has is of another kind (a part at odds
 * with another, which the check can't see), and the memory is then passed
 * over. In the caller's transaction.
 */
const entityRowsOf = (
  sql: SqlStorage,
  line: MemoryLine
): Map<string, number> | undefined => {
  const known = line.entities.map(({ id }) =>
    sql
      .exec<{ row: number; kind: string }>(
        "SELECT row, kind FROM entities WHERE id = ?",
        id
      )
      .toArray()
      .at(0)
  );
  // Every one checked before any is made, so none is left without its memory.
  if (
    line.entities.some(
      ({ kind }, index) =>
        known[index] !== undefined && known[index]?.kind !== kind
    )
  ) {
    return undefined;
  }
  return new Map(
    line.entities.map(({ id, kind }, index) => [
      id,
      known[index]?.row ??
        sql
          .exec<{ row: number }>(
            "INSERT INTO entities (id, kind) VALUES (?, ?) RETURNING row",
            id,
            kind
          )
          .one().row,
    ])
  );
};

/**
 * Whether the memory `line` is passed over: the store holds it already (a
 * run of this restore before), or it rests on a version the store doesn't
 * hold. In the caller's transaction.
 */
const passesOverMemory = (
  sql: SqlStorage,
  line: MemoryLine,
  subject: string | null
): boolean =>
  sql.exec("SELECT 1 FROM memories WHERE id = ?", line.id).toArray().length >
    0 ||
  (line.source !== null &&
    (subject === null ||
      line.version === null ||
      !holdsVersion(sql, line.source, subject, line.version)));

/** The lineage of the memory `line`: its writer's, or its source's. */
const lineageOf = (line: MemoryLine): string =>
  line.writer === null
    ? lineageOfSource(line.source ?? "")
    : lineageOfWriter(line.writer);

/**
 * Writes the memory `line` back as it was (above), with its words and the
 * names it gave the entities it mentions, in one transaction, unless the
 * store holds it already (a run of this restore before) or it rests on a
 * version the store doesn't hold.
 */
const restoreMemory = async (
  storage: DurableObjectStorage,
  db: DrizzleSqliteDODatabase,
  line: MemoryLine
): Promise<void> => {
  const subject = line.source === null ? null : await subjectOf(line.source);
  storage.transactionSync(() => {
    const { sql } = storage;
    if (passesOverMemory(sql, line, subject)) {
      return;
    }
    const rows = entityRowsOf(sql, line);
    const about = rows?.get(line.about);
    const kind = line.entities.find(({ id }) => id === line.about)?.kind;
    if (rows === undefined || about === undefined || kind === undefined) {
      return;
    }
    const rule =
      line.attribute === null
        ? undefined
        : attributeRuleOf(kind, line.attribute);
    // The set is stored (reads match readers by it); a memory names it by
    // its key.
    readerSetOf(db, line.access);
    const { row } = sql
      .exec<{ row: number }>(
        `INSERT INTO memories (id, entity, attribute, object, value, value_key,
          one_value, type, statement, quote, source, version, subject, writer,
          lineage, lineage_order, speaker, valid_from, valid_until, learned_at,
          retired_at, readers)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING row`,
        line.id,
        about,
        line.attribute,
        line.object === null ? null : (rows.get(line.object) ?? null),
        line.value,
        valueKeyFor(rule, line.value, line.object),
        rule?.values === "one" ? 1 : 0,
        line.type,
        line.statement,
        line.quote,
        line.source,
        line.version,
        subject,
        line.writer,
        lineageOf(line),
        line.version ?? 0,
        JSON.stringify(line.speaker),
        line.validFrom,
        line.validUntil,
        line.learnedAt,
        line.retiredAt,
        readerSetKeyOf(line.access)
      )
      .one();
    indexMemoryWords(sql, row, line.statement, new Map());
    for (const { id, names, identifiers } of line.entities) {
      const entity = rows.get(id);
      if (entity !== undefined) {
        keepNames(sql, entity, row, names, identifiers);
      }
    }
  });
};

/**
 * Writes the confirmation `line` back, over the memories it names, unless
 * the store lacks any of them (passed over, as erasing one deletes the
 * confirmation) or holds it already (the same memory, person and moment:
 * a run of this restore before). In one transaction.
 */
const restoreConfirmation = (
  storage: DurableObjectStorage,
  line: ConfirmationLine
): void => {
  storage.transactionSync(() => {
    const { sql } = storage;
    const named = [line.memory, ...line.over];
    const rows = sql
      .exec<{ id: string; row: number }>(
        "SELECT id, row FROM memories WHERE id IN (SELECT value FROM json_each(?))",
        JSON.stringify(named)
      )
      .toArray();
    const rowOfId = new Map(rows.map(({ id, row }) => [id, row]));
    const memory = rowOfId.get(line.memory);
    if (memory === undefined || named.some((id) => !rowOfId.has(id))) {
      return;
    }
    const there = sql
      .exec(
        `SELECT 1 FROM memory_confirmations
        WHERE memory = ? AND person = ? AND at = ?`,
        memory,
        line.person,
        line.at
      )
      .toArray();
    if (there.length > 0) {
      return;
    }
    const { row } = sql
      .exec<{ row: number }>(
        "INSERT INTO memory_confirmations (memory, person, at) VALUES (?, ?, ?) RETURNING row",
        memory,
        line.person,
        line.at
      )
      .one();
    for (const id of line.over) {
      sql.exec(
        `INSERT OR IGNORE INTO memory_confirmed_over (confirmation, memory)
        VALUES (?, ?)`,
        row,
        rowOfId.get(id) ?? null
      );
    }
  });
};

/**
 * Writes the extraction mark `line` back, unless the store doesn't hold
 * the version it marks; once per version and readers, as an add marks it.
 * In one transaction.
 */
const restoreExtraction = async (
  storage: DurableObjectStorage,
  db: DrizzleSqliteDODatabase,
  line: ExtractionLine
): Promise<void> => {
  const subject = await subjectOf(line.source);
  storage.transactionSync(() => {
    const { sql } = storage;
    if (!holdsVersion(sql, line.source, subject, line.version)) {
      return;
    }
    readerSetOf(db, line.access);
    sql.exec(
      `INSERT OR IGNORE INTO memory_extractions
        (source, version, subject, lineage, at, readers)
      VALUES (?, ?, ?, ?, ?, ?)`,
      line.source,
      line.version,
      subject,
      lineageOfSource(line.source),
      line.at,
      readerSetKeyOf(line.access)
    );
  });
};

/**
 * Writes the change key `line` back, once, only when it answered memories
 * and this restore wrote every one of them (the store held none before
 * it): so a change key in a bundle never answers for what it didn't bring
 * back, and never hides a later add of anything else. In one transaction.
 */
const restoreChange = (
  storage: DurableObjectStorage,
  line: ChangeLine
): void => {
  storage.transactionSync(() => {
    const { sql } = storage;
    const { memories } = line.answer;
    const restored = sql
      .exec<{ count: number }>(
        `SELECT count(*) AS count FROM memories
        WHERE id IN (SELECT value FROM json_each(?))`,
        JSON.stringify(memories)
      )
      .one().count;
    if (memories.length === 0 || restored !== new Set(memories).size) {
      return;
    }
    sql.exec(
      "INSERT OR IGNORE INTO memory_changes (key, hash, answer) VALUES (?, ?, ?)",
      line.key,
      line.hash,
      JSON.stringify(line.answer)
    );
  });
};

/**
 * Writes `line`, one of the memories' steps (exports.ts), back as it was,
 * unless it is passed over (above). A change key goes in as kept, once.
 */
const restoreMemoriesLine = async (
  storage: DurableObjectStorage,
  db: DrizzleSqliteDODatabase,
  line: MemoriesLine
): Promise<void> => {
  if (line.kind === "memory") {
    await restoreMemory(storage, db, line);
  } else if (line.kind === "confirmation") {
    restoreConfirmation(storage, line);
  } else if (line.kind === "extraction") {
    await restoreExtraction(storage, db, line);
  } else {
    restoreChange(storage, line);
  }
};

/** The restore's state set to `state`, once it is still running. In the caller's transaction. */
const settle = (
  storage: DurableObjectStorage,
  id: string,
  state: "done" | "failed"
): void => {
  const { sql } = storage;
  // Failed, it records the last row the store held (`restoreFailedSql`).
  const settled = sql
    .exec(
      state === "failed"
        ? `UPDATE restores SET ${restoreFailedSql}
          WHERE export = ?2 AND state = 'running' RETURNING export`
        : `UPDATE restores SET state = 'done', finished_at = ?1
          WHERE export = ?2 AND state = 'running' RETURNING export`,
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

/** The version `line` holds or rests on, if any. */
const restsOn = (
  line: PartLine
): { source: string; version: number } | undefined => {
  if (isVersionLine(line) || line.kind === "extraction") {
    return { source: line.source, version: line.version };
  }
  if (line.kind === "memory" && line.source !== null && line.version !== null) {
    return { source: line.source, version: line.version };
  }
  return undefined;
};

/**
 * Part `index` of the export `id` checked (the first pass, above): the
 * versions it holds recorded for the export, from its holdings file and
 * from its lines when they check, whether or not it does, so an erasure of
 * any of them reaches the export's files; and the restore marked damaged
 * when it doesn't, which fails it once every part is checked.
 */
const checkPart = async (
  storage: DurableObjectStorage,
  bucket: BrainBucket,
  id: string,
  index: number,
  part: Manifest["parts"][number]
): Promise<void> => {
  const [lines, holdings] = await Promise.all([
    partLinesOf(bucket, id, part),
    partHoldingsOf(bucket, id, index),
  ]);
  const fromLines: Held[] = await Promise.all(
    (lines ?? []).flatMap((line) => {
      const rests = restsOn(line);
      return rests === undefined
        ? []
        : [
            (async () =>
              [await subjectOf(rests.source), rests.version] as const)(),
          ];
    })
  );
  storage.transactionSync(() => {
    const { sql } = storage;
    recordExportSources(sql, id, [...(holdings ?? []), ...fromLines]);
    // A part whose lines don't check, or whose holdings are missing or
    // unreadable (what it holds may not all be on record), is damaged.
    sql.exec(
      `UPDATE restores SET checked = checked + 1,
        damaged = damaged OR ?3
      WHERE export = ?1 AND checked = ?2 AND state = 'running'`,
      id,
      index,
      lines === undefined || holdings === undefined ? 1 : 0
    );
  });
};

/**
 * Export `id`, adopted by its restore, made `done` once every part was
 * checked and none was damaged: then what each holds is on record, and it
 * may be served and restored again (exports.ts `recordRestoredExport`).
 * The one place that does it, for any number of parts, none among them.
 */
const adoptChecked = (storage: DurableObjectStorage, id: string): void => {
  storage.transactionSync(() => {
    storage.sql.exec(
      `UPDATE exports SET state = 'done', finished_at = ?1
      WHERE id = ?2 AND state = 'restoring'
        AND EXISTS (
          SELECT 1 FROM restores
          WHERE export = ?2 AND state = 'running' AND damaged = 0
            AND checked >= (SELECT count(*) FROM export_parts WHERE export = ?2)
        )`,
      Date.now(),
      id
    );
  });
};

/**
 * One run of a restore: the next part checked, while any is unchecked;
 * then, unless one was damaged, the next part written back.
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
  // What it needs of each part is in rows, never one value that grows
  // with how many parts there are.
  const parts = manifestPartsOf(sql, id);
  // Started by an older release, which restores no memories: its parts
  // have no count of them. Failed, never finished without them; the admin
  // restores a new export.
  if (parts === undefined) {
    settleNow(storage, id, "failed");
    return;
  }
  const checking = row.checked < parts.length;
  if (!checking) {
    if (row.damaged === 1) {
      settleNow(storage, id, "failed");
      return;
    }
    adoptChecked(storage, id);
  }
  const index = checking ? row.checked : row.part;
  const part = parts[index];
  if (part === undefined) {
    settleNow(storage, id, "done");
    return;
  }
  if (checking) {
    await checkPart(storage, bucket, id, index, part);
    again(1);
    return;
  }
  const lines = await partLinesOf(bucket, id, part);
  if (lines === undefined) {
    settleNow(storage, id, "failed");
    return;
  }
  // A store at its quota fails every write (contract.ts `storeBytesMax`).
  if (sql.databaseSize >= storeBytesMax) {
    settleNow(storage, id, "failed");
    return;
  }
  let restored = 0;
  for (const line of lines) {
    if (isVersionLine(line)) {
      // oxlint-disable-next-line no-await-in-loop -- a version at a time, each its own transaction
      if (await restoreVersion(storage, db, bucket, line)) {
        restored += 1;
      }
    } else {
      // oxlint-disable-next-line no-await-in-loop -- a line at a time, each its own transaction, in order
      await restoreMemoriesLine(storage, db, line);
    }
  }
  const last = index + 1 >= parts.length;
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
 * The manifest of the company export `id` of `deployment`, if a restore of
 * it may start now (above), or a restore of it under way or done to answer
 * with: throws, as `startRestore` refuses, when the store holds a version,
 * a restore is under way, or the export isn't a whole company export of
 * this deployment in the bucket.
 */
const restorable = async (
  storage: DurableObjectStorage,
  bucket: BrainBucket,
  id: string,
  deployment: string
): Promise<Manifest | RestoreStatus> => {
  const { sql } = storage;
  const before = rowOf(sql, id);
  if (before?.state === "abandoned") {
    throw new Error(refusals.givenUp);
  }
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
  return manifest;
};

/**
 * Whether a restore of the company export `id` of `deployment` may start
 * now, starting nothing: throws as `startRestore` refuses. So the host
 * can prepare the store for it first (core installs Grasp's own skills).
 */
export const checkRestore = async (
  storage: DurableObjectStorage,
  bucket: BrainBucket,
  id: string,
  deployment: string
): Promise<void> => {
  await restorable(storage, bucket, id, deployment);
};

/**
 * Starts restoring the company export `id` of `deployment` (above), or
 * answers with the restore of it under way or done; a failed one starts
 * again. Throws, starting nothing, as `restorable` refuses. Asked again in
 * the transaction that records it, after the manifest was read.
 */
export const startRestore = async (
  storage: DurableObjectStorage,
  bucket: BrainBucket,
  id: string,
  deployment: string
): Promise<RestoreStatus> => {
  const { sql } = storage;
  const manifest = await restorable(storage, bucket, id, deployment);
  if (!("format" in manifest)) {
    return manifest;
  }
  // Files past the parts the manifest names are never checked, so nothing
  // would record what they hold: they go before the export is adopted.
  await dropPartsBeyond(bucket, id, manifest.parts.length);
  return storage.transactionSync(() => {
    const started = rowOf(sql, id);
    if (started?.state === "abandoned") {
      throw new Error(refusals.givenUp);
    }
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
      `INSERT INTO restores (export, checked, part, restored, state, started_at)
      VALUES (?, 0, 0, 0, 'running', ?)
      ON CONFLICT (export) DO UPDATE SET
        checked = 0, damaged = 0, held_to = NULL, held_stamp = NULL, part = 0,
        restored = 0,
        state = 'running',
        started_at = excluded.started_at, finished_at = NULL`,
      id,
      Date.now()
    );
    recordRestoredExport(sql, manifest);
    // What the export learned by its stamp comes back: the store's stamp
    // is raised to it, never lowered (memories.ts `stampWrite`).
    sql.exec(
      `INSERT INTO memory_stamps (id, latest) VALUES (1, ?1)
      ON CONFLICT (id) DO UPDATE SET latest = max(latest, ?1)`,
      manifest.stamp
    );
    enqueueWork(storage, restoreWork, {
      key: keyOf(id),
      payload: { id },
      priority: "asked",
    });
    return { export: id, state: "running", restored: 0 };
  });
};
