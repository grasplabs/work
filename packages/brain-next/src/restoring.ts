// Whether a restore is under way (restore.ts): while one runs, nothing is
// added to the store, so no add can meet a version the restore brings back
// and none can be passed over or replaced by it. An add asks this in the
// transaction that would write its version (sources.ts), and is refused, to
// be made again once the restore is done. Its own module, so sources.ts
// imports no part of the restore.

/** What an add answers while a restore runs: made again later, it lands. */
export const restoringNow =
  "The Brain refused it: it is restoring an export, so it adds nothing until that is done: add it again shortly";

/** Whether a restore of an export is under way in the store. */
export const isRestoring = (sql: SqlStorage): boolean =>
  sql.exec("SELECT 1 FROM restores WHERE state = 'running' LIMIT 1").toArray()
    .length > 0;
