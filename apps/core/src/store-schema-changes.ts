import type { ValueDescriptor } from "@grasp-os/sdk";
import { answerValue } from "@grasp-os/sdk/host";
import type {
  AcceptedPlan,
  PlannedCheck,
  SchemaAnswerKind,
  SchemaManifest,
} from "@grasp-os/sdk/host";
import { canonicalJson } from "@grasp-os/shared/json";
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
import { and, asc, eq, gt, isNotNull, sql } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import { records, schemaChangeValues } from "./db/data-store/schema.ts";
import { fitsTable } from "./store-migrations.ts";
import { validates } from "./store-queries.ts";

// A schema change the store checks every record for before its contract
// takes it (the SDK's schema-plan.ts, `activates`: a narrowing, a field
// required, a conversion, a rename, a changed access mode or row rule),
// as the store's host carries it out (store-host.ts, `activateReady`).
// The plan is pure and the SDK's; this is where it meets the records.
//
// It runs twice: as the release is sealed, a dry run over every record
// that writes nothing and answers what doesn't fit; and as the release is
// made current, in the one transaction that rewrites the records an
// answer or a default changes and moves the contract. Threat model, and
// how each is closed:
//
// - Data lost to a narrowing, or a value guessed: a record that doesn't
//   fit a checked field is rewritten only by the App's own answer for it
//   (schema-answer.ts, which reads text, numbers and booleans as written
//   and nothing else), and only when what the answer made fits the field;
//   otherwise the record is reported and nothing is applied. Nothing is
//   removed: a field the schema leaves out stays in every record and in
//   the contract, and a rewritten record's document before the change is
//   kept (`sdk_schema_change_values`) for its undo.
// - A partial migration: a crash, a timeout or a record that fails
//   halfway. The check, every rewrite, the undo copies, the contract's
//   move and the schemas it leaves behind are one SQLite transaction
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
//   refuses its writes (`migration.incompatible_write`) until an undo
//   brings it back.
// - A rule bypassed: an answer or a rename never rewrites a field a row
//   rule reads, before or after (`rule_field_rewritten`, refused by the
//   plan), so a record's audience changes only through writes, which
//   pass the rules (store-rules.ts); nor a field the store's reference or
//   file index reads. A changed access mode or row rule rewrites nothing:
//   the store reads and writes every version under its contract's
//   (store-host.ts, `#pinned`), so once the contract takes them they hold
//   for every record and every version still pinned, and no older
//   version reads on under looser ones.
// - A dry run leaking hidden rows: a question names a record by its ID
//   and why it doesn't fit (`SchemaCheckReason`, a fixed word), never a
//   value, a validator's message or anything the record holds, on any
//   table: the builder asking may not read the record (an owner's, or one
//   row rules keep from them). What still tells something, inherently,
//   and as an explicit migration's failure already does
//   (store-migrations.ts): that the record exists, and which of a field's
//   checks it fails. A question lists at most `schemaQuestionRecordsMax`
//   records, and counts the rest.
// - An undo overwriting what was written since: it puts back a record's
//   document only where the record is still at the revision the change
//   wrote; every other record of the tables it changed must fit the
//   contract before as it is, or the undo is refused, naming them, with
//   nothing written. A record deleted since stays deleted.
// - The undo copies outliving what they copy: they go with their record
//   (a trigger of this migration's), with a person's erasure for the
//   records they own, and once the contract moves past the change, when
//   no undo can reach them, in the transaction that moves it.

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

/**
 * The value `checked` takes in a record holding `fields`: kept where it
 * fits, filled in with its default where it is missing, or what the
 * check's answer makes of it; a failure where none of those fits.
 */
