// A run's history: what observers of a run are shown of it, numbered in
// the order it happened, the event IDs a subscription's cursor counts in.
// Each event is written by a trigger on the journal row whose change it
// tells of (a status, a step's start or end, an attempt's), in the same
// statement: no write of the run's state can leave its event out, and no
// event is written for a change that was rolled back.
//
// An event, once written, says the same at every delivery. What can still
// change in the journal after it is copied into the event's `detail` as it
// is written: an attempt's error and retry delay (a resume moves a retry's
// time on; a delay function's answer replaces the provisional one), a
// rolling back step's error, the run's error, a sleep's duration. What a
// row never changes once the event is written is read from it as the
// event is delivered, so the history copies no value of the run's: a
// step's name, count, config and event type (fixed when the step is first
// reached), a completed step's result (fixed once it succeeded), the
// run's params, and its output (fixed once it completed). A restart that
// clears any of these forgets the events that read them in the same write
// (forgetHistoryIn). Each row is a few dozen bytes, one per change the
// journal keeps a row for, or per status change.
//
//   history   one row per event: its ID, when, its type, which step and
//             attempt it is of, and what it copied (`detail`)
//
// Every event's time is SQLite's clock in the trigger that writes it, one
// clock for all of them, so, per host, they never go back in the order
// written (a run object moved to another host has that host's clock).
//
// A sensitive step's output is redacted as its event is built: no observer
// gets it, the history never held it, and the raw result stays in the
// step's journal row for the run's own replay and the host's inspection.
// The IDs come from AUTOINCREMENT, so none is ever handed out again, not
// even after a restart forgot the events it ran again: a cursor only ever
// moves forward.
import { decode, streamResultOf } from "./codec.ts";
import type {
  WorkflowInstanceEvent,
  WorkflowInstanceEventType,
  WorkflowStepEventConfig,
} from "./contracts.ts";
import { parseError } from "./errors.ts";
import type { RunRow } from "./journal.ts";
import { warnRecovered } from "./log.ts";
import { replayStream } from "./streams.ts";

/** What observers see in place of a sensitive step's result. */
const redacted = "[REDACTED]";

/** Every event type a subscription can be filtered to, as the reference. */
export const eventTypes: ReadonlySet<string> =
  new Set<WorkflowInstanceEventType>([
    "workflow_queued",
    "workflow_started",
    "workflow_running",
    "workflow_paused",
    "workflow_waiting_for_pause",
    "workflow_waiting",
    "workflow_completed",
    "workflow_errored",
    "workflow_terminated",
    "step_started",
    "step_completed",
    "step_errored",
    "attempt_started",
    "attempt_completed",
    "attempt_errored",
    "sleep_started",
    "sleep_completed",
    "wait_started",
    "wait_completed",
    "wait_timed_out",
    "rollback_started",
    "rollback_step_started",
    "rollback_step_completed",
    "rollback_step_errored",
    "rollback_attempt_started",
    "rollback_attempt_completed",
    "rollback_attempt_errored",
    "rollback_completed",
    "rollback_errored",
  ]);

export const isEventType = (
  value: unknown
): value is WorkflowInstanceEventType =>
  typeof value === "string" && eventTypes.has(value);

/** The events that end a run, and with them every subscription to it. */
export const terminalTypes = [
  "workflow_completed",
  "workflow_errored",
  "workflow_terminated",
] as const;

const terminalList = terminalTypes.map((type) => `'${type}'`).join(", ");

/** Now, in milliseconds, as SQLite tells it inside a trigger. */
const now = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

/** The event a step's row ending in `new.state` tells of. */
const stepEnded = `CASE new.type
  WHEN 'do' THEN CASE new.state WHEN 'succeeded' THEN 'step_completed' ELSE 'step_errored' END
  WHEN 'sleep' THEN 'sleep_completed'
  WHEN 'waitForEvent' THEN CASE new.state WHEN 'succeeded' THEN 'wait_completed' ELSE 'wait_timed_out' END
  ELSE CASE new.state WHEN 'succeeded' THEN 'rollback_step_completed' ELSE 'rollback_step_errored' END
END`;

const stepEndedStates = "('succeeded', 'failed', 'fatal')";

/** What a step's end copies: a rollback's error, which an upsert sets. */
const stepEndedDetail =
  "CASE WHEN new.type = 'rollback' AND new.state <> 'succeeded' THEN json_object('error', new.error) END";

