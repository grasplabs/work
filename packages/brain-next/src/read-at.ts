// When a version was last read where it lives (`NewSource.readAt`): the
// latest read time among its changes, which the store keeps per change
// (`source_changes.read_at`), so a read again of the same text moves it
// on without a new version. A column for any statement that has the
// version's row, one indexed lookup (`source_changes_version_idx`).

/** `max(read_at)` of the version whose row is `versionRow` (an SQL expression), or null. */
export const readAtOf = (versionRow: string): string =>
  `(SELECT max(source_changes.read_at) FROM source_changes
    WHERE source_changes.version_row = ${versionRow})`;
