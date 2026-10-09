// A run's journal: the SQLite tables of its Durable Object. They alone say
// where the run is and how it got there, so recovery after a crash, an
// eviction or a duplicate alarm reads them and nothing else.
//
//   run          one row: identity, params, status, the current generation
//                and execution, when a waiting run is next due, and when a
//                paused one was paused
//   activations  each time the run was executed, by generation, and how
//                that ended (no end: the process died or it was evicted)
//   steps        each step occurrence: identity, start order, outcome; a
//                sleep's or an event wait's absolute deadline; whether it
//                registered a rollback. A rollback that ran is a step too,
//                of type `rollback`, under its step's name and count
//   attempts     each attempt at a `do` step, by generation: its timeout's
//                absolute deadline, how it ended (no end: cut off before
//                its outcome was journaled), and when a failed one's retry
//                is due
//   events       the inbox: each event the run accepted, in order, and the
//                wait that took it
//   history      what observers are shown: one row per change of the
//                above, written by triggers in the same statement
//                (history.ts)
//
// Beside the journal, and outliving it, `tombstones` keeps the start key
// of each removed run whose start can be delivered again (`admit`, a
// schedule), and when it was removed, nothing else: a start delivered
// again finds that, and creates no second run to repeat the first one's
// effects. A tombstone holds for the run object's tombstone horizon (30
// days by default, run.ts), then expires: a start delivered after that is
// a new start. A run `create` made leaves none: no one has its key.
//
// Values and errors are kept as codec text (codec.ts), never as live
// objects; a step's stream result as chunks beside them (streams.ts).
import { createHistory } from "./history.ts";
import { createStreamChunks } from "./streams.ts";

/**
 * A journal of a layout this engine doesn't read. It is refused as it is
 * read, before any of its other columns are: the run object answers with
 * this, and its alarm ends without an activation (run.ts).
 */
export class JournalSchemaError extends Error {
  override readonly name = "JournalSchemaError";
}

/**
 * The journal's own layout; a change to it is a new version. No journal
 * predates version 7 (nothing earlier was released), so a run of any other
 * version is refused when it is read; a later layout that changes it
 * brings its own upgrade.
 */
export const journalSchemaVersion = 7;

/**
 * The largest event payload a run accepts, as the encoded text it keeps:
 * the most text the codec writes for any one value, which holds every
 * value within Cloudflare's 1 MiB limit that a journal value can hold.
 */
export { maxStoredTextBytes as maxEventPayloadBytes } from "./codec.ts";

/**
 * What one run's inbox holds at most, taken and untaken events alike, so
 * no sender can fill a run's storage. Taken events aren't pruned: each is
 * what its wait returns on every replay, for as long as the run lives.
 * They go with the rest of the journal when retention (run.ts)
 * removes it; an ended run takes no events, so its inbox no longer grows.
 */
export const maxInboxEvents = 10_000;
export const maxInboxBytes = 32 * 1024 * 1024;

/**
 * `waitingForPause`: a pause was asked for while an activation ran; it
 * finishes the steps it has out and starts nothing new, then the run is
 * `paused`, with no activation and no alarm, until it is resumed.
 * `terminated`: ended by a command, not by its definition. `rollingBack`:
 * running its steps' rollbacks, after which it ends as `rollback_end`
 * says.
 */
export type RunState =
  | "queued"
  | "running"
  | "waiting"
  | "waitingForPause"
  | "paused"
  | "rollingBack"
  | "complete"
  | "errored"
  | "terminated";