const settledField = (
  checked: CheckedField,
  fields: StoreFields
):
  | { readonly kept: true }
  | { readonly value: unknown }
  | { readonly reason: SchemaCheckReason } => {
  const { field, descriptor, check } = checked;
  const present = Object.hasOwn(fields, field);
  const value = present ? fields[field] : undefined;
  if (present && validates(descriptor, value)) {
    return { kept: true };
  }
  if (!present && descriptor.presence === "optional") {
    return { kept: true };
  }
  if (!present && descriptor.presence === "default") {
    return { value: descriptor.defaultValue ?? null };
  }
  const answer = check?.answer ?? null;
  if (answer === null) {
    return { reason: present ? "invalid" : "missing" };
  }
  const answered = answerValue(answer, present, value, fields);
  if (!answered.answered || answered.value === undefined) {
    return { reason: "unanswered" };
  }
  return validates(descriptor, answered.value)
    ? { value: answered.value }
    : { reason: "unfit" };
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

/** The questions a run asks, as it finds records that don't fit. */
export class Questions {
  readonly #byField = new Map<string, SchemaQuestion>();

  /** Notes that record `id` doesn't fit `field` of `table`, and why. */
  add(
    table: string,
    field: string,
    id: string,
    reason: SchemaCheckReason,
    answers: readonly SchemaAnswerKind[]
  ): void {
    const key = canonicalJson([table, field]);
    const question = this.#byField.get(key) ?? {
      table,
      field,
      rows: 0,
      records: [],
      answers: [...answers, "migration"],
    };
    question.rows += 1;
    if (question.records.length < schemaQuestionRecordsMax) {
      question.records.push({ id, reason });
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

/** Where a change's rewrites go, when it applies them. */
export interface ChangeWrite {
  readonly changeId: number;
  /** The schema being made current: what each rewritten record is stamped with. */
  readonly schemaHash: string;
  readonly now: number;
}

/** What a run of a change found and did. */
export interface ChangeRun {
  readonly questions: Questions;
  readonly rewritten: number;
  /** The tables whose records it rewrote, by ID. */
  readonly changedTables: ReadonlySet<string>;
}

/**
 * Writes `fields` over `record` for change `write`, moving its revision
 * on, and keeps its document before for an undo.
 */
const rewrite = (
  db: Db,
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
  db.insert(schemaChangeValues)
    .values({
      changeId: write.changeId,
      tableId: record.tableId,
      recordId: record.recordId,
      ownerId: record.ownerId,
      revision: record.revision + 1,
      valueJson: record.valueJson,
      schemaHash: record.schemaHash,
    })
    .run();
};

/**
 * Runs a change over every record of `steps`' tables: a dry run that
 * writes nothing, or, with `write`, one that rewrites each record the
 * change settles differently (its revision moved on) and keeps its
 * document before for an undo. Either way it answers the questions the
 * records that don't fit ask. A run that writes must be inside the
 * transaction that moves the contract, and that transaction must be
 * thrown out when any question is asked: the run itself goes on past a
 * record that fails, to count them all.
 */
export const runChange = (
  db: Db,
  steps: readonly TableSteps[],
  write?: ChangeWrite
): ChangeRun => {
  const questions = new Questions();
  const changedTables = new Set<string>();
  const tally = { rewritten: 0 };
  for (const table of steps) {
    const answersOf = new Map(
      table.fields.map(({ field, check }) => [field, check?.answers ?? []])
    );
    eachRecord(db, table.tableId, (record) => {
      const settled = settledRecord(
        table,
        storedFieldsSchema.parse(JSON.parse(record.valueJson))
      );
      if ("failures" in settled) {
        for (const { field, reason } of settled.failures) {
          questions.add(
            table.table,
            field,
            record.recordId,
            reason,
            answersOf.get(field) ?? []
          );
        }
        return;
      }
      // Once a record failed, the transaction is thrown out: nothing more
      // is written, and the rest only counted.
      if (settled.changed && write !== undefined && questions.empty) {
        rewrite(db, record, settled.fields, write);
        changedTables.add(record.tableId);
        tally.rewritten += 1;
      }
    });
  }
  return { questions, rewritten: tally.rewritten, changedTables };
};

/** A change to undo, as its record holds it. */
export interface UndoneChange {
  readonly changeId: number;
  /** The contract before the change, which every record must fit again. */
  readonly base: SchemaManifest;
  /** The tables it checked, by name, with their IDs. */
  readonly tables: readonly { table: string; tableId: string }[];
  readonly now: number;
}

/** The first of `declared`'s fields `fields` doesn't fit, and why. */
const firstMisfit = (
  declared: Readonly<Record<string, ValueDescriptor>>,
  fields: StoreFields
): { field: string; reason: SchemaCheckReason } => {
  for (const [field, descriptor] of Object.entries(declared)) {
    if (!Object.hasOwn(fields, field)) {
      if (descriptor.presence !== "optional") {
        return { field, reason: "missing" };
      }
    } else if (!validates(descriptor, fields[field])) {
      return { field, reason: "invalid" };
    }
  }
  return { field: "", reason: "invalid" };
};

/**
 * Undoes change `change` in the transaction that moves the contract back:
 * every record it rewrote and nobody changed since gets its document back
 * (its revision moved on, so a reader holding the change's version knows
 * it changed); every other record of the tables it checked must fit the
 * contract before as it is. Answers the questions of those that don't,
 * and what it put back. As with `runChange`, the transaction must be
 * thrown out when any question is asked.
 */
export const undoChange = (db: Db, change: UndoneChange): ChangeRun => {
  const questions = new Questions();
  const changedTables = new Set<string>();
  const tally = { rewritten: 0 };
  for (const { table, tableId } of change.tables) {
    const declared = Object.hasOwn(change.base.tables, table)
      ? (change.base.tables[table]?.fields ?? {})
      : {};
    const kept = new Map(
      db
        .select()
        .from(schemaChangeValues)
        .where(
          and(
            eq(schemaChangeValues.changeId, change.changeId),
            eq(schemaChangeValues.tableId, tableId)
          )
        )
        .all()
        .map((row) => [row.recordId, row])
    );
    eachRecord(db, tableId, (record) => {
      const before = kept.get(record.recordId);
      if (
        before?.valueJson !== null &&
        before?.valueJson !== undefined &&
        before.revision === record.revision
      ) {
        db.update(records)
          .set({
            valueJson: before.valueJson,
            revision: record.revision + 1,
            updatedAt: Math.max(change.now, record.updatedAt),
            schemaHash: before.schemaHash,
          })
          .where(
            and(
              eq(records.tableId, tableId),
              eq(records.recordId, record.recordId)
            )
          )
          .run();
        changedTables.add(tableId);
        tally.rewritten += 1;
        return;
      }
      const fields = storedFieldsSchema.parse(JSON.parse(record.valueJson));
      if (!fitsTable(declared, fields)) {
        const { field, reason } = firstMisfit(declared, fields);
        questions.add(table, field, record.recordId, reason, []);
      }
    });
  }
  return { questions, rewritten: tally.rewritten, changedTables };
};

/**
 * Clears the undo copies of the records `personId` owns: their erasure
 * (store-host.ts, `forgetPerson`). An undo then checks those records as
 * they are, as it does a record edited since.
 */
export const forgetChangeValues = (db: Db, personId: string): void => {
  db.update(schemaChangeValues)
    .set({ valueJson: null })
    .where(
      and(
        eq(schemaChangeValues.ownerId, personId),
        isNotNull(schemaChangeValues.valueJson)
      )
    )
    .run();
};

/**
 * Removes every undo copy: called in the transaction that moves the
 * contract on by any other way than an undo, past the only change an undo
 * can reach (the newest, while the contract is still its own).
 */
export const dropChangeValues = (db: Db): void => {
  db.delete(schemaChangeValues)
    .where(sql`1 = 1`)
    .run();
};
