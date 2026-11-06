import type { ValueDescriptor } from "@grasp-os/sdk";
import { holdsId } from "@grasp-os/sdk/host";
import type { SchemaManifest } from "@grasp-os/sdk/host";
import { storedFieldsSchema } from "@grasp-os/shared/stores";
import type { MigrationFailure, StoreFields } from "@grasp-os/shared/stores";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { z } from "zod";

import { migrationWork, records } from "./db/data-store/schema.ts";
import {
  firstChanged,
  ruleChangedIssue,
  transformBatchMaxBytes,
  transformBatchOverhead,
  transformRecordBytes,
} from "./migration-transform.ts";
import { validates } from "./store-queries.ts";
import { audienceKey } from "./store-rules.ts";
import type { Audience } from "./store-rules.ts";

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
// - The contract moves while a record still doesn't fit it, or holds
//   fields derived from what it held before an edit (premature
//   activation, stale derivations): every commit that inserts or changes
//   a record of a migrated table under another schema than the target
//   queues it in its own transaction (store-host.ts, `#flush`), and it is
//   transformed again from the edit; the target is ready only once the
//   scan is through and no work is left, and a write that queues work
//   makes it not ready again.
// - The version still current can't write between the migration's end
//   and its release being made current (a write outage): a ready target
//   takes over only as its release is made current (store-host.ts,
//   `activateReady`, which checks again for work in its transaction);
//   until then the contract in force and its writers stay as they were.
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
// - One person's or team's data reaches a record others see through the
//   transform's module state: a batch holds records of one audience only
//   (store-rules.ts, `audienceKey`: one owner where the access mode or a
//   rule reads it, one value of each field a row rule reads), cut where
//   the next record's differs. The scan goes by owner (an index serves
//   it), so an owner table cuts few batches. Where a table's rules read
//   fields, consecutive records may alternate between audiences: a scan
//   batch takes the first record's audience from the next
//   `migrationBatchSize` records and queues the others it passes over as
//   work, which is taken in audience order (`sdk_migration_work_batches`),
//   so batches stay full either way.
// - A transform moves a record into other people's sight by rewriting a
//   field a row rule reads: refused (`rule_changed`), whatever the
//   transform answered, for the rules of the target and of the contract
//   in force. Who a record reaches changes only through writes, which
//   pass the rules before and after. A transform's output is the same
//   record's, of the same table: no batch moves records between tables.
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
  /** Who its records reach: a batch holds one audience's only. */
  readonly audience: Audience;
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
  /** The schema the migrations transform to: its writers' records fit it. */
  schema: z.string().regex(/^[0-9a-f]{64}$/u),
  migrations: z.array(z.tuple([z.string().min(1), z.string().min(1)])),
});
export type PendingMigrations = z.output<typeof pendingMigrationsSchema>;

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

/** The audience of `record` in a table of `audience` (`audienceKey`). */
export const recordAudience = (
  audience: Audience,
  record: Pick<RecordRow, "ownerId" | "valueJson">
): string =>
  audienceKey(audience, {
    owner: record.ownerId,
    fields:
      audience.fields.length === 0
        ? {}
        : storedFieldsSchema.parse(JSON.parse(record.valueJson)),
  });

/**
 * The first records of `rows` one batch takes: those of the first one's
 * audience up to the first of another, and no more bytes than a
 * transform's batch takes (always at least one: a record holds less).
 */
const batchOf = (
  rows: readonly RecordRow[],
  audience: Audience
): RecordRow[] => {
  const [first] = rows;
  if (first === undefined) {
    return [];
  }
  const key = recordAudience(audience, first);
  const taken: RecordRow[] = [];
  // A running total, as the transform measures its batch
  // (`transformBatchBytes`): a record's stored text is its fields'
  // canonical text, and each is measured once.
  let bytes = transformBatchOverhead;
  for (const row of rows) {
    if (recordAudience(audience, row) !== key) {
      break;
    }
    const added = transformRecordBytes(row.valueJson, taken.length > 0);
    if (taken.length > 0 && bytes + added > transformBatchMaxBytes) {
      break;
    }
    bytes += added;
    taken.push(row);
  }
  return taken;
};

/**
 * Queues `record` of `tableId` as work of `target`, once, under the
 * audience it reaches now (`recordAudience`).
 */
export const queueWork = (
  db: Db,
  target: string,
  tableId: string,
  record: { recordId: string; audience: string },
  now: number
): void => {
  db.insert(migrationWork)
    .values({
      targetHash: target,
      tableId,
      recordId: record.recordId,
      audience: record.audience,
      queuedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        migrationWork.targetHash,
        migrationWork.tableId,
        migrationWork.recordId,
      ],
      set: { audience: record.audience },
    })
    .run();
};

/**
 * Of `rows`, in scan order, those one batch takes and those it passes
 * over: the first one's audience (`batchOf`), skipping the others, up to
 * the last it takes; the others before that are passed over.
 */
