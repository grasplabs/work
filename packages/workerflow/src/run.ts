// The run object: one SQLite-backed Durable Object per workflow run. It is
// the only authority on the run: its creation, its status, its steps'
// outcomes. Register it privately (no route reaches it); callers go through
// the binding (binding.ts), the host by subclassing it to resolve
// definitions.
//
// Executing a run is always an alarm's job: creating it arms the alarm, and
// each alarm is one activation that replays the definition from the start.
// Alarms are at least once, on Cloudflare and on plain workerd alike: an
// alarm whose handler was cut off (the process killed, the object evicted)
// runs again, and one may run while another is still out. So:
//
// - Every activation takes a new generation, journaled before it runs any
//   of the definition. A call from an older generation, and an answer that
//   arrives for one, is refused: the fence.
// - A refused call is answered with a promise that never settles, never an
//   error. Definition code can catch errors (its own try/catch/finally, or
//   a transport that turns errors into values); a promise that never
//   settles just leaves it where it stopped, so no handler of the author's
//   runs in an activation that is over.
// - Before executing, an activation arms the alarm as a watchdog, a lease
//   away, and renews it at every step. If the activation dies, the watchdog
//   is the run's way back; when it settles, it removes the alarm in the
//   same write as its outcome. An object gets no alarm while its alarm
//   handler still runs, so a live activation is not raced by its own
//   watchdog, however long a step takes (test/process shows it on workerd).
// - A sleep or an event wait that isn't due suspends the run: in one write,
//   its deadline (journaled when it was first reached), the status
//   `waiting` and that deadline as the run's wake; then the alarm is set to
//   that wake, and the activation ends (activation.ts). Waits come one at
//   a time, so there is one deadline to wake for. Nothing of the run stays
//   in memory. Every alarm and event replays to the wait, which reads its
//   deadline back from the journal, so no duplicate, early or late alarm
//   moves it.
// - A step's failed attempt with a retry left journals the retry's
//   absolute time in the write that ends the attempt; a retry not yet due
//   parks the step, and once every step still out is parked the run
//   suspends the way a sleep does, its wake the earliest parked retry (or
//   at once, for an attempt left to a fresh activation's wall time). Every
//   alarm replays to the steps, which read their times back. An attempt
//   past its timeout is ended in the journal, and only a step's latest
//   attempt can journal its outcome, so the late answer of one that timed
//   out is ignored.
// - A storage failure the engine meets is a fault, never an error out of
//   `alarm()`: the activation is journaled `faulted` if storage lets it,
//   and the watchdog alarm brings the run back. Only when no alarm can be
//   set at all does the error go to the host, whose retry of the alarm is
//   then the run's one way back.
// - Each alarm write follows the journal write it goes with in the same
//   synchronous turn, so the alarm always says what the latest write
//   meant, whichever path wrote last.
//
// Lifecycle commands (pause, resume, terminate, restart, delete) are RPC
// calls on this object, so they are serialized with each other, with
// events and with the activation's own writes: each reads the run and
// writes its decision in one transaction, its alarm in the same turn.
//
// - `pause` while an activation runs asks it to stop at a safe boundary:
//   the run is `waitingForPause`, the activation claims no new attempt and
//   reaches no new wait, and once nothing it had out is still out it lets
//   go of the run, `paused`, with no alarm. A run asleep or waiting has no
//   activation, and is `paused` at once. A paused run's deadlines don't
//   come due: `resume` moves each one on by as long as the run was paused,
//   as the reference engine does, and sets the alarm to run it now. That
//   counts for an attempt left open by an activation that died before the
//   pause, too: its deadline moves on, so paused time doesn't make it a
//   timed-out attempt, and it is retried at once, as one cut off in time.
// - `terminate` ends the run as `terminated` and takes a new generation in
//   the same write: an activation still out is fenced, so whatever its
//   steps answer later is ignored, and it starts nothing more.
// - `restart` keeps the run's identity and params, takes a new generation
//   and a new execution, and runs the run again from its start, or from a
//   step it has started: that step and every step started after it (and
//   any started before that hadn't come to an outcome) are forgotten, with
//   their attempts, results and the events their waits took; the steps
//   before it keep their outcomes, which replay returns. A step it runs
//   again goes out under a key of the new execution (identity.ts).
// - `terminate({ rollback: true })` of a run with steps to roll back
//   fences the activation as `terminate` does, and rolls the run back:
//   it is `rollingBack`, its alarm set to now, and a compensating
//   activation runs its steps' rollbacks (activation.ts) before it ends as
//   `terminated`. A definition that throws, with steps to roll back, is
//   rolled back the same way before it ends as `errored`. A run rolling
//   back can't be paused (as on the reference), terminated or restarted:
//   what undoes its effects isn't cut short by a command.
// - `delete` removes the run, its journal and its alarm. A stale
//   activation of it is fenced by the run's identity: it can't act on the
//   run, nor on one created again under the same ID. Its start key stays
//   as a tombstone, so the same start delivered again creates nothing.
//
// Retention (retention.ts) starts when the run ends: the write of its end
// also writes its purge time, its retention later, and the alarm is set to
// that time in the same turn. That alarm removes the run as `delete` does,
// tombstone and all. A restart clears the purge time, so a run that is to
// run, wait, pause or roll back is never purged; and since the alarm is
// stored with the run, a process that dies before the purge leaves it to
// the alarm when it starts again.
//
// The host enables `nodejs_als` (or `nodejs_compat`, which includes it):
// each call of the step API is told apart by the attempt it comes from,
// through AsyncLocalStorage (activation.ts).
//
// A step's outcome is journaled before the definition sees it. A step cut
// off after its effect left but before that write runs again, with the
// same idempotency key (contracts.ts): at least once, not exactly once. So
// does a step whose attempt timed out or failed: its retry has a new
// attempt number, and the same key.
//
// A step's result is kept as codec text (codec.ts) or, for a byte stream,
// as chunks in this object's storage (streams.ts). A result the step can't
// keep ends the run, as it does on Cloudflare: the definition doesn't get
// to catch it, and it isn't retried. Observers subscribe to the run's
// history (history.ts, subscription.ts), where a sensitive step's result
// is redacted; the raw result is for the run's own replay and the host's
// inspection (`stepOutput`).
import { DurableObject } from "cloudflare:workers";

import { Activation, superseded, suspended } from "./activation.ts";
import type { Settlement } from "./activation.ts";
import { decode, equivalent, streamResultOf } from "./codec.ts";
import {
  defaultRollbackReplays,
  handlerBudgetMs as defaultHandlerBudgetMs,
  maxRollbackReplayMs,
  rollbackReplayCapMs,
} from "./config.ts";
import type {
  DefinitionIdentity,
  InstanceStatus,
  RollbackOutcome,
  WorkflowDefinition,
} from "./contracts.ts";
import { errorRecord, namedError, parseError } from "./errors.ts";
import {
  buildEvent,
  endedBy,
  forgetHistoryIn,
  lastEventId,
  readNextEvent,
  recordStartIn,
} from "./history.ts";
import type { Schedule } from "./identity.ts";
import {
  createJournal,
  hasJournal,
  isTombstoned,
  JournalSchemaError,
  journalSchemaVersion,
  readJournal,
  readRollbackWorklist,
  maxEventPayloadBytes,
  maxInboxBytes,
  maxInboxEvents,
  readRun,
  readStep,
  removeJournal,
  nextTombstoneExpiry,
  notifyDue,
  expireTombstones,
  startRetentionIn,
} from "./journal.ts";
import type { Journal, RunRow, StepType } from "./journal.ts";
import { warnRecovered } from "./log.ts";
import {
  failedIn,
  defaultNotifyTimeoutMs,
  readPending,
  takenIn,
} from "./notifications.ts";
import type { RunNotification } from "./notifications.ts";
import { maxRetentionLimitMs } from "./retention.ts";
import {
  defaultMaxRunStreamBytes,
  defaultMaxStreamBytes,
  replayStream,
} from "./streams.ts";
import { Subscription } from "./subscription.ts";
import type { SubscriptionResult } from "./subscription.ts";

/** What `WorkflowRun.notify` is handed. */
export type { RunNotification } from "./notifications.ts";

/** What `WorkflowRun.journal()` returns. */
export type { Journal } from "./journal.ts";

/** How long an activation may go without journaling before it's recovered. */
export const defaultLeaseMs = 60_000;

/** What the binding asks the run object to create. */
export interface StartCommand {
  definition: string;
  version: string | null;
  instanceId: string;
  /** The params, already encoded (codec.ts): nothing live crosses. */
  params: string;
  /** Says which start this is: the same key again is the same start. */
  key: string;
  /** The schedule occurrence that starts the run, if one does. */
  schedule: Schedule | null;
  /**
   * Whether the start can be delivered again (`admit`, a schedule): only
   * then does removing the run leave its key as a tombstone.
   */
  redeliverable: boolean;
  /**
   * How long the run is kept once it has ended, resolved by the binding:
   * after it completed or was terminated, and after it errored.
   */
  retention: { successMs: number; errorMs: number };
}

