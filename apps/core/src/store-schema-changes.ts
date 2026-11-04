import type { ValueDescriptor } from "@grasp-os/sdk";
import { withDefaultsFilled } from "@grasp-os/sdk/host";
import type { AcceptedPlan, PlannedCheck } from "@grasp-os/sdk/host";
import { canonicalJson, canonicalText } from "@grasp-os/shared/json";
import {
  documentMaxBytes,
  schemaQuestionRecordsMax,
  storedFieldsSchema,
} from "@grasp-os/shared/stores";
import type {
  SchemaCheckReason,
  SchemaQuestion,
  StoreFields,
} from "@grasp-os/shared/stores";
import { and, asc, eq, gt } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import { records } from "./db/data-store/schema.ts";
import { recordChangesIn } from "./store-changes.ts";
import { validates } from "./store-queries.ts";

// A schema change the store checks every record for before its contract
// takes it (the SDK's schema-plan.ts, `activates`: a narrowing, a field
// required, a nested default, a rename, a changed access mode or row
// rule, or a rollback to a schema a change left behind), as the store's
// host carries it out (store-host.ts, `activateReady`). The plan is pure
// and the SDK's; this is where it meets the records.
//
// It runs twice: as the release is sealed, a dry run over every record
// that writes nothing and answers what doesn't fit; and as the release is
// made current, in the one transaction that gives records what they lack
// and moves the contract. A changed access mode or row rule checks no
// record: as core makes an App's version current or publishes a
// workflow's, it is left out here and applied once core's database
// committed it (store-backfill.ts, `applyCurrentRules`). Threat model,
// and how each is closed:
//
// - Data lost or a value guessed: the platform never writes over a value
//   a record holds. It only gives a record what it lacks (a field it
//   doesn't hold or holds as null): the field's default, a nested
//   default, a renamed field's value, or the App's value for the field
//   (`SchemaAnswer`, a backfill's default), and only when that fits. A
//   value that doesn't fit is reported, and only an explicit migration,
//   code the App's builders write and review, reshapes it. Nothing is
//   removed: a field the schema leaves out stays in every record and in
//   the contract. Every write is recorded in the store's change history
//   (source `schema_change`) as any write is.
// - A partial migration: a crash, a timeout or a record that fails
//   halfway. The check, every write and its history, the contract's move
//   and the schemas it leaves behind are one SQLite transaction
//   (`transactionSync`), which a failure anywhere in it rolls back whole,
//   so the version in force goes on serving the records as they were.
//   There is no state between: a store killed mid-change wakes up with
//   the change not applied, and making the release current again runs
//   the whole check again. Durable Objects run one request at a time,
//   and a synchronous transaction can't interleave with a commit, so no
//   write lands between the check and the move. A write by the version
//   in force after the dry run is checked by the run at activation; one
//   that no longer fits is reported then.
// - A version pinned to the old schema writes what the new contract
//   doesn't take: activation leaves behind every schema the new contract
//   doesn't cover (sdk schema-plan.ts, `schemaCovered`), and the store
//   refuses its writes (`migration.incompatible_write`). A rollback is
//   making such a release current again: its schema planned onto the
//   contract, every record of every table it narrows checked against it,
//   refused with questions when one doesn't fit.
// - A rule bypassed: nothing here writes a field a row rule reads, before
//   or after (`rule_field_rewritten`, refused by the plan: a value, a
//   rename or a default for one), so a record's audience changes only
//   through writes, which pass the rules (store-rules.ts); nor a field
//   the store's reference or file index reads. A changed access mode or
//   row rule writes nothing: the store reads and writes every version
//   under its contract's (store-host.ts, `#pinned`), so once the contract
//   takes them they hold for every record and every version still
//   pinned, and no older version reads on under looser ones.
// - A dry run leaking hidden rows: a question names a record by its ID
//   and why it doesn't fit (`SchemaCheckReason`, a fixed word), never a
//   value, a validator's message or anything the record holds, on any
//   table: the builder asking may not read the record (an owner's, or one
//   row rules keep from them). What still tells something, inherently,
//   and as an explicit migration's failure already does
//   (store-migrations.ts): that the record exists, and which of a field's
//   checks it fails. A question lists at most `schemaQuestionRecordsMax`
//   records, and counts the rest.