export interface RunRow extends Record<string, SqlStorageValue> {
  schema: number;
  run_uid: string;
  definition: string;
  version: string | null;
  instance_id: string;
  start_key: string;
  params: string;
  created_at: number;
  status: RunState;
  /**
   * Bumped by every activation, and by every command that ends one's hold
   * on the run (terminate, restart, a pause taken over from a dead one):
   * the fence against stale ones.
   */
  generation: number;
  /**
   * The current execution of the run: drawn when it is created, and drawn
   * again by every restart. A step's idempotency key is drawn from the
   * execution it first ran in (identity.ts), so a step a restart runs
   * again goes out under another key than before, where a retry goes out
   * under the same one.
   */
  execution_uid: string;
  /** When a paused run was paused; null otherwise. */
  paused_at: number | null;
  /**
   * About when the watchdog alarm is due while an activation runs: a lease
   * after the activation's start or its latest write for a step (a claim,
   * an outcome, a wait's end). The alarm is moved after each such write,
   * so it may come a little later than this. Null while the run waits and
   * once it has ended. Nothing reads it to decide anything; it records
   * when recovery would start. An object gets no alarm while its alarm
   * handler still runs, so a step that hangs is ended by its own timeout,
   * in the activation, not by the watchdog.
   */
  lease_until: number | null;
  /**
   * When a waiting run is next due: the deadline of the wait it suspended
   * on, or the earliest time one of its parked steps is due (a retry, or
   * an attempt left for a fresh activation, due at once), or the time an
   * event its wait can take was accepted. Written with the alarm it sets,
   * in the same synchronous turn, and read by nothing.
   */
  wake_at: number | null;
  /**
   * How many events the inbox holds, and their encoded payload bytes:
   * kept with each acceptance, in its write, so checking the limits costs
   * the same however many events there are.
   */
  event_count: number;
  event_bytes: number;
  /**
   * What the run's stream chunks hold in all, kept in the writes that add
   * and delete them (streams.ts), so a cap on it reads one row.
   */
  stream_bytes: number;
  output: string | null;
  error: string | null;
  ended_at: number | null;
  /**
   * Why the run rolls back, as error text: the error its definition
   * threw, or the termination's. Set when it starts rolling back.
   */
  rollback_trigger: string | null;
  /** What a run rolling back ends as. */
  rollback_end: "errored" | "terminated" | null;
  /** How its rolling back ended (a RollbackOutcome, as JSON). */
  rollback: string | null;
  /**
   * How many compensating replays in a row ended without getting back the
   * rollbacks still to run; reset by one that does.
   */
  rollback_replays: number;
  /**
   * The schedule occurrence that started the run (a Schedule, as JSON);
   * null for a run started otherwise.
   */
  schedule: string | null;
  /**
   * 1 when the start can be delivered again (`admit`, a schedule's
   * occurrence), so removing the run leaves its key as a tombstone; 0 for
   * a `create`, whose key no one else has.
   */
  redeliverable: number;
  /**
   * How long the run is kept once it has ended, in milliseconds: after it
   * completed or was terminated, and after it errored. Resolved by the
   * binding when it was created (its own setting, or the binding's
   * default), and never changed.
   */
  success_retention_ms: number;
  error_retention_ms: number;
  /**
   * When the ended run is purged: its end plus its retention, written in
   * the transaction that wrote the end. Null while it hasn't ended, and
   * cleared by a restart, so no run that runs, waits, is paused or rolls
   * back is ever purged.
   */
  purge_at: number | null;
}

/**
 * `running`: a `do` step's latest attempt is out, or was cut off.
 * `retrying`: its latest attempt failed, and the next is due at that
 * attempt's `retry_at`. `waiting`: a sleep or an event wait that hasn't
 * come to its outcome. `fatal`: a `do` step returned what it can't keep,
 * and the run ends with it; unlike `failed`, no replay hands it to the
 * definition.
 */
export type StepState =
  | "running"
  | "retrying"
  | "waiting"
  | "succeeded"
  | "failed"
  | "fatal";

/**
 * What kind of step a row is; part of its identity. A `rollback` row is
 * the rollback of the `do` step of the same name and count.
 */
export type StepType = "do" | "sleep" | "waitForEvent" | "rollback";

