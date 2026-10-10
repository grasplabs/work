import { storeIdSchema } from "@grasp-os/shared/ids";
import type { StoreId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import {
  commitSchema,
  dataErrors,
  recordIdSchema,
  storeMaxTables,
  storedFieldsSchema,
  tableNameSchema,
} from "@grasp-os/shared/stores";
import type {
  Commit,
  Committed,
  StoreFields,
  StoredRecord,
} from "@grasp-os/shared/stores";
import { DurableObject } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { z } from "zod";

import migrations from "./db/data-store/migrations/migrations.js";
import { records, store, tables } from "./db/data-store/schema.ts";
import { migrateOnWake } from "./db/migrate.ts";

// A business store: one Durable Object per store, named by the store's
// ID (data-stores.ts), with a SQLite database of its own that holds all
// of the store's logical tables and their records. The layout is the
// host's and fixed (db/data-store/schema.ts): a table is a row with an ID
// the store mints, a record a row with its managed fields in columns and
// its declared fields in one JSON document. No name an author chose ever
// becomes SQL: tables are found by ID, values are bound parameters.
//
// Only core holds this object's stub (`DATA_STORES` is one of core's own
// bindings, which App and workflow code never get), and core reaches it
// only for a store its inventory lists. Each deployment's core has a
// namespace of these objects of its own, so stores of two deployments
// never meet, whatever their names.
//
// A commit is one synchronous transaction: every revision guard and
// write checks against the store as it is, and all of the commit's
// writes land, or none do. Multiple writes to one record in a commit
// change its revision once; a record inserted in the commit is at
// revision 1 until it commits. A commit that changes nothing in a record
// leaves its revision and update time as they were.

/** A store's record, as staged in a commit. */
interface Staged {
  tableId: string;
  recordId: string;
  /** The row as committed before this commit; none for a record it inserted. */
  base: typeof records.$inferSelect | undefined;
  /** Its fields as staged so far; null once the commit deleted it. */
  fields: StoreFields | null;
}

/** Where a staged record is kept: its table and ID, which can't collide. */
const keyOf = (tableId: string, recordId: string): string =>
  JSON.stringify([tableId, recordId]);

/** A record's fields as stored: canonical, so equal fields store equal text. */
const storedText = (fields: StoreFields): string => canonicalJson(fields);

/** The fields a row stores. Its JSON is an object, as SQLite checks. */
const fieldsOf = (row: { valueJson: string }): StoreFields =>
  storedFieldsSchema.parse(JSON.parse(row.valueJson));

const toStored = (row: typeof records.$inferSelect): StoredRecord => ({
  id: row.recordId,
  ownerId: row.ownerId,
  revision: row.revision,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  schemaHash: row.schemaHash,
  fields: fieldsOf(row),
});

const conflict = (table: string, id: string) =>
  dataErrors.create("data.conflict", { table, id });

export class DataStore extends DurableObject<Env> {
  readonly #db = drizzle(this.ctx.storage);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrateOnWake(ctx, migrations);
  }

  /**
   * Makes sure the store has a table for each of `names`, minting an ID
   * for each new one, and answers every table's ID by name. A name that
   * differs from an existing one only in case is refused, and so is one
   * past `storeMaxTables`. Tables are never renamed or removed here.
   */
  defineTables(
    storeId: StoreId,
    names: readonly string[]
  ): Record<string, string> {
    const parsed = dataErrors.parse(
      "data.invalid",
      z.array(tableNameSchema).max(storeMaxTables),
      names
    );
    return this.ctx.storage.transactionSync(() => {
      this.#bind(storeId);
      const now = Date.now();
      for (const name of new Set(parsed)) {
        const existing = this.#db
          .select({ name: tables.name })
          .from(tables)
          .where(eq(tables.nameKey, name.toLowerCase()))
          .get();
        if (existing !== undefined) {
          if (existing.name !== name) {
            throw dataErrors.create("data.table_conflict", {
              table: name,
              existing: existing.name,
            });
          }
          continue;
        }
        this.#db
          .insert(tables)
          .values({
            tableId: crypto.randomUUID(),
            name,
            nameKey: name.toLowerCase(),
            createdAt: now,
          })
          .run();
      }
      const all = this.#db
        .select({ name: tables.name, tableId: tables.tableId })
        .from(tables)
        .all();
      if (all.length > storeMaxTables) {
        throw dataErrors.create("data.too_many_tables");
      }
      return Object.fromEntries(
        all.map(({ name, tableId }) => [name, tableId])
      );
    });
  }

  /** The record `id` of `table`, or null if the store has none. */
  get(storeId: StoreId, table: string, id: string): StoredRecord | null {
    const name = dataErrors.parse("data.invalid", tableNameSchema, table);
    const recordId = dataErrors.parse("data.invalid", recordIdSchema, id);
    return this.ctx.storage.transactionSync(() => {
      this.#bind(storeId);
      const row = this.#db
        .select()
        .from(records)
        .where(
          and(
            eq(records.tableId, this.#tableId(name)),
            eq(records.recordId, recordId)
          )
        )
        .get();
      return row === undefined ? null : toStored(row);
    });
  }

  /**
   * Commits a mutation's staged writes in one transaction, or nothing:
   * each guard's record must still be at the revision read, and each
   * write's record at its expected revision (a record the commit inserted
   * is at 1). Inserted records are owned by the principal and get IDs the
   * store mints. Refuses with `data.conflict` (a record changed or is
   * gone), `data.unknown_table` or `data.invalid`.
   */
  commit(input: Commit): Committed {
    const { storeId, principal, schemaHash, guards, writes } = dataErrors.parse(
      "data.invalid",
      commitSchema,
      input
    );
    return this.ctx.storage.transactionSync(() => {
      this.#bind(storeId);
      const staged = new Map<string, Staged>();
      const stage = (table: string, recordId: string): Staged => {
        const tableId = this.#tableId(table);
        const key = keyOf(tableId, recordId);
        const known = staged.get(key);
        if (known !== undefined) {
          return known;
        }
        const base = this.#db
          .select()
          .from(records)
          .where(
            and(eq(records.tableId, tableId), eq(records.recordId, recordId))
          )
          .get();
        const entry: Staged = {
          tableId,
          recordId,
          base,
          fields: base === undefined ? null : fieldsOf(base),
        };
        staged.set(key, entry);
        return entry;
      };
      /** The staged record, if it exists at `expected`; otherwise a conflict. */
      const at = (
        table: string,
        recordId: string,
        expected: number
      ): Staged & { fields: StoreFields } => {
        const entry = stage(table, recordId);
        const { fields } = entry;
        const revision = entry.base?.revision ?? 1;
        if (fields === null || revision !== expected) {
          throw conflict(table, recordId);
        }
        return { ...entry, fields };
      };

      for (const guard of guards) {
        at(guard.table, guard.id, guard.expectedRevision);
      }
      const inserted: string[] = [];
      for (const write of writes) {
        if (write.op === "insert") {
          const recordId = crypto.randomUUID();
          const tableId = this.#tableId(write.table);
          staged.set(keyOf(tableId, recordId), {
            tableId,
            recordId,
            base: undefined,
            fields: write.fields,
          });
          inserted.push(recordId);
          continue;
        }
        const entry = at(write.table, write.id, write.expectedRevision);
        const target = staged.get(keyOf(entry.tableId, entry.recordId));
        if (target === undefined) {
          throw new Error("A staged record went missing");
        }
        if (write.op === "delete") {
          target.fields = null;
        } else if (write.op === "replace") {
          target.fields = write.fields;
        } else {
          const unset = new Set(write.unset);
          target.fields = Object.fromEntries(
            Object.entries({ ...entry.fields, ...write.fields }).filter(
              ([name]) => !unset.has(name)
            )
          );
        }
      }
      this.#flush([...staged.values()], principal.userId, schemaHash);
      return { inserted };
    });
  }

  /** Writes what a commit staged, changing only the records it changed. */
  #flush(staged: readonly Staged[], ownerId: string, schemaHash: string): void {
    const now = Date.now();
    for (const { tableId, recordId, base, fields } of staged) {
      const where = and(
        eq(records.tableId, tableId),
        eq(records.recordId, recordId)
      );
      if (base === undefined) {
        if (fields !== null) {
          this.#db
            .insert(records)
            .values({
              tableId,
              recordId,
              ownerId,
              revision: 1,
              createdAt: now,
              updatedAt: now,
              valueJson: storedText(fields),
              schemaHash,
            })
            .run();
        }
      } else if (fields === null) {
        this.#db.delete(records).where(where).run();
      } else {
        const valueJson = storedText(fields);
        if (valueJson !== base.valueJson) {
          this.#db
            .update(records)
            .set({
              revision: base.revision + 1,
              updatedAt: Math.max(now, base.updatedAt),
              valueJson,
              schemaHash,
            })
            .where(where)
            .run();
        }
      }
    }
  }

  /** The ID of the table named `name`, or `data.unknown_table`. */
  #tableId(name: string): string {
    const row = this.#db
      .select({ tableId: tables.tableId })
      .from(tables)
      .where(eq(tables.name, name))
      .get();
    if (row === undefined) {
      throw dataErrors.create("data.unknown_table", { table: name });
    }
    return row.tableId;
  }

  /**
   * Holds this object to one store: the first call records which store it
   * is, and a call for any other store fails. Its name is the store's ID
   * (data-stores.ts), so this only fails if core addressed it wrongly.
   */
  #bind(storeId: StoreId): void {
    const id = storeIdSchema.parse(storeId);
    const bound = this.#db.select({ storeId: store.storeId }).from(store).get();
    if (bound === undefined) {
      this.#db
        .insert(store)
        .values({ only: 1, storeId: id, createdAt: Date.now() })
        .run();
      return;
    }
    if (bound.storeId !== id) {
      throw new Error("This object holds another store");
    }
  }
}
