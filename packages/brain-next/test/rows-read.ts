// What a store's SQL reads, as workerd counts it (each cursor's
// `rowsRead`): how the cost tests hold a rule no answer shows (a scan
// where an index should seek, rows read that the reader may not read).
import { runInDurableObject } from "cloudflare:test";

/** The rows a call `ask` has the store's SQL read. */
export type RowsReadBy = (ask: () => Promise<unknown>) => Promise<number>;

/**
 * Wakes `store` and wraps its SQL once, so every cursor its statements
 * open is kept, and answers how many rows a call made then reads. The
 * test runs in the store's own isolate, so the cursors are reached here.
 * Counts what this instance of the store reads: a store restarted
 * meanwhile counts nothing.
 */
export const countRowsRead = async (
  store: DurableObjectStub
): Promise<RowsReadBy> => {
  const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
  await runInDurableObject(store, (_instance, state) => {
    const { sql } = state.storage;
    const exec = sql.exec.bind(sql);
    Object.defineProperty(sql, "exec", {
      value: (...args: Parameters<typeof sql.exec>) => {
        const cursor = exec(...args);
        cursors.push(cursor);
        return cursor;
      },
    });
  });
  return async (ask) => {
    cursors.length = 0;
    await ask();
    return cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0);
  };
};