type Db = DrizzleSqliteDODatabase;

/** How many records one read of a table's scan takes. */
const scanPage = 500;

const encoder = new TextEncoder();

/** One field a table's records are checked for. */
interface CheckedField {
  readonly field: string;
  readonly descriptor: ValueDescriptor;
  /** Null for a defaulted field filled in where it is missing. */
  readonly check: PlannedCheck | null;
}

/** What one table's records are checked for. */
export interface TableSteps {
  readonly table: string;
  readonly tableId: string;
  readonly fields: readonly CheckedField[];
}

/**
 * The tables `plan` checks or fills, each with its ID in `tableIds` and
 * the fields its records must fit as the plan's contract describes them.
 * Tables that don't exist in the store yet hold no record, and are left
 * out.
 */
export const tableStepsOf = (
  plan: AcceptedPlan,
  tableIds: ReadonlyMap<string, string>
): TableSteps[] => {
  const byTable = new Map<string, CheckedField[]>();
  const add = (table: string, field: string, check: PlannedCheck | null) => {
    const descriptor = Object.hasOwn(plan.contract.tables, table)
      ? plan.contract.tables[table]?.fields[field]
      : undefined;
    if (descriptor === undefined) {
      throw new Error(`The plan's contract lacks ${table}.${field}`);
    }
    byTable.set(table, [
      ...(byTable.get(table) ?? []),
      { field, descriptor, check },
    ]);
  };
  for (const check of plan.checks) {
    add(check.table, check.field, check);
  }
  for (const { table, field } of plan.filledFields) {
    add(table, field, null);
  }
  return [...byTable].flatMap(([table, fields]) => {
    const tableId = tableIds.get(table);
    return tableId === undefined ? [] : [{ table, tableId, fields }];
  });
};

/** Why each field of a record doesn't fit, or the record as it would be. */
type Settled =
  | { readonly fields: StoreFields; readonly changed: boolean }
  | {
      readonly failures: readonly {
        field: string;
        reason: SchemaCheckReason;
      }[];
    };

/** What settling a field answers: kept, a value to write, or why not. */
type FieldSettled =
  | { readonly kept: true }
  | { readonly value: unknown }
  | { readonly reason: SchemaCheckReason };

/**
 * What a field the record lacks takes (it doesn't hold it, or holds null):
 * the value of the field it was renamed from, or the App's value for it,
 * when that fits.
 */
const givenField = (
  checked: CheckedField,
  fields: StoreFields,
  present: boolean
): FieldSettled => {
  const { descriptor, check } = checked;
  // A field renamed takes the old field's value; any other, the App's.
  const from = check?.from ?? null;
  let given: unknown = check?.answer?.value;
  if (from !== null) {
    given = Object.hasOwn(fields, from) ? fields[from] : undefined;
  }
  if (given === undefined) {
    return { reason: present ? "invalid" : "missing" };
  }
  return validates(descriptor, given) ? { value: given } : { reason: "unfit" };
};

/**
 * The value `checked` takes in a record holding `fields`: kept where it
 * fits (its nested defaults filled in where they are missing), or, where
 * the record lacks it, its default or what `givenField` gives it; a
 * failure where none of those fits. Never over a value the record holds.
 */
