import { recordChangeLimits } from "@grasp-os/shared/app-data";
import type {
  RecordChange,
  RecordChangeOp,
  RecordChangeSource,
  ValuesLeftOut,
} from "@grasp-os/shared/app-data";
import { auditActorSchema } from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import { canonicalJson } from "@grasp-os/shared/json";
import type { StoreFields } from "@grasp-os/shared/stores";
import { and, asc, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { z } from "zod";

import { recordChanges, store } from "./db/data-store/schema.ts";

// A business store's change history (`sdk_record_changes`): every record a
// commit, a cascade or an import inserted, updated or deleted, recorded by
// the store's host (store-host.ts) in the transaction that changed it, so
// no change lands unrecorded and none is recorded that didn't land. Read
// by the App's builders and the organization's admins (app-data.ts),
// never by App code. Threat model, and how each is closed:
//
// - A change nobody can attribute: each names the actor core resolved for
//   the call that made it (`Commit.actor`: the person, the agent acting
//   for them, the visitor, the workflow run or the App), never one App
//   code or a request could name; a cascade job's deletions name its
//   commit's actor, kept with the job; an import names its importer.
// - Sensitive values copied into a second place that outlives the record:
//   a table declared sensitive (`defineTable(...).sensitive()`, sticky in
//   the store's `sdk_tables.sensitive`, which clears the values kept
//   before) keeps which fields changed, never their values, whatever
//   version wrote it; so does a change whose values are larger
//   than `valuesMaxBytes`.
// - The history growing without bound, or kept forever: each change is
//   kept `retentionDays`, at most `maxEntries` in all and `maxBytes` of
//   them, pruned by the store's alarm (`pruneHistory`), which an idle
//   store keeps set for it too, a bounded amount at a time; the store's
//   deletion purges the rest with it.
// - Values kept of a person who is erased: their erasure clears the values
//   of every change made for them, whoever acted (store-host.ts,
//   `forgetPerson`, by `principal` and the actor).
// - The history leaking records the reader can't read: it is read only
//   through a table the reader's roles may read, for an `owner` table only
//   of a record that is theirs now, and for a table with row rules only of
//   a record its rules admit them to now, and then only the changes whose
//   before and after states the rules admit them to, nothing past a change
//   that kept no values (`admittedHistoryOf`; app-data.ts, store-host.ts).
//   A migration's rewrite keeps no change, and never moves a field a row
//   rule reads (store-host.ts, `rule_changed`), so the states a
//   history is rebuilt through admit the same people across it; a field
//   renamed is renamed in its history too, in the same transaction
//   (`renameHistoryFields`), so a state is never rebuilt from a field's
//   value now and its old name's then.

const dayMs = 24 * 60 * 60 * 1000;

/** Most changes one page of retention removes. */
const prunePage = 1000;

/** Most pages one alarm's retention removes: the next alarm goes on. */
const prunePages = 10;

const encoder = new TextEncoder();

/** One change to record, as the host saw it in its transaction. */
export interface ChangeInput {
  readonly tableId: string;
  readonly tableName: string;
  readonly recordId: string;
  /** Its fields before; undefined for a record the change inserted. */
  readonly before: StoreFields | undefined;
  /** Its fields after; null for a record the change deleted. */
  readonly after: StoreFields | null;
  /** The fields were never read (a cascade job's deletion). */
  readonly unread?: true;
  readonly sensitive: boolean;
}

/** Where a set of changes came from, and who made them. */
export interface ChangeOrigin {
  readonly source: RecordChangeSource;
  readonly actor: AuditActor;
  /** The commit they were made in, if one counted them. */
  readonly commit: number | null;
  /** The person they were made for, whoever acted. */
  readonly principal: string;
}

/** `fields`' values of `names` that it holds. */
const picked = (
  fields: StoreFields | null | undefined,
  names: readonly string[]
): StoreFields => {
  const kept: StoreFields = {};
  for (const name of names) {
    const value =
      fields !== null && fields !== undefined && Object.hasOwn(fields, name)
        ? fields[name]
        : undefined;
    if (value !== undefined) {
      // Defined, not assigned: no field name reaches the prototype.
      Object.defineProperty(kept, name, { enumerable: true, value });
    }
  }
  return kept;
};

/** The names of the fields whose values differ between `before` and `after`. */
const changedFields = (
  before: StoreFields | undefined,
  after: StoreFields | null
): string[] => {
  const was = before ?? {};
  const is = after ?? {};
  const names = new Set([...Object.keys(was), ...Object.keys(is)]);
  return [...names]
    .filter((name) => {
      const old = Object.hasOwn(was, name) ? was[name] : undefined;
      const now = Object.hasOwn(is, name) ? is[name] : undefined;
      if (old === undefined || now === undefined) {
        return old !== now;
      }
      return canonicalJson(old) !== canonicalJson(now);
    })
    .toSorted();
};

/** How a change moved its record, if it did. */
const opOf = (change: ChangeInput): RecordChangeOp | undefined => {
  if (change.after === null) {
    return change.before === undefined && change.unread !== true
      ? undefined
      : "delete";
  }
  return change.before === undefined ? "insert" : "update";
};

/** The bytes of `text` as UTF-8; none for no text. */
const bytesOf = (text: string | null): number =>
  text === null ? 0 : encoder.encode(text).byteLength;

/** What a row costs beyond its texts: its numbers and its indexes' keys. */
const rowOverheadBytes = 64;

/**
 * Records `changes`, made at `now` by `origin`: call it inside the
 * transaction that made them. A change that moved nothing (an update to
 * the same fields) records nothing. Retention is the alarm's
 * (`pruneHistory`), never the commit's.
 */
export const recordChangesIn = (
  db: DrizzleSqliteDODatabase,
  changes: readonly ChangeInput[],
  origin: ChangeOrigin,
  now: number
): void => {
  const actor = JSON.stringify(auditActorSchema.parse(origin.actor));
  let added = 0;
  for (const change of changes) {
    const op = opOf(change);
    const fields =
      change.unread === true ? [] : changedFields(change.before, change.after);
    if (op === undefined || (op === "update" && fields.length === 0)) {
      continue;
    }
    let leftOut: ValuesLeftOut | null = null;
    let beforeJson: string | null = null;
    let afterJson: string | null = null;
    if (change.unread === true) {
      leftOut = "unread";
    } else if (change.sensitive) {
      leftOut = "sensitive";
    } else {
      beforeJson = JSON.stringify(picked(change.before, fields));
      afterJson = JSON.stringify(picked(change.after, fields));
      if (
        bytesOf(beforeJson) + bytesOf(afterJson) >
        recordChangeLimits.valuesMaxBytes
      ) {
        leftOut = "too_large";
        beforeJson = null;
        afterJson = null;
      }
    }
    const names = JSON.stringify(fields);
    const bytes =
      rowOverheadBytes +
      bytesOf(actor) +
      bytesOf(origin.principal) +
      bytesOf(change.tableName) +
      bytesOf(change.recordId) +
      bytesOf(names) +
      bytesOf(beforeJson) +
      bytesOf(afterJson);
    added += bytes;
    db.insert(recordChanges)
      .values({
        changedAt: now,
        commit: origin.commit,
        tableId: change.tableId,
        tableName: change.tableName,
        recordId: change.recordId,
        op,
        source: origin.source,
        actor,
        principal: origin.principal,
        bytes,
        fields: names,
        beforeJson,
        afterJson,
        valuesLeftOut: leftOut,
      })
      .run();
  }
  if (added > 0) {
    db.update(store)
      .set({ historyBytes: sql`${store.historyBytes} + ${added}` })
      .run();
  }
};

/**
 * Whether the history is past `maxEntries` or `maxBytes`. The count is
 * the span of its IDs (an upper bound, as retention removes the oldest),
 * the bytes the store's running sum (as recorded: values cleared since
 * still count, an upper bound too): cheap enough for every schedule.
 */
const overBound = (db: DrizzleSqliteDODatabase): boolean => {
  // Each end its own seek of the primary key: `min` and `max` in one
  // query would scan the whole history, and every schedule asks this.
  const end = (order: typeof asc) =>
    db
      .select({ id: recordChanges.id })
      .from(recordChanges)
      .orderBy(order(recordChanges.id))
      .limit(1)
      .get()?.id;
  const first = end(asc);
  const last = end(desc);
  const bytes =
    db.select({ bytes: store.historyBytes }).from(store).get()?.bytes ?? 0;
  const count =
    first === undefined || last === undefined ? 0 : last - first + 1;
  return (
    count > recordChangeLimits.maxEntries || bytes > recordChangeLimits.maxBytes
  );
};

/** A change's field names, and its values, as their columns hold them. */
const namesSchema = z.array(z.string());
const valuesSchema = z.record(z.string(), z.unknown());

/** History rows a field rename rewrites at once. */
const renamePage = 500;

/** `fields` with each key `names` maps renamed, others as they are. */
const renamedKeys = (
  fields: Readonly<Record<string, unknown>>,
  names: ReadonlyMap<string, string>
): Record<string, unknown> => {
  const renamed: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) {
    // Defined, not assigned: no field name reaches the prototype.
    Object.defineProperty(renamed, names.get(name) ?? name, {
      enumerable: true,
      value,
    });
  }
  return renamed;
};