/** What the instance asks the run object to accept into its inbox. */
export interface EventCommand {
  type: string;
  /** The payload, already encoded (codec.ts). */
  payload: string;
  /** The sender's delivery key, or null for an event with none. */
  key: string | null;
}

/**
 * `accepted`: the event is in the run's inbox. `duplicate`: an event with
 * this key and this content was accepted before. `conflict`: the key came
 * with another type or payload. `too_large`: the payload is over
 * `maxEventPayloadBytes`. `full`: the inbox is at one of its limits.
 * `ended`: the run has ended and takes no events. `missing`: there is no
 * such run.
 */
export type EventOutcome =
  | "accepted"
  | "duplicate"
  | "conflict"
  | "too_large"
  | "full"
  | "ended"
  | "missing";

interface EventDecision {
  outcome: EventOutcome;
  wake: boolean;
}

/**
 * A completed step's result, raw: a value, or a fresh stream of its bytes
 * with what they were committed as.
 */
export type StepOutput =
  | { readonly kind: "value"; readonly value: unknown }
  | {
      readonly kind: "stream";
      readonly stream: ReadableStream<Uint8Array>;
      readonly length: number;
      readonly sha256: string;
      readonly encoding: string;
    };

/**
 * `created`: this command created the run. `existing`: the run was created
 * by an earlier delivery of this same start. `collision`: another start
 * created a run under this ID. `conflict`: the same start key came with
 * other params, so it isn't the same start. `removed`: this start created
 * a run that has since been deleted; it isn't created again.
 */
export type StartOutcome =
  | "created"
  | "existing"
  | "collision"
  | "conflict"
  | "removed";

/**
 * `pausing`: an activation runs the run, and stops at its next safe
 * boundary. `paused`: the run had no activation, and is paused now.
 * `ignored`: the run is queued, pausing or paused already, or has ended,
 * and a pause does nothing, as on the reference engine.
 */
export type PauseOutcome = "pausing" | "paused" | "ignored" | "missing";

/**
 * `resumed`: the run was paused, or still pausing, and runs again.
 * `ignored`: it was neither, and a resume does nothing.
 */
export type ResumeOutcome = "resumed" | "ignored" | "missing";

/**
 * `ended`: the run has ended already, and can't be terminated.
 * `rolling_back`: it is rolling back, which a command doesn't cut short.
 */
export type TerminateOutcome =
  | "terminated"
  | "ended"
  | "rolling_back"
  | "missing";

/** Whether a termination rolls the run's steps back first. */
export interface TerminateCommand {
  rollback: boolean;
}

/**
 * `no_such_step`: the run has started no step `from` names.
 * `nested_step`: the step was called from inside another step's callback.
 * `rolling_back`: it is rolling back, which a command doesn't cut short.
 */
export type RestartOutcome =
  | "restarted"
  | "no_such_step"
  | "nested_step"
  | "rolling_back"
  | "missing";

export type DeleteOutcome = "deleted" | "missing";

/**
 * Where a subscription starts, and what it delivers: the binding read and
 * checked them (instance.ts).
 */
export interface SubscribeCommand {
  /** The last event ID the subscriber has; 0 for all of them. */
  cursor: number;
  /** The event types it takes; null for every type. */
  filter: string[] | null;
}

/** A subscription's place in the run's history, in the run object. */
interface Observer {
  /** The run it subscribed to: not one created again under the ID. */
  readonly runUid: string;
  cursor: number;
  /** Whether it checked once that its cursor isn't past the run's end. */
  endChecked: boolean;
  /** The types it takes, or null for every type. */
  readonly types: ReadonlySet<string> | null;
  /** The same, as the history reads it: a JSON array, or null. */
  readonly filter: string | null;
  /** Set while it waits for the next write; called by that write. */
  wake: (() => void) | undefined;
  closed: boolean;
  /**
   * Why it was closed short of the run's end, to be taken up again from
   * its cursor: cut off for a newer one, or waited too long.
   */
  failure: string | undefined;
}

/**
 * The most subscriptions a run object keeps open. Each holds a cursor and
 * a filter, and nothing it hasn't read yet, however far it is behind; a
 * caller that never disposes of them (or whose session ended while one
 * waited) would still add one each time. Past this, the oldest is cut
 * off: its `next` fails, as an RPC failure would, and its caller takes it
 * up again from its cursor.
 */
export const maxSubscriptions = 100;

/** How long a subscription's `next` waits for an event by default: 60 s. */
export const defaultSubscriptionWaitMs = 60_000;

/** The longest a host may let a subscription wait: 10 minutes. */
export const maxSubscriptionWaitMs = 10 * 60_000;

/** Which step a restart starts from; null for the run's start. */
export interface RestartCommand {
  from: { name: string; count: number; type: StepType } | null;
}

/**
 * What a command decided, in the transaction that read the run: its
 * outcome, and the alarm it leaves (a time, null for none, or undefined
 * to leave the alarm as it is).
 */
interface CommandDecision<Outcome> {
  outcome: Outcome;
  alarm?: number | null;
}

/** Why a run terminated with `rollback: true` rolls back, as Cloudflare says. */
const terminatedTrigger = JSON.stringify(
  errorRecord(namedError("Terminated", "Instance terminated during rollback"))
);

/** How a run's rolling back ended, as its journal keeps it. */
const rollbackOf = (text: string): RollbackOutcome => {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "status" in parsed &&
    parsed.status === "complete"
  ) {
    return { status: "complete" };
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "status" in parsed &&
    parsed.status === "errored" &&
    "error" in parsed
  ) {
    return {
      status: "errored",
      error: parseError(JSON.stringify(parsed.error)),
    };
  }
  throw new Error(
    `The journal holds a rollback this engine can't read: ${text}`
  );
};

const statusOf = (run: RunRow): InstanceStatus => {
  const rollback = run.rollback === null ? undefined : rollbackOf(run.rollback);
  switch (run.status) {
    case "complete": {
      return {
        status: "complete",
        output: run.output === null ? undefined : decode(run.output),
      };
    }
    case "errored": {
      const error =
        run.error === null
          ? { name: "Error", message: "" }
          : parseError(run.error);
      return rollback === undefined
        ? { status: "errored", error }
        : { status: "errored", error, rollback };
    }
    case "terminated": {
      return rollback === undefined
        ? { status: "terminated" }
        : { status: "terminated", rollback };
    }
    case "queued":
    case "running":
    case "waiting":
    case "waitingForPause":
    case "paused":
    case "rollingBack": {
      return { status: run.status };
    }
    default: {
      throw new Error(
        `The journal holds an unknown status: ${String(run.status)}`
      );
    }
  }
};

/** A settlement's error, as an Error. */
const errorOf = (settlement: Settlement): Error => {
  const error = settlement.ok ? undefined : settlement.error;
  return error instanceof Error ? error : new Error(String(error));
};

const hasEnded = (run: RunRow): boolean =>
  run.status === "complete" ||
  run.status === "errored" ||
  run.status === "terminated";

/**
 * When the run itself next needs its alarm: an ended run's purge, a
 * waiting run's wake, any other at once.
 */
const ownWake = (run: RunRow): number => {
  if (hasEnded(run) && run.purge_at !== null) {
    return run.purge_at;
  }
  if (run.status === "waiting" && run.wake_at !== null) {
    return run.wake_at;
  }
  return Date.now();
};

/**
 * Takes the run from whatever activation holds it: a new generation, and
 * every activation still open journaled as superseded. Called inside the
 * transaction of the command that does it.
 */
const supersedeIn = (sql: SqlStorage, now: number): void => {
  sql.exec("UPDATE run SET generation = generation + 1");
  sql.exec(
    "UPDATE activations SET ended_at = ?, ended = 'superseded' WHERE ended_at IS NULL",
    now
  );
};

/**
 * Pauses a run with no activation alive: in the transaction of the command
 * or the alarm that found it so. The run keeps no alarm while paused.
 */
const pauseIn = (sql: SqlStorage, now: number): void => {
  sql.exec(
    "UPDATE run SET status = 'paused', paused_at = ?, lease_until = NULL, wake_at = NULL",
    now
  );
};

/**
 * Moves each of the run's pending deadlines on by `ms`, the time it was
 * paused: a sleep's or a wait's, a retry's, and that of an attempt cut
 * off, its step's latest with no outcome journaled: one still open (its
 * activation died before the pause) or one whose answer came back
 * superseded, which the next activation ends as cut off by its deadline
 * (activation.ts). Paused time doesn't count against them, as on the
 * reference engine.
 */
