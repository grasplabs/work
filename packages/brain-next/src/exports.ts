import { z } from "zod";

import type { BrainBucket } from "./bucket.ts";
import {
  accessSchema,
  entityIdSchema,
  entityKinds,
  exportPartNameOf,
  exportPartOf,
  identifierSchema,
  memoryIdSchema,
  memoryTypes,
  nameSchema,
  restoringNow,
  shippedSkillsPrefix,
  speakerSchema,
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
import { answerSchema } from "./remember.ts";
import {
  isRestoring,
  memoriesWrittenSinceSql,
  restoreFailedSql,
} from "./restoring.ts";
import { defineWork, enqueueWork, workParksMax } from "./work.ts";
import type { WorkContext } from "./work.ts";

// Exports: the company's Brain, written as files in the shared store's
// part of the bucket, under `exports/<id>/`: parts of JSON Lines, a version
// a line, each beside the versions it holds (`partHoldsFileOf`), and a
// manifest written last, naming the deployment and each part with its
// SHA-256, size and how many versions and lines of memories it holds. So an
// export whose manifest is there is whole, and a restore (restore.ts)
// checks each part against it.
//
// After the versions, the memories, in steps (`memoryPhases`), each a part
// a run in the order of its rows: memories, each with the entities it
// mentions by their ids and the names and identifiers it gave them;
// confirmations, by the ids of the memories they name; extraction marks;
// and the change keys of adds of memories (as the store keeps them,
// hashed). Nothing names a row: a restore makes new ones, in the same
// order, so what that order decides (a writer's latest memory, the latest
// confirmation) comes back as it was. What it takes is what the store had
// learned as it started (`stamp`, its latest write stamp then): what was
// learned, confirmed, marked or retired after is left out, and the
// manifest carries that stamp, so a restore never lowers the store's
// (memories.ts `stampWrite`).
//
// What it holds: every version, current or history, with its readers, but
// those one person alone may read (a set of readers that is one person and
// nothing else) and those no one is known to read (a set with no one in it:
// an admin is not a reader of it), and every version of a source whose
// current version is such or that has none (no one else may read its
// history), left out in the statement that selects them; and the skills
// Grasp ships (contract.ts `shippedSkillsPrefix`), which each release adds
// again. It holds the company's instruction files and its own skills. Of
// memories and extraction marks, those one group reads (the shared store
// keeps none only one person may read) and that rest on no version, or on
// one the export holds, in the statement that selects them
// (`exportedMemorySql`): so it never holds a memory drawn from what it
// leaves out. A confirmation goes with its memories: only when every
// memory it names is held. An
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
// names a version it holds. Each part records the versions it holds, and
// those its memories and extraction marks rest on, by their source's key as
// the ledger names it and their number (`export_sources`); a source's erasure names every version of its source,
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

/**
 * An entity a memory line mentions: its id and kind, and the names and
 * identifiers that memory gave it, as stored: each by the contract's own
 * rule, and as many as the memory gave. That is no add's bound
 * (`namesPerEntityMax` is per entity of an add): two entities of one add
 * that link to one entity, both named by one memory, store both sets.
 */
const mentionedSchema = z.strictObject({
  id: entityIdSchema,
  kind: z.enum(entityKinds),
  names: z.array(nameSchema),
  identifiers: z.array(identifierSchema),
});

/**
 * A line of a memory, as the store holds it: what an add took (checked by
 * the add's own rules again on a restore), with its id, when it was learned
 * and retired, and the entities it mentions. Its basis is a version
 * (`source` and `version`, with `quote`) or a writer.
 */
export const memoryLineSchema = z.strictObject({
  kind: z.literal("memory"),
  id: memoryIdSchema,
  about: entityIdSchema,
  object: entityIdSchema.nullable(),
  entities: z.array(mentionedSchema),
  attribute: z.string().nullable(),
  value: z.string().nullable(),
  type: z.enum(memoryTypes),
  statement: z.string(),
  quote: z.string().nullable(),
  source: z.string().nullable(),
  version: z.int().positive().nullable(),
  writer: z.string().nullable(),
  speaker: speakerSchema,
  /** The world clock, in milliseconds. */
  validFrom: z.int().nullable(),
  validUntil: z.int().nullable(),
  /** When the store learned it, and retired it if it did by then, in milliseconds. */
  learnedAt: z.int().nonnegative(),
  retiredAt: z.int().nonnegative().nullable(),
  access: accessSchema,
});
export type MemoryLine = z.infer<typeof memoryLineSchema>;

/** A line of a confirmation: the memory confirmed and those it was made over, by id. */
export const confirmationLineSchema = z.strictObject({
  kind: z.literal("confirmation"),
  memory: memoryIdSchema,
  person: z.string(),
  at: z.int().nonnegative(),
  over: z.array(memoryIdSchema),
});
export type ConfirmationLine = z.infer<typeof confirmationLineSchema>;

/** A line of an extraction mark: the version marked, when, and for whose readers. */
export const extractionLineSchema = z.strictObject({
  kind: z.literal("extraction"),
  source: z.string(),
  version: z.int().positive(),
  at: z.int().nonnegative(),
  access: accessSchema,
});
export type ExtractionLine = z.infer<typeof extractionLineSchema>;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

/**
 * A line of an add of memories' change key, as the store keeps it: the
 * SHA-256 of the key and of what it added, and what it answered (ids
 * only), so a retry made after a restore answers as before.
 */
export const changeLineSchema = z.strictObject({
  kind: z.literal("change"),
  key: sha256Schema,
  hash: sha256Schema,
  answer: answerSchema,
});
export type ChangeLine = z.infer<typeof changeLineSchema>;

/** A line of a part past the versions: one of the memories' steps (`memoryPhases`). */
export type MemoriesLine =
  | MemoryLine
  | ConfirmationLine
  | ExtractionLine
  | ChangeLine;

/**
 * The format of the exports this release writes, and the only one it
 * restores: format 2 holds memories, and an export of format 1 (versions
 * only) would come back as a Brain without them while reading as whole,
 * so a restore refuses it (restore.ts) and the admin makes a new export.
 */
export const exportFormat = 2;

/** An export's manifest, as written last. */
export const manifestSchema = z.strictObject({
  format: z.literal(exportFormat),
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
  /** Lines of memories, in all its parts. */
  memories: z.int().nonnegative(),
  /**
   * The store's latest write stamp of memories as it started: a restore
   * raises the store's to it, never lowers it.
   */
  stamp: z.int().nonnegative(),
  parts: z.array(
    z
      .strictObject({
        file: z.string().refine((name) => exportPartOf(name)?.holds === false, {
          message: "Not a part's file",
        }),
        sha256: sha256Schema,
        versions: z.int().nonnegative(),
        /** Its lines of memories. */
        memories: z.int().nonnegative(),
        bytes: z.int().positive(),
      })
      .refine(({ versions, memories }) => versions + memories > 0, {
        message: "A part holds no line",
      })
  ),
});
export type Manifest = z.infer<typeof manifestSchema>;

/**
 * An export being written by this release: started with the stamp and the
 * bound of change keys it takes (`startExport`). One an older release
 * started has neither, and is failed (`writePart`).
 */
type WritingRow = ExportRow & { stamp: number; changes_up_to: number };

/** An export's row, as the store keeps it. */
interface ExportRow extends Record<string, SqlStorageValue> {
  id: string;
  deployment: string;
  up_to: number;
  cursor: number;
  phase: number | null;
  stamp: number | null;
  changes_up_to: number | null;
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
const unreadableSql = `unreadable AS (
  SELECT reader_set AS id FROM reader_set_members
  GROUP BY reader_set HAVING count(*) = 1 AND max(kind) = 'person'
  UNION
  SELECT id FROM reader_sets
  WHERE id NOT IN (SELECT reader_set FROM reader_set_members)
)`;

const selectSql = `
WITH ${unreadableSql}
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

/**
 * The steps of an export past its versions, in order, each by its number
 * in `exports.phase` (its index plus one): a part holds lines of one step,
 * read in the order of that table's rows.
 */
export const memoryPhases = [
  "memories",
  "confirmations",
  "extractions",
  "changes",
] as const;

/** Most rows one part of a step of memories reads; its bytes bound it first. */
const memoryPartRows = 500;

/**
 * Whether the set of readers whose key is `key` (an expression) is one
 * group: what a company export holds of memories and extraction marks
 * (the contract's `audience`), never one person alone or no one.
 */
const oneGroupSql = (key: string): string =>
  `(json_array_length(${key}) = 1 AND ${key} ->> '$[0][0]' = 'group')`;

/**
 * `?2` the export: whether a part it wrote holds the version `version` of
 * the source whose key the ledger names `subject` (expressions)
 * (`export_sources.written`). Decided by what its versions' parts wrote,
 * never by asking again of the store as it is now: a source closed since
 * keeps the memories of what was written, and one opened since gets none
 * of what wasn't.
 */
const writtenVersionSql = (
  subject: string,
  version: string
): string => `EXISTS (
  SELECT 1 FROM export_sources AS held
  WHERE held.export = ?2 AND held.subject = ${subject}
    AND held.version = ${version} AND held.written = 1
)`;

/**
 * `?2` the export, `?4` the stamp it started at: whether the memory
 * `alias` is one the export holds: learned by then, read by one group, and
 * resting on no version or one a part of it wrote.
 */
const exportedMemorySql = (alias: string): string => `(
  ${alias}.learned_at <= ?4
  AND ${oneGroupSql(`${alias}.readers`)}
  AND (${alias}.source IS NULL
    OR ${writtenVersionSql(`${alias}.subject`, `${alias}.version`)})
)`;

/**
 * Each step's statement (`memoryPhases`): `?1` the last row written, `?2`
 * the export, `?3` how many, `?4` the stamp
 * it started at, `?5` the last change's row it takes. Each row with its
 * `row`, in order.
 */
const memoryPhaseSql: Record<(typeof memoryPhases)[number], string> = {
  memories: `SELECT m.row AS row, m.id AS id, about.id AS about, object.id AS object,
  m.attribute AS attribute, m.value AS value, m.type AS type,
  m.statement AS statement, m.quote AS quote, m.source AS source,
  m.version AS version, m.subject AS subject, m.writer AS writer,
  m.speaker AS speaker, m.valid_from AS valid_from,
  m.valid_until AS valid_until, m.learned_at AS learned_at,
  CASE WHEN m.retired_at <= ?4 THEN m.retired_at END AS retired_at,
  m.readers AS readers,
  (SELECT json_group_array(json_array(named.id, named.kind))
    FROM entities AS named WHERE named.row IN (m.entity, m.object)) AS entities,
  (SELECT json_group_array(json_array(named.id, entity_names.type, entity_names.value))
    FROM entity_names JOIN entities AS named ON named.row = entity_names.entity
    WHERE entity_names.memory = m.row) AS names
FROM memories AS m
JOIN entities AS about ON about.row = m.entity
LEFT JOIN entities AS object ON object.row = m.object
WHERE m.row > ?1 AND ${exportedMemorySql("m")}
ORDER BY m.row
LIMIT ?3`,
  confirmations: `SELECT confirmed.row AS row, m.id AS memory, confirmed.person AS person,
  confirmed.at AS at,
  (SELECT json_group_array(other.id) FROM memory_confirmed_over AS over
    JOIN memories AS other ON other.row = over.memory
    WHERE over.confirmation = confirmed.row) AS over
FROM memory_confirmations AS confirmed
JOIN memories AS m ON m.row = confirmed.memory
WHERE confirmed.row > ?1 AND confirmed.at <= ?4 AND ${exportedMemorySql("m")}
  AND NOT EXISTS (
    SELECT 1 FROM memory_confirmed_over AS over
    LEFT JOIN memories AS other ON other.row = over.memory
    WHERE over.confirmation = confirmed.row
      AND (other.row IS NULL OR NOT ${exportedMemorySql("other")})
  )
ORDER BY confirmed.row
LIMIT ?3`,
  extractions: `SELECT marked.rowid AS row, marked.source AS source, marked.version AS version,
  marked.subject AS subject, marked.at AS at, marked.readers AS readers
FROM memory_extractions AS marked
WHERE marked.rowid > ?1 AND marked.at <= ?4
  AND ${oneGroupSql("marked.readers")}
  AND ${writtenVersionSql("marked.subject", "marked.version")}
ORDER BY marked.rowid
LIMIT ?3`,
  // A change goes with its memories: only one that answered some, each
  // held by the export (a restore writes it only when it restored them
  // all, restore.ts).
  changes: `SELECT changed.rowid AS row, changed.key AS key, changed.hash AS hash,
  changed.answer AS answer
FROM memory_changes AS changed
WHERE changed.rowid > ?1 AND changed.rowid <= ?5
  AND json_array_length(changed.answer, '$.memories') > 0
  AND NOT EXISTS (
    SELECT 1 FROM json_each(changed.answer, '$.memories') AS answered
    LEFT JOIN memories AS m ON m.id = answered.value
    WHERE m.row IS NULL OR NOT ${exportedMemorySql("m")}
  )
ORDER BY changed.rowid
LIMIT ?3`,
};

/** A row of a step's statement, as it comes. */
type PhaseRow = Record<string, SqlStorageValue> & { row: number };

const textOf = (value: SqlStorageValue | undefined): string =>
  z.string().parse(value);
const textOrNull = (value: SqlStorageValue | undefined): string | null =>
  z.string().nullable().parse(value);
const intOrNull = (value: SqlStorageValue | undefined): number | null =>
  z.int().nullable().parse(value);
/** A column a statement built with `json_group_array` or kept as JSON. */
const jsonOf = (value: SqlStorageValue | undefined): unknown =>
  JSON.parse(textOf(value));

/** The access a set of readers' key names, which a step selects only as one group's. */
const groupAccessOf = (key: SqlStorageValue | undefined): Access => {
  const access = accessOfKey(textOf(key));
  if (access?.kind !== "audience") {
    throw new Error("The Brain selected readers it doesn't export");
  }
  return access;
};

/**
 * A row of step `phase` as its line, with the version it rests on (by its
 * source's key as the ledger names it), if it rests on one.
 */
const memoriesLineOf = (
  phase: (typeof memoryPhases)[number],
  row: PhaseRow
): { line: MemoriesLine; held: Held | undefined } => {
  if (phase === "memories") {
    const names = z
      .array(z.tuple([z.string(), z.string(), z.string()]))
      .parse(jsonOf(row.names));
    const entities = z
      .array(z.tuple([z.string(), z.string()]))
      .parse(jsonOf(row.entities));
    const source = textOrNull(row.source);
    const version = intOrNull(row.version);
    const line = memoryLineSchema.parse({
      kind: "memory",
      id: row.id,
      about: row.about,
      object: row.object,
      entities: entities.map(([id, kind]) => ({
        id,
        kind,
        names: names.flatMap(([of, type, value]) =>
          of === id && type === "name" ? [value] : []
        ),
        identifiers: names.flatMap(([of, type, value]) =>
          of === id && type !== "name" ? [{ type, value }] : []
        ),
      })),
      attribute: row.attribute,
      value: row.value,
      type: row.type,
      statement: row.statement,
      quote: row.quote,
      source,
      version,
      writer: row.writer,
      speaker: jsonOf(row.speaker),
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      learnedAt: row.learned_at,
      retiredAt: row.retired_at,
      access: groupAccessOf(row.readers),
    });
    const subject = textOrNull(row.subject);
    return {
      line,
      held:
        subject === null || version === null ? undefined : [subject, version],
    };
  }
  if (phase === "confirmations") {
    return {
      line: confirmationLineSchema.parse({
        kind: "confirmation",
        memory: row.memory,
        person: row.person,
        at: row.at,
        over: jsonOf(row.over),
      }),
      held: undefined,
    };
  }
  if (phase === "extractions") {
    const line = extractionLineSchema.parse({
      kind: "extraction",
      source: row.source,
      version: row.version,
      at: row.at,
      access: groupAccessOf(row.readers),
    });
    return { line, held: [textOf(row.subject), line.version] };
  }
  return {
    line: changeLineSchema.parse({
      kind: "change",
      key: row.key,
      hash: row.hash,
      answer: jsonOf(row.answer),
    }),
    held: undefined,
  };
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
 * for a part's holdings whether the manifest is there): a manifest that is
 * missing, isn't JSON, or, read loosely, isn't a company export of that id
 * (nothing can serve or restore it); never for its format, so a build
 * rolled back to an older release keeps what a newer one wrote, and the
 * other way round, each judged by its holdings as below; a
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
      const manifest = z
        .looseObject({ id: z.literal(id), scope: z.literal("company") })
        .safeParse(JSON.parse(await object.text()));
      return { drop: !manifest.success, reads: 1 };
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
 * Of a row of `restores`: a failed one whose check found a damaged part
 * while its export was still `restoring` (what its files hold may not all
 * be on record, so they go), or one that failed with its export no longer
 * adopted (`handedBackSql`) or checked whole, once the store took
 * something since it failed (a version past `held_to`, but Grasp's own
 * skills, or a write of memories past `held_stamp`) or the ledger names a
 * version its export holds: to give up.
 */
const givenUpSql = `restores.state = 'failed' AND (
  (
    restores.damaged = 1 AND EXISTS (
      SELECT 1 FROM exports
      WHERE exports.id = restores.export AND exports.state = 'restoring'
    )
  )
  OR
  EXISTS (
    SELECT 1 FROM source_versions
    WHERE source_versions.row > coalesce(restores.held_to, 0)
      AND substr(source_versions.source, 1, ${shippedSkillsPrefix.length})
        != '${shippedSkillsPrefix}'
  )
  OR ${memoriesWrittenSinceSql}
  OR EXISTS (
    SELECT 1 FROM exports WHERE exports.id = restores.export AND ${staleSql}
  )
)`;

/**
 * Of a row of `restores`: a failed one whose check found no damage but
 * didn't end (its item of the queue parked for good or gone: an outage,
 * a throw), its export still `restoring`. Nothing was wrong with the
 * export, and after a storage loss it may be the company's only copy.
 */
const handedBackSql = `restores.state = 'failed' AND restores.damaged = 0
  AND EXISTS (
    SELECT 1 FROM exports
    WHERE exports.id = restores.export AND exports.state = 'restoring'
  )`;

/**
 * Every adopted export whose check stopped (`handedBackSql`) handed back
 * to the sweep, as one the store has no record of: its rows deleted, its
 * files kept, and the sweep's pass marked as covering no erasure, so the
 * next pass judges them by the ledger (`orphanFileDrops`), as soon as one
 * is recorded. Its restore stays failed, to start again. In the caller's
 * transaction.
 */
const handBackStopped = (storage: DurableObjectStorage): void => {
  const { sql } = storage;
  const handed = sql
    .exec<{ export: string }>(
      `SELECT export FROM restores WHERE ${handedBackSql}`
    )
    .toArray();
  for (const { export: id } of handed) {
    sql.exec("DELETE FROM export_sources WHERE export = ?", id);
    sql.exec("DELETE FROM export_parts WHERE export = ?", id);
    sql.exec("DELETE FROM exports WHERE id = ?", id);
  }
  if (handed.length > 0) {
    sql.exec("UPDATE export_sweep SET through = 0 WHERE id = 1");
  }
};

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
    // Adopted, and its check found a damaged part: what its files hold is
    // not all on record, so they go.
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
 * settled as failed, adopted exports whose check stopped handed back to
 * the sweep, and failed restores given up; once per new erasure
 * (the `checked` marker), every export the ledger now makes stale retired
 * (`staleSql`); and, when no pass of the sweep is on the queue, a pass
 * started: from the first key when an erasure was recorded past the one
 * the last pass started for (`through`), or from its saved place when a
 * pass's item went before it ended. A pass is never restarted, but from
 * the first key once an export is handed back, which its saved place may
 * be past. Its rule is
 * `exportsDue`. Between erasures nothing can make an export stale: a part
 * and a restore done are asked as they land (`writePart`, `retireIfStale`).
 */
export const exportsStep = (storage: DurableObjectStorage): void => {
  storage.transactionSync(() => {
    const { sql } = storage;
    settleStuck(storage);
    handBackStopped(storage);
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
 * an erasure recorded since it last looked, a failed restore to give up
 * or an adopted export to hand back, or an export or a restore stuck.
 */
export const exportsDue = (sql: SqlStorage): boolean =>
  sweepDue(sql) ||
  sql
    .exec(
      `SELECT 1 FROM restores WHERE (${givenUpSql}) OR (${handedBackSql}) LIMIT 1`
    )
    .toArray().length > 0 ||
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
 * whole, and before a restore adopts it, so it holds nothing it doesn't
 * name.
 */
export const dropPartsBeyond = async (
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

/** A part of an export, as `export_parts` records it. */
interface PartRow extends Record<string, SqlStorageValue> {
  part: number;
  hash: string;
  versions: number;
  memories: number | null;
  bytes: number;
}

/** The parts of export `id`, in order, as recorded. */
const partRowsOf = (sql: SqlStorage, id: string): PartRow[] =>
  sql
    .exec<PartRow>(
      `SELECT part, hash, versions, memories, bytes FROM export_parts
      WHERE export = ? ORDER BY part`,
      id
    )
    .toArray();

/**
 * The parts of export `id` as its manifest names them, in order: none
 * when a part has no count of memories, recorded by an older release that
 * wrote none (exports.ts `exportFormat`), so it is never taken as zero.
 */
export const manifestPartsOf = (
  sql: SqlStorage,
  id: string
): Manifest["parts"] | undefined => {
  const parts: Manifest["parts"] = [];
  for (const { part, hash, versions, memories, bytes } of partRowsOf(sql, id)) {
    if (memories === null) {
      return undefined;
    }
    parts.push({
      file: partFileOf(part),
      sha256: hash,
      versions,
      memories,
      bytes,
    });
  }
  return parts;
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
  row: WritingRow
): Promise<void> => {
  const parts = manifestPartsOf(storage.sql, row.id);
  if (parts === undefined) {
    fail(storage, row.id);
    return;
  }
  const manifest: Manifest = {
    format: exportFormat,
    id: row.id,
    deployment: row.deployment,
    scope: "company",
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: new Date().toISOString(),
    versions: row.versions,
    memories: parts.reduce((sum, { memories }) => sum + memories, 0),
    stamp: row.stamp,
    parts,
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
 * The lines of the next part, its step (`phase`: null for versions), the
 * last row it reads (its step's cursor), and what it holds: how many
 * versions and lines of memories, and the versions they rest on.
 */
interface NextPart {
  lines: Uint8Array[];
  phase: number | null;
  cursor: number;
  versions: number;
  memories: number;
  held: Held[];
}

/**
 * The next part of versions after `row`'s cursor: none once they are all
 * written; `failed` when the first one's file is gone, or its readers are
 * not the contract's (see `linesOf`).
 */
const versionsPart = async (
  sql: SqlStorage,
  bucket: BrainBucket,
  row: ExportRow
): Promise<NextPart | "failed" | undefined> => {
  const selected = sql
    .exec<Selected>(selectSql, row.cursor, row.up_to, exportPartVersions)
    .toArray();
  if (selected.length === 0) {
    return undefined;
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
      return "failed";
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
  return {
    lines,
    phase: null,
    cursor: last,
    versions: lines.length,
    memories: 0,
    held,
  };
};

/**
 * The next part of the memories' steps (`memoryPhases`) from where `row`
 * is: the rows of the first step with any left, read in one statement, up
 * to `exportPartBytes` of encoded lines (at least one). None once every
 * step is written.
 */
const memoriesPart = (
  sql: SqlStorage,
  row: WritingRow
): NextPart | undefined => {
  for (let phase = row.phase ?? 1; phase <= memoryPhases.length; phase += 1) {
    const name = memoryPhases[phase - 1];
    if (name === undefined) {
      return undefined;
    }
    const bindings = [
      phase === row.phase ? row.cursor : 0,
      row.id,
      memoryPartRows,
      row.stamp,
      row.changes_up_to,
    ];
    // Each statement takes as many bindings as the last it names.
    const rows = sql
      .exec<PhaseRow>(
        memoryPhaseSql[name],
        ...bindings.slice(0, name === "changes" ? 5 : 4)
      )
      .toArray();
    const lines: Uint8Array[] = [];
    const held: Held[] = [];
    let cursor = 0;
    let bytes = 0;
    for (const found of rows) {
      const { line, held: rests } = memoriesLineOf(name, found);
      const encoded = encoder.encode(`${JSON.stringify(line)}\n`);
      if (lines.length > 0 && bytes + encoded.byteLength > exportPartBytes) {
        break;
      }
      lines.push(encoded);
      bytes += encoded.byteLength;
      if (rests !== undefined) {
        held.push(rests);
      }
      cursor = found.row;
    }
    if (lines.length > 0) {
      return {
        lines,
        phase,
        cursor,
        versions: 0,
        memories: lines.length,
        held,
      };
    }
  }
  return undefined;
};

/**
 * One run of an export: the next part written and recorded with the
 * versions it holds and those its memories rest on (a part of versions,
 * then of each of the memories' steps), or, once none is left, its
 * manifest. A part that holds what was erased meanwhile makes the export
 * stale, which the tick then retires (`exportsStep`), deleting its files,
 * this part's among them.
 */
const writePart = async (
  id: string,
  { storage, bucket, again }: WorkContext
): Promise<void> => {
  const { sql } = storage;
  const found = rowOf(sql, id);
  if (found?.state !== "writing" || isStale(sql, id)) {
    return;
  }
  const { stamp, changes_up_to: changesUpTo } = found;
  // Started by an older release, which took no memories: it would finish
  // as whole without them. Failed; the admin starts a new one.
  if (stamp === null || changesUpTo === null) {
    fail(storage, id);
    return;
  }
  const row: WritingRow = { ...found, stamp, changes_up_to: changesUpTo };
  const versions =
    row.phase === null ? await versionsPart(sql, bucket, row) : undefined;
  if (versions === "failed") {
    fail(storage, id);
    return;
  }
  const next = versions ?? memoriesPart(sql, row);
  if (next === undefined) {
    await finish(storage, bucket, row);
    return;
  }
  const { lines, held } = next;
  /** Whether the export is still where this run read it from. */
  const unmoved = (now: ExportRow | undefined): boolean =>
    now?.state === "writing" &&
    now.cursor === row.cursor &&
    now.phase === row.phase;
  // Written ahead: what the part holds is on record before any of its
  // files are put, so a store that stops between the puts and the part's
  // record leaves files an erasure of what they hold still reaches (the
  // deletion lists the export's prefix). The ledger is asked here too.
  const ahead = storage.transactionSync(() => {
    if (!unmoved(rowOf(sql, id))) {
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
    if (!unmoved(rowOf(sql, id))) {
      return false;
    }
    sql.exec(
      `INSERT INTO export_parts (export, part, hash, versions, memories, bytes)
      VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      row.parts,
      hash,
      next.versions,
      next.memories,
      body.byteLength
    );
    sql.exec(
      `UPDATE exports SET cursor = ?, phase = ?, parts = parts + 1,
        versions = versions + ?
      WHERE id = ?`,
      next.cursor,
      next.phase,
      next.versions,
      id
    );
    // What it holds is written now: what later parts' memories may rest
    // on (`writtenVersionSql`).
    sql.exec(
      `UPDATE export_sources SET written = 1
      WHERE export = ?1 AND (subject, version) IN (
        SELECT value ->> 0, value ->> 1 FROM json_each(?2)
      )`,
      id,
      JSON.stringify(held)
    );
    // The part as it lands: an erasure that came while it was written, of
    // one of what it holds, makes the export stale now.
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
    // What the store held, and had learned, as it starts: one snapshot.
    const at = sql
      .exec<{ last: number; stamp: number; changes: number }>(
        `SELECT (SELECT coalesce(max(row), 0) FROM source_versions) AS last,
          (SELECT coalesce(max(latest), 0) FROM memory_stamps) AS stamp,
          (SELECT coalesce(max(rowid), 0) FROM memory_changes) AS changes`
      )
      .one();
    sql.exec(
      `INSERT INTO exports (id, deployment, up_to, cursor, state, parts,
        versions, started_at, stamp, changes_up_to)
      VALUES (?, ?, ?, 0, 'writing', 0, 0, ?, ?, ?)`,
      id,
      deployment,
      at.last,
      Date.now(),
      at.stamp,
      at.changes
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
  for (const [
    part,
    { sha256, versions, memories, bytes },
  ] of manifest.parts.entries()) {
    sql.exec(
      `INSERT INTO export_parts (export, part, hash, versions, memories, bytes)
      VALUES (?, ?, ?, ?, ?, ?)`,
      manifest.id,
      part,
      sha256,
      versions,
      memories,
      bytes
    );
  }
};
