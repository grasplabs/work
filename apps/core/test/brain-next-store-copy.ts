/**
 * The Brain's store copied and put back, as a backup and a restore of it
 * would: for the tests of erasure (brain-next-erasure.test.ts) and the
 * leak harness (brain-next-leaks.test.ts), which hold that what was
 * erased after a copy was taken stays erased once the copy comes back.
 * Local workerd has no point-in-time recovery, so the copy is every row
 * of every table, and putting it back replaces them all: the store
 * holds exactly what it held then, its own record of erasures included,
 * while the bucket, which no restore of the store touches, stays as it
 * is.
 */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

import { inJurisdiction } from "../src/durable-objects.ts";

/** The Brain's one store, as core reaches it. */
const store = () => inJurisdiction(env, env.BRAIN_STORE).getByName("brain");

/**
 * Kills the store, as a crash or a restart would: its next call starts it
 * afresh. The kill's own error is the test's: observed here and dropped.
 */
export const killStore = async (): Promise<void> => {
  try {
    await runInDurableObject(store(), (_instance, state) => {
      state.abort("Killed by the test");
    });
  } catch {
    // The kill ends the call it was made in.
  }
};

/** A row of a table, as the store keeps it. */
type Row = Record<string, SqlStorageValue>;

/**
 * Every row of the store, as a copy of it taken now: each table's, and
 * the word indexes' own (their pages are written again from them), with
 * the triggers that guard them.
 */
export interface StoreCopy {
  tables: { name: string; rows: Row[] }[];
  triggers: string[];
}

/** The word indexes' own tables, written by the indexes themselves. */
const indexPages = /^chunk_(?:words|stems)_/u;

/** A copy of the whole store, as a backup taken now would hold it. */
export const copyOfStore = async (): Promise<StoreCopy> =>
  await runInDurableObject(store(), (_instance, state) => {
    const { sql } = state.storage;
    const tables = sql
      .exec<{ name: string; sql: string }>(
        `SELECT name, sql FROM sqlite_master WHERE type = 'table'
        AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
        AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'`
      )
      .toArray()
      .filter(({ name }) => !indexPages.test(name))
      .map(({ name, sql: created }) => ({
        name,
        rows: sql
          .exec<Row>(
            created.startsWith("CREATE VIRTUAL TABLE")
              ? `SELECT rowid AS rowid, * FROM "${name}"`
              : `SELECT * FROM "${name}"`
          )
          .toArray(),
      }));
    const triggers = sql
      .exec<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger'"
      )
      .toArray()
      .map(({ sql: created }) => created);
    return { tables, triggers };
  });

/**
 * Puts `copy` back as the store's every row, as a restore of an older
 * copy would, and kills the store, as a restore restarts it: what came
 * since is gone from it, erasures and the store's record of them
 * included. The bucket is untouched.
 */
export const restoreStore = async (copy: StoreCopy): Promise<void> => {
  await runInDurableObject(store(), (_instance, state) => {
    const { sql } = state.storage;
    state.storage.transactionSync(() => {
      sql.exec("PRAGMA defer_foreign_keys = ON");
      // A restore replaces the database whole: no trigger of the store's
      // runs on the rows it takes away or brings back.
      const triggers = sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'trigger'"
        )
        .toArray();
      for (const { name } of triggers) {
        sql.exec(`DROP TRIGGER "${name}"`);
      }
      for (const { name } of copy.tables) {
        sql.exec(`DELETE FROM "${name}"`);
      }
      for (const { name, rows } of copy.tables) {
        for (const row of rows) {
          const columns = Object.keys(row);
          sql.exec(
            `INSERT INTO "${name}" (${columns.map((column) => `"${column}"`).join(", ")})
            VALUES (${columns.map(() => "?").join(", ")})`,
            ...Object.values(row)
          );
        }
      }
      for (const created of copy.triggers) {
        sql.exec(created);
      }
    });
  });
  await killStore();
};