/**
 * Renames fields of table `tableId` in its history, old name to new
 * (`names`, all at once, so two fields that swap names swap here too):
 * call it inside the transaction of the schema change that renames them.
 * A history is rebuilt from the record as it is now through its changes
 * (`admittedHistoryOf`), so its changes must name each field as the
 * record does: a row rule reading a renamed field would otherwise read
 * the record's value now in states its history says it didn't hold.
 */
export const renameHistoryFields = (
  db: DrizzleSqliteDODatabase,
  tableId: string,
  names: ReadonlyMap<string, string>
): void => {
  if (names.size === 0) {
    return;
  }
  const rename = (text: string | null): string | null =>
    text === null
      ? null
      : JSON.stringify(
          renamedKeys(valuesSchema.parse(JSON.parse(text)), names)
        );
  let after = 0;
  let grown = 0;
  for (;;) {
    const rows = db
      .select({
        id: recordChanges.id,
        fields: recordChanges.fields,
        beforeJson: recordChanges.beforeJson,
        afterJson: recordChanges.afterJson,
        bytes: recordChanges.bytes,
      })
      .from(recordChanges)
      .where(
        and(eq(recordChanges.tableId, tableId), gt(recordChanges.id, after))
      )
      .orderBy(asc(recordChanges.id))
      .limit(renamePage)
      .all();
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      after = row.id;
      const listed = namesSchema.parse(JSON.parse(row.fields));
      if (!listed.some((name) => names.has(name))) {
        continue;
      }
      const fields = JSON.stringify(
        listed.map((name) => names.get(name) ?? name)
      );
      const beforeJson = rename(row.beforeJson);
      const afterJson = rename(row.afterJson);
      const bytes =
        row.bytes +
        bytesOf(fields) -
        bytesOf(row.fields) +
        bytesOf(beforeJson) -
        bytesOf(row.beforeJson) +
        bytesOf(afterJson) -
        bytesOf(row.afterJson);
      grown += bytes - row.bytes;
      db.update(recordChanges)
        .set({ fields, beforeJson, afterJson, bytes })
        .where(eq(recordChanges.id, row.id))
        .run();
    }
  }
  if (grown !== 0) {
    db.update(store)
      .set({ historyBytes: sql`${store.historyBytes} + ${grown}` })
      .run();
  }
};