export interface StepRow extends Record<string, SqlStorageValue> {
  /** The order steps were first started in. */
  ordinal: number;
  type: StepType;
  name: string;
  occurrence: number;
  idempotency_key: string;
  state: StepState;
  /** The latest attempt, from 1; a sleep or a wait only ever has one. */
  attempt: number;
  value: string | null;
  error: string | null;
  /**
   * A sleep's or a wait's absolute deadline, journaled when the step was
   * first reached. Nothing a replay, an alarm or an event does moves it;
   * only `resume` does, by the time the run was paused (run.ts).
   */
  deadline: number | null;
  /** The event type a wait takes. */
  event_type: string | null;
  /**
   * A sleep's duration or a wait's timeout as first given, which every
   * replay must give again; null for `sleepUntil`.
   */
  duration_ms: number | null;
  /**
   * A `do` step's config as first given (config.ts), in milliseconds, its
   * sensitivity with it, which every replay must give again; null for a
   * sleep or a wait.
   */
  config: string | null;
  /** 1 when the step registered a rollback when it started. */
  has_rollback: number;
  /**
   * 1 when the step was called from inside another step's attempt: a
   * replay that returns that step's outcome never calls it again, so a
   * restart can't start from it (run.ts).
   */
  nested: number;
}

/**
 * How an attempt ended. `succeeded` / `failed`: its outcome is journaled
 * (a failure with a retry left has its `retry_at`). `timed_out`: it ran
 * past its deadline and failed as it did; whatever it answers later is
 * ignored. `superseded`: its activation was over (a later generation took
 * over) or a later attempt had the step when it came back, and what it
 * came back with was ignored. One still the step's latest counts as cut
 * off: the next activation to reach the step ends it as such, over this
 * (activation.ts).
 */
export type AttemptEnd = "succeeded" | "failed" | "timed_out" | "superseded";

/**
 * How an activation ended. `settled`: it journaled the run's end.
 * `superseded`: a later generation took over. `suspended`: it reached a
 * wait that isn't due, or every step it had out was parked, and let go of
 * the run until its alarm. `paused`: a pause was asked for, and it let go
 * of the run once nothing it had out was still out. `faulted`: one of the engine's own storage
 * calls failed, and the watchdog alarm brings the run back. No end: the
 * process died, or the object was evicted.
 */
export type ActivationEnd =
  | "settled"
  | "superseded"
  | "suspended"
  | "paused"
  | "faulted";

export interface AttemptRow extends Record<string, SqlStorageValue> {
  ordinal: number;
  attempt: number;
  generation: number;
  started_at: number;
  /** When its timeout ends it: journaled before its callback is called. */
  deadline: number;
  ended_at: number | null;
  ended: AttemptEnd | null;
  /** What a failed or timed-out attempt threw, as error text. */
  error: string | null;
  /**
   * When the next attempt is due, for a failed attempt with a retry left:
   * an absolute time, journaled in the write that ended this one, and
   * never computed again.
   */
  retry_at: number | null;
}

export interface ActivationRow extends Record<string, SqlStorageValue> {
  generation: number;
  started_at: number;
  ended_at: number | null;
  ended: ActivationEnd | null;
}

export interface EventRow extends Record<string, SqlStorageValue> {
  /** The order the run accepted events in. */
  seq: number;
  type: string;
  /** The payload, as codec text. */
  payload: string;
  /** The sender's delivery key: the same key again is the same event. */
  key: string | null;
  accepted_at: number;
  /** The wait (its step's ordinal) that took the event. */
  consumed_by: number | null;
}

/** The whole journal, as plain data: what a run's recovery is read from. */
export interface Journal {
  run: RunRow;
  activations: ActivationRow[];
  steps: StepRow[];
  attempts: AttemptRow[];
  events: EventRow[];
}

