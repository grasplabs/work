import type { SchemaManifest } from "@grasp-os/sdk/host";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import {
  queryMaxScannedEntries,
  storeMaxSearchIndexes,
} from "@grasp-os/shared/store-limits";
import { dataErrors } from "@grasp-os/shared/stores";

import { tableIdLiteral, textExpression } from "./store-expressions.ts";
import type { Fragment } from "./store-expressions.ts";

// How a table's declared search index (`.searchIndex` in the schema)
// becomes a full-text index in its store (store-host.ts), and the text an
// FTS5 query of it is given (store-queries.ts reads it).
//
// Each search index is an FTS5 table of its own: one column per
// text field (`f0`, `f1`, ...) and, for a table read by owner only, its
// records' owner (`owner`), so a search narrows to the caller's records
// inside the index rather than ranking every owner's. Its rows are keyed
// by the record's number in `sdk_search_docs` (data-store migration 0019),
// which outlives a VACUUM; the record's own fields stay in `sdk_records`,
// where every read takes them from.
//
// Triggers on `sdk_records` keep it in step, in the transaction of every
// write that touches a record of its table, whichever path writes it (a
// commit, a backfill, a migration's batch, a cascade, a preview that is
// rolled back): a record inserted is added, one whose document or owner
// changed is replaced, and one deleted is removed before it goes (so its
// number is still there to find; the migration's own trigger forgets the
// number after). Nothing in the write path calls this module.
//
// The index keeps its own copy of the text it holds, and FTS5's
// `secure-delete` is on for it: a record deleted or changed has its old
// words taken out of the index's pages in the same write, at that
// record's cost (a contentless index would only mark them deleted until a
// merge of the whole index, and can't securely delete). A deleted store's
// purge drops every search index, its triggers and shadow tables before
// its records (`dropSearches`).
//
// Search indexes, like indexes, are never retired yet: a table's index
// that no retained version declares any more stays, kept in step, until
// versions are retired (GRA-1480) and drop what none of them pins.
//
// Like an index (store-indexes.ts), a search index is named by the hash of
// its definition (its format's version, the table, the owner column and
// the fields, in order), never by its author: a changed definition is a
// new index beside the old, built over the records already there when the
// schema declaring it is applied, and a consumer pinned to an older schema
// keeps searching its own. Installing checks what SQLite holds and refuses
// an object of one of its names with another definition. A store holds at
// most `storeMaxSearchIndexes`, since every write to a table runs the
// triggers of every one of its table's indexes.
//
// Threat model (who writes the definition: an App's schema, through its
// manifest; who writes the text searched for: App code, from anyone):
//
// - Text searched for smuggles FTS5 syntax: a column filter onto the owner
//   column, `NEAR`, `NOT`, `*` on every word. Each word is quoted as an
//   FTS5 string, its quotes doubled, so it is only ever a phrase; the
//   column filter and the prefix on the last word are the host's own, and
//   the whole query is a bound parameter.
// - A search counts, ranks or answers rows a table's read rules keep from
//   the caller (store-rules.ts): the rules aren't in the index, so what it
//   matches is counted joined to the records under their condition
//   (`requireSearchable`), and the read itself joins under it as every
//   query does. Accepted residual: its relevance (BM25) still weighs
//   words by how often they stand in the whole index, rows the caller
//   can't see included, as it does across owners. No score leaves the
//   store, not even in a cursor (store-cursors.ts), yet the order of the
//   rows they can see moves with it: someone who plants rows of their own
//   holding chosen words, and searches for two of them, can tell from
//   which ranks first whether rows they can't see hold a word often. It
//   tells a word's presence in bulk, never a row or its fields; closing
//   it needs relevance computed over the caller's rows alone.
// - A search reads another owner's records: the owner column narrows what
//   the index answers, but the read itself joins `sdk_records` under the
//   same `owner_id = ?` every query has (store-queries.ts), so a phrase
//   that matched more than the owner never shows them.
// - A search ranks without bound: what the index matches is counted first,
//   streaming at most `queryMaxScannedEntries` + 1 of them, and a search
//   matching more fails (`data.scan_limit`) before any is ranked.
// - A field name reaches SQL: only through the shared emitter, which
//   refuses anything but an identifier; a table ID only as a host-minted
//   UUID literal.