export const createHistory = (sql: SqlStorage): void => {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS history (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      type TEXT NOT NULL,
      ordinal INTEGER REFERENCES steps (ordinal),
      attempt INTEGER,
      detail TEXT
    );
    -- A restart forgets the events of the steps it runs again.
    CREATE INDEX IF NOT EXISTS history_by_step
      ON history (ordinal) WHERE ordinal IS NOT NULL;

    -- A status the run changes to. 'queued' is written by the run object
    -- itself (run.ts): a restart from a step queues the run again without
    -- telling observers, as the reference does. A rolling back that ends
    -- tells how before the run's own end; every way out of rolling back
    -- writes how it went (a termination can't cut it short, as on the
    -- reference), and a termination with nothing to roll back tells of no
    -- rolling back, as the reference doesn't either.
    CREATE TRIGGER IF NOT EXISTS history_status
    AFTER UPDATE OF status ON run
    WHEN old.status IS NOT new.status AND new.status <> 'queued'
    BEGIN
      INSERT INTO history (at, type)
        SELECT ${now}, CASE json_extract(new.rollback, '$.status') WHEN 'complete' THEN 'rollback_completed' ELSE 'rollback_errored' END
        WHERE old.status = 'rollingBack' AND new.rollback IS NOT NULL;
      INSERT INTO history (at, type, detail) VALUES (
        ${now},
        CASE new.status
          WHEN 'running' THEN 'workflow_running'
          WHEN 'waiting' THEN 'workflow_waiting'
          WHEN 'waitingForPause' THEN 'workflow_waiting_for_pause'
          WHEN 'paused' THEN 'workflow_paused'
          WHEN 'rollingBack' THEN 'rollback_started'
          WHEN 'complete' THEN 'workflow_completed'
          WHEN 'errored' THEN 'workflow_errored'
          ELSE 'workflow_terminated'
        END,
        CASE WHEN new.status = 'errored' THEN json_object('error', new.error) END
      );
    END;

    -- A step first reached; one journaled ended at once (a rollback the
    -- replay didn't get back) ends in the same write.
    CREATE TRIGGER IF NOT EXISTS history_step_started
    AFTER INSERT ON steps
    BEGIN
      INSERT INTO history (at, type, ordinal, detail) VALUES (
        ${now},
        CASE new.type
          WHEN 'do' THEN 'step_started'
          WHEN 'sleep' THEN 'sleep_started'
          WHEN 'waitForEvent' THEN 'wait_started'
          ELSE 'rollback_step_started'
        END,
        new.ordinal,
        CASE WHEN new.type = 'sleep'
          THEN json_object('durationMs', COALESCE(new.duration_ms, MAX(0, new.deadline - ${now})))
        END
      );
      INSERT INTO history (at, type, ordinal, detail)
        SELECT ${now}, ${stepEnded}, new.ordinal, ${stepEndedDetail}
        WHERE new.state IN ${stepEndedStates};
    END;

    CREATE TRIGGER IF NOT EXISTS history_step_ended
    AFTER UPDATE OF state ON steps
    WHEN new.state IN ${stepEndedStates}
    BEGIN
      INSERT INTO history (at, type, ordinal, detail)
        VALUES (${now}, ${stepEnded}, new.ordinal, ${stepEndedDetail});
    END;

    CREATE TRIGGER IF NOT EXISTS history_attempt_started
    AFTER INSERT ON attempts
    BEGIN
      INSERT INTO history (at, type, ordinal, attempt)
        SELECT ${now}, CASE type WHEN 'rollback' THEN 'rollback_attempt_started' ELSE 'attempt_started' END, new.ordinal, new.attempt
        FROM steps WHERE ordinal = new.ordinal;
    END;

    -- An attempt's outcome, journaled once. One whose answer was ignored
    -- ('superseded') has none yet, and may still be ended as cut off. A
    -- failure's error and retry delay are copied: a resume moves the
    -- retry on, and a delay function's answer, which comes after this
    -- write, replaces the provisional one, so that delay isn't told.
    CREATE TRIGGER IF NOT EXISTS history_attempt_ended
    AFTER UPDATE OF ended ON attempts
    WHEN new.ended IN ('succeeded', 'failed', 'timed_out')
    BEGIN
      INSERT INTO history (at, type, ordinal, attempt, detail)
        SELECT ${now},
          CASE WHEN type = 'rollback' THEN 'rollback_' ELSE '' END || CASE new.ended WHEN 'succeeded' THEN 'attempt_completed' ELSE 'attempt_errored' END,
          new.ordinal, new.attempt,
          CASE WHEN new.ended <> 'succeeded' THEN json_object(
            'error', new.error,
            'retryDelayMs', CASE WHEN new.retry_at IS NOT NULL AND json_extract(config, '$.delay') IS NOT 'dynamic' THEN new.retry_at - new.ended_at END
          ) END
        FROM steps WHERE ordinal = new.ordinal;
    END;
  `);
};

/**
 * Records that the run was queued and started: at its creation, and at a
 * restart from its start, as the reference does. In the caller's write.
 */
export const recordStartIn = (sql: SqlStorage): void => {
  sql.exec(
    `INSERT INTO history (at, type) VALUES (${now}, 'workflow_queued'), (${now}, 'workflow_started')`
  );
};

/**
 * Forgets what a restart runs again, in its write: from the start, every
 * event; from a step, the run's own events but its queueing and start (the
 * events of the steps it forgets go with them, run.ts). The IDs forgotten
 * are never handed out again.
 */
export const forgetHistoryIn = (sql: SqlStorage, fromStart: boolean): void => {
  sql.exec(
    fromStart
      ? "DELETE FROM history"
      : "DELETE FROM history WHERE ordinal IS NULL AND type NOT IN ('workflow_queued', 'workflow_started')"
  );
};

interface EventRow extends Record<string, SqlStorageValue> {
  seq: number;
  at: number;
  type: string;
  ordinal: number | null;
  attempt: number | null;
  detail: string | null;
  name: string | null;
  occurrence: number | null;
  value: string | null;
  config: string | null;
  event_type: string | null;
}

/**
 * The first event after `cursor` a subscription filtered to `filter` (a
 * JSON array of types; null for every type) is to see, or a run-ending
 * event it filters out, which ends it all the same.
 */
export const readNextEvent = (
  sql: SqlStorage,
  cursor: number,
  filter: string | null
): EventRow | undefined =>
  sql
    .exec<EventRow>(
      `SELECT h.seq, h.at, h.type, h.ordinal, h.attempt, h.detail, s.name, s.occurrence, s.value, s.config, s.event_type
       FROM history AS h
       LEFT JOIN steps AS s ON s.ordinal = h.ordinal
       WHERE h.seq > ?1 AND (?2 IS NULL OR h.type IN (SELECT value FROM json_each(?2)) OR h.type IN (${terminalList}))
       ORDER BY h.seq LIMIT 1`,
      cursor,
      filter
    )
    .toArray()[0];

/**
 * The latest event ID handed out, or 0: a subscription that found nothing
 * after its cursor has read past every row up to it, and reads none of
 * them again.
 */
export const lastEventId = (sql: SqlStorage): number =>
  sql.exec<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM history").one()
    .seq ?? 0;

/**
 * Whether the run ended at or before `cursor`: a subscription past its end
 * has nothing more to wait for.
 */
export const endedBy = (sql: SqlStorage, cursor: number): boolean =>
  sql
    .exec(
      `SELECT 1 FROM history WHERE seq <= ? AND type IN (${terminalList}) LIMIT 1`,
      cursor
    )
    .toArray().length > 0;

const unreadable = (seq: number): Error =>
  new Error(`The run's history holds an event this engine can't read: ${seq}`);

/** An error as observers see it: its name and message, as the reference. */
const errorOf = (text: string | null): { name: string; message: string } => {
  if (text === null) {
    return { name: "Error", message: "" };
  }
  const { name, message } = parseError(text);
  return { name, message };
};

interface JournaledConfig {
  limit: number;
  delay: number | "dynamic";
  backoff: "constant" | "linear" | "exponential";
  timeout: number;
  sensitive: boolean;
}

const configOf = (text: string | null): JournaledConfig | undefined => {
  if (text === null) {
    return undefined;
  }
  // SAFETY: the engine's own journal text (config.ts), written by it alone.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return JSON.parse(text) as JournaledConfig;
};

/** A step's config as observers are told it, in milliseconds. */
const shownConfig = (
  config: JournaledConfig | undefined
): { config?: WorkflowStepEventConfig } => {
  if (config === undefined) {
    return {};
  }
  return {
    config: {
      retries: {
        limit: config.limit,
        delay: config.delay === "dynamic" ? "[dynamic]" : config.delay,
        backoff: config.backoff,
      },
      timeout: config.timeout,
      ...(config.sensitive ? { sensitive: "output" as const } : {}),
    },
  };
};

/**
 * A completed step's output as observers see it. One that can't be read
 * back (a stream's stored bytes corrupt) is left out and logged, rather
 * than stop every subscription at this event.
 */
const outputOf = async (
  sql: SqlStorage,
  row: EventRow
): Promise<{ output?: unknown }> => {
  if (configOf(row.config)?.sensitive === true) {
    return { output: redacted };
  }
  if (row.value === null || row.ordinal === null) {
    return {};
  }
  try {
    const stream = streamResultOf(row.value);
    if (stream === undefined) {
      return { output: decode(row.value) };
    }
    // A fresh stream of the step's bytes, as its replay gets.
    const replay = await replayStream(sql, row.ordinal, stream);
    if ("corrupt" in replay) {
      throw replay.corrupt;
    }
    return { output: replay.stream };
  } catch (error) {
    warnRecovered("workflow_event_output_unreadable", error);
    return {};
  }
};

/** What every event of a step carries. */
interface StepCommon {
  readonly instanceId: string;
  readonly eventId: number;
  readonly timestamp: number;
  readonly stepName: string;
}

/** What the event copied when it was written (`detail`). */
interface Detail {
  durationMs?: number;
  error?: string | null;
  retryDelayMs?: number | null;
}

const detailOf = (row: EventRow): Detail => {
  if (row.detail === null) {
    return {};
  }
  // SAFETY: the engine's own JSON, written by its triggers alone.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return JSON.parse(row.detail) as Detail;
};

/** An attempt's event, at a step or a rollback, or undefined for another. */
const attemptEventOf = (
  row: EventRow,
  step: StepCommon
): WorkflowInstanceEvent | undefined => {
  const attempt = row.attempt ?? 0;
  switch (row.type) {
    case "attempt_started":
    case "attempt_completed":
    case "rollback_attempt_started":
    case "rollback_attempt_completed": {
      return { ...step, type: row.type, attempt };
    }
    case "attempt_errored":
    case "rollback_attempt_errored": {
      const { error, retryDelayMs } = detailOf(row);
      return {
        ...step,
        type: row.type,
        attempt,
        ...(typeof retryDelayMs === "number"
          ? { retryDelayMs: Math.max(0, retryDelayMs) }
          : {}),
        error: errorOf(error ?? null),
      };
    }
    default: {
      return undefined;
    }
  }
};

const stepEventOf = async (
  sql: SqlStorage,
  row: EventRow,
  common: { instanceId: string; eventId: number; timestamp: number }
): Promise<WorkflowInstanceEvent> => {
  if (row.name === null || row.occurrence === null) {
    throw unreadable(row.seq);
  }
  // As the reference names a step to observers: its name and its count.
  const step = { ...common, stepName: `${row.name}-${row.occurrence}` };
  switch (row.type) {
    case "step_started":
    case "rollback_step_started": {
      return { ...step, type: row.type, ...shownConfig(configOf(row.config)) };
    }
    case "step_completed": {
      return { ...step, type: row.type, ...(await outputOf(sql, row)) };
    }
    case "step_errored":
    case "sleep_completed":
    case "wait_completed":
    case "wait_timed_out":
    case "rollback_step_completed": {
      return { ...step, type: row.type };
    }
    case "rollback_step_errored": {
      return {
        ...step,
        type: row.type,
        error: errorOf(detailOf(row).error ?? null),
      };
    }
    case "sleep_started": {
      return {
        ...step,
        type: row.type,
        durationMs: detailOf(row).durationMs ?? 0,
      };
    }
    case "wait_started": {
      return { ...step, type: row.type, eventType: row.event_type ?? "" };
    }
    default: {
      const event = attemptEventOf(row, step);
      if (event === undefined) {
        throw unreadable(row.seq);
      }
      return event;
    }
  }
};

/** Builds the event `row` refers to, from the journal rows as they are. */
export const buildEvent = async (
  sql: SqlStorage,
  run: RunRow,
  row: EventRow
): Promise<WorkflowInstanceEvent> => {
  const common = {
    instanceId: run.instance_id,
    eventId: row.seq,
    timestamp: row.at,
  };
  switch (row.type) {
    case "workflow_queued":
    case "workflow_running":
    case "workflow_paused":
    case "workflow_waiting_for_pause":
    case "workflow_waiting":
    case "workflow_terminated":
    case "rollback_started":
    case "rollback_completed":
    case "rollback_errored": {
      return { ...common, type: row.type };
    }
    case "workflow_started": {
      return { ...common, type: row.type, params: decode(run.params) };
    }
    case "workflow_completed": {
      return run.output === null
        ? { ...common, type: row.type }
        : { ...common, type: row.type, output: decode(run.output) };
    }
    case "workflow_errored": {
      return {
        ...common,
        type: row.type,
        error: errorOf(detailOf(row).error ?? null),
      };
    }
    default: {
      return await stepEventOf(sql, row, common);
    }
  }
};