const scanned = (
  rows: readonly RecordRow[],
  audience: Audience
): { taken: RecordRow[]; passed: RecordRow[] } => {
  const [first] = rows;
  if (first === undefined) {
    return { taken: [], passed: [] };
  }
  const key = recordAudience(audience, first);
  const taken = batchOf(
    rows.filter((row) => recordAudience(audience, row) === key),
    audience
  );
  const last = taken.at(-1);
  const through = last === undefined ? -1 : rows.indexOf(last);
  const ids = new Set(taken.map(({ recordId }) => recordId));
  return {
    taken,
    passed: rows
      .slice(0, through + 1)
      .filter(({ recordId }) => !ids.has(recordId)),
  };
};

/**
 * The next batch of the scan from `cursor` (null: the start of the first
 * table) through `tables`, in table order, then each table's records by
 * owner, creation time and ID up to its bound: the records, the table and
 * where the batch ends; null once every table is through. The records of
 * other audiences it passes over (`scanned`) are queued as work of
 * `target`, in the batch's transaction, so its commit accounts for them.
 */
export const nextScanBatch = (
  db: Db,
  target: string,
  tables: readonly MigratedTable[],
  cursor: ScanPosition | null,
  now: number
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
    const { taken, passed } = scanned(found, table.audience);
    for (const record of passed) {
      queueWork(
        db,
        target,
        table.tableId,
        {
          recordId: record.recordId,
          audience: recordAudience(table.audience, record),
        },
        now
      );
    }
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
 * The next batch of queued work of `target`: one table's records of one
 * audience (`batchOf`), by audience then ID, each transformed again
 * from what it holds now, whether or not it fits the target (an edit of
 * a transformed record still fits, and its derived fields are stale).
 * Work whose record is gone is dropped as it is found. Null once no work
 * is left.
 */
export const nextWorkBatch = (
  db: Db,
  target: string,
  tables: readonly MigratedTable[]
): { table: MigratedTable; rows: MigrationRow[] } | null => {
  for (;;) {
    const queued = db
      .select()
      .from(migrationWork)
      .where(eq(migrationWork.targetHash, target))
      .orderBy(
        asc(migrationWork.tableId),
        asc(migrationWork.audience),
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
      if (item.tableId !== first.tableId || item.audience !== first.audience) {
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
      if (record === undefined) {
        dropWork(db, target, item.tableId, item.recordId);
      } else {
        due.push(record);
      }
    }
    const taken = batchOf(due, table.audience);
    if (taken.length > 0) {
      return { table, rows: taken.map((row) => rowOf(row)) };
    }
  }
};

/**
 * The IDs of the records of `table` a scan batch from `cursor` through
 * `through` covers, as they are now: what its commit must account for.
 */
export const scanRangeIds = (
  db: Db,
  table: MigratedTable,
  cursor: ScanPosition | null,
  through: ScanPosition
): string[] =>
  db
    .select({ id: records.recordId })
    .from(records)
    .where(
      and(
        eq(records.tableId, table.tableId),
        lte(records.recordId, table.bound),
        cursor !== null && cursor.tableId === table.tableId
          ? sql`(${records.ownerId}, ${records.createdAt}, ${records.recordId}) > (${cursor.ownerId}, ${cursor.createdAt}, ${cursor.recordId})`
          : undefined,
        sql`(${records.ownerId}, ${records.createdAt}, ${records.recordId}) <= (${through.ownerId}, ${through.createdAt}, ${through.recordId})`
      )
    )
    .all()
    .map(({ id }) => id);

/** Whether `recordId` of `tableId` is queued as work of `target`. */
export const isQueued = (
  db: Db,
  target: string,
  tableId: string,
  recordId: string
): boolean =>
  db
    .select({ id: migrationWork.recordId })
    .from(migrationWork)
    .where(
      and(
        eq(migrationWork.targetHash, target),
        eq(migrationWork.tableId, tableId),
        eq(migrationWork.recordId, recordId)
      )
    )
    .get() !== undefined;

/** Whether `target` has work left. */
export const hasWork = (db: Db, target: string): boolean =>
  db
    .select({ id: migrationWork.recordId })
    .from(migrationWork)
    .where(eq(migrationWork.targetHash, target))
    .limit(1)
    .get() !== undefined;

/**
 * Why `after`, a transform's output for a record holding `before`, can't
 * commit: it doesn't fit the target table, or the contract in force, or
 * it changes a field that can hold a record ID, or one of `ruleFields`
 * (those the row rules of either read); undefined when it can.
 */
export const outputRefusal = (
  target: Readonly<Record<string, ValueDescriptor>>,
  contract: Readonly<Record<string, ValueDescriptor>>,
  ruleFields: readonly string[],
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
  const reference = firstChanged(references, before, after);
  if (reference !== undefined) {
    return {
      reason: "reference_changed",
      issues: [
        `${reference}: A migration doesn't change a field that refers to records`,
      ],
    };
  }
  const ruled = firstChanged(ruleFields, before, after);
  if (ruled !== undefined) {
    return { reason: "rule_changed", issues: [ruleChangedIssue(ruled)] };
  }
  return undefined;
};