/** The version of the definition below: part of every search index's name. */
const searchVersion = 1;

/** The prefix of every search index's physical name. */
const searchPrefix = "sdk_fts_";

/** Hex digits of a definition's SHA-256 a name keeps: 128 bits. */
const nameHashLength = 32;

/**
 * How text is split into words: Unicode letters and digits, case folded,
 * accents removed (so "Müller" finds "muller" and the other way round).
 */
const tokenizer = "unicode61 remove_diacritics 2";

/** One statement of a search index's DDL, under the name SQLite keeps it by. */
export interface SearchObject {
  readonly name: string;
  readonly type: "table" | "trigger";
  readonly sql: string;
}

/** One declared search index's full-text table and triggers. */
export interface PhysicalSearch {
  /** `sdk_fts_` and the start of its definition's hash. */
  readonly name: string;
  readonly tableId: string;
  /** Whether it holds its records' owner: the table is read by owner only. */
  readonly ownerScoped: boolean;
  /** Its text fields, in order, as the schema names them (`f0`, `f1`, ...). */
  readonly fields: readonly string[];
  /** Its table, then its triggers, exactly as SQLite keeps them. */
  readonly objects: readonly SearchObject[];
  /** The statements that fill it with the records already there. */
  readonly fill: readonly string[];
}

/** The columns a search index holds, as its row's values for `column`. */
const valuesOf = (
  ownerScoped: boolean,
  fields: readonly string[],
  record: string
): string[] => [
  ...(ownerScoped ? [`${record}.owner_id`] : []),
  ...fields.map((field) => textExpression(`${record}.value_json`, field)),
];

/** A record's number in `sdk_search_docs`, by the record `row` names. */
const docOf = (row: string): string =>
  `(SELECT doc FROM sdk_search_docs WHERE doc_table = ${row}.table_id AND doc_record = ${row}.record_id)`;

/** One declared search index's physical index, named by its definition's hash. */
const physicalSearch = async (
  tableId: string,
  ownerScoped: boolean,
  fields: readonly string[]
): Promise<PhysicalSearch> => {
  const definition = canonicalJson({
    searchVersion,
    tableId,
    ownerScoped,
    fields: [...fields],
  });
  const hash = await sha256Hex(definition);
  const name = `${searchPrefix}${hash.slice(0, nameHashLength)}`;
  const table = tableIdLiteral(tableId);
  const columns = [
    ...(ownerScoped ? ["owner"] : []),
    ...fields.map((_field, position) => `f${position}`),
  ];
  const insert = (row: string): string =>
    `INSERT INTO ${name} (rowid, ${columns.join(", ")}) VALUES (${docOf(row)}, ${valuesOf(ownerScoped, fields, row).join(", ")});`;
  const remove = (row: string): string =>
    `DELETE FROM ${name} WHERE rowid = ${docOf(row)};`;
  const number =
    "INSERT OR IGNORE INTO sdk_search_docs (doc_table, doc_record) VALUES (new.table_id, new.record_id);";
  return {
    name,
    tableId,
    ownerScoped,
    fields,
    objects: [
      {
        name,
        type: "table",
        sql: `CREATE VIRTUAL TABLE ${name} USING fts5(${columns.join(", ")}, tokenize='${tokenizer}')`,
      },
      {
        name: `${name}_on_insert`,
        type: "trigger",
        sql: `CREATE TRIGGER ${name}_on_insert AFTER INSERT ON sdk_records WHEN new.table_id = ${table} BEGIN ${number} ${insert("new")} END`,
      },
      {
        name: `${name}_on_update`,
        type: "trigger",
        sql: `CREATE TRIGGER ${name}_on_update AFTER UPDATE OF value_json, owner_id ON sdk_records WHEN new.table_id = ${table} BEGIN ${remove("old")} ${insert("new")} END`,
      },
      {
        name: `${name}_on_delete`,
        type: "trigger",
        sql: `CREATE TRIGGER ${name}_on_delete BEFORE DELETE ON sdk_records WHEN old.table_id = ${table} BEGIN ${remove("old")} END`,
      },
    ],
    fill: [
      // Kept in the index's own config: a removal takes its words out of
      // the index's pages at once, not only marks them deleted.
      `INSERT INTO ${name} (${name}, rank) VALUES ('secure-delete', 1)`,
      `INSERT OR IGNORE INTO sdk_search_docs (doc_table, doc_record) SELECT table_id, record_id FROM sdk_records WHERE table_id = ${table}`,
      `INSERT INTO ${name} (rowid, ${columns.join(", ")}) SELECT ${docOf("sdk_records")}, ${valuesOf(ownerScoped, fields, "sdk_records").join(", ")} FROM sdk_records WHERE table_id = ${table}`,
    ],
  };
};

