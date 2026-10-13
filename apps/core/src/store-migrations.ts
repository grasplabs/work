import type { ValueDescriptor } from "@grasp-os/sdk";
import { holdsId } from "@grasp-os/sdk/host";
import type { SchemaManifest } from "@grasp-os/sdk/host";
import { canonicalJson } from "@grasp-os/shared/json";
import { storedFieldsSchema } from "@grasp-os/shared/stores";
import type { MigrationFailure, StoreFields } from "@grasp-os/shared/stores";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { z } from "zod";

import { migrationWork, records } from "./db/data-store/schema.ts";
import { transformBatchMaxBytes } from "./migration-transform.ts";
import { validates } from "./store-queries.ts";

// An explicit migration as the store runs it (spec 17.2, 17.4 step 5): a
// pending target whose tables are rewritten by a release's transform
// (migration-transform.ts) instead of filled in, a bounded batch at a
// time, on the same backfill run, fence, lease and receipts as a fill
// (store-host.ts, `fillMissing`, `commitTransformed`; store-backfill.ts).
// The store hands core a batch's records with their revisions, core runs
// the transform in the sandbox, and the store commits what it answered.
// Threat model, and how each is closed:
//
// - A transform's output overwrites an edit made while it ran (a lost
//   update): each record commits only at the revision it was read at, in
//   one transaction; one that moved on is queued as work
//   (`sdk_migration_work`) and transformed again from its new revision.
// - A crash or a lost answer applies a batch twice, or skips one: the
//   batch commits under the run's fence and number with its receipt, as a
//   fill's does; a retry of a committed batch is answered from that
//   receipt, never compared with a transform run again (its answer may
//   differ: determinism is best effort).
// - The contract moves while a record still doesn't fit it (premature
//   activation): concurrent commits that leave a record of a migrated
//   table not fitting the target queue it in their own transaction
//   (store-host.ts, `#flush`), and activation happens only in the
//   transaction that finds the scan through and no work left.
// - Old readers break on a migrated record, or an abandoned migration
//   leaves records the contract doesn't describe: every output must fit
//   both the target and the contract in force (`outside_contract`
//   otherwise), so the version still current reads every record, before
//   and after an abandonment, and a migration only expands; contraction
//   is a later release (spec 17.3).
// - A transform rewrites references behind the store's reference index:
//   a field that can hold a record ID must come back unchanged
//   (`reference_changed`); planning refuses adding or changing one
//   (schema-plan.ts).
// - One owner's data reaches another's record through the transform's
//   module state: on a table whose read or write access is `owner`, a
//   batch holds one owner's records only (the scan goes by owner).
// - A writer pinned to a schema the migration left behind writes after
//   activation: refused (`migration.incompatible_write`, store-host.ts).
// - A failure's details leak another record's content: what a transform
//   threw is shown only to the migration's App (`schemaStatus`) and to
//   admins (`backfillStatus`).

/** Records one batch hands a transform, at most (spec 17.2). */
export const migrationBatchSize = 100;

/** One table a pending target migrates, as its batches need it. */
export interface MigratedTable {
  readonly table: string;
  readonly tableId: string;
  readonly migration: string;
  /** Whether its read or write access is `owner`: batches by owner then. */
  readonly owned: boolean;
  /** The highest record ID it held when the target became pending. */
  readonly bound: string;
}

/** A record a batch hands core to transform, with what it was read at. */
export interface MigrationRow {
  readonly id: string;
  readonly owner: string;
  readonly revision: number;
  readonly fields: StoreFields;
}

/** Where a batch's scan ends: the last record it read, in scan order. */
export interface ScanPosition {
  readonly tableId: string;
  readonly ownerId: string;
  readonly createdAt: number;
  readonly recordId: string;
}

export const scanPositionSchema = z.strictObject({
  tableId: z.string().min(1),
  ownerId: z.string(),
  createdAt: z.number().int(),
  recordId: z.string().min(1),
});