export const createJournal = (sql: SqlStorage): void => {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS run (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema INTEGER NOT NULL,
      run_uid TEXT NOT NULL,
      definition TEXT NOT NULL,
      version TEXT,
      instance_id TEXT NOT NULL,
      start_key TEXT NOT NULL,
      params TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting', 'waitingForPause', 'paused', 'rollingBack', 'complete', 'errored', 'terminated')),
      generation INTEGER NOT NULL,
      execution_uid TEXT NOT NULL,
      paused_at INTEGER,
      lease_until INTEGER,
      wake_at INTEGER,
      event_count INTEGER NOT NULL DEFAULT 0,
      event_bytes INTEGER NOT NULL DEFAULT 0,
      stream_bytes INTEGER NOT NULL DEFAULT 0,
      output TEXT,
      error TEXT,
      ended_at INTEGER,
      rollback_trigger TEXT,
      rollback_end TEXT CHECK (rollback_end IN ('errored', 'terminated')),
      rollback TEXT,
      rollback_replays INTEGER NOT NULL DEFAULT 0,
      schedule TEXT,
      redeliverable INTEGER NOT NULL,
      success_retention_ms INTEGER NOT NULL,
      error_retention_ms INTEGER NOT NULL,
      purge_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS activations (
      generation INTEGER PRIMARY KEY,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      ended TEXT CHECK (ended IN ('settled', 'superseded', 'suspended', 'paused', 'faulted'))
    );
    -- AUTOINCREMENT: an ordinal is never used again, not even for a step a
    -- restart ran again, so nothing a stale activation does by ordinal
    -- reaches another step's rows.
    CREATE TABLE IF NOT EXISTS steps (
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN ('do', 'sleep', 'waitForEvent', 'rollback')),
      name TEXT NOT NULL,
      occurrence INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('running', 'retrying', 'waiting', 'succeeded', 'failed', 'fatal')),
      attempt INTEGER NOT NULL,
      value TEXT,
      error TEXT,
      deadline INTEGER,
      event_type TEXT,
      duration_ms INTEGER,
      config TEXT,
      has_rollback INTEGER NOT NULL DEFAULT 0,
      nested INTEGER NOT NULL DEFAULT 0,
      UNIQUE (type, name, occurrence)
    );
    CREATE TABLE IF NOT EXISTS attempts (
      ordinal INTEGER NOT NULL REFERENCES steps (ordinal),
      attempt INTEGER NOT NULL,
      generation INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      deadline INTEGER NOT NULL,
      ended_at INTEGER,
      ended TEXT CHECK (ended IN ('succeeded', 'failed', 'timed_out', 'superseded')),
      error TEXT,
      retry_at INTEGER,
      PRIMARY KEY (ordinal, attempt)
    );
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      key TEXT UNIQUE,
      accepted_at INTEGER NOT NULL,
      consumed_by INTEGER UNIQUE REFERENCES steps (ordinal)
    );
    CREATE INDEX IF NOT EXISTS events_unconsumed
      ON events (type, seq) WHERE consumed_by IS NULL;
    -- At most one wait waits at a time: the lookups by state stay one row
    -- deep however long the run's history grows.
    CREATE INDEX IF NOT EXISTS steps_waiting
      ON steps (type, event_type) WHERE state = 'waiting';
    -- The waits and retries a run suspended on: a handful at most.
    CREATE INDEX IF NOT EXISTS steps_pending
      ON steps (state) WHERE state IN ('waiting', 'retrying');
  `);
  createStreamChunks(sql);
  createHistory(sql);
};

/**
 * Whether this object has a journal: one that was only looked up (a status
 * of an instance that doesn't exist) keeps no tables.
 */
export const hasJournal = (sql: SqlStorage): boolean =>
  sql
    .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run'")
    .toArray().length > 0;

/**
 * The journal's tables, those that refer to others first, so dropping
 * them in this order never leaves a reference dangling.
 */
const journalTables = [
  "history",
  "stream_chunks",
  "attempts",
  "events",
  "steps",
  "activations",
  "run",
];

/** Tables that aren't the journal's: SQLite's and the host's own. */
const internalTable = /^(?:sqlite_|_cf_)/u;

/**
 * Removes the run's journal (every table of it, its stream chunks and
 * history too) and, for a start that can be delivered again, leaves its
 * key as a tombstone, in the caller's transaction: there is never a moment
 * with neither. The tombstone holds the key and when it was left, nothing
 * else: no params, no outputs, nothing a deletion should have taken.
 * `null`: no tombstone (a `create`'s start, never delivered again).
 * Tombstones left before stay, each until it expires.
 */
export const removeJournal = (
  sql: SqlStorage,
  tombstone: { key: string; at: number } | null
): void => {
  const present = new Set(
    sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
      )
      .toArray()
      .map((table) => table.name)
      .filter((name) => !internalTable.test(name) && name !== "tombstones")
  );
  // Any table a later layout adds goes too, after the known ones.
  const order = [
    ...journalTables.filter((name) => present.has(name)),
    ...[...present].filter((name) => !journalTables.includes(name)),
  ];
  for (const name of order) {
    sql.exec(`DROP TABLE "${name.replaceAll('"', '""')}"`);
  }
  if (tombstone === null) {
    return;
  }
  sql.exec(
    "CREATE TABLE IF NOT EXISTS tombstones (start_key TEXT PRIMARY KEY, removed_at INTEGER NOT NULL)"
  );
  sql.exec(
    "INSERT OR REPLACE INTO tombstones (start_key, removed_at) VALUES (?, ?)",
    tombstone.key,
    tombstone.at
  );
};