/**
 * The search index of each table of `manifest` that declares one, by
 * table name, for a store whose tables have the IDs `tableIds`.
 */
export const planSearches = async (
  manifest: SchemaManifest,
  tableIds: Readonly<Record<string, string>>
): Promise<Map<string, PhysicalSearch>> => {
  const plan = new Map<string, PhysicalSearch>();
  for (const [table, declared] of Object.entries(manifest.tables)) {
    const tableId = Object.hasOwn(tableIds, table)
      ? tableIds[table]
      : undefined;
    if (declared.searchIndex === undefined) {
      continue;
    }
    if (tableId === undefined) {
      throw new Error(`Table ${table} has no ID in this store`);
    }
    plan.set(
      table,
      // One per table, each hashed in turn: at most 64.
      // oxlint-disable-next-line no-await-in-loop -- see above
      await physicalSearch(
        tableId,
        declared.access.read === "owner",
        declared.searchIndex.fields
      )
    );
  }
  return plan;
};

/**
 * Creates the search indexes of `plan` that `sql` doesn't hold yet, and
 * fills each with its table's records. An object of one of their names
 * with another definition is refused, and so is a plan that would take
 * the store past `storeMaxSearchIndexes` (`data.too_many_indexes`), before
 * any is created. Run it inside the transaction that records the schema,
 * so both land or neither.
 */
export const installSearches = (
  sql: SqlStorage,
  plan: ReadonlyMap<string, PhysicalSearch>
): void => {
  const installed = new Map<string, string | null>();
  let tables = 0;
  for (const row of sql.exec<{
    name: string;
    type: string;
    sql: string | null;
  }>(
    "SELECT name, type, sql FROM sqlite_master WHERE name LIKE 'sdk\\_fts\\_%' ESCAPE '\\' AND type IN ('table', 'trigger')"
  )) {
    installed.set(row.name, row.sql);
    if (
      row.type === "table" &&
      row.sql?.startsWith("CREATE VIRTUAL TABLE") === true
    ) {
      tables += 1;
    }
  }
  const missing: PhysicalSearch[] = [];
  for (const search of plan.values()) {
    const held = search.objects.filter(({ name }) => installed.has(name));
    for (const object of held) {
      if (installed.get(object.name) !== object.sql) {
        throw new Error(`Search index ${search.name} holds another definition`);
      }
    }
    if (held.length === 0) {
      missing.push(search);
    } else if (held.length !== search.objects.length) {
      throw new Error(`Search index ${search.name} is incomplete`);
    }
  }
  if (tables + missing.length > storeMaxSearchIndexes) {
    throw dataErrors.create("data.too_many_indexes", {
      installed: tables,
      wanted: missing.length,
    });
  }
  for (const search of missing) {
    for (const object of search.objects) {
      sql.exec(object.sql);
    }
    for (const statement of search.fill) {
      sql.exec(statement);
    }
  }
};

/**
 * SQL that is 1 while the store holds any search index object (an index
 * or its triggers): what a deleted store's purge must still drop.
 */