/** A pending target's migrations, as `sdk_schema_backfills.migrations` keeps them. */
export const pendingMigrationsSchema = z.strictObject({
  consumer: z.tuple([z.string().min(1), z.number().int().min(1)]),
  migrations: z.array(z.tuple([z.string().min(1), z.string().min(1)])),
});
export type PendingMigrations = z.output<typeof pendingMigrationsSchema>;

const encoder = new TextEncoder();

type Db = DrizzleSqliteDODatabase;
type RecordRow = typeof records.$inferSelect;

/**
 * Whether `fields` fit a table of `declared` fields: each it declares
 * present and valid, or absent and optional. Keys it doesn't declare (a
 * retained version's) don't count.
 */
export const fitsTable = (
  declared: Readonly<Record<string, ValueDescriptor>>,
  fields: StoreFields
): boolean =>
  Object.entries(declared).every(([name, descriptor]) =>
    Object.hasOwn(fields, name)
      ? validates(descriptor, fields[name])
      : descriptor.presence === "optional"
  );

/** The fields of `table` in `manifest`, or none. */
export const fieldsOf = (
  manifest: SchemaManifest,
  table: string
): Readonly<Record<string, ValueDescriptor>> =>
  Object.hasOwn(manifest.tables, table)
    ? (manifest.tables[table]?.fields ?? {})
    : {};

/** A record as a batch hands it on. */
const rowOf = (record: RecordRow): MigrationRow => ({
  id: record.recordId,
  owner: record.ownerId,
  revision: record.revision,
  fields: storedFieldsSchema.parse(JSON.parse(record.valueJson)),
});

/**
 * The first records of `rows` one batch takes: one owner's where the
 * table is `owned`, and no more bytes than a transform's batch takes
 * (always at least one: a record holds less).
 */
const batchOf = (rows: readonly RecordRow[], owned: boolean): RecordRow[] => {
  const [first] = rows;
  if (first === undefined) {
    return [];
  }
  const taken: RecordRow[] = [];
  let bytes = 0;
  for (const row of rows) {
    if (owned && row.ownerId !== first.ownerId) {
      break;
    }
    bytes += encoder.encode(row.valueJson).byteLength;
    if (taken.length > 0 && bytes > transformBatchMaxBytes) {
      break;
    }
    taken.push(row);
  }
  return taken;
};

/**
 * The next batch of the scan from `cursor` (null: the start of the first
 * table) through `tables`, in table order, then each table's records by
 * owner, creation time and ID up to its bound: the records, the table and
 * where the batch ends; null once every table is through.
 */
export const nextScanBatch = (
  db: Db,
  tables: readonly MigratedTable[],
  cursor: ScanPosition | null
): {
  table: MigratedTable;
  rows: MigrationRow[];
  through: ScanPosition;
} | null => {
  const start =
    cursor === null
      ? 0
      : tables.findIndex(({ tableId }) => tableId === cursor.tableId);
  for (let index = Math.max(start, 0); index < tables.length; index += 1) {
    const table = tables[index];
    if (table === undefined) {
      continue;
    }
    const after =
      cursor !== null && cursor.tableId === table.tableId
        ? sql`(${records.ownerId}, ${records.createdAt}, ${records.recordId}) > (${cursor.ownerId}, ${cursor.createdAt}, ${cursor.recordId})`
        : undefined;
    const found = db
      .select()
      .from(records)
      .where(
        and(
          eq(records.tableId, table.tableId),
          lte(records.recordId, table.bound),
          after
        )
      )
      .orderBy(
        asc(records.ownerId),
        asc(records.createdAt),
        asc(records.recordId)
      )
      .limit(migrationBatchSize)
      .all();
    const taken = batchOf(found, table.owned);
    const last = taken.at(-1);
    if (last !== undefined) {
      return {
        table,
        rows: taken.map((row) => rowOf(row)),
        through: {
          tableId: table.tableId,
          ownerId: last.ownerId,
          createdAt: last.createdAt,
          recordId: last.recordId,
        },
      };
    }
  }
  return null;
};