/**
 * When retention next has something to remove from the history: `now`
 * while it is past a bound (`overBound`), otherwise when its
 * oldest change ages out; null while it is empty.
 */
export const historyDueAt = (
  db: DrizzleSqliteDODatabase,
  now: number
): number | null => {
  // The oldest by its index: a seek, never a scan.
  const oldest = db
    .select({ at: recordChanges.changedAt })
    .from(recordChanges)
    .orderBy(asc(recordChanges.changedAt))
    .limit(1)
    .get()?.at;
  if (oldest === null || oldest === undefined) {
    return null;
  }
  if (overBound(db)) {
    return now;
  }
  return oldest + recordChangeLimits.retentionDays * dayMs;
};

/**
 * Removes what retention no longer keeps, as the store's alarm runs it, at
 * most `prunePages` pages of `prunePage` changes: the oldest while the
 * history is past a bound, then those older than `retentionDays`. Each
 * page in a transaction of its own; the next alarm goes on.
 */
export const pruneHistory = (
  storage: DurableObjectStorage,
  db: DrizzleSqliteDODatabase,
  now: number
): void => {
  const cutoff = now - recordChangeLimits.retentionDays * dayMs;
  for (let at = 0; at < prunePages; at += 1) {
    const pruned = storage.transactionSync((): boolean => {
      const due = historyDueAt(db, now);
      if (due === null || due > now) {
        return false;
      }
      const oldest = db
        .select({ id: recordChanges.id })
        .from(recordChanges)
        .where(overBound(db) ? undefined : lt(recordChanges.changedAt, cutoff))
        .orderBy(asc(recordChanges.id))
        .limit(prunePage);
      const gone = db
        .delete(recordChanges)
        .where(inArray(recordChanges.id, oldest))
        .returning({ bytes: recordChanges.bytes })
        .all();
      const freed = gone.reduce((sum, { bytes }) => sum + bytes, 0);
      db.update(store)
        .set({ historyBytes: sql`max(0, ${store.historyBytes} - ${freed})` })
        .run();
      return gone.length > 0;
    });
    if (!pruned) {
      return;
    }
  }
};