const settledField = (
  checked: CheckedField,
  fields: StoreFields
): FieldSettled => {
  const { field, descriptor } = checked;
  const present = Object.hasOwn(fields, field);
  const value = present ? (fields[field] ?? null) : null;
  if (present && validates(descriptor, value)) {
    const filled = withDefaultsFilled(descriptor, value);
    return canonicalText(filled) === canonicalText(value)
      ? { kept: true }
      : { value: filled };
  }
  if (!present && descriptor.presence === "optional") {
    return { kept: true };
  }
  if (!present && descriptor.presence === "default") {
    return { value: descriptor.defaultValue ?? null };
  }
  if (present && value !== null) {
    // A value the record holds, which doesn't fit: a migration's.
    return { reason: "invalid" };
  }
  return givenField(checked, fields, present);
};

/**
 * A record of `steps`' table as the change leaves it: every checked field
 * settled from the record as it was (an answer reading another field
 * reads what the record held, never a value another answer just made).
 */
const settledRecord = (steps: TableSteps, fields: StoreFields): Settled => {
  const failures: { field: string; reason: SchemaCheckReason }[] = [];
  const after: Record<string, unknown> = { ...fields };
  let changed = false;
  for (const checked of steps.fields) {
    const settled = settledField(checked, fields);
    if ("reason" in settled) {
      failures.push({ field: checked.field, reason: settled.reason });
    } else if ("value" in settled) {
      after[checked.field] = settled.value;
      changed = true;
    }
  }
  if (failures.length > 0) {
    return { failures };
  }
  const settled = storedFieldsSchema.parse(after);
  if (
    changed &&
    encoder.encode(canonicalJson(settled)).byteLength > documentMaxBytes
  ) {
    return {
      failures: [{ field: steps.fields[0]?.field ?? "", reason: "too_large" }],
    };
  }
  return { fields: settled, changed };
};

/**
 * Whether a value the App gives could settle a record that doesn't fit
 * for `reason`: only one that lacks the field (`missing`), or one the
 * value given didn't fit (`unfit`). A value never replaces one the record
 * holds (`invalid`), nor makes a record smaller (`too_large`).
 */
const valueSettles = (reason: SchemaCheckReason): boolean =>
  reason === "missing" || reason === "unfit";

/** The questions a run asks, as it finds records that don't fit. */
export class Questions {
  readonly #byField = new Map<string, SchemaQuestion>();
  /**
   * Whether the App may answer with a value: not on a rollback, whose
   * answers are the old release's, sealed with it.
   */
  readonly #answerable: boolean;

  constructor(answerable: boolean) {
    this.#answerable = answerable;
  }

  /** Notes that record `id` doesn't fit `field` of `table`, and why. */
  add(
    table: string,
    field: string,
    id: string,
    reason: SchemaCheckReason
  ): void {
    const key = canonicalJson([table, field]);
    const question = this.#byField.get(key) ?? {
      table,
      field,
      rows: 0,
      records: [],
      answers: ["migration"],
    };
    question.rows += 1;
    if (question.records.length < schemaQuestionRecordsMax) {
      question.records.push({ id, reason });
    }
    if (this.#answerable && valueSettles(reason)) {
      question.answers = ["value", "migration"];
    }
    this.#byField.set(key, question);
  }

  /** Whether no record failed. */
  get empty(): boolean {
    return this.#byField.size === 0;
  }

  /** The questions, by table then field. */
  list() {
    // Copied into plain objects, as an error's details carry them.
    return [...this.#byField.values()]
      .toSorted(
        (a, b) =>
          a.table.localeCompare(b.table) || a.field.localeCompare(b.field)
      )
      .map(({ table, field, rows, records: listed, answers }) => ({
        table,
        field,
        rows,
        records: listed.map(({ id, reason }) => ({ id, reason })),
        answers: [...answers],
      }));
  }
}

/** One page of a table's records after `after`, by record ID. */
const pageOf = (db: Db, tableId: string, after: string | null) =>
  db
    .select()
    .from(records)
    .where(
      after === null
        ? eq(records.tableId, tableId)
        : and(eq(records.tableId, tableId), gt(records.recordId, after))
    )
    .orderBy(asc(records.recordId))
    .limit(scanPage)
    .all();

