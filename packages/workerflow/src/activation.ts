// One activation: one execution of a run's definition, from the start,
// under one generation (run.ts says when there is one). Steps the journal
// has an outcome for return it; the first step without one runs.
//
// A sleep or an event wait that isn't due suspends the run: its deadline
// and the run's wake time are journaled, the alarm is set to that time,
// and the activation ends. The definition's call never settles, so none of
// the author's handlers (catch, finally, a `Settled` transport, a rejected
// sibling under `Promise.allSettled`) runs; the next activation replays to
// that call and resolves it. The driver learns of the suspension through
// `stopped`, a typed outcome of its own: nothing is thrown through the
// definition, and nothing is recognised by an error's name or message.
//
// A `do` step's attempt runs to its outcome or its timeout, whichever
// comes first. One that times out is ended in the journal as `timed_out`
// in the write that fails it: whatever it answers later is dropped, and
// only the step's latest attempt can journal an outcome. A failed attempt
// with retries left journals when the next is due, as an absolute time;
// one due later parks the step, and once every step still out is parked
// the activation suspends until the earliest of them, as a wait does.
// Nothing of the run stays in memory between attempts. A parked step's
// retry may wait past its time for siblings still out to land: a retry
// is never early, and the step out is never cut off for it.
//
// Every call of the step API carries the attempt it comes from, if any,
// in its async context: a callback whose attempt has its outcome (one
// that timed out goes on regardless) can't journal, count or wait for
// anything. An attempt is claimed only if its deadline fits in what is
// left of the alarm handler's wall time (config.ts); one that doesn't is
// left for a fresh activation, whose first attempt always runs.
//
// Waits come one at a time. A second sleep or wait reached while one is
// pending ends the run with a WorkflowParallelWaitError, and a replay that
// reaches a wait other than the one the journal holds (another event type
// or duration, or a new wait while the run's suspended one still waits)
// ends it with a WorkflowReplayMismatchError: a `Halt`, through the same
// typed outcome, never a loop of activations.
//
// A step's result is kept as codec text, or as a stream's chunks
// (streams.ts), within the attempt: a stream's upload runs inside the
// attempt's deadline and its async scope, and only the attempt that still
// holds the step (latest, not ended, of a current activation) can store a
// chunk. A result the step can't keep (a value structured clone refuses, a
// stream that can't be read) is no failure to retry: it ends the run as
// Cloudflare ends it, with a WorkflowFatalError, journaled as the step's
// `fatal` outcome first, through a `Halt`. A failure of the engine's own
// storage while a result is kept or read back is a `Fault`, as for every
// other journal write: the watchdog recovers the run, and the definition
// never hears of it. A sensitive step's errors are redacted wherever they
// are kept: the step's, each attempt's, and the run's.
import { AsyncLocalStorage } from "node:async_hooks";

import { decode, encode, encodeStreamResult, streamResultOf } from "./codec.ts";
import type { StreamResult } from "./codec.ts";
import {
  defaultRetryDelayMs,
  delayFunctionTimeoutMs,
  handlerBudgetMs,
  readCall,
  retryDelayMs,
} from "./config.ts";
import type { StepConfig, StepWork } from "./config.ts";
import type {
  WorkflowDefinition,
  WorkflowError,
  WorkflowDuration,
  WorkflowEvent,
  WorkflowStep,
  WorkflowStepContext,
  WorkflowStepEvent,
} from "./contracts.ts";
import {
  defaultEventTimeoutMs,
  maxWaitMs,
  parseDuration,
  waitTimedOut,
} from "./durations.ts";
import { errorRecord, isNonRetryable, namedError, rebuild } from "./errors.ts";
import { recordStepCompleted } from "./history.ts";
import { assertEventType, assertStepName, stepKey } from "./identity.ts";
import {
  readAttempt,
  readConsumedEvent,
  readNextEvent,
  readRun,
  readStep,
} from "./journal.ts";
import type {
  AttemptRow,
  EventRow,
  RunRow,
  StepRow,
  StepType,
} from "./journal.ts";
import {
  discardChunks,
  isStoredWhole,
  isStream,
  persistStream,
  replayStream,
  StreamResultError,
} from "./streams.ts";
import type { Replay } from "./streams.ts";

/** What the definition did: returned, or threw. */
export type Settlement =
  | { ok: true; output: unknown }
  | { ok: false; error: unknown };

/** A later generation took over this activation. */
export const superseded = Symbol("superseded");
/** The run waits for its alarm; this activation let go of it. */
export const suspended = Symbol("suspended");
/** One of the engine's own storage calls failed; the watchdog recovers. */
export interface Fault {
  readonly fault: unknown;
}

/**
 * The definition did something this engine can't run on: its replay
 * strayed from what the journal holds, it waited on two things at once,
 * or a step returned what it can't keep. The run ends with `halt` as its
 * error; no handler of the author's sees it, and replaying would only do
 * the same again.
 */
export interface Halt {
  readonly halt: Error;
}

/** Why an activation stopped short of settling the run. */
export type Stop = typeof superseded | typeof suspended | Fault | Halt;

/** What of an activation's limits comes from its host. */
export interface ActivationLimits {
  readonly leaseMs: number;
  /** The most bytes one step's stream result may hold. */
  readonly maxStreamBytes: number;
  /** The most bytes all of the run's stream results may hold. */
  readonly maxRunStreamBytes: number;
}

/** What a sensitive step's error message is, wherever it is kept. */
const redactedMessage = "[REDACTED]";

/** A step, sleep or wait reached beside a sleep or wait still pending. */
const parallelWait = (kind: string, name: string): Error =>
  namedError(
    "WorkflowParallelWaitError",
    `The ${kind} ${JSON.stringify(name)} was reached while a sleep or wait of the run was pending, or a wait beside a step still out; parallel waits aren't supported yet`
  );

/** A replay that reaches what the journal doesn't hold. */
const replayMismatch = (detail: string): Error =>
  namedError(
    "WorkflowReplayMismatchError",
    `The run's definition no longer replays as its journal recorded: ${detail}`
  );

/**
 * What a refused or suspended call gets: a promise that never settles.
 * Definition code can catch an error; it can't catch this, so it stays
 * where it stopped.
 */
const never = async (): Promise<never> =>
  await Promise.withResolvers<never>().promise;

/** What a guarded journal write returns when it failed. */
const failed = Symbol("failed");

interface StepIdentity {
  type: StepType;
  name: string;
  occurrence: number;
}

interface Claim {
  ordinal: number;
  attempt: number;
  key: string;
  /** When the attempt's timeout ends it. */
  deadline: number;
}

/** A failed attempt whose retry waits for the step's delay function. */
interface Asking {
  claim: Claim;
  /** The attempt's error, which the function is told. */
  error: string;
}

/**
 * What comes of a failed attempt once it is journaled: a retry, the delay
 * function to ask first, or the step's failure.
 */
type Landing = "retry" | { ask: Asking } | { failed: string };

/** A failed attempt's landing once any delay function has answered. */
type Settled = Exclude<Landing, { ask: Asking }>;

/** What comes next for a step, in this activation. */
type Next =
  | { claim: Claim }
  | { park: number }
  | Exclude<Landing, "retry">
  | null;

/** What a callback did, before its timeout or after it. */
type Answer =
  | { ok: true; value: unknown }
  | { ok: false; error: unknown }
  | { timedOut: true };