/** A row as the history answers it. */
const changeOf = (row: typeof recordChanges.$inferSelect): RecordChange => ({
  id: row.id,
  at: new Date(row.changedAt).toISOString(),
  table: row.tableName,
  record: row.recordId,
  op: row.op,
  source: row.source,
  actor: auditActorSchema.parse(JSON.parse(row.actor)),
  commit: row.commit,
  fields: namesSchema.parse(JSON.parse(row.fields)),
  before:
    row.beforeJson === null
      ? null
      : valuesSchema.parse(JSON.parse(row.beforeJson)),
  after:
    row.afterJson === null
      ? null
      : valuesSchema.parse(JSON.parse(row.afterJson)),
  valuesLeftOut: row.valuesLeftOut,
});

/** How many changes a history read by row rules reads at once. */
const historyChunk = 100;

/**
 * The record as it was before `change`, from `after`, as it was just
 * after it: each field the change named back at the value it had, or
 * left out where it had none. Undefined when the change kept no values
 * (`valuesLeftOut`), so what the record held before can't be told.
 */
const stateBefore = (
  change: RecordChange,
  after: StoreFields
): StoreFields | undefined => {
  if (change.op === "insert") {
    return {};
  }
  const { before } = change;
  if (before === null) {
    return undefined;
  }
  const state: StoreFields = {};
  for (const [name, value] of Object.entries(after)) {
    if (!change.fields.includes(name)) {
      Object.defineProperty(state, name, { enumerable: true, value });
    }
  }
  for (const name of change.fields) {
    const value = Object.hasOwn(before, name) ? before[name] : undefined;
    if (value !== undefined) {
      Object.defineProperty(state, name, { enumerable: true, value });
    }
  }
  return state;
};

/**
 * A page of the history of record `recordId` of table `tableId`, as a
 * reader its table's read rules choose rows for may read it: only the
 * changes whose record, before and after, the rules admitted them to
 * (`admits`), so no state of the record they weren't let see shows, a
 * team it was moved from included. Each state is the record as it stands
 * now (`current`) with the newer changes undone, newest first; once a
 * change kept no values (a sensitive table's, one too large), what came
 * before can't be told, and nothing older shows. Newest first, before
 * change `before` if given, with where the next page starts.
 */
export const admittedHistoryOf = (
  db: DrizzleSqliteDODatabase,
  tableId: string,
  recordId: string,
  before: number | null,
  current: StoreFields,
  admits: (fields: StoreFields) => boolean
): { changes: RecordChange[]; next: number | null } => {
  const shown: RecordChange[] = [];
  let state: StoreFields | undefined = current;
  // Read newest first, a chunk at a time, and only as far as needed: up
  // to one change past a full page, or the first that kept no values,
  // past which no state can be told. The changes newer than `before` are
  // read too, as the states before them are rebuilt through them.
  let older: number | null = null;
  while (state !== undefined && shown.length <= recordChangeLimits.pageSize) {
    const chunk = db
      .select()
      .from(recordChanges)
      .where(
        and(
          eq(recordChanges.tableId, tableId),
          eq(recordChanges.recordId, recordId),
          older === null ? undefined : lt(recordChanges.id, older)
        )
      )
      .orderBy(desc(recordChanges.id))
      .limit(historyChunk)
      .all();
    for (const row of chunk) {
      older = row.id;
      const change = changeOf(row);
      const after: StoreFields = state;
      state = stateBefore(change, after);
      const admitted =
        admits(after) &&
        (change.op === "insert" || (state !== undefined && admits(state)));
      if (admitted && (before === null || change.id < before)) {
        shown.push(change);
      }
      if (state === undefined || shown.length > recordChangeLimits.pageSize) {
        break;
      }
    }
    if (chunk.length < historyChunk) {
      break;
    }
  }
  const page = shown.slice(0, recordChangeLimits.pageSize);
  return {
    changes: page,
    next:
      shown.length > recordChangeLimits.pageSize
        ? (page.at(-1)?.id ?? null)
        : null,
  };
};

/**
 * A page of the history of record `recordId` of table `tableId`, newest
 * first, before change `before` if given, and where the next page starts.
 */
export const historyOf = (
  db: DrizzleSqliteDODatabase,
  tableId: string,
  recordId: string,
  before: number | null
): { changes: RecordChange[]; next: number | null } => {
  const rows = db
    .select()
    .from(recordChanges)
    .where(
      and(
        eq(recordChanges.tableId, tableId),
        eq(recordChanges.recordId, recordId),
        before === null ? undefined : lt(recordChanges.id, before)
      )
    )
    .orderBy(desc(recordChanges.id))
    .limit(recordChangeLimits.pageSize + 1)
    .all();
  const page = rows.slice(0, recordChangeLimits.pageSize);
  return {
    changes: page.map(changeOf),
    next:
      rows.length > recordChangeLimits.pageSize
        ? (page.at(-1)?.id ?? null)
        : null,
  };
};