const shiftDeadlinesIn = (sql: SqlStorage, ms: number): void => {
  sql.exec(
    "UPDATE steps SET deadline = deadline + ? WHERE state = 'waiting' AND deadline IS NOT NULL",
    ms
  );
  sql.exec(
    "UPDATE attempts SET retry_at = retry_at + ? WHERE retry_at IS NOT NULL AND EXISTS (SELECT 1 FROM steps WHERE steps.ordinal = attempts.ordinal AND steps.attempt = attempts.attempt AND steps.state = 'retrying')",
    ms
  );
  sql.exec(
    "UPDATE attempts SET deadline = deadline + ? WHERE ended_at IS NULL OR (ended = 'superseded' AND EXISTS (SELECT 1 FROM steps WHERE steps.ordinal = attempts.ordinal AND steps.attempt = attempts.attempt AND steps.state = 'running'))",
    ms
  );
};

/**
 * Forgets the steps a restart runs again (`forget`, a condition on
 * `steps`): their observers' history, stream chunks, attempts and rows,
 * and every event no step it keeps took, as the reference engine drops
 * its event buffer. The run's counts of its events and stream bytes are
 * counted again from what is left. Called inside the restart's
 * transaction.
 */
const forgetIn = (
  sql: SqlStorage,
  forget: { clause: string; values: SqlStorageValue[] }
): void => {
  const forgotten = `SELECT ordinal FROM steps WHERE ${forget.clause}`;
  sql.exec(
    `DELETE FROM history WHERE ordinal IN (${forgotten})`,
    ...forget.values
  );
  sql.exec(
    `DELETE FROM stream_chunks WHERE ordinal IN (${forgotten})`,
    ...forget.values
  );
  sql.exec(
    `DELETE FROM attempts WHERE ordinal IN (${forgotten})`,
    ...forget.values
  );
  sql.exec(
    `DELETE FROM events WHERE consumed_by IS NULL OR consumed_by IN (${forgotten})`,
    ...forget.values
  );
  sql.exec(`DELETE FROM steps WHERE ${forget.clause}`, ...forget.values);
  // Bytes as the inbox counts them: the payload's UTF-8 encoding.
  sql.exec(
    "UPDATE run SET event_count = (SELECT COUNT(*) FROM events), event_bytes = (SELECT COALESCE(SUM(LENGTH(CAST(payload AS BLOB))), 0) FROM events), stream_bytes = (SELECT COALESCE(SUM(LENGTH(bytes)), 0) FROM stream_chunks)"
  );
};

/**
 * Awaits the host's answer, or fails once `ms` have passed without it: a
 * host that never answers counts as one that failed.
 */
const answeredWithin = async (
  answer: Promise<void> | void,
  ms: number
): Promise<void> => {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    deadline.reject(
      new Error(`The host didn't take its notifications within ${ms} ms`)
    );
  }, ms);
  try {
    await Promise.race([answer, deadline.promise]);
  } finally {
    clearTimeout(timer);
  }
};

/** How long a tombstone holds by default: 30 days. */
export const defaultTombstoneMs = 30 * 24 * 60 * 60 * 1000;

/** The longest tombstone horizon a host may set: 365 days. */
const maxTombstoneMs = 365 * 24 * 60 * 60 * 1000;

/**
 * The object's storage, with its one alarm shared by the run, the
 * notifications its host hasn't taken (notifications.ts) and the object's
 * tombstones: every alarm the engine sets is moved to the next of those
 * obligations when that comes first, and an alarm it deletes is left at
 * it while one is left. So a run created under an ID after another was
 * deleted, whatever it does (runs, waits, pauses, ends), never keeps a
 * tombstone past its horizon, nor a notification from its host; alarm()
 * does what is due, then the run's own work. `written` is called after
 * each transaction commits, so subscriptions waiting for the next event
 * read again and notifications go out: every write that changes the
 * run's state after its creation is one. Everything else is the storage's
 * own, failures included.
 */
const sharingAlarm = (
  storage: DurableObjectStorage,
  horizon: () => number,
  written: () => void
): DurableObjectStorage => {
  const expiry = (): number | null => {
    const tombstone = nextTombstoneExpiry(storage.sql, horizon());
    const notify = notifyDue(storage.sql);
    if (tombstone === null || notify === null) {
      return tombstone ?? notify;
    }
    return Math.min(tombstone, notify);
  };
  const earliest = (time: number | Date): number => {
    const at = typeof time === "number" ? time : time.getTime();
    const tombstone = expiry();
    return tombstone === null ? at : Math.min(at, tombstone);
  };
  return new Proxy(storage, {
    get: (target, property) => {
      if (property === "transactionSync") {
        return <T>(closure: () => T): T => {
          const result = target.transactionSync(closure);
          written();
          return result;
        };
      }
      if (property === "setAlarm") {
        return async (time: number | Date): Promise<void> => {
          // Read with no await before the call: the same turn as the
          // write it goes with.
          await target.setAlarm(earliest(time));
        };
      }
      if (property === "deleteAlarm") {
        return async (): Promise<void> => {
          const tombstone = expiry();
          await (tombstone === null
            ? target.deleteAlarm()
            : target.setAlarm(tombstone));
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]): unknown =>
        Reflect.apply(value, target, args);
    },
  });
};

/**
 * What removing a run left: null when nothing is left (the object can be
 * emptied), else when the oldest tombstone left expires.
 */
interface Removal {
  expiresAt: number | null;
}

/**
 * Removes the run's journal, in the caller's transaction, leaving `key` as
 * a tombstone when the start can be delivered again (null: it can't), and
 * expiring tombstones past the horizon on the way.
 */
const removeIn = (
  sql: SqlStorage,
  key: string | null,
  now: number,
  horizon: number
): Removal => {
  removeJournal(sql, key === null ? null : { key, at: now });
  const oldest = expireTombstones(sql, now - horizon);
  return { expiresAt: oldest === null ? null : oldest + horizon };
};

/**
 * A workflow run. Subclass it to say which definition a run executes, and
 * register the subclass as a SQLite-backed Durable Object class with no
 * route to it. Its RPC methods are for the binding (binding.ts).
 */
export abstract class WorkflowRun<Env = unknown> extends DurableObject<Env> {
  /** How long an activation may go quiet before the alarm recovers the run. */
  protected readonly leaseMs: number = defaultLeaseMs;

  /**
   * How long the tombstone of a removed run's redeliverable start holds
   * (`admit`, a schedule's occurrence): a start delivered again within it
   * creates nothing; after it, the tombstone is dropped and the same start
   * is a new one, which creates a run. 30 days by default, Grasp's
   * retention, so a trigger redelivered within a run's lifetime and
   * retention is never run twice.
   */
  protected readonly tombstoneMs: number = defaultTombstoneMs;

