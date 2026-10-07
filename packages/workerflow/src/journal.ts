// A run's journal: the SQLite tables of its Durable Object. They alone say
// where the run is and how it got there, so recovery after a crash, an
// eviction or a duplicate alarm reads them and nothing else.
//
//   run          one row: identity, params, status, the current generation,
//                and when a waiting run is next due
//   activations  each time the run was executed, by generation, and how
//                that ended (no end: the process died or it was evicted)
//   steps        each step occurrence: identity, start order, outcome; a
//                sleep's or an event wait's absolute deadline
//   attempts     each attempt at a `do` step, by generation, and how it
//                ended (no end: cut off before its outcome was journaled)
//   events       the inbox: each event the run accepted, in order, and the
//                wait that took it
//
// Values and errors are kept as codec text (codec.ts), never as live
// objects.

/** The journal's own layout; a change to it is a new version. */
export const journalSchemaVersion = 1;

export type RunState =
  | "queued"
  | "running"
  | "waiting"
  | "complete"
  | "errored";

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
  /** Bumped by every activation: the fence against stale ones. */
  generation: number;
  /**
   * When the watchdog alarm is due: the current activation's lease, renewed
   * at every step. Nothing reads it to decide anything; it records when
   * recovery would start. An object gets no alarm while its alarm handler
   * still runs, so a step that hangs hangs its run: until step timeouts
   * are built, only the host ending the handler (Cloudflare's alarm wall
   * time; on workerd, nothing) recovers it.
   */
  lease_until: number | null;
  /**
   * When a waiting run is next due: the nearest deadline of its waits, or
   * the time an event one of them can take was accepted. Written with the
   * alarm it sets, like `lease_until`, and like it read by nothing.
   */
  wake_at: number | null;
  output: string | null;
  error: string | null;
  ended_at: number | null;
}

/** `waiting`: a sleep or an event wait that hasn't come to its outcome. */
export type StepState = "running" | "waiting" | "succeeded" | "failed";

/** What kind of step a row is; part of its identity. */
export type StepType = "do" | "sleep" | "waitForEvent";

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
   * first reached and never moved after.
   */
  deadline: number | null;
  /** The event type a wait takes. */
  event_type: string | null;
}

/**
 * How an activation or an attempt ended: `settled` and `succeeded` /
 * `failed` journaled its outcome; `superseded` means a later generation
 * took over, and what it came back with was ignored. `suspended`: the
 * activation reached a wait that isn't due, and let go of the run until
 * its alarm. `faulted`: one of the engine's own journal writes failed, and
 * the watchdog alarm brings the run back.
 */
export type AttemptEnd = "succeeded" | "failed" | "superseded";
export type ActivationEnd = "settled" | "superseded" | "suspended" | "faulted";

export interface AttemptRow extends Record<string, SqlStorageValue> {
  ordinal: number;
  attempt: number;
  generation: number;
  started_at: number;
  ended_at: number | null;
  ended: AttemptEnd | null;
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
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting', 'complete', 'errored')),
      generation INTEGER NOT NULL,
      lease_until INTEGER,
      wake_at INTEGER,
      output TEXT,
      error TEXT,
      ended_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS activations (
      generation INTEGER PRIMARY KEY,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      ended TEXT CHECK (ended IN ('settled', 'superseded', 'suspended', 'faulted'))
    );
    CREATE TABLE IF NOT EXISTS steps (
      ordinal INTEGER PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('do', 'sleep', 'waitForEvent')),
      name TEXT NOT NULL,
      occurrence INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('running', 'waiting', 'succeeded', 'failed')),
      attempt INTEGER NOT NULL,
      value TEXT,
      error TEXT,
      deadline INTEGER,
      event_type TEXT,
      UNIQUE (type, name, occurrence)
    );
    CREATE TABLE IF NOT EXISTS attempts (
      ordinal INTEGER NOT NULL REFERENCES steps (ordinal),
      attempt INTEGER NOT NULL,
      generation INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      ended TEXT CHECK (ended IN ('succeeded', 'failed', 'superseded')),
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
  `);
};

/**
 * Whether this object has a journal: one that was only looked up (a status
 * of an instance that doesn't exist) keeps no tables.
 */
export const hasJournal = (sql: SqlStorage): boolean =>
  sql
    .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run'")
    .toArray().length > 0;

export const readRun = (sql: SqlStorage): RunRow | undefined =>
  sql
    .exec<RunRow>(
      "SELECT schema, run_uid, definition, version, instance_id, start_key, params, created_at, status, generation, lease_until, wake_at, output, error, ended_at FROM run"
    )
    .toArray()[0];

const stepColumns =
  "ordinal, type, name, occurrence, idempotency_key, state, attempt, value, error, deadline, event_type";

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
 * The oldest event of `type` no wait has taken that the run accepted
 * before `deadline`: the one a wait with that deadline takes.
 */
export const readNextEvent = (
  sql: SqlStorage,
  type: string,
  deadline: number
): EventRow | undefined =>
  sql
    .exec<EventRow>(
      `SELECT ${eventColumns} FROM events WHERE type = ? AND consumed_by IS NULL AND accepted_at < ? ORDER BY seq LIMIT 1`,
      type,
      deadline
    )
    .toArray()[0];

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
        "SELECT ordinal, attempt, generation, started_at, ended_at, ended FROM attempts ORDER BY ordinal, attempt"
      )
      .toArray(),
    events: sql
      .exec<EventRow>(`SELECT ${eventColumns} FROM events ORDER BY seq`)
      .toArray(),
  };
};