/**
 * Hands `visit` every record of table `tableId`, a page at a time, by
 * record ID: a record `visit` rewrites keeps its ID, so the next page
 * goes on after it.
 */
const eachRecord = (
  db: Db,
  tableId: string,
  visit: (record: typeof records.$inferSelect) => void
): void => {
  let after: string | null = null;
  for (;;) {
    const page = pageOf(db, tableId, after);
    for (const record of page) {
      visit(record);
    }
    const last = page.at(-1);
    if (last === undefined || page.length < scanPage) {
      return;
    }
    after = last.recordId;
  }
};

/** Where a change's writes go, and how they are recorded. */
export interface ChangeWrite {
  /** The store's commit they are recorded under in the change history. */
  readonly commit: number;
  /** The schema being made current: what each rewritten record is stamped with. */
  readonly schemaHash: string;
  readonly now: number;
  /** Whether a table's history keeps field names only. */
  readonly sensitive: (table: string) => boolean;
}

/** What a run of a change found and did. */
export interface ChangeRun {
  readonly questions: Questions;
  readonly rewritten: number;
  /** The tables whose records it rewrote, by ID. */
  readonly changedTables: ReadonlySet<string>;
}

/**
 * Writes `fields` over `record` of `table` for `write`, moving its
 * revision on, and records the change in the store's history (source
 * `schema_change`), for the record's owner.
 */
const rewrite = (
  db: Db,
  table: string,
  record: typeof records.$inferSelect,
  fields: StoreFields,
  write: ChangeWrite
): void => {
  db.update(records)
    .set({
      valueJson: canonicalJson(fields),
      revision: record.revision + 1,
      updatedAt: Math.max(write.now, record.updatedAt),
      schemaHash: write.schemaHash,
    })
    .where(
      and(
        eq(records.tableId, record.tableId),
        eq(records.recordId, record.recordId)
      )
    )
    .run();
  recordChangesIn(
    db,
    [
      {
        tableId: record.tableId,
        tableName: table,
        recordId: record.recordId,
        before: storedFieldsSchema.parse(JSON.parse(record.valueJson)),
        after: fields,
        sensitive: write.sensitive(table),
      },
    ],
    {
      source: "schema_change",
      actor: { type: "system" },
      commit: write.commit,
      principal: record.ownerId,
    },
    write.now
  );
};

/**
 * Runs a change over every record of `steps`' tables: a dry run that
 * writes nothing, or, with `write`, one that rewrites each record the
 * change settles differently (its revision moved on) and records it in
 * the change history. Either way it answers the questions the records
 * that don't fit ask, offering a value only where one could settle them
 * and the change isn't a `rollback`. A run that writes must be inside the
 * transaction that moves the contract, and that transaction must be
 * thrown out when any question is asked: the run itself goes on past a
 * record that fails, to count them all.
 */
export const runChange = (
  db: Db,
  steps: readonly TableSteps[],
  { write, rollback = false }: { write?: ChangeWrite; rollback?: boolean } = {}
): ChangeRun => {
  const questions = new Questions(!rollback);
  const changedTables = new Set<string>();
  const tally = { rewritten: 0 };
  for (const table of steps) {
    eachRecord(db, table.tableId, (record) => {
      const settled = settledRecord(
        table,
        storedFieldsSchema.parse(JSON.parse(record.valueJson))
      );
      if ("failures" in settled) {
        for (const { field, reason } of settled.failures) {
          questions.add(table.table, field, record.recordId, reason);
        }
        return;
      }
      // Once a record failed, the transaction is thrown out: nothing more
      // is written, and the rest only counted.
      if (settled.changed && write !== undefined && questions.empty) {
        rewrite(db, table.table, record, settled.fields, write);
        changedTables.add(record.tableId);
        tally.rewritten += 1;
      }
    });
  }
  return { questions, rewritten: tally.rewritten, changedTables };
};