/** How a failed attempt failed, as the journal keeps it. */
interface AttemptFailure {
  error: string;
  ended: "failed" | "timed_out";
  /** False for a NonRetryableError or a value it can't keep. */
  retryable: boolean;
}

/**
 * A result the step can't keep: Cloudflare Workflows ends the run with
 * it, as a `WorkflowFatalError`, and the definition never hears of it.
 */
interface Fatal {
  /** What ended the run, in Cloudflare's words. */
  run: Error;
  /** What the step returned that couldn't be kept, for the journal. */
  detail: string;
}

/** How one attempt came out, as the journal keeps it. */
type AttemptOutcome =
  | { ok: true; value: string; stream?: StreamResult }
  | ({ ok: false } & AttemptFailure)
  | { fatal: Fatal }
  | { fault: unknown }
  | { superseded: true };

/** An attempt's outcome the journal keeps as the step's. */
type Committable = Extract<AttemptOutcome, { ok: boolean }>;

/** A step's value, once an attempt's outcome is journaled. */
interface Landed {
  ok: true;
  value: string;
  /** The step's ordinal, which a stream result is read back by. */
  ordinal: number;
}

/**
 * Marks what came of keeping a callback's stream within its attempt: no
 * value of the author's can carry this key.
 */
const keptStream = Symbol("kept stream");

interface KeptStream {
  readonly [keptStream]: AttemptOutcome;
}

const isKeptStream = (value: unknown): value is KeptStream =>
  typeof value === "object" && value !== null && keptStream in value;

/** A retry's delay, or why the step is spent instead. */
type Delay = { ms: number } | { error: string };

/**
 * The attempt a call of the step API comes from, through the callback's
 * async context. `live` is false once the attempt has an outcome (it
 * answered, or timed out), and for a delay function.
 */
interface AttemptScope {
  live: boolean;
}

/**
 * What a step's thrown error is kept as: redacted for a sensitive step,
 * its name and code kept.
 */
const failureText = (record: WorkflowError, config: StepConfig): string =>
  JSON.stringify(
    config.sensitive ? { ...record, message: redactedMessage } : record
  );

/**
 * A step's result it can't keep, as Cloudflare words it. A sensitive
 * step's detail (a stream source's own message may carry its secret) is
 * redacted.
 */
const fatalOf = (
  identity: StepIdentity,
  config: StepConfig,
  failure: { detail: string; reason: string; detailInRun: boolean }
): { fatal: Fatal } => {
  const shown = config.sensitive ? redactedMessage : failure.detail;
  const run = `The execution of the Workflow instance was terminated, as the step "${identity.name}" ${failure.reason}`;
  return {
    fatal: {
      run: namedError(
        "WorkflowFatalError",
        failure.detailInRun ? `${run} ${shown}` : run
      ),
      detail: shown,
    },
  };
};

const attempts = new AsyncLocalStorage<AttemptScope>();

/** Whether `scope` is an attempt's that has its outcome; read each time. */
const hasEnded = (scope: AttemptScope | undefined): boolean =>
  scope?.live === false;

/** What an attempt cut off before its outcome was journaled failed with. */
const cutOff = (): Error =>
  namedError(
    "WorkflowInternalError",
    "Attempt failed due to internal workflows error"
  );

/** A delay function's failure, as Cloudflare words it. */
const delayFailure = (identity: StepIdentity, reason: string): Delay => ({
  error: JSON.stringify(
    errorRecord(
      namedError(
        "NonRetryableDelayError",
        `The delay function for step "${identity.name}-${identity.occurrence}" ${reason}`
      )
    )
  ),
});

/** How a sleep or a wait came out, in this activation. */
type WaitOutcome =
  | { ok: true; event: EventRow | undefined }
  | { ok: false; error: string }
  | { suspend: number }
  | { mismatch: string }
  | null;

/** What a wait journals when it is first reached. */
interface WaitPlan {
  type: "sleep" | "waitForEvent";
  name: string;
  deadline: (now: number) => number;
  eventType: string | null;
  /**
   * A sleep's duration or a wait's timeout, journaled to compare a replay
   * with; null for `sleepUntil`, whose time a definition may compute
   * afresh each replay. The deadline, not this, decides when it's due.
   */
  durationMs: number | null;
}

/** What `call` did, as a value: it never rejects. */
const answerOf = async (call: () => Promise<unknown>): Promise<Answer> => {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    return { ok: false, error };
  }
};

/** A timeout after `ms`, or never once `signal` aborts. */
const timeoutAfter = async (
  ms: number,
  signal: AbortSignal
): Promise<Answer> => {
  try {
    await scheduler.wait(Math.max(0, ms), { signal });
  } catch {
    // Aborted: what it timed answered first.
    return await never();
  }
  return { timedOut: true };
};

/**
 * What `call` did, or its timeout after `ms`, whichever comes first. The
 * deadline is taken and the timer started before any of the author's
 * code runs. A timer can't interrupt synchronous code, so an answer that
 * comes back past the deadline (by `clock`, the clock the deadline was
 * taken on) timed out, though it beat the timer. A call that throws
 * before it returns fails as one that rejects, and one that answers after
 * its timeout answers no one: its answer is a value, so even a late
 * rejection is never an unhandled one.
 *
 * On workerd the clock only moves with I/O, so code that never awaits any
 * looks instant to it; the host's CPU limit is what ends such code there.
 */
const answerWithin = async (
  call: () => Promise<unknown>,
  ms: number,
  clock: () => number
): Promise<Answer> => {
  const deadline = clock() + ms;
  const timer = new AbortController();
  const timedOut = timeoutAfter(ms, timer.signal);
  try {
    const answer = await Promise.race([answerOf(call), timedOut]);
    return clock() >= deadline ? { timedOut: true } : answer;
  } finally {
    timer.abort();
  }
};

/**
 * Refuses to journal a time that isn't one: a retry's time is computed
 * from config, and the alarm set to it must be a real time. Throwing in the
 * journal's write faults the activation, and nothing is written.
 */
const assertTime = (time: number | null): void => {
  if (time !== null && !Number.isFinite(time)) {
    throw new RangeError(`A retry's time came out as ${String(time)}`);
  }
};

/** What a step's callback, or its delay function, is told. */
const contextOf = (
  identity: StepIdentity,
  claim: Claim,
  config: StepConfig
): WorkflowStepContext => ({
  step: { name: identity.name, count: identity.occurrence },
  attempt: claim.attempt,
  idempotencyKey: claim.key,
  // A copy each time: what one callback does to it, the next never sees.
  config: structuredClone(config.context),
});

const stepEvent = <Payload>(event: EventRow): WorkflowStepEvent<Payload> => ({
  // SAFETY: what the sender sent, through the codec; the payload's type is
  // the author's claim, as it is on Cloudflare.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  payload: decode(event.payload) as Payload,
  timestamp: new Date(event.accepted_at),
  type: event.type,
});

// Taken once, when the module loads: nothing a definition later does to
// Date.prototype, Function.prototype or Reflect changes how a time is read.
// oxlint-disable-next-line typescript/unbound-method -- applied with the value as `this`, on purpose
const { getTime } = Date.prototype;
const { apply } = Reflect;

