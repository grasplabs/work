// Applying a grid's patch to plain rows, for a caller that keeps its rows as objects keyed by the
// columns' keys. A caller with another store (a server, a document) applies the patch itself.
import type { Patch } from "./model";

/** The rows after a patch: each changed cell's column key set to its new value on its row. */
export const applyPatch = <Row extends object>(
  rows: readonly Row[],
  patch: Patch,
  rowKey: (row: Row) => string
): Row[] => {
  // A loop, not Map.groupBy: that is ES2024, and a Vite app's TypeScript stops at ES2023.
  const byRow = new Map<string, Patch["changes"][number][]>();
  for (const change of patch.changes) {
    byRow.set(change.rowId, [...(byRow.get(change.rowId) ?? []), change]);
  }
  return rows.map((row) => {
    const changes = byRow.get(rowKey(row));
    if (changes === undefined) {
      return row;
    }
    return {
      ...row,
      ...Object.fromEntries(
        changes.map((change) => [change.columnId, change.to])
      ),
    };
  });
};
