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
// Nothing of the run stays in memory between attempts.
//
// Waits come one at a time. A second sleep or wait reached while one is
// pending ends the run with a WorkflowParallelWaitError, and a replay that
// reaches a wait other than the one the journal holds (another event type
// or duration, or a new wait while the run's suspended one still waits)
// ends it with a WorkflowReplayMismatchError: a `Halt`, through the same
// typed outcome, never a loop of activations.
import { decode, encode } from "./codec.ts";
import { delayFunctionTimeoutMs, readCall, retryDelayMs } from "./config.ts";
import type { StepConfig, StepWork } from "./config.ts";
import type {
  WorkflowDefinition,
  WorkflowDelayFunction,
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
import { assertEventType, assertStepName, stepKey } from "./identity.ts";
import {
  readAttempt,
  readConsumedEvent,
  readNextEvent,
  readRun,
  readStep,
} from "./journal.ts";
import type { EventRow, RunRow, StepRow, StepType } from "./journal.ts";

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
 * strayed from what the journal holds, or it waited on two things at
 * once. The run ends with `halt` as its error; no handler of the author's
 * sees it, and replaying would only do the same again.
 */
export interface Halt {
  readonly halt: Error;
}

/** Why an activation stopped short of settling the run. */
export type Stop = typeof superseded | typeof suspended | Fault | Halt;

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

/** What comes next for a step, in this activation. */
type Next = { claim: Claim } | { park: number } | null;

/** What a callback did, before its timeout or after it. */
type Answer =
  | { ok: true; value: unknown }
  | { ok: false; error: unknown }
  | { timedOut: true };

/** How one attempt came out, as the journal keeps it. */
type AttemptOutcome =
  | { ok: true; value: string }
  | {
      ok: false;
      error: string;
      ended: "failed" | "timed_out";
      /** False for a NonRetryableError or a value it can't keep. */
      retryable: boolean;
    };

/** What an attempt's commit journals for its step. */
type StepOutcome =
  | { ok: true; value: string }
  | {
      ok: false;
      /** The attempt's own error. */
      error: string;
      ended: "failed" | "timed_out";
      /** The step's, when it is spent: a delay function's failure, say. */
      stepError: string;
      /** When the next attempt is due; null when there is none. */
      retryAt: number | null;
    };

/** How a step stands once an attempt's outcome is journaled. */
type Landed = { ok: true; value: string } | { ok: false; error: string };

/** A retry's delay, or why the step is spent instead. */
type Delay = { ms: number } | { error: string };

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
 * What `call` did, or its timeout after `ms`, whichever comes first. A
 * call that throws before it returns fails as one that rejects, and one
 * that answers after its timeout answers no one: its answer is a value,
 * so even a late rejection is never an unhandled one.
 */
const answerWithin = async (
  call: () => Promise<unknown>,
  ms: number
): Promise<Answer> => {
  const timer = new AbortController();
  try {
    return await Promise.race([answerOf(call), timeoutAfter(ms, timer.signal)]);
  } finally {
    timer.abort();
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
  readonly #leaseMs: number;
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
   * When each of this activation's parked steps is due: steps whose next
   * attempt comes later. They count among the steps in flight; once they
   * are all that is, the activation suspends.
   */
  readonly #parked: number[] = [];

  /** What the definition is handed as `step`. */
  readonly step: WorkflowStep;

  constructor(
    storage: DurableObjectStorage,
    run: RunRow,
    generation: number,
    leaseMs: number
  ) {
    this.#storage = storage;
    this.#run = run;
    this.#generation = generation;
    this.#leaseMs = leaseMs;
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
    this.#over = true;
    this.#stop({ halt: error });
    return await never();
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
      now + this.#leaseMs
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
    await this.#arm(Date.now() + this.#leaseMs);
  }

  /**
   * What comes next for a step, if this activation is current: its first
   * attempt, the next one (after one that was cut off, or a retry that is
   * due), or parking until its retry is due. The journal is read in the
   * same write that claims, so what was read is what the claim is for.
   */
  #nextAttempt(identity: StepIdentity, config: StepConfig): Next {
    return this.#storage.transactionSync((): Next => {
      if (!this.#current()) {
        return null;
      }
      const { sql } = this.#storage;
      const now = Date.now();
      const step = readStep(sql, identity);
      let claim: Claim;
      if (step === undefined) {
        const key = stepKey(this.#run.run_uid, identity);
        const { ordinal } = sql
          .exec<{ ordinal: number }>(
            "INSERT INTO steps (type, name, occurrence, idempotency_key, state, attempt, config) VALUES (?, ?, ?, ?, 'running', 1, ?) RETURNING ordinal",
            identity.type,
            identity.name,
            identity.occurrence,
            key,
            config.journal
          )
          .one();
        claim = { ordinal, attempt: 1, key, deadline: now + config.timeoutMs };
      } else {
        if (step.state === "retrying") {
          const retryAt = readAttempt(
            sql,
            step.ordinal,
            step.attempt
          )?.retry_at;
          if (typeof retryAt !== "number") {
            throw new TypeError(
              `The journal lost the retry of ${identity.name}`
            );
          }
          if (now < retryAt) {
            return { park: retryAt };
          }
        } else if (step.state !== "running") {
          throw new Error(
            `The journal holds the step ${identity.name} as ${step.state}, with no attempt left to make`
          );
        }
        // A retry that is due, or an attempt cut off before its outcome
        // was journaled: the next goes out under the same key.
        claim = {
          ordinal: step.ordinal,
          attempt: step.attempt + 1,
          key: step.idempotency_key,
          deadline: now + config.timeoutMs,
        };
        sql.exec(
          "UPDATE steps SET attempt = ?, state = 'running' WHERE ordinal = ?",
          claim.attempt,
          claim.ordinal
        );
      }
      sql.exec(
        "INSERT INTO attempts (ordinal, attempt, generation, started_at, deadline) VALUES (?, ?, ?, ?, ?)",
        claim.ordinal,
        claim.attempt,
        this.#generation,
        now,
        claim.deadline
      );
      this.#renewLease(now);
      return { claim };
    });
  }

  /**
   * Journals the attempt's outcome if this activation is current and the
   * attempt is still the step's latest and not ended; otherwise records
   * that its answer was ignored. A failure with a retry left journals the
   * retry's time with it, and the step as `retrying`.
   */
  #commit(claim: Claim, outcome: StepOutcome): boolean {
    return this.#storage.transactionSync(() => {
      const { sql } = this.#storage;
      const now = Date.now();
      const latest = sql
        .exec<{ attempt: number }>(
          "SELECT attempt FROM steps WHERE ordinal = ?",
          claim.ordinal
        )
        .one();
      const attempt = readAttempt(sql, claim.ordinal, claim.attempt);
      if (
        !this.#current() ||
        latest.attempt !== claim.attempt ||
        attempt?.ended_at !== null
      ) {
        sql.exec(
          "UPDATE attempts SET ended_at = ?, ended = 'superseded' WHERE ordinal = ? AND attempt = ? AND ended_at IS NULL",
          now,
          claim.ordinal,
          claim.attempt
        );
        return false;
      }
      if (outcome.ok) {
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
      } else {
        const retrying = outcome.retryAt !== null;
        sql.exec(
          "UPDATE steps SET state = ?, value = NULL, error = ? WHERE ordinal = ?",
          retrying ? "retrying" : "failed",
          retrying ? null : outcome.stepError,
          claim.ordinal
        );
        sql.exec(
          "UPDATE attempts SET ended_at = ?, ended = ?, error = ?, retry_at = ? WHERE ordinal = ? AND attempt = ?",
          now,
          outcome.ended,
          outcome.error,
          outcome.retryAt,
          claim.ordinal,
          claim.attempt
        );
      }
      this.#renewLease(now);
      return true;
    });
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
    // stopped), but nothing it answers is looked at again.
    const context = contextOf(identity, claim, config);
    const answer = await answerWithin(
      async () => await work(context),
      claim.deadline - Date.now()
    );
    if ("timedOut" in answer) {
      return {
        ok: false,
        error: JSON.stringify(errorRecord(waitTimedOut(config.timeoutMs))),
        ended: "timed_out",
        retryable: true,
      };
    }
    if (answer.ok) {
      try {
        return { ok: true, value: encode(answer.value) };
      } catch (error) {
        // A value the journal can't keep fails the step, as a throw
        // would; the same callback would only return it again.
        return {
          ok: false,
          error: JSON.stringify(errorRecord(error)),
          ended: "failed",
          retryable: false,
        };
      }
    }
    const record = errorRecord(answer.error);
    return {
      ok: false,
      error: JSON.stringify(record),
      ended: "failed",
      retryable: !isNonRetryable(record),
    };
  }

  /**
   * What a dynamic delay function says, once, for the attempt that failed
   * with `error`. It is the author's code, so it runs only while this
   * activation is current, and has `delayFunctionTimeoutMs`. One that
   * throws, takes too long or says something that isn't a delay spends the
   * step, as Cloudflare's NonRetryableDelayError.
   */
  async #dynamicDelay(
    identity: StepIdentity,
    config: StepConfig,
    claim: Claim,
    delay: WorkflowDelayFunction,
    error: string
  ): Promise<Delay> {
    const current = this.#write(() => this.#current());
    if (current === failed) {
      return await never();
    }
    if (!current) {
      return await this.#refuse();
    }
    const ctx = contextOf(identity, claim, config);
    const answer = await answerWithin(
      async () => await delay({ ctx, error: rebuild(error) }),
      delayFunctionTimeoutMs
    );
    let reason: string;
    if ("timedOut" in answer) {
      reason = `did not return within ${delayFunctionTimeoutMs / 1000} seconds`;
    } else if (answer.ok) {
      try {
        const base = parseDuration(answer.value, "A retry delay");
        return { ms: retryDelayMs(config.backoff, base, claim.attempt) };
      } catch {
        reason =
          'returned an invalid delay value (expected a number of ms or a duration string like "30 seconds")';
      }
    } else {
      reason = `threw an error: ${errorRecord(answer.error).message}`;
    }
    return {
      error: JSON.stringify(
        errorRecord(
          namedError(
            "NonRetryableDelayError",
            `The delay function for step "${identity.name}-${identity.occurrence}" ${reason}`
          )
        )
      ),
    };
  }

  /**
   * Journals how the attempt came out: a value, a failure that spends the
   * step, or a failure with a retry left, with the retry's absolute time.
   * `retry` when the step goes on to another attempt.
   */
  async #conclude(
    identity: StepIdentity,
    config: StepConfig,
    claim: Claim,
    outcome: AttemptOutcome
  ): Promise<Landed | "retry"> {
    let committing: StepOutcome;
    if (outcome.ok) {
      committing = outcome;
    } else {
      let stepError = outcome.error;
      let retryAt: number | null = null;
      if (outcome.retryable && claim.attempt <= config.limit) {
        const delay =
          typeof config.delay === "function"
            ? await this.#dynamicDelay(
                identity,
                config,
                claim,
                config.delay,
                outcome.error
              )
            : {
                ms: retryDelayMs(config.backoff, config.delay, claim.attempt),
              };
        if ("ms" in delay) {
          retryAt = Date.now() + delay.ms;
        } else {
          stepError = delay.error;
        }
      }
      committing = { ...outcome, stepError, retryAt };
    }
    const committed = this.#write(() => this.#commit(claim, committing));
    if (committed === failed) {
      return await never();
    }
    if (!committed) {
      return await this.#refuse();
    }
    if (committing.ok) {
      return committing;
    }
    return committing.retryAt === null
      ? { ok: false, error: committing.stepError }
      : "retry";
  }

  /** The next occurrence of `name` among steps of `type`, from 1. */
  #occurrence(type: StepType, name: string): StepIdentity {
    const counter = JSON.stringify([type, name]);
    const occurrence = (this.#occurrences.get(counter) ?? 0) + 1;
    this.#occurrences.set(counter, occurrence);
    return { type, name, occurrence };
  }

  /**
   * Parks a step until its retry is due: its call doesn't settle in this
   * activation. The activation suspends once every step still out is
   * parked, so no step out at its effect is cut off by the suspension.
   */
  async #park(retryAt: number): Promise<never> {
    this.#parked.push(retryAt);
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
      this.#parked.length > 0 &&
      !this.#waitPending &&
      this.#stepsInFlight === this.#parked.length;
    if (!quiet) {
      return;
    }
    const wake = Math.min(...this.#parked);
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
      // What this step's work returned, through the codec, as the attempt
      // that journaled it returned it.
      return decode(journaled.value);
    }
    if (journaled?.state === "failed" && journaled.error !== null) {
      land();
      throw rebuild(journaled.error);
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
    const outcome = await this.#runAttempt(identity, config, next.claim, work);
    const landed = await this.#conclude(identity, config, next.claim, outcome);
    if (landed === "retry") {
      return await this.#attempts(identity, config, work, land);
    }
    land();
    await this.#renewWatchdog();
    if (!landed.ok) {
      throw rebuild(landed.error);
    }
    return decode(landed.value);
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