/**
 * Starts the run's retention clock, in the transaction that wrote its end
 * (`ended_at` and the status it ended with): it is purged its retention
 * after that, the success retention for a run that completed or was
 * terminated, the error retention for one that errored, as on the
 * reference. Returns when, for the alarm set in the same turn.
 */
export const startRetentionIn = (sql: SqlStorage): number =>
  sql
    .exec<{ purge_at: number }>(
      "UPDATE run SET purge_at = ended_at + CASE status WHEN 'errored' THEN error_retention_ms ELSE success_retention_ms END RETURNING purge_at"
    )
    .one().purge_at;

const hasTombstones = (sql: SqlStorage): boolean =>
  sql
    .exec(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tombstones'"
    )
    .toArray().length > 0;

/**
 * Whether a run started under `key` was here and was removed after
 * `since`: a tombstone left at or before it has expired, and holds no
 * longer, whether or not it has been dropped yet.
 */
export const isTombstoned = (
  sql: SqlStorage,
  key: string,
  since: number
): boolean =>
  hasTombstones(sql) &&
  sql
    .exec(
      "SELECT 1 FROM tombstones WHERE start_key = ? AND removed_at > ?",
      key,
      since
    )
    .toArray().length > 0;

/**
 * When the oldest tombstone expires, `horizon` after it was left, or null
 * when there is none.
 */
export const nextTombstoneExpiry = (
  sql: SqlStorage,
  horizon: number
): number | null => {
  if (!hasTombstones(sql)) {
    return null;
  }
  const [oldest] = sql
    .exec<{ at: number | null }>("SELECT MIN(removed_at) AS at FROM tombstones")
    .toArray();
  return oldest?.at === null || oldest === undefined
    ? null
    : oldest.at + horizon;
};

/**
 * Drops the tombstones left at or before `since`, in the caller's
 * transaction, and the table once none is left. Returns when the oldest
 * left was left, or null when none is.
 */
export const expireTombstones = (
  sql: SqlStorage,
  since: number
): number | null => {
  if (!hasTombstones(sql)) {
    return null;
  }
  sql.exec("DELETE FROM tombstones WHERE removed_at <= ?", since);
  const [oldest] = sql
    .exec<{ at: number | null }>("SELECT MIN(removed_at) AS at FROM tombstones")
    .toArray();
  if (oldest?.at === null || oldest === undefined) {
    sql.exec("DROP TABLE tombstones");
    return null;
  }
  return oldest.at;
};

export const readRun = (sql: SqlStorage): RunRow | undefined => {
  // A run deleted (its tables with it) is no run: a stale activation of it
  // reads that, and is fenced, rather than fail on a missing table.
  if (!hasJournal(sql)) {
    return undefined;
  }
  // The version first, on its own: another layout's columns may not be
  // the ones read below.
  const [stored] = sql
    .exec<{ schema: number | string | null }>("SELECT schema FROM run")
    .toArray();
  if (stored === undefined) {
    return undefined;
  }
  if (stored.schema !== journalSchemaVersion) {
    // No journal predates this version; see journalSchemaVersion.
    throw new JournalSchemaError(
      `This run's journal has schema ${String(stored.schema)}, where this engine reads only schema ${journalSchemaVersion}`
    );
  }
  return sql
    .exec<RunRow>(
      "SELECT schema, run_uid, definition, version, instance_id, start_key, params, created_at, status, generation, execution_uid, paused_at, lease_until, wake_at, event_count, event_bytes, stream_bytes, output, error, ended_at, rollback_trigger, rollback_end, rollback, rollback_replays, schedule, redeliverable, success_retention_ms, error_retention_ms, purge_at FROM run"
    )
    .toArray()[0];
};

