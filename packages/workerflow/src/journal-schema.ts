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
 * - 10: `events.attributes`, what an event was sent with, and
 *   `steps.event_match`, what a `waitForMatch` takes (identity.ts).
 * - 11: `events.reserved`, an event the run's host owed it, which the
 *   inbox's limits on senders don't count (run.ts, `sendEvent`).
 * - 12: `events.sender`, who sent an event, for each sender's share of
 *   the inbox (run.ts, `sendEvent`).
 */
export const journalSchemaVersion = 12;

/**
 * The oldest journal this engine reads, upgrading it as it first reads
 * it. No journal predates version 8: nothing earlier was released.
 */
export const oldestJournalSchemaVersion = 8;
