// A run's history: what observers of a run are shown of it, kept as it
// happens, numbered in order. A sensitive step's result is redacted here
// before it is written: the history never holds it, so nothing that reads
// the history (a subscription, a log, an export) can show it. The raw
// result stays in the step's journal row, for the run's own replay and the
// host's inspection.
//
//   history   one row per event: its sequence number, when, what, which
//             step, and the observer's view of its output
//
// Only step completions so far; the run's other events come with
// subscriptions.
import { decode } from "./codec.ts";
import type { StreamResult } from "./codec.ts";

/** What observers see in place of a sensitive step's result. */
const redacted = "[REDACTED]";

export const createHistory = (sql: SqlStorage): void => {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS history (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('step_completed')),
      ordinal INTEGER NOT NULL REFERENCES steps (ordinal),
      output_kind TEXT NOT NULL CHECK (output_kind IN ('value', 'redacted', 'stream')),
      output TEXT
    );
  `);
};

/** What observers are told of a stream result: never its bytes. */
export interface StreamOutput {
  readonly length: number;
  readonly sha256: string;
  readonly encoding: string;
}

/** A step's result, as observers see it; `"[REDACTED]"` if sensitive. */
export interface StepCompletedEvent {
  /** From 1, in the order events happened. */
  readonly seq: number;
  readonly timestamp: number;
  readonly type: "step_completed";
  readonly step: { readonly name: string; readonly count: number };
  readonly output: unknown;
}

/** A stream result that isn't sensitive: its length and hash, never bytes. */
export interface StepStreamedEvent {
  readonly seq: number;
  readonly timestamp: number;
  readonly type: "step_completed";
  readonly step: { readonly name: string; readonly count: number };
  readonly streamOutput: StreamOutput;
}

export type HistoryEvent = StepCompletedEvent | StepStreamedEvent;

/** A step's result, as its journal row keeps it. */
export type CompletedResult =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "stream"; readonly result: StreamResult };

/**
 * Records that the step at `ordinal` completed with `result`. Called in
 * the same write as the step's outcome.
 */
export const recordStepCompleted = (
  sql: SqlStorage,
  step: {
    ordinal: number;
    at: number;
    sensitive: boolean;
    result: CompletedResult;
  }
): void => {
  let kind: "value" | "redacted" | "stream" = "value";
  let output: string | null = null;
  const { result } = step;
  if (step.sensitive) {
    kind = "redacted";
    output = null;
  } else if (result.kind === "stream") {
    kind = "stream";
    output = JSON.stringify({
      length: result.result.length,
      sha256: result.result.sha256,
      encoding: result.result.encoding,
    } satisfies StreamOutput);
  } else {
    output = result.value;
  }
  sql.exec(
    "INSERT INTO history (at, type, ordinal, output_kind, output) VALUES (?, 'step_completed', ?, ?, ?)",
    step.at,
    step.ordinal,
    kind,
    output
  );
};

interface HistoryRow extends Record<string, SqlStorageValue> {
  seq: number;
  at: number;
  name: string;
  occurrence: number;
  output_kind: string;
  output: string | null;
}

const unreadable = (seq: number): Error =>
  new Error(`The run's history holds an event this engine can't read: ${seq}`);

const isStreamOutput = (value: unknown): value is StreamOutput =>
  typeof value === "object" &&
  value !== null &&
  "length" in value &&
  "sha256" in value &&
  "encoding" in value &&
  typeof value.length === "number" &&
  typeof value.sha256 === "string" &&
  typeof value.encoding === "string";

const eventOf = (row: HistoryRow): HistoryEvent => {
  const common = {
    seq: row.seq,
    timestamp: row.at,
    type: "step_completed" as const,
    step: { name: row.name, count: row.occurrence },
  };
  switch (row.output_kind) {
    case "redacted": {
      return { ...common, output: redacted };
    }
    case "stream": {
      if (row.output === null) {
        throw unreadable(row.seq);
      }
      const parsed: unknown = JSON.parse(row.output);
      if (!isStreamOutput(parsed)) {
        throw unreadable(row.seq);
      }
      return { ...common, streamOutput: parsed };
    }
    case "value": {
      if (row.output === null) {
        throw unreadable(row.seq);
      }
      return { ...common, output: decode(row.output) };
    }
    default: {
      throw unreadable(row.seq);
    }
  }
};

/** The run's history, in order. */
export const readHistory = (sql: SqlStorage): HistoryEvent[] =>
  sql
    .exec<HistoryRow>(
      "SELECT history.seq, history.at, steps.name, steps.occurrence, history.output_kind, history.output FROM history JOIN steps ON steps.ordinal = history.ordinal ORDER BY history.seq"
    )
    .toArray()
    .map((row) => eventOf(row));