/** A Date's time through the built-in, or undefined for anything else. */
const timeOf = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return value;
  }
  try {
    // Throws for anything but a real Date, whatever it claims to be.
    const time: unknown = apply(getTime, value, []);
    return typeof time === "number" ? time : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Why the journaled wait `step` isn't the one `plan` describes, or why
 * the journal holds another wait still waiting: waits run one at a time,
 * so a replay that reaches this one while another waits has strayed
 * from the run it replays. Undefined when the journal agrees.
 */
const mismatchIn = (
  sql: SqlStorage,
  identity: StepIdentity,
  step: StepRow | undefined,
  plan: WaitPlan
): string | undefined => {
  const named = `the ${identity.type} ${JSON.stringify(identity.name)}`;
  if (step !== undefined) {
    // A wait the journal holds: it must be the same wait. Passing it
    // while the one the run suspended on waits is every replay's way.
    if (step.event_type !== plan.eventType) {
      return `${named} was for events of type ${JSON.stringify(step.event_type)}, and is now for ${JSON.stringify(plan.eventType)}`;
    }
    if (step.duration_ms !== plan.durationMs) {
      return `${named} was given ${String(step.duration_ms)}ms, and is now given ${String(plan.durationMs)}ms`;
    }
    return undefined;
  }
  // A new wait: the run's waits come one at a time, so none may still be
  // waiting. One that is was never reached by this replay.
  const [other] = sql
    .exec<{
      type: string;
      name: string;
      state: string;
    }>(
      "SELECT type, name, state FROM steps WHERE state IN ('waiting', 'retrying') LIMIT 1"
    )
    .toArray();
  if (other !== undefined) {
    const still = other.state === "retrying" ? "waiting to retry" : "waiting";
    return `it reached ${named} while the ${other.type} ${JSON.stringify(other.name)} it suspended on is still ${still}`;
  }
  return undefined;
};

export class Activation {
  readonly #storage: DurableObjectStorage;
  readonly #run: RunRow;
  readonly #generation: number;
  readonly #limits: ActivationLimits;
  /** The clock an attempt's or a delay function's running time is measured on. */
  readonly #clock: () => number;
  /** Settled, superseded, suspended or faulted: every later call is refused. */
  #over = false;
  readonly #stop: (stop: Stop) => void;
  /** Resolves when the activation stopped without settling the run. */
  readonly stopped: Promise<Stop>;
  readonly #occurrences = new Map<string, number>();
  /**
   * A sleep or wait of this activation that hasn't settled. One that
   * suspended never does, so this stays set once the activation let go.
   */
  #waitPending = false;
  /** `do` steps of this activation whose calls haven't settled. */
  #stepsInFlight = 0;
  /**
   * This activation's parked steps: steps whose next attempt comes later.
   * They count among the steps in flight; once they are all that is, the
   * activation suspends until the earliest is due.
   */
  #parkedCount = 0;
  #parkedWake = Number.POSITIVE_INFINITY;
  /** When this activation's alarm handler started: its wall time's start. */
  readonly #startedAt = Date.now();
  /** Whether this activation has claimed an attempt yet. */
  #claimed = false;

  /** What the definition is handed as `step`. */
  readonly step: WorkflowStep;

  constructor(
    storage: DurableObjectStorage,
    run: RunRow,
    generation: number,
    limits: ActivationLimits,
    clock: () => number
  ) {
    this.#storage = storage;
    this.#run = run;
    this.#generation = generation;
    this.#limits = limits;
    this.#clock = clock;
    const { promise, resolve } = Promise.withResolvers<Stop>();
    this.stopped = promise;
    this.#stop = resolve;
    // Every call goes through #toAuthor, the one place an outcome is
    // handed back to the definition.
    const doStep = async (name: string, ...rest: unknown[]): Promise<unknown> =>
      await this.#toAuthor(async () => await this.#do(name, rest));
    this.step = {
      // SAFETY: both of the contract's forms, told apart by `rest` (config.ts).
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      do: doStep as WorkflowStep["do"],
      sleep: async (
        name: string,
        duration: WorkflowDuration
      ): Promise<void> => {
        await this.#toAuthor(async () => {
          await this.#sleep(name, duration);
        });
      },
      sleepUntil: async (
        name: string,
        timestamp: Date | number
      ): Promise<void> => {
        await this.#toAuthor(async () => {
          await this.#sleepUntil(name, timestamp);
        });
      },
      waitForEvent: async <Payload>(
        name: string,
        options: { type: string; timeout?: WorkflowDuration }
      ): Promise<WorkflowStepEvent<Payload>> =>
        await this.#toAuthor(
          async () => await this.#waitForEvent<Payload>(name, options)
        ),
    };
  }

  /**
   * Hands a call's outcome to the definition, its value or its error, only
   * if this activation is still current once the call is done. Every await
   * inside a call (the journal's writes, the alarm's) lets other calls of
   * the definition run, and one of them may have ended the activation: a
   * halt, a suspension, a later generation. Then the outcome is held back
   * and the call never settles, so no continuation, catch or finally of
   * the author's runs after the stop.
   */
  async #toAuthor<T>(call: () => Promise<T>): Promise<T> {
    // A call from a step's callback whose attempt has its outcome (it
    // answered, or timed out and goes on regardless) acts for nothing: it
    // never settles, journals nothing and counts no occurrence. Not
    // #refuse: this activation is still current, only that attempt is over.
    // Nested calls from an attempt still out are the reference's, and run.
    const caller = attempts.getStore();
    if (hasEnded(caller)) {
      return await never();
    }
    let settled: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      settled = { ok: true, value: await call() };
    } catch (error) {
      settled = { ok: false, error };
    }
    const current = this.#write(() => this.#current());
    if (current === failed) {
      return await never();
    }
    if (!current) {
      return await this.#refuse();
    }
    if (hasEnded(caller)) {
      // Called while its attempt was out, and answered after it ended: the
      // answer has no one to go to.
      return await never();
    }
    if (!settled.ok) {
      throw settled.error;
    }
    return settled.value;
  }

  /** Whether this activation may still act: not over, not superseded. */
  #current(): boolean {
    return !this.#over && this.#holdsGeneration();
  }

  /** Whether no later activation has taken the run over. */
  #holdsGeneration(): boolean {
    return readRun(this.#storage.sql)?.generation === this.#generation;
  }

  /**
   * Ends the activation on something it can't run (`Halt`): the driver
   * settles the run with `error`, and the definition's call never settles.
   */
  async #halt(error: Error): Promise<never> {
    this.#haltNow(error);
    return await never();
  }

  /** `#halt`, for a caller that can't wait on it: a stream's pull. */
  #haltNow(error: Error): void {
    this.#over = true;
    this.#stop({ halt: error });
  }

  /** Records how this activation ended, if nothing has yet. */
  #recordEnd(ended: "superseded" | "faulted"): void {
    this.#storage.sql.exec(
      "UPDATE activations SET ended_at = ?, ended = ? WHERE generation = ? AND ended_at IS NULL",
      Date.now(),
      ended,
      this.#generation
    );
  }

  /** Ends this activation as superseded, once. */
  #endSuperseded(): void {
    if (this.#over) {
      return;
    }
    this.#over = true;
    try {
      this.#recordEnd("superseded");
    } finally {
      this.#stop(superseded);
    }
  }

  /**
   * Ends this activation because the engine's own storage call failed.
   * The error never reaches the definition: a handler of the author's
   * would take a failed journal write for a failed step, or for none.
   * Whatever alarm is set stays (the watchdog, or the wake a suspension
   * set), and brings the run back with its deadlines as journaled.
   */
  #fault(fault: unknown): void {
    if (!this.#over) {
      this.#over = true;
      try {
        this.#recordEnd("faulted");
      } catch {
        // Storage is failing: the activation row stays open, as after a
        // crash. The fault itself is what `stopped` reports.
      }
    }
    // Even once over: a suspension whose alarm write failed was over
    // before it could report how it stopped. An earlier report stands.
    this.#stop({ fault });
  }

  /** Runs one of the engine's own journal writes, faulting if it throws. */
  #write<T>(write: () => T): T | typeof failed {
    try {
      return write();
    } catch (error) {
      this.#fault(error);
      return failed;
    }
  }

  /** Refuses a call from this activation, which is over. */
  async #refuse(): Promise<never> {
    try {
      this.#endSuperseded();
    } catch {
      // Only the record of it failed; the call is refused all the same.
    }
    return await never();
  }

  #renewLease(now: number): void {
    this.#storage.sql.exec(
      "UPDATE run SET lease_until = ?",
      now + this.#limits.leaseMs
    );
  }

  /**
   * Sets the alarm. Called right after the journal write it goes with,
   * with no await between: one write, and alarms are set in the order of
   * the writes they go with. A failure faults the activation, never the
   * definition.
   */
  async #arm(time: number): Promise<void> {
    try {
      await this.#storage.setAlarm(time);
    } catch (error) {
      this.#fault(error);
      await never();
    }
  }

  /**
   * Moves the watchdog alarm to a lease from now, unless the activation is
   * over: then the alarm is what its end set (a suspension's wake, or none
   * once settled), and a renewal issued after that would replace it.
   */
  async #renewWatchdog(): Promise<void> {
    if (this.#over) {
      return;
    }
    await this.#arm(Date.now() + this.#limits.leaseMs);
  }

  /**
   * Ends the failed attempt `claim` in the journal and says what comes
   * next for its step: a retry (its absolute time journaled here), a
   * delay function to ask (a provisional retry journaled here, so the
   * attempt is fenced now and recovery finds one consistent state), or
   * the step's failure once its retries are spent. Called inside the
   * transaction that found the attempt failed.
   */
  // oxlint-disable-next-line class-methods-use-this -- one of the step's journal writes, beside the others
  #endFailedIn(
    sql: SqlStorage,
    now: number,
    claim: Claim,
    config: StepConfig,
    failure: AttemptFailure
  ): Landing {
    const retrying = failure.retryable && claim.attempt <= config.limit;
    let retryAt: number | null = null;
    let landing: Landing = { failed: failure.error };
    if (retrying && typeof config.delay === "function") {
      // Until the function answers, the retry is due after the default
      // delay: should the activation die while it asks, that is when the
      // retry comes, and the function is never asked again for this
      // attempt.
      retryAt = now + defaultRetryDelayMs;
      landing = { ask: { claim, error: failure.error } };
    } else if (retrying && typeof config.delay === "number") {
      retryAt = now + retryDelayMs(config.backoff, config.delay, claim.attempt);
      landing = "retry";
    }
    assertTime(retryAt);
    discardChunks(sql, claim.ordinal, claim.attempt);
    sql.exec(
      "UPDATE steps SET state = ?, value = NULL, error = ? WHERE ordinal = ?",
      retryAt === null ? "failed" : "retrying",
      retryAt === null ? failure.error : null,
      claim.ordinal
    );
    sql.exec(
      "UPDATE attempts SET ended_at = ?, ended = ?, error = ?, retry_at = ? WHERE ordinal = ? AND attempt = ?",
      now,
      failure.ended,
      failure.error,
      retryAt,
      claim.ordinal,
      claim.attempt
    );
    return landing;
  }

  /**
   * What comes next for a step, if this activation is current: its first
   * attempt, the next one (after a retry that is due, or one cut off
   * before its outcome was journaled), parking until a retry is due, or
   * the step's end. The journal is read in the same write that acts on
   * it, so what was read is what the write is for.
   *
   * An attempt cut off (the process died, the object was evicted or taken
   * over) counts against the step's retries like any other. One cut off
   * past its deadline timed out, as far as the step can tell: it is ended
   * as one that timed out, and retried after its backoff. One cut off
   * before is retried at once, as on Cloudflare. Either way the attempts
   * a step gets are bounded by its limit, however often its activations
   * die.
   */
  #nextAttempt(identity: StepIdentity, config: StepConfig): Next {
    return this.#storage.transactionSync((): Next => {
      if (!this.#current()) {
        return null;
      }
      const { sql } = this.#storage;
      const now = Date.now();
      const step = readStep(sql, identity);
      let ordinal: number;
      let attempt = 1;
      let key = stepKey(this.#run.run_uid, identity);
      if (step === undefined) {
        if (!this.#fits(now, config)) {
          return { park: now };
        }
        ({ ordinal } = sql
          .exec<{ ordinal: number }>(
            "INSERT INTO steps (type, name, occurrence, idempotency_key, state, attempt, config) VALUES (?, ?, ?, ?, 'running', 1, ?) RETURNING ordinal",
            identity.type,
            identity.name,
            identity.occurrence,
            key,
            config.journal
          )
          .one());
      } else {
        const latest = readAttempt(sql, step.ordinal, step.attempt);
        if (latest === undefined) {
          throw new Error(`The journal lost the attempts of ${identity.name}`);
        }
        const ended = this.#endCutOffIn(sql, now, step, latest, config);
        if (ended !== undefined) {
          return ended;
        }
        const after = readStep(sql, identity);
        if (after?.state === "retrying") {
          const retryAt = readAttempt(
            sql,
            after.ordinal,
            after.attempt
          )?.retry_at;
          if (typeof retryAt !== "number") {
            throw new TypeError(
              `The journal lost the retry of ${identity.name}`
            );
          }
          if (now < retryAt) {
            return { park: retryAt };
          }
        } else if (after?.state !== "running") {
          throw new Error(
            `The journal holds the step ${identity.name} as ${String(after?.state)}, with no attempt left to make`
          );
        }
        if (!this.#fits(now, config)) {
          return { park: now };
        }
        // A retry that is due, or an attempt cut off before its deadline
        // with retries left. The next goes out under the step's one key
        // (contracts.ts): an attempt that timed out or was cut off may
        // still have had its effect, and a receiver that deduplicates by
        // the key applies it once. Effect receipts stay stable across
        // attempts, as spec 43.6 asks; the attempt number is the fence.
        ({ ordinal } = step);
        attempt = step.attempt + 1;
        key = step.idempotency_key;
        sql.exec(
          "UPDATE steps SET attempt = ?, state = 'running' WHERE ordinal = ?",
          attempt,
          ordinal
        );
        // What an earlier attempt uploaded of a stream is no result: only
        // the committing attempt's chunks survive.
        discardChunks(sql, ordinal);
      }
      const claim: Claim = {
        ordinal,
        attempt,
        key,
        deadline: now + config.timeoutMs,
      };
      sql.exec(
        "INSERT INTO attempts (ordinal, attempt, generation, started_at, deadline) VALUES (?, ?, ?, ?, ?)",
        claim.ordinal,
        claim.attempt,
        this.#generation,
        now,
        claim.deadline
      );
      this.#renewLease(now);
      this.#claimed = true;
      return { claim };
    });
  }

  /**
   * Ends the step's latest attempt if it was cut off before its outcome
   * was journaled and counts as a failure now: past its deadline (it timed
   * out, as far as the step can tell), or the last its retries allow.
   * Returns what comes of it, unless that is a retry: then undefined, as
   * for an attempt cut off before its deadline with retries left, which
   * is retried at once.
   */
  #endCutOffIn(
    sql: SqlStorage,
    now: number,
    step: StepRow,
    latest: AttemptRow,
    config: StepConfig
  ): Exclude<Landing, "retry"> | undefined {
    if (step.state !== "running" || latest.ended_at !== null) {
      return undefined;
    }
    const timedOut = now >= latest.deadline;
    if (!timedOut && step.attempt <= config.limit) {
      return undefined;
    }
    const landing = this.#endFailedIn(
      sql,
      now,
      {
        ordinal: step.ordinal,
        attempt: step.attempt,
        key: step.idempotency_key,
        deadline: latest.deadline,
      },
      config,
      {
        error: JSON.stringify(
          errorRecord(timedOut ? waitTimedOut(config.timeoutMs) : cutOff())
        ),
        ended: timedOut ? "timed_out" : "failed",
        retryable: true,
      }
    );
    this.#renewLease(now);
    return landing === "retry" ? undefined : landing;
  }

  /**
   * Whether an attempt claimed now can run to its deadline inside this
   * alarm handler's wall time. An activation's first attempt always runs:
   * the next activation would be no fresher, so it would never run.
   */
  #fits(now: number, config: StepConfig): boolean {
    return (
      !this.#claimed ||
      now + config.timeoutMs <= this.#startedAt + handlerBudgetMs
    );
  }

  /**
   * Journals the attempt's outcome if this activation is current and the
   * attempt is still the step's latest and not ended; otherwise records
   * that its answer was ignored.
   */
  /**
   * Whether the claimed attempt still holds its step: this activation is
   * current, and the attempt is the step's latest and not ended (one that
   * timed out is ended in the write that fails it). What it does while it
   * doesn't (commit, store a chunk) is refused.
   */
  #holds(claim: Claim): boolean {
    if (!this.#current()) {
      return false;
    }
    const { sql } = this.#storage;
    const latest = sql
      .exec<{ attempt: number }>(
        "SELECT attempt FROM steps WHERE ordinal = ?",
        claim.ordinal
      )
      .one();
    const attempt = readAttempt(sql, claim.ordinal, claim.attempt);
    return latest.attempt === claim.attempt && attempt?.ended_at === null;
  }

  /** Records that the attempt's answer was ignored, and drops its upload. */
  #ignore(claim: Claim, now: number): void {
    this.#storage.sql.exec(
      "UPDATE attempts SET ended_at = ?, ended = 'superseded' WHERE ordinal = ? AND attempt = ? AND ended_at IS NULL",
      now,
      claim.ordinal,
      claim.attempt
    );
    discardChunks(this.#storage.sql, claim.ordinal, claim.attempt);
  }

  /**
   * Journals the attempt's outcome if the attempt still holds its step;
   * otherwise records that its answer was ignored. A stream result is
   * journaled only if every chunk it names is stored, checked in the same
   * write. With a result, the observers' record of it (history.ts).
   */
  #commit(
    claim: Claim,
    config: StepConfig,
    outcome: Committable
  ): Landing | Landed | "incomplete" | null {
    return this.#storage.transactionSync(
      (): Landing | Landed | "incomplete" | null => {
        const { sql } = this.#storage;
        const now = Date.now();
        if (!this.#holds(claim)) {
          this.#ignore(claim, now);
          return null;
        }
        this.#renewLease(now);
        if (!outcome.ok) {
          return this.#endFailedIn(sql, now, claim, config, outcome);
        }
        if (
          outcome.stream !== undefined &&
          !isStoredWhole(sql, claim.ordinal, outcome.stream)
        ) {
          return "incomplete";
        }
        sql.exec(
          "UPDATE steps SET state = 'succeeded', value = ?, error = NULL WHERE ordinal = ?",
          outcome.value,
          claim.ordinal
        );
        sql.exec(
          "UPDATE attempts SET ended_at = ?, ended = 'succeeded' WHERE ordinal = ? AND attempt = ?",
          now,
          claim.ordinal,
          claim.attempt
        );
        recordStepCompleted(sql, {
          ordinal: claim.ordinal,
          at: now,
          sensitive: config.sensitive,
          result:
            outcome.stream === undefined
              ? { kind: "value", value: outcome.value }
              : { kind: "stream", result: outcome.stream },
        });
        return { ok: true, value: outcome.value, ordinal: claim.ordinal };
      }
    );
  }

  /**
   * Journals a step's fatal outcome, in one write with the check that the
   * attempt still holds its step: `fatal`, not `failed`, so a replay that
   * reaches it, should the run's end not follow (the process dies, its
   * write fails), halts the run with the same error rather than hand it
   * to the definition; and never retried. Then halts, so the driver ends
   * the run with it (and clears its wake and its alarm).
   */
  async #fail(claim: Claim, fatal: Fatal): Promise<never> {
    const journaled = this.#write(() =>
      this.#storage.transactionSync(() => {
        const { sql } = this.#storage;
        const now = Date.now();
        if (!this.#holds(claim)) {
          this.#ignore(claim, now);
          return false;
        }
        discardChunks(sql, claim.ordinal, claim.attempt);
        const error = JSON.stringify({
          ...errorRecord(fatal.run),
          detail: fatal.detail,
        });
        sql.exec(
          "UPDATE steps SET state = 'fatal', value = NULL, error = ? WHERE ordinal = ?",
          error,
          claim.ordinal
        );
        sql.exec(
          "UPDATE attempts SET ended_at = ?, ended = 'failed', error = ?, retry_at = NULL WHERE ordinal = ? AND attempt = ?",
          now,
          error,
          claim.ordinal,
          claim.attempt
        );
        return true;
      })
    );
    if (journaled === failed) {
      return await never();
    }
    if (!journaled) {
      return await this.#refuse();
    }
    return await this.#halt(fatal.run);
  }

  /**
   * Keeps a stream result, inside its attempt: its chunks stored only
   * while the attempt holds its step, its reading stopped when the
   * attempt ends (an answer, a timeout) or the activation stops. The
   * stream's own failures are fatal; storage's are a fault.
   */
  async #keepStream(
    identity: StepIdentity,
    claim: Claim,
    config: StepConfig,
    stream: object,
    attemptEnded: Promise<unknown>
  ): Promise<AttemptOutcome> {
    let result: StreamResult | undefined;
    try {
      result = await persistStream(stream, {
        storage: this.#storage,
        ordinal: claim.ordinal,
        attempt: claim.attempt,
        holds: () => this.#holds(claim),
        stopped: Promise.race([this.stopped, attemptEnded]),
        maxBytes: this.#limits.maxStreamBytes,
        maxRunBytes: this.#limits.maxRunStreamBytes,
      });
    } catch (error) {
      if (!(error instanceof StreamResultError)) {
        // The engine's own storage or hashing: not the step's doing.
        return { fault: error };
      }
      return fatalOf(identity, config, {
        detail: errorRecord(error).message,
        reason: "returned an invalid ReadableStream output.",
        detailInRun: true,
      });
    }
    return result === undefined
      ? { superseded: true }
      : { ok: true, value: encodeStreamResult(result), stream: result };
  }

  /**
   * A succeeded step's value, as its journal row keeps it: fresh. Storage
   * failing while a stream result is read back faults the activation, and
   * bytes that aren't what the commit named halt it; the reader hears of
   * neither, and its read never settles.
   */
  async #result(ordinal: number, value: string): Promise<unknown> {
    const stream = streamResultOf(value);
    if (stream === undefined) {
      return decode(value);
    }
    let replay: Replay;
    try {
      replay = await replayStream(this.#storage.sql, ordinal, stream, {
        fault: (error) => {
          this.#fault(error);
        },
        corrupt: (error) => {
          this.#haltNow(error);
        },
        // Read from a step's callback whose attempt has ended (it timed
        // out and goes on), or once this activation is over: it acts for
        // nothing, so it reads nothing more.
        stopped: () => this.#over || hasEnded(attempts.getStore()),
      });
    } catch (error) {
      this.#fault(error);
      return await never();
    }
    if ("corrupt" in replay) {
      // A result the journal holds but can't give back: replaying again
      // would find the same, so the run ends with it, as on a fatal step.
      return await this.#halt(replay.corrupt);
    }
    return replay.stream;
  }

  /** Runs one attempt at the step: its callback, to an outcome. */
  async #runAttempt(
    identity: StepIdentity,
    config: StepConfig,
    claim: Claim,
    work: StepWork
  ): Promise<AttemptOutcome> {
    await this.#renewWatchdog();
    // The await above lets other calls of the definition run; one of them
    // may have ended this activation (a halt, a suspension). The callback
    // is the effect: it never runs for an activation that is over.
    const stillCurrent = this.#write(() => this.#current());
    if (stillCurrent === failed) {
      return await never();
    }
    if (!stillCurrent) {
      return await this.#refuse();
    }
    // A callback still out at its deadline goes on (JavaScript can't be
    // stopped), but nothing it answers is looked at again, and nothing it
    // calls of the step API once the attempt has an outcome is answered.
    const context = contextOf(identity, claim, config);
    const scope: AttemptScope = { live: true };
    // Ends with the attempt (its answer, its timeout): a stream still being
    // uploaded then stops reading, and stores nothing more.
    const attemptEnded = Promise.withResolvers<true>();
    let answer: Answer;
    try {
      answer = await answerWithin(
        async () =>
          await attempts.run(scope, async () => {
            const returned: unknown = await work(context);
            // A stream is kept within the attempt: its upload counts
            // against the attempt's deadline, in the attempt's scope.
            if (!isStream(returned)) {
              return returned;
            }
            const kept: KeptStream = {
              [keptStream]: await this.#keepStream(
                identity,
                claim,
                config,
                returned,
                attemptEnded.promise
              ),
            };
            return kept;
          }),
        claim.deadline - Date.now(),
        this.#clock
      );
    } finally {
      scope.live = false;
      attemptEnded.resolve(true);
    }
    if ("timedOut" in answer) {
      return {
        ok: false,
        error: JSON.stringify(errorRecord(waitTimedOut(config.timeoutMs))),
        ended: "timed_out",
        retryable: true,
      };
    }
    if (answer.ok && isKeptStream(answer.value)) {
      return answer.value[keptStream];
    }
    if (answer.ok) {
      try {
        return { ok: true, value: encode(answer.value) };
      } catch (error) {
        // A value the journal can't keep is no failure to retry: the same
        // callback would only return it again. It ends the run, as on
        // Cloudflare.
        return fatalOf(identity, config, {
          detail: `Value returned from step "${identity.name}" is not serialisable: ${errorRecord(error).message}`,
          reason: "returned a value which is not serialisable",
          detailInRun: false,
        });
      }
    }
    // Read once: the retry decision and the stored error are the same
    // reading, whatever the error's getters answer another time.
    const record = errorRecord(answer.error);
    return {
      ok: false,
      error: failureText(record, config),
      ended: "failed",
      retryable: !isNonRetryable(record),
    };
  }

  /**
   * Asks the step's delay function, once, when the attempt `asking.claim`
   * that failed is due again, and journals what it says over the
   * provisional retry: the retry's time, or the step's failure. It is the
   * author's code, so it runs only while this activation is current, has
   * `delayFunctionTimeoutMs`, and nothing it calls of the step API is
   * answered. One that throws, takes too long or says something that
   * isn't a delay spends the step, as Cloudflare's NonRetryableDelayError.
   */
  async #askDelay(
    identity: StepIdentity,
    config: StepConfig,
    asking: Asking
  ): Promise<Settled | null> {
    const { delay } = config;
    if (typeof delay !== "function") {
      throw new TypeError(`The step ${identity.name} has no delay function`);
    }
    const current = this.#write(() => this.#current());
    if (current === failed) {
      return await never();
    }
    if (!current) {
      return await this.#refuse();
    }
    const { claim } = asking;
    const ctx = contextOf(identity, claim, config);
    const answer = await answerWithin(
      async () =>
        await attempts.run(
          { live: false },
          async () => await delay({ ctx, error: rebuild(asking.error) })
        ),
      delayFunctionTimeoutMs,
      this.#clock
    );
    let said: Delay;
    if ("timedOut" in answer) {
      said = delayFailure(
        identity,
        `did not return within ${delayFunctionTimeoutMs / 1000} seconds`
      );
    } else if (answer.ok) {
      try {
        const base = parseDuration(answer.value, "A retry delay");
        said = { ms: retryDelayMs(config.backoff, base, claim.attempt) };
      } catch {
        said = delayFailure(
          identity,
          'returned an invalid delay value (expected a number of ms or a duration string like "30 seconds")'
        );
      }
    } else {
      said = delayFailure(
        identity,
        `threw an error: ${config.sensitive ? redactedMessage : errorRecord(answer.error).message}`
      );
    }
    const landing = this.#write(() => this.#journalDelay(claim, said));
    if (landing === failed) {
      return await never();
    }
    return landing;
  }

  /**
   * Journals what a delay function said over the provisional retry, if
   * this activation is current and that retry still stands: the retry's
   * time, counted from when the attempt ended, or the step's failure.
   * Null when it no longer stands.
   */
  #journalDelay(claim: Claim, said: Delay): Settled | null {
    return this.#storage.transactionSync((): Settled | null => {
      if (!this.#current()) {
        return null;
      }
      const { sql } = this.#storage;
      const step = sql
        .exec<{ attempt: number; state: string }>(
          "SELECT attempt, state FROM steps WHERE ordinal = ?",
          claim.ordinal
        )
        .one();
      const ended = readAttempt(sql, claim.ordinal, claim.attempt);
      if (
        step.attempt !== claim.attempt ||
        step.state !== "retrying" ||
        typeof ended?.ended_at !== "number"
      ) {
        return null;
      }
      if ("ms" in said) {
        const retryAt = ended.ended_at + said.ms;
        assertTime(retryAt);
        sql.exec(
          "UPDATE attempts SET retry_at = ? WHERE ordinal = ? AND attempt = ?",
          retryAt,
          claim.ordinal,
          claim.attempt
        );
        return "retry";
      }
      sql.exec(
        "UPDATE steps SET state = 'failed', error = ? WHERE ordinal = ?",
        said.error,
        claim.ordinal
      );
      sql.exec(
        "UPDATE attempts SET retry_at = NULL WHERE ordinal = ? AND attempt = ?",
        claim.ordinal,
        claim.attempt
      );
      return { failed: said.error };
    });
  }

  /** The next occurrence of `name` among steps of `type`, from 1. */
  #occurrence(type: StepType, name: string): StepIdentity {
    const counter = JSON.stringify([type, name]);
    const occurrence = (this.#occurrences.get(counter) ?? 0) + 1;
    this.#occurrences.set(counter, occurrence);
    return { type, name, occurrence };
  }

  /**
   * Parks a step until `wake`: its retry, or a fresh activation for an
   * attempt this one has no wall time left for. Its call doesn't settle in
   * this activation. The activation suspends once every step still out is
   * parked, so no step out at its effect is cut off by the suspension: a
   * parked step's retry may wait for its siblings to land.
   */
  async #park(wake: number): Promise<never> {
    this.#parkedCount += 1;
    this.#parkedWake = Math.min(this.#parkedWake, wake);
    this.#suspendIfParked();
    return await never();
  }

  /**
   * Suspends the activation until the earliest parked step is due, once
   * the parked steps are all that is out and no wait is pending. The wake
   * is journaled and the alarm set in one synchronous turn.
   */
  #suspendIfParked(): void {
    const quiet =
      !this.#over &&
      this.#parkedCount > 0 &&
      !this.#waitPending &&
      this.#stepsInFlight === this.#parkedCount;
    if (!quiet) {
      return;
    }
    const wake = this.#parkedWake;
    const suspendedNow = this.#write(() =>
      this.#storage.transactionSync(() => {
        if (!this.#current()) {
          return false;
        }
        this.#suspendIn(this.#storage.sql, Date.now(), wake);
        return true;
      })
    );
    if (suspendedNow === failed) {
      return;
    }
    if (!suspendedNow) {
      try {
        this.#endSuperseded();
      } catch {
        // Only the record of it failed; the activation is over all the same.
      }
      return;
    }
    this.#over = true;
    // Issued now, in the turn of the write it goes with; `stopped` reports
    // the suspension once it is set, or the fault if it couldn't be.
    void (async (): Promise<void> => {
      await this.#arm(wake);
      this.#stop(suspended);
    })();
  }

  async #do(name: string, rest: unknown[]): Promise<unknown> {
    if (this.#waitPending) {
      return await this.#halt(parallelWait("step", name));
    }
    this.#stepsInFlight += 1;
    let inFlight = true;
    // Out of flight once its outcome is journaled: a wait started after
    // that can't cost the step its effect. Once, whichever way it lands.
    const land = (): void => {
      if (inFlight) {
        inFlight = false;
        this.#stepsInFlight -= 1;
        // The steps still out may all be parked now.
        this.#suspendIfParked();
      }
    };
    try {
      return await this.#doAlone(name, rest, land);
    } finally {
      // Never reached by a step whose call never settles.
      land();
    }
  }

  async #doAlone(
    name: string,
    rest: unknown[],
    land: () => void
  ): Promise<unknown> {
    const current = this.#write(() => this.#current());
    if (current === failed) {
      return await never();
    }
    if (!current) {
      return await this.#refuse();
    }
    assertStepName(name);
    const { work, config } = readCall(rest);
    const identity = this.#occurrence("do", name);
    const journaled = this.#write(() => readStep(this.#storage.sql, identity));
    if (journaled === failed) {
      return await never();
    }
    // Checked whatever state the step is in, as a wait's are: a step
    // configured otherwise isn't the step the journal holds.
    if (journaled !== undefined && journaled.config !== config.journal) {
      return await this.#halt(
        replayMismatch(
          `the do ${JSON.stringify(name)} was configured ${String(journaled.config)}, and is now configured ${config.journal}`
        )
      );
    }
    if (journaled?.state === "succeeded" && journaled.value !== null) {
      land();
      // What this step's work returned, through the codec or from storage,
      // as the attempt that journaled it returned it.
      return await this.#result(journaled.ordinal, journaled.value);
    }
    if (journaled?.state === "failed" && journaled.error !== null) {
      land();
      throw rebuild(journaled.error);
    }
    if (journaled?.state === "fatal" && journaled.error !== null) {
      // The step's result couldn't be kept, and the run ends with that,
      // however this replay got here: never to the definition.
      land();
      return await this.#halt(rebuild(journaled.error));
    }
    return await this.#attempts(identity, config, work, land);
  }

  /**
   * The step's next attempt, and each after it that is due at once, to
   * the step's outcome; a retry due later parks the step.
   */
  async #attempts(
    identity: StepIdentity,
    config: StepConfig,
    work: StepWork,
    land: () => void
  ): Promise<unknown> {
    const next = this.#write(() => this.#nextAttempt(identity, config));
    if (next === failed) {
      return await never();
    }
    if (next === null) {
      return await this.#refuse();
    }
    if ("park" in next) {
      return await this.#park(next.park);
    }
    let journaled: Landing | Landed | null;
    if ("claim" in next) {
      const { claim } = next;
      const outcome = await this.#runAttempt(identity, config, claim, work);
      if ("fault" in outcome) {
        this.#fault(outcome.fault);
        return await never();
      }
      if ("superseded" in outcome) {
        // Superseded mid-upload: recorded as an answer ignored, like a
        // late one.
        this.#write(() => {
          this.#storage.transactionSync(() => {
            this.#ignore(claim, Date.now());
          });
        });
        return await this.#refuse();
      }
      if ("fatal" in outcome) {
        return await this.#fail(claim, outcome.fatal);
      }
      const committed = this.#write(() => this.#commit(claim, config, outcome));
      if (committed === failed) {
        return await never();
      }
      if (committed === "incomplete") {
        return await this.#fail(
          claim,
          fatalOf(identity, config, {
            detail: "Its stream output was stored incompletely",
            reason: "returned a ReadableStream output that couldn't be kept.",
            detailInRun: true,
          }).fatal
        );
      }
      journaled = committed;
    } else {
      journaled = next;
    }
    const landed: Settled | Landed | null =
      typeof journaled === "object" && journaled !== null && "ask" in journaled
        ? await this.#askDelay(identity, config, journaled.ask)
        : journaled;
    if (landed === null) {
      return await this.#refuse();
    }
    if (landed === "retry") {
      return await this.#attempts(identity, config, work, land);
    }
    land();
    await this.#renewWatchdog();
    if ("failed" in landed) {
      throw rebuild(landed.failed);
    }
    return await this.#result(landed.ordinal, landed.value);
  }

  /**
   * Suspends this activation: the run waits, with no activation, until
   * `wake`, the deadline of the wait it suspends on. Called in the
   * transaction that found the wait not due.
   */
  #suspendIn(sql: SqlStorage, now: number, wake: number): number {
    sql.exec(
      "UPDATE run SET status = 'waiting', lease_until = NULL, wake_at = ?",
      wake
    );
    sql.exec(
      "UPDATE activations SET ended_at = ?, ended = 'suspended' WHERE generation = ?",
      now,
      this.#generation
    );
    return wake;
  }

  /**
   * Brings the wait `plan` describes to its outcome if it's due, or
   * suspends the activation on it: one transaction. The deadline is
   * journaled the first time the wait is reached and read back after; an
   * event is taken, if one is there to take, in the same write as the
   * outcome, so no event is taken twice and no wait takes two.
   */
  #resolveWait(identity: StepIdentity, plan: WaitPlan): WaitOutcome {
    return this.#storage.transactionSync((): WaitOutcome => {
      if (!this.#current()) {
        return null;
      }
      const { sql } = this.#storage;
      const now = Date.now();
      let step = readStep(sql, identity);
      // Checked before anything is written: a replay that strayed leaves
      // the journal as it found it.
      const mismatch = mismatchIn(sql, identity, step, plan);
      if (mismatch !== undefined) {
        return { mismatch };
      }
      if (step === undefined) {
        sql.exec(
          "INSERT INTO steps (type, name, occurrence, idempotency_key, state, attempt, deadline, event_type, duration_ms) VALUES (?, ?, ?, ?, 'waiting', 1, ?, ?, ?)",
          identity.type,
          identity.name,
          identity.occurrence,
          stepKey(this.#run.run_uid, identity),
          plan.deadline(now),
          plan.eventType,
          plan.durationMs
        );
        step = readStep(sql, identity);
      }
      if (step === undefined || step.deadline === null) {
        throw new Error(`The journal lost the wait ${identity.name}`);
      }
      if (step.state === "succeeded") {
        return { ok: true, event: readConsumedEvent(sql, step.ordinal) };
      }
      if (step.state === "failed" && step.error !== null) {
        return { ok: false, error: step.error };
      }
      // An event accepted before the deadline is on time, however late the
      // activation that hands it over runs.
      const event =
        step.event_type === null
          ? undefined
          : readNextEvent(sql, step.event_type, step.deadline);
      if (event !== undefined) {
        sql.exec(
          "UPDATE events SET consumed_by = ? WHERE seq = ?",
          step.ordinal,
          event.seq
        );
        sql.exec(
          "UPDATE steps SET state = 'succeeded' WHERE ordinal = ?",
          step.ordinal
        );
        this.#renewLease(now);
        return { ok: true, event: { ...event, consumed_by: step.ordinal } };
      }
      if (now < step.deadline) {
        return { suspend: this.#suspendIn(sql, now, step.deadline) };
      }
      if (step.type === "sleep") {
        sql.exec(
          "UPDATE steps SET state = 'succeeded' WHERE ordinal = ?",
          step.ordinal
        );
        this.#renewLease(now);
        return { ok: true, event: undefined };
      }
      const error = JSON.stringify(
        errorRecord(waitTimedOut(step.duration_ms ?? 0))
      );
      sql.exec(
        "UPDATE steps SET state = 'failed', error = ? WHERE ordinal = ?",
        error,
        step.ordinal
      );
      this.#renewLease(now);
      return { ok: false, error };
    });
  }

  /** A sleep or an event wait, from the definition's call to its outcome. */
  async #wait(plan: WaitPlan): Promise<EventRow | undefined> {
    if (this.#waitPending || this.#stepsInFlight > 0) {
      // Racing a wait against a sleep would quietly lose the sleep: the
      // first suspends the activation, and the second is never reached. A
      // wait beside a step out at its effect would suspend under it, and
      // the effect would go out again on replay. Until parallel waits are
      // built, the run ends saying so.
      return await this.#halt(parallelWait(plan.type, plan.name));
    }
    this.#waitPending = true;
    let pending = true;
    // No longer pending once its outcome is journaled. Once.
    const land = (): void => {
      if (pending) {
        pending = false;
        this.#waitPending = false;
      }
    };
    try {
      return await this.#waitAlone(plan, land);
    } finally {
      // Never reached by a wait that suspended: its call never settles.
      land();
    }
  }

  async #waitAlone(
    plan: WaitPlan,
    land: () => void
  ): Promise<EventRow | undefined> {
    const current = this.#write(() => this.#current());
    if (current === failed) {
      return await never();
    }
    if (!current) {
      return await this.#refuse();
    }
    const identity = this.#occurrence(plan.type, plan.name);
    const outcome = this.#write(() => this.#resolveWait(identity, plan));
    if (outcome === failed) {
      return await never();
    }
    if (outcome === null) {
      return await this.#refuse();
    }
    if ("mismatch" in outcome) {
      return await this.#halt(replayMismatch(outcome.mismatch));
    }
    if ("suspend" in outcome) {
      this.#over = true;
      // The wake goes with the write that suspended the run.
      await this.#arm(outcome.suspend);
      this.#stop(suspended);
      return await never();
    }
    land();
    await this.#renewWatchdog();
    if (!outcome.ok) {
      throw rebuild(outcome.error);
    }
    return outcome.event;
  }

  async #sleep(name: string, duration: WorkflowDuration): Promise<void> {
    assertStepName(name);
    const ms = parseDuration(duration, "A sleep's duration");
    await this.#wait({
      type: "sleep",
      name,
      deadline: (now) => now + ms,
      eventType: null,
      durationMs: ms,
    });
  }

  async #sleepUntil(name: string, timestamp: Date | number): Promise<void> {
    assertStepName(name);
    const time = timeOf(timestamp);
    if (
      time === undefined ||
      !Number.isFinite(time) ||
      time - Date.now() > maxWaitMs
    ) {
      throw new TypeError(
        `sleepUntil takes a Date or a time in milliseconds, at most 365 days ahead: ${String(timestamp)}`
      );
    }
    const until = Math.ceil(time);
    await this.#wait({
      type: "sleep",
      name,
      // A time already past is due at once.
      deadline: () => until,
      eventType: null,
      durationMs: null,
    });
  }

  async #waitForEvent<Payload>(
    name: string,
    options: { type: string; timeout?: WorkflowDuration }
  ): Promise<WorkflowStepEvent<Payload>> {
    assertStepName(name);
    if (typeof options !== "object" || options === null) {
      throw new TypeError("waitForEvent takes a name and { type, timeout? }");
    }
    const eventType = assertEventType(options.type);
    // As Cloudflare's reference: any falsy timeout (0, "", null, none at
    // all) is the default.
    const timeoutGiven = Boolean(options.timeout);
    const timeoutMs = timeoutGiven
      ? parseDuration(options.timeout, "An event wait's timeout")
      : defaultEventTimeoutMs;
    const event = await this.#wait({
      type: "waitForEvent",
      name,
      deadline: (now) => now + timeoutMs,
      eventType,
      durationMs: timeoutMs,
    });
    if (event === undefined) {
      throw new Error(`The journal holds no event for the wait ${name}`);
    }
    return stepEvent<Payload>(event);
  }

  /** Runs the definition; resolves when it returns or throws. */
  async execute(definition: WorkflowDefinition): Promise<Settlement> {
    try {
      const event: WorkflowEvent = {
        payload: decode(this.#run.params),
        timestamp: new Date(this.#run.created_at),
        instanceId: this.#run.instance_id,
      };
      return { ok: true, output: await definition.run(event, this.step) };
    } catch (error) {
      return { ok: false, error };
    }
  }

  /**
   * Journals the run's end, unless a later activation took over. `halted`:
   * the activation stopped on a `Halt`, so it is over already, and only
   * the generation decides.
   */
  async settle(settlement: Settlement, halted = false): Promise<void> {
    let output: string | null = null;
    let failure: string | null = null;
    if (settlement.ok) {
      try {
        output = encode(settlement.output);
      } catch (error) {
        failure = JSON.stringify(errorRecord(error));
      }
    } else {
      failure = JSON.stringify(errorRecord(settlement.error));
    }
    const settled = this.#storage.transactionSync(() => {
      if (!(halted ? this.#holdsGeneration() : this.#current())) {
        return false;
      }
      const now = Date.now();
      this.#storage.sql.exec(
        "UPDATE run SET status = ?, output = ?, error = ?, ended_at = ?, lease_until = NULL, wake_at = NULL",
        failure === null ? "complete" : "errored",
        output,
        failure,
        now
      );
      this.#storage.sql.exec(
        "UPDATE activations SET ended_at = ?, ended = 'settled' WHERE generation = ?",
        now,
        this.#generation
      );
      return true;
    });
    if (!settled) {
      this.#endSuperseded();
      return;
    }
    this.#over = true;
    // In the same write as the outcome: nothing is left to wake for.
    await this.#storage.deleteAlarm();
  }
}
