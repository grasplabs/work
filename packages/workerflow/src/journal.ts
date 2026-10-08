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
//   attempts     each attempt at a `do` step, by generation: its timeout's
//                absolute deadline, how it ended (no end: cut off before
//                its outcome was journaled), and when a failed one's retry
//                is due
//   events       the inbox: each event the run accepted, in order, and the
//                wait that took it
//
// Values and errors are kept as codec text (codec.ts), never as live
// objects.

/** The journal's own layout; a change to it is a new version. */
export const journalSchemaVersion = 2;

/**
 * The largest event payload a run accepts, as encoded: the most the codec
 * keeps of any one value (codec.ts), and Cloudflare's per-step limit.
 */
export const maxEventPayloadBytes = 1024 * 1024;

/**
 * What one run's inbox holds at most, taken and untaken events alike, so
 * no sender can fill a run's storage. Taken events aren't pruned: each is
 * what its wait returns on every replay, for as long as the run lives.
 * They go with the rest of the journal when retention (a later slice)
 * removes it; an ended run takes no events, so its inbox no longer grows.
 */
export const maxInboxEvents = 10_000;
export const maxInboxBytes = 32 * 1024 * 1024;

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
   * still runs, so a step that hangs is ended by its own timeout, in the
   * activation, not by the watchdog.
   */
  lease_until: number | null;
  /**
   * When a waiting run is next due: the nearest deadline of its waits or
   * retries, or the time an event a wait can take was accepted. Written with the
   * alarm it sets, like `lease_until`, and like it read by nothing.
   */
  wake_at: number | null;
  /**
   * How many events the inbox holds, and their encoded payload bytes:
   * kept with each acceptance, in its write, so checking the limits costs
   * the same however many events there are.
   */
  event_count: number;
  event_bytes: number;
  output: string | null;
  error: string | null;
  ended_at: number | null;
}

/**
 * `running`: a `do` step's latest attempt is out, or was cut off.
 * `retrying`: its latest attempt failed, and the next is due at that
 * attempt's `retry_at`. `waiting`: a sleep or an event wait that hasn't
 * come to its outcome.
 */
export type StepState =
  | "running"
  | "retrying"
  | "waiting"
  | "succeeded"
  | "failed";

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
  /**
   * A sleep's duration or a wait's timeout as first given, which every
   * replay must give again; null for `sleepUntil`.
   */
  duration_ms: number | null;
  /**
   * A `do` step's config as first given (config.ts), in milliseconds,
   * which every replay must give again; null for a sleep or a wait.
   */
  config: string | null;
}

/**
 * How an activation or an attempt ended: `settled` and `succeeded` /
 * `failed` journaled its outcome; `timed_out`: the attempt ran past its
 * deadline, failed as it did, and whatever it answers later is ignored;
 * `superseded` means a later generation took over, and what it came back
 * with was ignored. `suspended`: the
 * activation reached a wait that isn't due, and let go of the run until
 * its alarm. `faulted`: one of the engine's own journal writes failed, and
 * the watchdog alarm brings the run back.
 */
export type AttemptEnd = "succeeded" | "failed" | "timed_out" | "superseded";
export type ActivationEnd = "settled" | "superseded" | "suspended" | "faulted";

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
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting', 'complete', 'errored')),
      generation INTEGER NOT NULL,
      lease_until INTEGER,
      wake_at INTEGER,
      event_count INTEGER NOT NULL DEFAULT 0,
      event_bytes INTEGER NOT NULL DEFAULT 0,
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
      state TEXT NOT NULL CHECK (state IN ('running', 'retrying', 'waiting', 'succeeded', 'failed')),
      attempt INTEGER NOT NULL,
      value TEXT,
      error TEXT,
      deadline INTEGER,
      event_type TEXT,
      duration_ms INTEGER,
      config TEXT,
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
      "SELECT schema, run_uid, definition, version, instance_id, start_key, params, created_at, status, generation, lease_until, wake_at, event_count, event_bytes, output, error, ended_at FROM run"
    )
    .toArray()[0];

const stepColumns =
  "ordinal, type, name, occurrence, idempotency_key, state, attempt, value, error, deadline, event_type, duration_ms, config";

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
