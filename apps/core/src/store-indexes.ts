import type { SchemaManifest } from "@grasp-os/sdk/host";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import { storeMaxIndexes } from "@grasp-os/shared/store-limits";
import { dataErrors } from "@grasp-os/shared/stores";

import {
  emitterVersion,
  fieldExpression,
  tableIdLiteral,
} from "./store-expressions.ts";

// How a store's declared indexes become real SQLite indexes (store-
// host.ts). Every logical table's records share `sdk_records`, so each
// declared index is a partial index over that one table, `WHERE table_id`
// is its logical table, on the fields' expressions (store-expressions.ts)
// and the record ID that breaks ties. When the table's records are read
// only by their owner, the owner leads the index, so a read never scans
// another owner's records to skip them.
//
// An index is named by the hash of its definition (the expressions'
// version, the table, the owner prefix and the fields, in order), never
// by its author's name: a changed definition is a new index beside the
// old, so a consumer pinned to an older schema keeps reading through its
// own. Nothing here drops an index; contracting them is schema
// activation's (GRA-246), under its retention gates.
//
// Installing is idempotent and checks what SQLite actually holds: an
// index that exists under its name with any other definition is refused,
// never trusted. A store holds at most `storeMaxIndexes` of them, retained
// ones included, because every write to `sdk_records` evaluates every
// partial index's WHERE and opens each index, so a write's cost grows with
// the store's total; the refusal comes before any is created.
//
// Reads without an index use the two fixed default-order indexes of the
// host's layout (db/data-store/schema.ts), which serve every table.

/** One physical index of a declared one. */
export interface PhysicalIndex {
  /** `sdk_ix_` and the start of its definition's hash. */
  readonly name: string;
  readonly tableId: string;
  /** Whether the owner leads it: the table is read by owner only. */
  readonly ownerScoped: boolean;
  /** Its fields, in order, as the schema names them. */
  readonly fields: readonly string[];
  /** The exact statement that creates it, as SQLite keeps it. */
  readonly ddl: string;
}

/** The default-order index for a table read by owner only, or by anyone. */
export const defaultIndexName = (ownerScoped: boolean): string =>
  ownerScoped ? "sdk_records_owner_created" : "sdk_records_created";

/** The prefix of every declared index's physical name. */
const indexPrefix = "sdk_ix_";

/** Hex digits of a definition's SHA-256 a name keeps: 128 bits. */
const nameHashLength = 32;

/** One declared index's physical index, named by its definition's hash. */
const physicalIndex = async (
  tableId: string,
  ownerScoped: boolean,
  fields: readonly string[]
): Promise<PhysicalIndex> => {
  const definition = canonicalJson({
    emitterVersion,
    tableId,
    ownerScoped,
    fields: [...fields],
  });
  const hash = await sha256Hex(definition);
  const name = `${indexPrefix}${hash.slice(0, nameHashLength)}`;
  const columns = [
    ...(ownerScoped ? ["owner_id"] : []),
    ...fields.map((field) => fieldExpression(field)),
    "record_id",
  ];
  return {
    name,
    tableId,
    ownerScoped,
    fields,
    ddl: `CREATE INDEX ${name} ON sdk_records (${columns.join(", ")}) WHERE table_id = ${tableIdLiteral(tableId)}`,
  };
};

/**
 * The physical index of each declared index of `manifest`, by table and
 * index name, for a store whose tables have the IDs `tableIds`.
 */
export const planIndexes = async (
  manifest: SchemaManifest,
  tableIds: Readonly<Record<string, string>>
): Promise<Map<string, Map<string, PhysicalIndex>>> => {
  const plan = new Map<string, Map<string, PhysicalIndex>>();
  for (const [table, declared] of Object.entries(manifest.tables)) {
    const tableId = Object.hasOwn(tableIds, table)
      ? tableIds[table]
      : undefined;
    if (tableId === undefined) {
      throw new Error(`Table ${table} has no ID in this store`);
    }
    const ownerScoped = declared.access.read === "owner";
    const indexes = new Map<string, PhysicalIndex>();
    for (const [name, { fields }] of Object.entries(declared.indexes)) {
      // One table's indexes, each hashed in turn: at most 32.
      // oxlint-disable-next-line no-await-in-loop -- see above
      indexes.set(name, await physicalIndex(tableId, ownerScoped, fields));
    }
    plan.set(table, indexes);
  }
  return plan;
};

/**
 * Creates the indexes of `plan` that `sql` doesn't hold yet. An index of
 * one of their names with another definition is refused, and so is a plan
 * that would take the store past `storeMaxIndexes`
 * (`data.too_many_indexes`), before any index is created. Run it inside
 * the transaction that records the schema, so both land or neither.
 */
export const installIndexes = (
  sql: SqlStorage,
  plan: ReadonlyMap<string, ReadonlyMap<string, PhysicalIndex>>
): void => {
  const installed = new Map<string, string | null>();
  for (const row of sql.exec<{ name: string; sql: string | null }>(
    "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'sdk\\_ix\\_%' ESCAPE '\\'"
  )) {
    installed.set(row.name, row.sql);
  }
  const wanted = new Map<string, PhysicalIndex>();
  for (const indexes of plan.values()) {
    for (const index of indexes.values()) {
      wanted.set(index.name, index);
    }
  }
  const missing: PhysicalIndex[] = [];
  for (const index of wanted.values()) {
    if (!installed.has(index.name)) {
      missing.push(index);
    } else if (installed.get(index.name) !== index.ddl) {
      throw new Error(`Index ${index.name} holds another definition`);
    }
  }
  if (installed.size + missing.length > storeMaxIndexes) {
    throw dataErrors.create("data.too_many_indexes", {
      installed: installed.size,
      wanted: missing.length,
    });
  }
  for (const index of missing) {
    sql.exec(index.ddl);
  }
};
