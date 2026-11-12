// Whether a restore is under way (restore.ts): while one runs, nothing is
// added to the store, so no add can meet a version the restore brings back
// and none can be passed over or replaced by it. An add asks this in the
// transaction that would write its version (sources.ts), and is refused
// (contract.ts `restoringNow`), to be made again once the restore is done. Its own module, so sources.ts
// imports no part of the restore.

/** Whether a restore of an export is under way in the store. */
export const isRestoring = (sql: SqlStorage): boolean =>
  sql.exec("SELECT 1 FROM restores WHERE state = 'running' LIMIT 1").toArray()
    .length > 0;
