// What a run tells its host of itself: each status it takes, from its
// creation on, as a notification in an outbox it keeps until the host has
// taken it. A trigger on the run's row writes it, in the statement that
// writes the status (history.ts writes the observers' events the same
// way): no status is written without its notification, and none is
// written for a change that was rolled back.
//
//   notifications   each status change the host hasn't taken yet: its
//                   sequence, when, the status, and the run's generation
//
// The run object hands them to its host (`WorkflowRun.notify`) in order,
// as soon as the write that added them commits, and drops them once the
// host has taken them (run.ts). The write that adds one also sets the
// run's `notify_at`, which every alarm the run object sets is brought
// forward to: a host that failed, or a process that died before the
// host's answer, gets the same notifications again from the alarm, after
// a backoff for a host that failed. Delivery is at least once and in
// order; a host keeps, per run, the greatest sequence it applied and
// ignores one at or below it, so one handed over again, late, never
// overwrites a newer one.
import type { InstanceStatus } from "./contracts.ts";
import type { RunRow } from "./journal.ts";

/**
 * A status change of a run, as its host is told it: never a value of the
 * run's. What a host wants of a run's output or error it asks `status()`
 * for, at the boundary where it decides who may see it.
 */
export interface RunNotification {
  readonly workflow: string;
  readonly version: string | undefined;
  readonly instanceId: string;
  /**
   * Which run under the instance ID: one deleted and created again under
   * the same ID is another run, with sequences of its own from 1.
   */
  readonly runId: string;
  /**
   * When that run was created, in ms since the epoch: a run created again
   * under the instance ID is created later, so `(createdAt, runId,
   * sequence)` orders every notification of an instance ID, across
   * deletions, as long as the clock doesn't go back between them.
   */
  readonly createdAt: number;
  /** The run's execution, from 1: one more at each restart. */
  readonly generation: number;
  /**
   * From 1, one more at each status change of the run, across its
   * restarts: the greater is the newer, and the same is the same change.
   */
  readonly sequence: number;
  readonly status: InstanceStatus["status"];
  /** When the run took the status, in ms since the epoch. */
  readonly timestamp: number;
}

/** The most notifications handed to the host at once. */
export const notificationBatch = 100;

/** How long the host may take to answer before it counts as failed. */
export const defaultNotifyTimeoutMs = 30_000;

/** The backoff after the host failed: doubling from 1 s, up to an hour. */
export const notifyRetryMs = (failures: number): number =>
  Math.min(60 * 60 * 1000, 1000 * 2 ** Math.max(0, failures - 1));

/** Now, in milliseconds, as SQLite tells it inside a trigger. */
const now = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

export const createNotifications = (sql: SqlStorage): void => {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      status TEXT NOT NULL,
      generation INTEGER NOT NULL
    );
    -- The status the run is created with.
    CREATE TRIGGER IF NOT EXISTS notifications_created
    AFTER INSERT ON run
    BEGIN
      INSERT INTO notifications (at, status, generation)
        VALUES (new.created_at, new.status, new.executions);
      UPDATE run SET notify_at = COALESCE(notify_at, new.created_at);
    END;
    -- Each status it changes to, and with it the alarm's obligation: due
    -- now, unless an earlier one still stands (a host that failed has it
    -- after its backoff).
    CREATE TRIGGER IF NOT EXISTS notifications_status
    AFTER UPDATE OF status ON run
    WHEN old.status IS NOT new.status
    BEGIN
      INSERT INTO notifications (at, status, generation)
        VALUES (${now}, new.status, new.executions);
      UPDATE run SET notify_at = COALESCE(notify_at, ${now});
    END;
  `);
};

interface NotificationRow extends Record<string, SqlStorageValue> {
  sequence: number;
  at: number;
  status: InstanceStatus["status"];
  generation: number;
}

/** The oldest notifications the host hasn't taken, in order. */
export const readPending = (sql: SqlStorage, run: RunRow): RunNotification[] =>
  sql
    .exec<NotificationRow>(
      "SELECT sequence, at, status, generation FROM notifications ORDER BY sequence LIMIT ?",
      notificationBatch
    )
    .toArray()
    .map((row) => ({
      workflow: run.definition,
      version: run.version ?? undefined,
      instanceId: run.instance_id,
      runId: run.run_uid,
      createdAt: run.created_at,
      generation: row.generation,
      sequence: row.sequence,
      status: row.status,
      timestamp: row.at,
    }));

/**
 * Drops what the host took, up to `sequence`, in the caller's write: the
 * alarm's obligation goes with the last of them, and the backoff is over.
 */
export const takenIn = (sql: SqlStorage, sequence: number): void => {
  sql.exec("DELETE FROM notifications WHERE sequence <= ?", sequence);
  sql.exec(
    "UPDATE run SET notify_failures = 0, notify_at = CASE WHEN EXISTS (SELECT 1 FROM notifications) THEN notify_at ELSE NULL END"
  );
};

/**
 * Puts the next delivery off after the host failed, in the caller's write.
 * Returns when it is due.
 */
export const failedIn = (sql: SqlStorage, at: number): number => {
  const { notify_failures: failures } = sql
    .exec<{ notify_failures: number }>(
      "UPDATE run SET notify_failures = notify_failures + 1 RETURNING notify_failures"
    )
    .one();
  const due = at + notifyRetryMs(failures);
  sql.exec("UPDATE run SET notify_at = ?", due);
  return due;
};