/** Queues `record` of `tableId` as work of `target`, once. */
export const queueWork = (
  db: Db,
  target: string,
  tableId: string,
  record: { recordId: string; ownerId: string },
  now: number
): void => {
  db.insert(migrationWork)
    .values({
      targetHash: target,
      tableId,
      recordId: record.recordId,
      ownerId: record.ownerId,
      queuedAt: now,
    })
    .onConflictDoNothing()
    .run();
};

/** Drops the work of `target` on a record. */
export const dropWork = (
  db: Db,
  target: string,
  tableId: string,
  recordId: string
): void => {
  db.delete(migrationWork)
    .where(
      and(
        eq(migrationWork.targetHash, target),
        eq(migrationWork.tableId, tableId),
        eq(migrationWork.recordId, recordId)
      )
    )
    .run();
};

/**
 * The next batch of queued work of `target`: one table's records (one
 * owner's where it is `owned`) that still don't fit `fits`, by owner then
 * ID. Work whose record is gone, or fits by now, is dropped as it is
 * found. Null once no work is left.
 */
export const nextWorkBatch = (
  db: Db,
  target: string,
  tables: readonly MigratedTable[],
  fits: (table: MigratedTable, fields: StoreFields) => boolean
): { table: MigratedTable; rows: MigrationRow[] } | null => {
  for (;;) {
    const queued = db
      .select()
      .from(migrationWork)
      .where(eq(migrationWork.targetHash, target))
      .orderBy(
        asc(migrationWork.tableId),
        asc(migrationWork.ownerId),
        asc(migrationWork.recordId)
      )
      .limit(migrationBatchSize)
      .all();
    const [first] = queued;
    if (first === undefined) {
      return null;
    }
    const table = tables.find(({ tableId }) => tableId === first.tableId);
    if (table === undefined) {
      throw new Error(
        "Migration work names a table its target doesn't migrate"
      );
    }
    const due: RecordRow[] = [];
    for (const item of queued) {
      if (
        item.tableId !== first.tableId ||
        (table.owned && item.ownerId !== first.ownerId)
      ) {
        break;
      }
      const record = db
        .select()
        .from(records)
        .where(
          and(
            eq(records.tableId, item.tableId),
            eq(records.recordId, item.recordId)
          )
        )
        .get();
      if (record === undefined || fits(table, rowOf(record).fields)) {
        dropWork(db, target, item.tableId, item.recordId);
      } else {
        due.push(record);
      }
    }
    const taken = batchOf(due, table.owned);
    if (taken.length > 0) {
      return { table, rows: taken.map((row) => rowOf(row)) };
    }
  }
};

/**
 * Why `after`, a transform's output for a record holding `before`, can't
 * commit: it doesn't fit the target table, or the contract in force, or
 * it changes a field that can hold a record ID; undefined when it can.
 */
export const outputRefusal = (
  target: Readonly<Record<string, ValueDescriptor>>,
  contract: Readonly<Record<string, ValueDescriptor>>,
  before: StoreFields,
  after: StoreFields
): Pick<MigrationFailure, "reason" | "issues"> | undefined => {
  if (!fitsTable(target, after)) {
    return {
      reason: "invalid_output",
      issues: ["The output doesn't fit the target table"],
    };
  }
  if (!fitsTable(contract, after)) {
    return {
      reason: "outside_contract",
      issues: [
        "The output doesn't fit the contract in force: a migration only expands it, so the version still current reads every record",
      ],
    };
  }
  const references = new Set(
    [...Object.entries(target), ...Object.entries(contract)]
      .filter(([, descriptor]) => holdsId(descriptor))
      .map(([name]) => name)
  );
  for (const name of references) {
    const was = Object.hasOwn(before, name)
      ? canonicalJson(before[name] ?? null)
      : undefined;
    const now = Object.hasOwn(after, name)
      ? canonicalJson(after[name] ?? null)
      : undefined;
    if (was !== now) {
      return {
        reason: "reference_changed",
        issues: [
          `${name}: A migration doesn't change a field that refers to records`,
        ],
      };
    }
  }
  return undefined;
};