export const searchObjectsLeft =
  "EXISTS (SELECT 1 FROM sqlite_master WHERE name LIKE 'sdk\\_fts\\_%' ESCAPE '\\')";

/**
 * Drops every search index of a deleted store, with its triggers and
 * shadow tables: run by its purge before its records go, so no deleted
 * record's text is kept in the store's pages and no trigger runs for the
 * records the purge removes.
 */
export const dropSearches = (sql: Pick<SqlStorage, "exec">): void => {
  const objects = sql
    .exec<{ name: string; type: string; sql: string | null }>(
      "SELECT name, type, sql FROM sqlite_master WHERE name LIKE 'sdk\\_fts\\_%' ESCAPE '\\' AND type IN ('table', 'trigger')"
    )
    .toArray();
  for (const { name, type } of objects) {
    if (type === "trigger") {
      sql.exec(`DROP TRIGGER IF EXISTS "${name}"`);
    }
  }
  // A virtual table drops its shadow tables with it.
  for (const { name, sql: ddl } of objects) {
    if (ddl?.startsWith("CREATE VIRTUAL TABLE") === true) {
      sql.exec(`DROP TABLE IF EXISTS "${name}"`);
    }
  }
};

/** A word as an FTS5 string: in double quotes, its own doubled. */
const quoted = (word: string): string => `"${word.replaceAll('"', '""')}"`;

/** A letter or digit: an owner ID without one narrows nothing. */
const wordCharacter = /[\p{L}\p{N}]/u;

/**
 * The FTS5 query for `terms` (`searchTerms`, at least one) in `search`:
 * every word in one of its text fields, the last as a prefix, and, for a
 * table owner-only now (`ownerScoped`, from the store's contract, not
 * the index: a version pinned to an index built while the table was
 * owner-only searches every owner's records once it isn't), the caller's
 * ID in the owner column.
 */
export const searchMatch = (
  search: PhysicalSearch,
  terms: readonly string[],
  principal: string,
  ownerScoped: boolean
): string => {
  const words = terms.map((term, position) =>
    position === terms.length - 1 ? `${quoted(term)}*` : quoted(term)
  );
  const columns = search.fields.map((_field, position) => `f${position}`);
  const text = `{${columns.join(" ")}} : (${words.join(" AND ")})`;
  return search.ownerScoped && ownerScoped && wordCharacter.test(principal)
    ? `${text} AND owner : ${quoted(principal)}`
    : text;
};

/**
 * How many entries of `search` `match` matches, counted up to one past the
 * scan bound and no further: a search past it is refused before anything
 * ranks its matches. With `rows` (a table's read rules as a condition on
 * the caller's view, store-rules.ts), only the matches among the rows they
 * admit count, joined to their records: what the caller can't read never
 * moves the count, so a refusal tells nothing of it.
 */
export const requireSearchable = (
  sql: Pick<SqlStorage, "exec">,
  search: PhysicalSearch,
  match: string,
  rows?: Fragment
): void => {
  const matched =
    rows === undefined
      ? `SELECT rowid FROM ${search.name} WHERE ${search.name} MATCH ?`
      : `SELECT 1 FROM (SELECT rowid AS doc FROM ${search.name} WHERE ${search.name} MATCH ?) AS hit JOIN sdk_search_docs ON sdk_search_docs.doc = hit.doc JOIN sdk_records ON sdk_records.table_id = sdk_search_docs.doc_table AND sdk_records.record_id = sdk_search_docs.doc_record WHERE ${rows.sql}`;
  const [row] = sql
    .exec<{ matches: number }>(
      `SELECT count(*) AS matches FROM (${matched} LIMIT ${queryMaxScannedEntries + 1})`,
      match,
      ...(rows?.params ?? [])
    )
    .toArray();
  const matches = row?.matches ?? 0;
  if (matches > queryMaxScannedEntries) {
    throw dataErrors.create("data.scan_limit", {
      scanned: queryMaxScannedEntries,
    });
  }
};
