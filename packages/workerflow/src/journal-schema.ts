// The journal schemas this engine reads, apart from the journal itself
// (journal.ts), so a release can declare them (scripts/release) without
// loading the engine.

/**
 * The journal's own layout; a change to it is a new version, with the
 * upgrade from the one before it (journal.ts, `upgradedSchema`). A run of
 * a version outside `oldestJournalSchemaVersion` to this one is refused
 * when it is read.
 *
 * - 9: `run.control_fence`, the newest fence a control came with (run.ts,
 *   `ControlFence`).
 * - 10: `steps.settled`, the order the definition's steps' outcomes were
 *   journaled in, which a replay hands them back in (journal.ts,
 *   `createSettledOrder`).
 */
export const journalSchemaVersion = 10;

/**
 * The oldest journal this engine reads, upgrading it as it first reads
 * it. No journal predates version 8: nothing earlier was released.
 */
export const oldestJournalSchemaVersion = 8;