  /**
   * The storage the engine sets its alarm through, shared with the
   * tombstones' expiry (sharingAlarm). The horizon is read when an alarm
   * is set, so a subclass's own is the one used; one the host got wrong
   * counts as the default here, and is refused where it is checked.
   */
  readonly #store: DurableObjectStorage = sharingAlarm(
    this.ctx.storage,
    () => {
      try {
        return this.#tombstoneHorizon();
      } catch {
        return defaultTombstoneMs;
      }
    },
    () => {
      this.#wakeObservers();
      this.#deliverSoon();
    }
  );

  /**
   * How long a subscription's `next` may wait for an event, in ms: a
   * minute by default. Past it the subscription is closed, as a cut-off
   * one is, and its caller takes it up again from its cursor; so no
   * waiter outlives its caller by more than this.
   */
  protected readonly subscriptionWaitMs: number = defaultSubscriptionWaitMs;

  /**
   * The subscription wait, checked: whole milliseconds from 1 to
   * `maxSubscriptionWaitMs`. One the host got wrong refuses a run's start,
   * and closes a subscription that would wait under it, never waits by a
   * value no timer keeps.
   */
  #subscriptionWait(): number {
    const ms = this.subscriptionWaitMs;
    if (!Number.isSafeInteger(ms) || ms < 1 || ms > maxSubscriptionWaitMs) {
      throw new TypeError(
        `A run's subscriptionWaitMs is a whole number of milliseconds from 1 to ${maxSubscriptionWaitMs}: ${String(ms)}`
      );
    }
    return ms;
  }

  /**
   * How long `notify` may take, in milliseconds above 0, before it counts
   * as failed: 30 s by default. A host that never answers can't hold the
   * run's alarm up for longer.
   */
  protected readonly notifyTimeoutMs: number = defaultNotifyTimeoutMs;

  /**
   * Takes the run's notifications (notifications.ts): resolves once the
   * host has them for good, and throws (or takes longer than
   * `notifyTimeoutMs`) when it doesn't, so they are handed over again,
   * after a backoff. They come in order, each at least once: the host
   * keeps, per run (`runId`), the greatest `sequence` it applied and
   * ignores one at or below it. Called outside any of the run's writes,
   * one call at a time per run object. By default the host takes nothing.
   */
  // oxlint-disable-next-line class-methods-use-this -- the host's hook; by default it takes nothing
  protected notify(
    _notifications: readonly RunNotification[]
  ): Promise<void> | void {
    // Nothing to tell: the notifications are dropped as taken.
  }

  /** The delivery out to the host, if one is. */
  #delivery: Promise<void> | undefined;

  /**
   * Hands what is due of the outbox to the host (#deliverDue reads what
   * is): once the write that called this has gone with its alarm write,
   * a microtask later, so the host's code never runs inside the run's own
   * turn.
   */
  #deliverSoon(): void {
    queueMicrotask(() => {
      void this.#deliver();
    });
  }

  /** Delivers what is due to the host: one delivery at a time. */
  async #deliver(): Promise<void> {
    this.#delivery ??= (async (): Promise<void> => {
      try {
        await this.#deliverDue();
      } finally {
        this.#delivery = undefined;
      }
    })();
    await this.#delivery;
  }

  /**
   * Hands the host what it hasn't taken, a batch at a time, in order, and
   * drops each batch once it has. A failure (the host's, or storage's) is
   * logged, never thrown: the alarm, brought forward to the outbox's due
   * time by the write that filled it, hands it over again.
   */
  async #deliverDue(): Promise<void> {
    const storage = this.#store;
    const { sql } = storage;
    for (;;) {
      let batch: RunNotification[];
      try {
        const run = this.#run();
        const due = notifyDue(sql);
        if (run === undefined || due === null || due > Date.now()) {
          return;
        }
        batch = readPending(sql, run);
      } catch (error) {
        warnRecovered("workflow_notify_read_failed", error);
        return;
      }
      const last = batch.at(-1);
      try {
        if (last !== undefined) {
          // oxlint-disable-next-line no-await-in-loop -- one batch at a time, in order
          await answeredWithin(this.notify(batch), this.notifyTimeoutMs);
        }
      } catch (error) {
        warnRecovered("workflow_notify_failed", error);
        this.#putOff();
        return;
      }
      try {
        const taken = storage.transactionSync((): RunRow | undefined => {
          const run = this.#run();
          // The run the host was told of, not one created since under
          // the same ID.
          if (
            run === undefined ||
            (last !== undefined && run.run_uid !== last.runId)
          ) {
            return undefined;
          }
          takenIn(sql, last?.sequence ?? 0);
          return { ...run, notify_at: notifyDue(sql) };
        });
        if (taken === undefined) {
          return;
        }
        if (taken.notify_at === null) {
          // oxlint-disable-next-line no-await-in-loop -- in the same turn as the write that emptied the outbox
          await this.#rearmOwn(taken);
        }
      } catch (error) {
        // Handed over again by the alarm: at least once.
        warnRecovered("workflow_notify_take_failed", error);
        return;
      }
    }
  }

  /**
   * Puts the alarm back, once the outbox it was brought forward for is
   * empty, to what the run itself needs, if it is set earlier: none for a
   * paused run, an ended run's purge, the watchdog of an activation that
   * holds the run (its lease), a waiting run's wake. Never earlier: an
   * alarm the run's own writes left later is theirs. Called with the run
   * as the write that emptied the outbox read it; the input gate holds
   * other events while getAlarm is out. A failure leaves the alarm early,
   * which finds nothing to do and sets it again (alarm()).
   */
  async #rearmOwn(run: RunRow): Promise<void> {
    const storage = this.#store;
    try {
      if (run.status === "paused") {
        await storage.deleteAlarm();
        return;
      }
      let own: number | null = null;
      if (hasEnded(run)) {
        own = run.purge_at;
      } else if (run.lease_until !== null) {
        own = run.lease_until;
      } else if (run.status === "waiting" || run.status === "rollingBack") {
        own = run.wake_at;
      }
      if (own === null) {
        return;
      }
      const alarm = await storage.getAlarm();
      if (alarm !== null && alarm < own) {
        await storage.setAlarm(own);
      }
    } catch (error) {
      warnRecovered("workflow_alarm_set_failed", error);
    }
  }

  /**
   * Puts the next delivery off after the host failed. The alarm is set no
   * later than the outbox was first due (the write that filled it set it
   * so), so it comes, finds the delivery not due yet, and is set again to
   * it through the shared alarm (alarm()).
   */
  #putOff(): void {
    const storage = this.#store;
    try {
      storage.transactionSync(() => {
        if (this.#run() !== undefined) {
          failedIn(storage.sql, Date.now());
        }
      });
    } catch (error) {
      warnRecovered("workflow_notify_put_off_failed", error);
    }
  }

  /**
   * The subscriptions open on this object, each only its cursor and filter:
   * what they deliver is read from the history, so an object evicted or
   * killed loses nothing a subscriber reconnecting with its cursor needs.
   */
  readonly #observers = new Set<Observer>();

  /** Lets every subscription waiting for an event read again. */
  #wakeObservers(): void {
    for (const observer of this.#observers) {
      const { wake } = observer;
      observer.wake = undefined;
      wake?.();
    }
  }

  /** The tombstone horizon, checked: whole milliseconds, 1 to 365 days. */
  #tombstoneHorizon(): number {
    const ms = this.tombstoneMs;
    if (!Number.isSafeInteger(ms) || ms < 1 || ms > maxTombstoneMs) {
      throw new TypeError(
        `A run's tombstoneMs is whole milliseconds from 1 to 365 days: ${String(ms)}`
      );
    }
    return ms;
  }

  /** The most bytes a step's stream result may hold. */
  protected readonly maxStreamOutputBytes: number = defaultMaxStreamBytes;

  /** The most bytes all of a run's stream results may hold together. */
  protected readonly maxRunStreamBytes: number = defaultMaxRunStreamBytes;

  /**
   * How long a compensating replay may take before a later activation
   * tries again (config.ts): at most what the handler budget allows
   * (`rollbackReplayCapMs`), which a longer setting is cut to.
   */
  protected readonly rollbackReplayMs: number = maxRollbackReplayMs;

  /**
   * How many compensating replays in a row may end without the rollbacks
   * still to run before the rolling back ends as errored (config.ts).
   */
  protected readonly rollbackReplays: number = defaultRollbackReplays;

  /**
   * The rollback settings, checked: a replay bound that isn't a time above
   * 0, or a count that isn't a whole number from 1, is the host's mistake,
   * never run with: refused at a run's start, and logged at an alarm,
   * which leaves the run to its watchdog as it was.
   */
  #rollbackLimits(): { rollbackReplayMs: number; rollbackReplays: number } {
    const ms = this.rollbackReplayMs;
    const replays = this.rollbackReplays;
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new TypeError(
        `A run's rollbackReplayMs is a time above 0: ${String(ms)}`
      );
    }
    if (!Number.isSafeInteger(replays) || replays < 1) {
      throw new TypeError(
        `A run's rollbackReplays is a whole number from 1: ${String(replays)}`
      );
    }
    return {
      rollbackReplayMs: Math.min(ms, rollbackReplayCapMs(this.handlerBudgetMs)),
      rollbackReplays: replays,
    };
  }

  /**
   * How much of an alarm handler's wall time a run's attempts may take
   * (config.ts). A host whose handlers get less than Cloudflare's 15
   * minutes says so here; a test, to see an attempt left for a fresh
   * activation without waiting minutes. The compensating replay's bound
   * scales with it.
   */
  protected readonly handlerBudgetMs: number = defaultHandlerBudgetMs;

  /**
   * The clock an attempt's running time, and a delay function's, is
   * measured on: Date.now(). A test stands in for it to measure code that
   * runs without awaiting anything.
   */
  // oxlint-disable-next-line class-methods-use-this -- the seam a subclass overrides
  protected clock(): number {
    return Date.now();
  }

  /**
   * The definition a run executes, built afresh for every activation:
   * nothing of it is kept between them. `undefined` when there is no such
   * definition, which ends the run as errored.
   */
  protected abstract definition(
    identity: DefinitionIdentity
  ): WorkflowDefinition | undefined;

  #run(): RunRow | undefined {
    const { sql } = this.ctx.storage;
    return hasJournal(sql) ? readRun(sql) : undefined;
  }

  /**
   * Creates the run, or finds the one this same start created before. The
   * run and its alarm are written together, before the answer: once a
   * caller hears `created` or `existing`, the run will execute.
   */
  async start(command: StartCommand): Promise<StartOutcome> {
    // Refused before any run exists, rather than at its first alarm.
    this.#rollbackLimits();
    this.#subscriptionWait();
    const horizon = this.#tombstoneHorizon();
    // The binding resolved and bounded these; this method is the run's
    // boundary, so it refuses anything that isn't a time above 0 and within
    // the greatest limit any host may set: the run's end plus it is then
    // always a time an alarm takes.
    for (const ms of [command.retention.successMs, command.retention.errorMs]) {
      if (!Number.isSafeInteger(ms) || ms <= 0 || ms > maxRetentionLimitMs) {
        throw new TypeError(
          `A run's retention is a whole number of milliseconds above 0, at most 365 days: ${String(ms)}`
        );
      }
    }
    const storage = this.#store;
    // Before the run: a start delivered again after its run was deleted
    // finds the tombstone, whatever run was created under the ID since.
    // Only a start with this key could have left it, so it is this start.
    // One past the horizon has expired, dropped yet or not.
    if (isTombstoned(storage.sql, command.key, Date.now() - horizon)) {
      return "removed";
    }
    const existing = this.#run();
    if (existing !== undefined) {
      const sameStart =
        existing.start_key === command.key &&
        existing.definition === command.definition &&
        existing.instance_id === command.instanceId;
      if (!sameStart) {
        return "collision";
      }
      if (
        // The same params, whatever order a retry put their keys in.
        !equivalent(existing.params, command.params) ||
        existing.version !== command.version ||
        // And the same retention: another is another start, not this one
        // delivered again, and isn't taken without a word.
        existing.success_retention_ms !== command.retention.successMs ||
        existing.error_retention_ms !== command.retention.errorMs
      ) {
        return "conflict";
      }
      await this.#ensureWake(existing);
      return "existing";
    }
    const now = Date.now();
    createJournal(storage.sql);
    storage.sql.exec(
      "INSERT INTO run (singleton, schema, run_uid, definition, version, instance_id, start_key, params, created_at, status, generation, execution_uid, schedule, redeliverable, success_retention_ms, error_retention_ms) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)",
      journalSchemaVersion,
      crypto.randomUUID(),
      command.definition,
      command.version,
      command.instanceId,
      command.key,
      command.params,
      now,
      crypto.randomUUID(),
      command.schedule === null ? null : JSON.stringify(command.schedule),
      command.redeliverable ? 1 : 0,
      command.retention.successMs,
      command.retention.errorMs
    );
    recordStartIn(storage.sql);
    // No await between the insert and this: one write.
    await storage.setAlarm(now);
    return "created";
  }

  /**
   * A run that hasn't ended always has an alarm; a repeated start re-arms
   * one that has gone missing, so asking again is a way to repair it. The
   * input gate holds other events while getAlarm is out; at worst this
   * brings an alarm forward, and an extra activation is fenced.
   */
  async #ensureWake(run: RunRow): Promise<void> {
    // A paused run has no alarm until it is resumed.
    if (run.status === "paused") {
      return;
    }
    // An alarm that is only the tombstones' expiry, or the outbox's due
    // time, may not be the run's own. It is set again from what the run
    // waits for: a waiting run's wake (the earlier obligation still wins,
    // through the shared alarm, and nothing replays), anything else now.
    const alarm = await this.#store.getAlarm();
    if (
      alarm === null ||
      alarm === this.#tombstoneExpiry() ||
      alarm === notifyDue(this.ctx.storage.sql)
    ) {
      await this.#store.setAlarm(ownWake(run));
    }
  }

  /** When the object's oldest tombstone expires, or null for none. */
  #tombstoneExpiry(): number | null {
    let horizon: number;
    try {
      horizon = this.#tombstoneHorizon();
    } catch {
      horizon = defaultTombstoneMs;
    }
    return nextTombstoneExpiry(this.ctx.storage.sql, horizon);
  }

  /**
   * Drops the tombstones past the horizon beside a run, in one write.
   * Returns whether any was due: this alarm may have been theirs.
   */
  #expireDueTombstones(now: number): boolean {
    const horizon = this.#tombstoneHorizon();
    const storage = this.#store;
    return storage.transactionSync(() => {
      const due = nextTombstoneExpiry(storage.sql, horizon);
      if (due === null || due > now) {
        return false;
      }
      expireTombstones(storage.sql, now - horizon);
      return true;
    });
  }

  status(): InstanceStatus | undefined {
    const run = this.#run();
    return run === undefined ? undefined : statusOf(run);
  }

  /**
   * The run's whole journal, as plain data: raw, a sensitive step's result
   * too, for the host's own inspection. Observers subscribe.
   */
  journal(): Journal | undefined {
    return hasJournal(this.ctx.storage.sql)
      ? readJournal(this.ctx.storage.sql)
      : undefined;
  }

  /**
   * A subscription to the run's events after `cursor` (subscription.ts),
   * or undefined when there is no run. It sees what the run has done so
   * far, then each write as it commits, and is done once the run's end
   * has been delivered or filtered out, or the run is removed. Like every
   * method here, only the host reaches it: the host decides who may
   * observe a run before it subscribes for them.
   */
  subscribe(command: SubscribeCommand): Subscription | undefined {
    const run = this.#run();
    if (run === undefined) {
      return undefined;
    }
    const observer: Observer = {
      runUid: run.run_uid,
      cursor: command.cursor,
      endChecked: false,
      types: command.filter === null ? null : new Set(command.filter),
      filter: command.filter === null ? null : JSON.stringify(command.filter),
      wake: undefined,
      closed: false,
      failure: undefined,
    };
    // A Set keeps the order observers were added in: the first is oldest.
    for (const oldest of this.#observers) {
      if (this.#observers.size < maxSubscriptions) {
        break;
      }
      oldest.failure = `this run has more than ${maxSubscriptions} subscriptions open, and this, the oldest, was closed`;
      this.#close(oldest);
    }
    this.#observers.add(observer);
    return new Subscription(
      async () => await this.#nextEvent(observer),
      () => {
        this.#close(observer);
      }
    );
  }

  /** Ends `observer`'s subscription, and a `next` of it that waits. */
  #close(observer: Observer): void {
    observer.closed = true;
    this.#observers.delete(observer);
    const { wake } = observer;
    observer.wake = undefined;
    wake?.();
  }

  /**
   * Ends every subscription, in the turn of the write that removed the run
   * (a deletion, a purge): none reads a run created again under the ID.
   */
  #closeObservers(): void {
    for (const observer of this.#observers) {
      this.#close(observer);
    }
  }

  /**
   * Waits for the next write, until `deadline`: the one deadline of the
   * `next` call it waits for, however many writes wake it meanwhile with
   * nothing it takes (its filter leaves them out). Past it the
   * subscription is closed, and its caller takes it up again from its
   * cursor, so no waiter outlives a caller that went away for long.
   */
  async #waitForWrite(
    observer: Observer,
    deadline: { at: number; waitMs: number }
  ): Promise<void> {
    const next = Promise.withResolvers<boolean>();
    observer.wake = () => {
      next.resolve(true);
    };
    const timer = setTimeout(
      () => {
        observer.failure = `no event came within ${deadline.waitMs} ms`;
        this.#close(observer);
      },
      Math.max(0, deadline.at - Date.now())
    );
    try {
      await next.promise;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The next event `observer` is to see: read from the history after its
   * cursor, or waited for until a write adds one. The read and the wait
   * are set up in one synchronous turn, so no write falls between them.
   * Each read starts after the rows the last one went through: a filter
   * that leaves most of a long run out costs each row once, not the whole
   * history at every write.
   */
  async #nextEvent(observer: Observer): Promise<SubscriptionResult> {
    const { sql } = this.ctx.storage;
    // One deadline for this call, from when it began to wait.
    let deadline: { at: number; waitMs: number } | undefined;
    while (!observer.closed) {
      const run = this.#run();
      if (run?.run_uid !== observer.runUid) {
        // Deleted, or purged, and maybe created again: nothing more to see.
        return { done: true, value: undefined };
      }
      // Once, for a cursor given at or past the run's end: every end
      // after it is read past the filter.
      if (!observer.endChecked) {
        observer.endChecked = true;
        if (endedBy(sql, observer.cursor)) {
          return { done: true, value: undefined };
        }
      }
      const row = readNextEvent(sql, observer.cursor, observer.filter);
      if (row === undefined) {
        observer.cursor = Math.max(observer.cursor, lastEventId(sql));
        if (deadline === undefined) {
          const waitMs = this.#subscriptionWait();
          deadline = { at: Date.now() + waitMs, waitMs };
        }
        // oxlint-disable-next-line no-await-in-loop -- one event at a time, waited for
        await this.#waitForWrite(observer, deadline);
        continue;
      }
      observer.cursor = row.seq;
      // oxlint-disable-next-line no-await-in-loop -- the one event this call answers with
      const event = await buildEvent(sql, run, row);
      const filtered =
        observer.types !== null && !observer.types.has(event.type);
      // Only a run's end is read past the filter: it ends the
      // subscription, delivered or not, as on the reference.
      return filtered
        ? { done: true, value: undefined }
        : { done: false, value: event };
    }
    if (observer.failure !== undefined) {
      throw new Error(
        `instance.subscription_closed: ${observer.failure}; subscribe again from the last event ID handled`
      );
    }
    return { done: true, value: undefined };
  }

  /**
   * The raw result of the `count`-th step named `name` that completed, a
   * sensitive one too, or undefined when there is none. For the host's own
   * inspection: like every method here, only the host reaches it.
   */
  async stepOutput(step: {
    name: string;
    count: number;
  }): Promise<StepOutput | undefined> {
    const { sql } = this.ctx.storage;
    if (!hasJournal(sql)) {
      return undefined;
    }
    const row = readStep(sql, {
      type: "do",
      name: step.name,
      occurrence: step.count,
    });
    if (row?.state !== "succeeded" || row.value === null) {
      return undefined;
    }
    const stream = streamResultOf(row.value);
    if (stream === undefined) {
      return { kind: "value", value: decode(row.value) };
    }
    const replay = await replayStream(sql, row.ordinal, stream);
    if ("corrupt" in replay) {
      throw replay.corrupt;
    }
    return {
      kind: "stream",
      stream: replay.stream,
      length: stream.length,
      sha256: stream.sha256,
      encoding: stream.encoding,
    };
  }

  /** The definition, or why there is none, as the run's end. */
  #resolve(run: RunRow): WorkflowDefinition | Settlement {
    const identity = {
      definition: run.definition,
      version: run.version ?? undefined,
    };
    try {
      const definition = this.definition(identity);
      if (definition !== undefined) {
        return definition;
      }
    } catch (error) {
      const { name, message } = errorRecord(error);
      return { ok: false, error: namedError(name, message) };
    }
    const version =
      identity.version === undefined
        ? ""
        : ` at version ${JSON.stringify(identity.version)}`;
    return {
      ok: false,
      error: namedError(
        "WorkflowDefinitionNotFound",
        `There is no workflow definition ${JSON.stringify(identity.definition)}${version}`
      ),
    };
  }

  /**
   * Leaves the run to a watchdog a lease from now, after a storage
   * failure before any of the definition ran (logged as `event`): the
   * watchdog's activation tries again. When even that alarm can't be set,
   * `error` goes to the host: with no alarm of the run's own, the host's
   * retry of this one is the run's only way back.
   */
  async #leaveToWatchdog(event: string, error: unknown): Promise<void> {
    warnRecovered(event, error);
    try {
      await this.#store.setAlarm(Date.now() + this.leaseMs);
    } catch {
      throw error;
    }
  }

  /**
   * Pauses a run whose pausing activation died first (an alarm comes only
   * once no alarm handler runs): nothing of it is out any more, so the run
   * is paused now. One still out somehow is fenced.
   */
  async #pauseNow(): Promise<void> {
    const storage = this.#store;
    const now = Date.now();
    try {
      storage.transactionSync(() => {
        supersedeIn(storage.sql, now);
        pauseIn(storage.sql, now);
      });
    } catch (error) {
      // Nothing was written: the watchdog's alarm finds it pausing still.
      await this.#leaveToWatchdog("workflow_pause_failed", error);
      return;
    }
    try {
      await storage.deleteAlarm();
    } catch (error) {
      // The run is paused: the alarm left behind finds it so, and does
      // nothing.
      warnRecovered("workflow_alarm_delete_failed", error);
    }
  }

  /**
   * Hands the host the notifications that are due, before the alarm reads
   * the run. `none`: the host has taken them all. `later`: some wait out a
   * failed host's backoff. `delivered`: some were due, and went out. A
   * failure is the delivery's to recover (#deliverDue), never the alarm's.
   */
  async #notifyDue(): Promise<"none" | "later" | "delivered"> {
    let due: number | null;
    try {
      due = notifyDue(this.ctx.storage.sql);
    } catch {
      return "none";
    }
    if (due === null) {
      return "none";
    }
    if (due > Date.now()) {
      return "later";
    }
    await this.#deliver();
    return "delivered";
  }

  /**
   * What the host hasn't taken goes out before the alarm does anything of
   * the run's; the run may have changed meanwhile (a command, an event),
   * so it is read again after. `notified`: the outbox may have been what
   * the alarm came for. Undefined when there is no run left to act on: it
   * was removed, or reading it failed (left to the watchdog).
   */
  async #afterNotifying(
    run: RunRow
  ): Promise<{ run: RunRow; notified: boolean } | undefined> {
    const notified = await this.#notifyDue();
    if (notified !== "delivered") {
      return { run, notified: notified === "later" };
    }
    let fresh: RunRow | undefined;
    try {
      fresh = this.#run();
    } catch (error) {
      await this.#leaveToWatchdog("workflow_run_read_failed", error);
      return undefined;
    }
    return fresh === undefined ? undefined : { run: fresh, notified: true };
  }

  /**
   * An alarm's first job beside a run: the tombstones of an earlier run
   * under this ID that are due go, whatever this run does, and none of
   * its journal is touched. True when that is all the alarm does: the run
   * is paused (a paused run waits for `resume`; the alarm left is the
   * next obligation's), or it waits and the alarm was the tombstones' or
   * the notifications' (`notified`), early for it (it only re-arms the
   * run's wake; no activation replays it). An ended run goes on to its
   * purge, which re-arms an early alarm.
   */
  async #tombstonesBeside(run: RunRow, notified: boolean): Promise<boolean> {
    const storage = this.#store;
    let due: boolean;
    try {
      due = this.#expireDueTombstones(Date.now()) || notified;
    } catch (error) {
      await this.#leaveToWatchdog("workflow_tombstone_expiry_failed", error);
      return true;
    }
    if (run.status === "paused") {
      try {
        await storage.deleteAlarm();
      } catch (error) {
        warnRecovered("workflow_alarm_delete_failed", error);
      }
      return true;
    }
    const wake = run.status === "waiting" ? run.wake_at : null;
    if (!due || wake === null || wake <= Date.now()) {
      return false;
    }
    try {
      await storage.setAlarm(wake);
    } catch (error) {
      await this.#leaveToWatchdog("workflow_alarm_rearm_failed", error);
    }
    return true;
  }

  /** One activation: replays the definition under a new generation. */
  override async alarm(): Promise<void> {
    // The host's settings first, before the run is read or a generation
    // taken: a mistake in them touches no run. It is logged, and the run
    // is left to a watchdog a lease away, the settings fixed by then or
    // not.
    let limits: { rollbackReplayMs: number; rollbackReplays: number };
    try {
      limits = this.#rollbackLimits();
    } catch (error) {
      await this.#leaveToWatchdog("workflow_settings_invalid", error);
      return;
    }
    let run: RunRow | undefined;
    try {
      run = this.#run();
    } catch (error) {
      if (!(error instanceof JournalSchemaError)) {
        // Storage failed as the run was read: nothing was written, and
        // the watchdog's activation reads it again.
        await this.#leaveToWatchdog("workflow_run_read_failed", error);
        return;
      }
      // A journal this engine doesn't read: nothing here can run it, and
      // retrying would only refuse it again. No alarm is left to do so.
      try {
        await this.#store.deleteAlarm();
      } catch (deleteError) {
        // An alarm left behind is refused the same way when it comes, and
        // tries to remove itself again.
        warnRecovered("workflow_alarm_delete_failed", deleteError);
      }
      return;
    }
    if (run === undefined) {
      // No run: what may be left is tombstones, to expire.
      await this.#expireTombstones();
      return;
    }
    const after = await this.#afterNotifying(run);
    if (after === undefined) {
      return;
    }
    ({ run } = after);
    if (await this.#tombstonesBeside(run, after.notified)) {
      return;
    }
    if (hasEnded(run)) {
      // An ended run's only alarm is its purge, once its retention is up;
      // an early one re-arms it (with the tombstones', if sooner).
      await this.#purge(run);
      return;
    }
    const storage = this.#store;
    if (run.status === "waitingForPause") {
      await this.#pauseNow();
      return;
    }
    const generation = run.generation + 1;
    const now = Date.now();
    // A run rolling back stays so: this activation runs its rollbacks.
    const compensating = run.status === "rollingBack";
    try {
      storage.transactionSync(() => {
        storage.sql.exec(
          "UPDATE run SET generation = ?, status = ?, lease_until = ?, wake_at = NULL",
          generation,
          compensating ? "rollingBack" : "running",
          now + this.leaseMs
        );
        storage.sql.exec(
          "INSERT INTO activations (generation, started_at) VALUES (?, ?)",
          generation,
          now
        );
      });
    } catch (error) {
      // No generation was taken, and no activation journaled: the
      // watchdog's activation takes one.
      await this.#leaveToWatchdog("workflow_generation_failed", error);
      return;
    }
    try {
      // The watchdog, in the same write as the new generation.
      await storage.setAlarm(now + this.leaseMs);
    } catch (error) {
      // The generation is taken, but nothing would bring the run back if
      // this activation died: none of the definition runs. Journaled as
      // faulted if storage lets it; the host's retry of this alarm is the
      // run's way back.
      try {
        storage.sql.exec(
          "UPDATE activations SET ended_at = ?, ended = 'faulted' WHERE generation = ? AND ended_at IS NULL",
          Date.now(),
          generation
        );
      } catch {
        // Its row stays open, as after a crash.
      }
      throw error;
    }

    const activation = new Activation(
      storage,
      run,
      generation,
      {
        leaseMs: this.leaseMs,
        handlerBudgetMs: this.handlerBudgetMs,
        maxStreamBytes: this.maxStreamOutputBytes,
        maxRunStreamBytes: this.maxRunStreamBytes,
        ...limits,
      },
      () => this.clock(),
      compensating
    );
    const resolved = this.#resolve(run);
    if (!("run" in resolved)) {
      // No definition to run, nor to get its rollbacks back from: the run
      // ends, rolling back nothing.
      await (compensating
        ? activation.endCompensation({
            status: "errored",
            error: errorOf(resolved),
          })
        : activation.settle(resolved));
      return;
    }
    if (compensating) {
      await this.#compensate(activation, resolved);
      return;
    }
    const settlement = await Promise.race([
      activation.execute(resolved),
      activation.stopped,
    ]);
    if (settlement === superseded || settlement === suspended) {
      // A later activation owns the run, or the run waits for the alarm
      // its suspension set. Either way this handler is done: a waiting run
      // holds no compute.
      return;
    }
    if ("halt" in settlement) {
      // Replaying would only reach the same thing again: the run ends,
      // with the reason as its error.
      await activation.settle({ ok: false, error: settlement.halt }, true);
      return;
    }
    if ("fault" in settlement) {
      // The journal write failed; the activation journaled that, if it
      // could. Returning leaves the alarm as it was, the watchdog or the
      // wake, to bring the run back with its deadlines as journaled.
      // Throwing would hand recovery to the host's alarm retries instead,
      // whose count is finite and whose timing isn't ours.
      return;
    }
    await activation.settle(settlement);
  }

  /**
   * Purges an ended run whose retention is up: its journal, stream chunks,
   * events and history go in one transaction, its start key stays as a
   * tombstone (journal.ts), as a deletion does. Only an alarm reaches it,
   * and only for a run that has ended: a restart clears the purge time, so
   * no run that runs, waits, is paused or rolls back is purged. An alarm
   * that came early (a duplicate, or the watchdog of the activation that
   * ended it) sets the purge's own again.
   */
  async #purge(run: RunRow): Promise<void> {
    const storage = this.#store;
    if (run.purge_at === null) {
      // Every end writes its purge time; a run with none is kept.
      return;
    }
    const now = Date.now();
    if (run.purge_at > now) {
      try {
        await storage.setAlarm(run.purge_at);
      } catch (error) {
        // Left to an alarm a lease away, which comes back here.
        await this.#leaveToWatchdog("workflow_purge_rearm_failed", error);
      }
      return;
    }
    let removal: Removal;
    try {
      const horizon = this.#tombstoneHorizon();
      // Read just now, with no await since: nothing has changed the run.
      removal = storage.transactionSync(() =>
        removeIn(
          storage.sql,
          run.redeliverable === 1 ? run.start_key : null,
          now,
          horizon
        )
      );
    } catch (error) {
      // Nothing was removed: an alarm a lease away tries again.
      await this.#leaveToWatchdog("workflow_purge_failed", error);
      return;
    }
    // With the write that removed it, the object emptied or its
    // tombstones' expiry set, each failure recovered (#afterRemoval).
    this.#closeObservers();
    await this.#afterRemoval(removal);
  }

  /** A compensating activation, from its replay to the run's end. */
  // oxlint-disable-next-line class-methods-use-this -- beside alarm(), whose part it is
  async #compensate(
    activation: Activation,
    definition: WorkflowDefinition
  ): Promise<void> {
    const result = await Promise.race([
      activation.compensate(definition),
      activation.stopped,
    ]);
    if (result === superseded || result === suspended) {
      // A later activation owns the run, or a rollback waits for its
      // retry, the run still rolling back.
      return;
    }
    if ("fault" in result) {
      // The watchdog brings the run back, its rolling back as journaled.
      return;
    }
    // A replay that strayed, or a result that can't be read back, ends the
    // rolling back: replaying again would only reach the same.
    await activation.endCompensation(
      "halt" in result ? { status: "errored", error: result.halt } : result
    );
  }

  /**
   * Reads the run and writes a command's decision in one transaction, and
   * the alarm it leaves in the same turn: commands are serialized with
   * each other and with every activation's writes.
   */
  async #command<Outcome extends string>(
    decide: (run: RunRow, now: number) => CommandDecision<Outcome>
  ): Promise<Outcome | "missing"> {
    const storage = this.#store;
    if (!hasJournal(storage.sql)) {
      return "missing";
    }
    const now = Date.now();
    const decision = storage.transactionSync(
      (): CommandDecision<Outcome | "missing"> => {
        const run = readRun(storage.sql);
        return run === undefined ? { outcome: "missing" } : decide(run, now);
      }
    );
    // With the write that decided it: no await between.
    if (decision.alarm === null) {
      await storage.deleteAlarm();
    } else if (decision.alarm !== undefined) {
      await storage.setAlarm(decision.alarm);
    }
    return decision.outcome;
  }

  /**
   * Pauses the run: at once if no activation runs it (it waits, asleep or
   * for an event), otherwise at the activation's next safe boundary.
   */
  async pause(): Promise<PauseOutcome> {
    const { sql } = this.ctx.storage;
    return await this.#command((run, now): CommandDecision<PauseOutcome> => {
      if (run.status === "running") {
        sql.exec("UPDATE run SET status = 'waitingForPause'");
        return { outcome: "pausing" };
      }
      if (run.status === "waiting") {
        // No activation is alive: a suspended one is over.
        pauseIn(sql, now);
        return { outcome: "paused", alarm: null };
      }
      return { outcome: "ignored" };
    });
  }

  /**
   * Resumes a paused run, its deadlines moved on by the time it was
   * paused, or lets a run still pausing go on as it was.
   */
  async resume(): Promise<ResumeOutcome> {
    const { sql } = this.ctx.storage;
    const outcome = await this.#command(
      (run, now): CommandDecision<ResumeOutcome> => {
        if (run.status === "waitingForPause") {
          // Its activation goes on; what it parked for the pause comes due
          // at once when it suspends (activation.ts).
          sql.exec("UPDATE run SET status = 'running'");
          return { outcome: "resumed" };
        }
        if (run.status !== "paused") {
          return { outcome: "ignored" };
        }
        if (run.paused_at === null) {
          throw new Error("The journal holds a paused run with no pause time");
        }
        shiftDeadlinesIn(sql, Math.max(0, now - run.paused_at));
        sql.exec(
          "UPDATE run SET status = 'running', paused_at = NULL, wake_at = ?",
          now
        );
        return { outcome: "resumed", alarm: now };
      }
    );
    if (outcome === "ignored") {
      // A resume sent again, after an answer that never came, repairs an
      // alarm a run still to end has lost, as a repeated start does.
      const run = this.#run();
      if (run !== undefined) {
        await this.#ensureWake(run);
      }
    }
    return outcome;
  }

  /**
   * Ends the run as terminated, fencing any activation still out; with
   * `rollback`, rolls its steps back first, if any registered a rollback.
   */
  async terminate(command: TerminateCommand): Promise<TerminateOutcome> {
    const { sql } = this.ctx.storage;
    const outcome = await this.#command(
      (run, now): CommandDecision<TerminateOutcome> => {
        if (hasEnded(run)) {
          return { outcome: "ended" };
        }
        if (run.status === "rollingBack") {
          return { outcome: "rolling_back" };
        }
        supersedeIn(sql, now);
        if (command.rollback && readRollbackWorklist(sql).length > 0) {
          sql.exec(
            "UPDATE run SET status = 'rollingBack', rollback_trigger = ?, rollback_end = 'terminated', lease_until = NULL, wake_at = ?, paused_at = NULL",
            terminatedTrigger,
            now
          );
          return { outcome: "terminated", alarm: now };
        }
        sql.exec(
          "UPDATE run SET status = 'terminated', ended_at = ?, lease_until = NULL, wake_at = NULL, paused_at = NULL",
          now
        );
        // Its alarm is now its purge, its retention after this end.
        return { outcome: "terminated", alarm: startRetentionIn(sql) };
      }
    );
    if (outcome === "ended") {
      // A terminate sent again, after one whose purge alarm failed to be
      // set once its end was written (the caller heard an error), repairs
      // that alarm, as a repeated start or resume does.
      const run = this.#run();
      if (run !== undefined) {
        await this.#ensureWake(run);
      }
    }
    return outcome;
  }

  /**
   * Runs the run again under a new generation and a new execution, from
   * its start or from a step it has started; whatever state it is in.
   */
  async restart(command: RestartCommand): Promise<RestartOutcome> {
    const { sql } = this.ctx.storage;
    return await this.#command((run, now): CommandDecision<RestartOutcome> => {
      if (run.status === "rollingBack") {
        return { outcome: "rolling_back" };
      }
      let forget: { clause: string; values: SqlStorageValue[] } = {
        clause: "1 = 1",
        values: [],
      };
      if (command.from !== null) {
        const target = readStep(sql, {
          type: command.from.type,
          name: command.from.name,
          occurrence: command.from.count,
        });
        if (target === undefined) {
          return { outcome: "no_such_step" };
        }
        if (target.nested === 1) {
          // Its enclosing step, started before it, keeps its outcome, which
          // replay returns without calling its callback: the target would
          // never run again. The reference engine has no such guard (it
          // wipes from the target's start on, as here); refusing is the
          // narrower choice, and restarting from the enclosing step reruns
          // both.
          return { outcome: "nested_step" };
        }
        // The target and every step started after it run again, and so
        // does any started before it that hadn't come to its outcome: the
        // steps kept are the outcomes replay can return.
        forget = {
          clause: "ordinal >= ? OR state NOT IN ('succeeded', 'failed')",
          values: [target.ordinal],
        };
      }
      supersedeIn(sql, now);
      // Observers see the run again from where it starts again, as on the
      // reference: from its start, queued and started anew; from a step,
      // with the events of the steps before it.
      forgetHistoryIn(sql, command.from === null);
      forgetIn(sql, forget);
      sql.exec(
        "UPDATE run SET status = 'queued', execution_uid = ?, output = NULL, error = NULL, ended_at = NULL, lease_until = NULL, paused_at = NULL, rollback_trigger = NULL, rollback_end = NULL, rollback = NULL, rollback_replays = 0, purge_at = NULL, executions = executions + 1, wake_at = ?",
        crypto.randomUUID(),
        now
      );
      if (command.from === null) {
        recordStartIn(sql);
      }
      return { outcome: "restarted", alarm: now };
    });
  }

  /**
   * Removes the run: its journal, its stream chunks and its alarm, leaving
   * only its start key as a tombstone (journal.ts). Nothing of the
   * definition runs for it; a step still out answers no one.
   */
  async deleteRun(): Promise<DeleteOutcome> {
    const horizon = this.#tombstoneHorizon();
    const storage = this.#store;
    const now = Date.now();
    const removed = storage.transactionSync((): Removal | "missing" => {
      // Not read through readRun: a journal of a layout this engine
      // doesn't read can be deleted too.
      if (!hasJournal(storage.sql)) {
        return "missing";
      }
      const [run] = storage.sql.exec("SELECT * FROM run").toArray();
      if (run === undefined) {
        return "missing";
      }
      const key = run.start_key;
      return removeIn(
        storage.sql,
        run.redeliverable === 1 && typeof key === "string" ? key : null,
        now,
        horizon
      );
    });
    if (removed === "missing") {
      return "missing";
    }
    this.#closeObservers();
    await this.#afterRemoval(removed);
    return "deleted";
  }

  /**
   * What is left once a run is removed: nothing, so the object is emptied
   * (`deleteAll`), or tombstones, so the alarm is set to expire the oldest.
   * The journal went first: should the process die before this, the alarm
   * the run had finds no run, and expires what it can (alarm()). The other
   * way round, a run would be left with no alarm to run it.
   */
  async #afterRemoval(removal: Removal): Promise<void> {
    const storage = this.#store;
    if (removal.expiresAt === null) {
      try {
        await storage.deleteAll();
        await storage.deleteAlarm();
      } catch (error) {
        // The journal is gone: an alarm left behind finds nothing, and
        // empties the object again.
        warnRecovered("workflow_delete_all_failed", error);
      }
      return;
    }
    try {
      await storage.setAlarm(removal.expiresAt);
    } catch (error) {
      await this.#leaveToWatchdog("workflow_tombstone_alarm_failed", error);
    }
  }

  /**
   * An alarm with no run: tombstones past the horizon are dropped, and the
   * alarm is set for the next to expire; once none is left, the object is
   * emptied. A failure leaves it all to an alarm a lease away.
   */
  async #expireTombstones(): Promise<void> {
    const storage = this.#store;
    let horizon: number;
    let oldest: number | null;
    try {
      horizon = this.#tombstoneHorizon();
      const since = Date.now() - horizon;
      oldest = storage.transactionSync(() =>
        expireTombstones(storage.sql, since)
      );
    } catch (error) {
      await this.#leaveToWatchdog("workflow_tombstone_expiry_failed", error);
      return;
    }
    await this.#afterRemoval({
      expiresAt: oldest === null ? null : oldest + horizon,
    });
  }

  /**
   * Accepts an event into the run's inbox: journaled, in order, with the
   * time it was accepted, before the answer. A run that waits for an event
   * of this type, and is still before that wait's deadline, is woken in
   * the same write. A key the run has seen is the same event delivered
   * again, and accepted once.
   */
  async sendEvent(command: EventCommand): Promise<EventOutcome> {
    const storage = this.#store;
    if (!hasJournal(storage.sql)) {
      return "missing";
    }
    const now = Date.now();
    const decision = storage.transactionSync((): EventDecision => {
      const run = readRun(storage.sql);
      if (run === undefined) {
        return { outcome: "missing", wake: false };
      }
      // A delivery's key is looked up first: one sent again after the run
      // ended is still the event it was.
      if (command.key !== null) {
        const [sent] = storage.sql
          .exec<{
            type: string;
            payload: string;
            accepted_at: number;
            consumed_by: number | null;
          }>(
            "SELECT type, payload, accepted_at, consumed_by FROM events WHERE key = ?",
            command.key
          )
          .toArray();
        if (sent !== undefined) {
          const same =
            sent.type === command.type &&
            // The same payload, whatever order a retry put its keys in, and
            // whichever of its parts it shared.
            equivalent(sent.payload, command.payload);
          if (!same) {
            return { outcome: "conflict", wake: false };
          }
          // The first delivery's wake may not have been written (its alarm
          // write failed after the event was): a retry that finds the
          // event still untaken, by a wait still in time for it, wakes
          // the run again.
          const wake =
            sent.consumed_by === null &&
            this.#wakeFor(run, sent.type, sent.accepted_at, now);
          return { outcome: "duplicate", wake };
        }
      }
      if (hasEnded(run)) {
        return { outcome: "ended", wake: false };
      }
      // Measured on the encoded text the journal keeps, here as well as
      // in the binding: this method is the run's boundary.
      const bytes = new TextEncoder().encode(command.payload).byteLength;
      if (bytes > maxEventPayloadBytes) {
        return { outcome: "too_large", wake: false };
      }
      if (
        run.event_count >= maxInboxEvents ||
        run.event_bytes + bytes > maxInboxBytes
      ) {
        return { outcome: "full", wake: false };
      }
      storage.sql.exec(
        "INSERT INTO events (type, payload, key, accepted_at) VALUES (?, ?, ?, ?)",
        command.type,
        command.payload,
        command.key,
        now
      );
      storage.sql.exec(
        "UPDATE run SET event_count = event_count + 1, event_bytes = event_bytes + ?",
        bytes
      );
      return {
        outcome: "accepted",
        wake: this.#wakeFor(run, command.type, now, now),
      };
    });
    if (decision.wake) {
      // With the write that accepted the event: no await between.
      await storage.setAlarm(now);
    }
    return decision.outcome;
  }

  /**
   * Whether an event of `type` accepted at `acceptedAt` should wake the
   * run now, journaling the wake if so. Only a suspended run needs waking:
   * a live activation reaches the wait itself, and a dead one has its
   * watchdog. The wait must be in time for the event and not yet over.
   * Called inside the transaction that accepted (or found) the event.
   */
  #wakeFor(
    run: RunRow,
    type: string,
    acceptedAt: number,
    now: number
  ): boolean {
    const { sql } = this.ctx.storage;
    const wake =
      run.status === "waiting" &&
      sql
        .exec(
          "SELECT 1 FROM steps WHERE state = 'waiting' AND type = 'waitForEvent' AND event_type = ? AND deadline > ? AND deadline > ?",
          type,
          now,
          acceptedAt
        )
        .toArray().length > 0;
    if (wake) {
      sql.exec("UPDATE run SET wake_at = ?", now);
    }
    return wake;
  }
}