const stepColumns =
  "ordinal, type, name, occurrence, idempotency_key, state, attempt, value, error, deadline, event_type, duration_ms, config, has_rollback, nested";

export const readStep = (
  sql: SqlStorage,
  step: { type: StepType; name: string; occurrence: number }
): StepRow | undefined =>
  sql
    .exec<StepRow>(
      `SELECT ${stepColumns} FROM steps WHERE type = ? AND name = ? AND occurrence = ?`,
      step.type,
      step.name,
      step.occurrence
    )
    .toArray()[0];

const attemptColumns =
  "ordinal, attempt, generation, started_at, deadline, ended_at, ended, error, retry_at";

/** An attempt at a `do` step. */
export const readAttempt = (
  sql: SqlStorage,
  ordinal: number,
  attempt: number
): AttemptRow | undefined =>
  sql
    .exec<AttemptRow>(
      `SELECT ${attemptColumns} FROM attempts WHERE ordinal = ? AND attempt = ?`,
      ordinal,
      attempt
    )
    .toArray()[0];

const eventColumns = "seq, type, payload, key, accepted_at, consumed_by";

/** The event a wait took, if it took one. */
export const readConsumedEvent = (
  sql: SqlStorage,
  ordinal: number
): EventRow | undefined =>
  sql
    .exec<EventRow>(
      `SELECT ${eventColumns} FROM events WHERE consumed_by = ?`,
      ordinal
    )
    .toArray()[0];

/**
 * The oldest event of `type` no wait has taken, if the run accepted it
 * before `deadline`: the one a wait with that deadline takes. Events are
 * taken in the order they were accepted, so when the oldest came too late
 * none can be on time; reading just that one keeps the lookup one index
 * row deep, however many events wait behind it.
 */
export const readNextEvent = (
  sql: SqlStorage,
  type: string,
  deadline: number
): EventRow | undefined => {
  const [oldest] = sql
    .exec<EventRow>(
      `SELECT ${eventColumns} FROM events WHERE type = ? AND consumed_by IS NULL ORDER BY seq LIMIT 1`,
      type
    )
    .toArray();
  return oldest !== undefined && oldest.accepted_at < deadline
    ? oldest
    : undefined;
};

/** A step whose rollback is still to run, or ended the rolling back. */
export interface RollbackItem extends Record<string, SqlStorageValue> {
  /** The step's own ordinal, name, count and key. */
  ordinal: number;
  name: string;
  occurrence: number;
  idempotency_key: string;
  /** Its rollback's row's state; null if its rollback hasn't started. */
  rollback_state: StepState | null;
  rollback_error: string | null;
}

/**
 * The rollbacks still to run, in the order they run: every `do` step that
 * registered one when it started (whether it succeeded, failed or never
 * answered), latest started first, but those whose rollback succeeded.
 */
export const readRollbackWorklist = (sql: SqlStorage): RollbackItem[] =>
  sql
    .exec<RollbackItem>(
      "SELECT f.ordinal, f.name, f.occurrence, f.idempotency_key, r.state AS rollback_state, r.error AS rollback_error FROM steps AS f LEFT JOIN steps AS r ON r.type = 'rollback' AND r.name = f.name AND r.occurrence = f.occurrence WHERE f.type = 'do' AND f.has_rollback = 1 AND (r.state IS NULL OR r.state <> 'succeeded') ORDER BY f.ordinal DESC"
    )
    .toArray();

export const readJournal = (sql: SqlStorage): Journal | undefined => {
  const run = readRun(sql);
  if (run === undefined) {
    return undefined;
  }
  return {
    run,
    activations: sql
      .exec<ActivationRow>(
        "SELECT generation, started_at, ended_at, ended FROM activations ORDER BY generation"
      )
      .toArray(),
    steps: sql
      .exec<StepRow>(`SELECT ${stepColumns} FROM steps ORDER BY ordinal`)
      .toArray(),
    attempts: sql
      .exec<AttemptRow>(
        `SELECT ${attemptColumns} FROM attempts ORDER BY ordinal, attempt`
      )
      .toArray(),
    events: sql
      .exec<EventRow>(`SELECT ${eventColumns} FROM events ORDER BY seq`)
      .toArray(),
  };
};
