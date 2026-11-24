// A store's storage copied and put back, as a backup and a restore of it
// would: the bucket untouched, the store killed, as a restore restarts it.
import { runInDurableObject } from "cloudflare:test";

/** A row of a table. */
type Row = Record<string, SqlStorageValue>;

/** Every table's schema and rows, and every index's and trigger's schema. */
export interface Copy {
  tables: { name: string; created: string; rows: Row[] }[];
  others: string[];
}

/** Tables another table of the store makes itself (the word indexes' pages). */
const madeByAnother = /^(?:sqlite_|(?:chunk|memory)_(?:words|stems)_)/u;

/** Kills the store, as a crash, a restart or a restore would. */
export const kill = async (store: DurableObjectStub): Promise<void> => {
  try {
    await runInDurableObject(store, (_instance, state) => {
      state.abort("Killed by the test");
    });
  } catch {
    // The kill ends the call it was made in.
  }
};

/** A copy of all `store` holds, as a backup taken now. */
export const copyOf = async (store: DurableObjectStub): Promise<Copy> =>
  await runInDurableObject(store, (_instance, state) => {
    const { sql } = state.storage;
    const tables = sql
      .exec<{ name: string; sql: string }>(
        `SELECT name, sql FROM sqlite_master WHERE type = 'table'
        AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'`
      )
      .toArray()
      .filter(({ name }) => !madeByAnother.test(name))
      .map(({ name, sql: created }) => ({
        name,
        created,
        rows: sql
          .exec<Row>(
            created.startsWith("CREATE VIRTUAL TABLE")
              ? `SELECT rowid AS rowid, * FROM "${name}"`
              : `SELECT * FROM "${name}"`
          )
          .toArray(),
      }));
    const others = sql
      .exec<{ sql: string | null }>(
        "SELECT sql FROM sqlite_master WHERE type IN ('index', 'trigger') ORDER BY type"
      )
      .toArray()
      .flatMap(({ sql: created }) => (created === null ? [] : [created]));
    return { tables, others };
  });

/** `copy` put back in place of all `store` holds, and the store killed. */
export const restore = async (
  store: DurableObjectStub,
  copy: Copy
): Promise<void> => {
  await runInDurableObject(store, async (_instance, state) => {
    await state.storage.deleteAll();
    const { sql } = state.storage;
    state.storage.transactionSync(() => {
      // Rows go back table by table: their references hold at the end.
      sql.exec("PRAGMA defer_foreign_keys = ON");
      for (const { created } of copy.tables) {
        sql.exec(created);
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
      for (const created of copy.others) {
        sql.exec(created);
      }
    });
  });
  await kill(store);
};
