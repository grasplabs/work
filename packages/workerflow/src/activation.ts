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
// Waits come one at a time. A second sleep or wait reached while one is
// pending ends the run with a WorkflowParallelWaitError, and a replay that
// reaches a wait other than the one the journal holds (another event type
// or duration, or a new wait while the run's suspended one still waits)
// ends it with a WorkflowReplayMismatchError: a `Halt`, through the same
// typed outcome, never a loop of activations.
import { decode, encode } from "./codec.ts";
import type {
  WorkflowDefinition,
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
import { errorRecord, namedError, rebuild } from "./errors.ts";
import { assertEventType, assertStepName, stepKey } from "./identity.ts";
import {
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

type StepWork<T> = (context: WorkflowStepContext) => Promise<T> | T;

interface StepIdentity {
  type: StepType;
  name: string;
  occurrence: number;
}

interface Claim {
  ordinal: number;
  attempt: number;
  key: string;
}

type StepOutcome = { ok: true; value: string } | { ok: false; error: string };

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
    }>("SELECT type, name FROM steps WHERE state = 'waiting' LIMIT 1")
    .toArray();
  if (other !== undefined) {
    return `it reached ${named} while the ${other.type} ${JSON.stringify(other.name)} it suspended on is still waiting`;
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
    this.step = {
      do: async <T>(
        name: string,
        work: StepWork<T>,
        ...rest: unknown[]
      ): Promise<T> => await this.#do(name, work, rest),
      sleep: async (
        name: string,
        duration: WorkflowDuration
      ): Promise<void> => {
        await this.#sleep(name, duration);
      },
      sleepUntil: async (
        name: string,
        timestamp: Date | number
      ): Promise<void> => {
        await this.#sleepUntil(name, timestamp);
      },
      waitForEvent: async <Payload>(
        name: string,
        options: { type: string; timeout?: WorkflowDuration }
      ): Promise<WorkflowStepEvent<Payload>> =>
        await this.#waitForEvent<Payload>(name, options),
    };
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

  /** Moves the watchdog alarm to a lease from now. */
  async #renewWatchdog(): Promise<void> {
    await this.#arm(Date.now() + this.#leaseMs);
  }

  /** Journals a new attempt at the step, if this activation is current. */
  #claim(step: StepIdentity, journaled: StepRow | undefined): Claim | null {
    return this.#storage.transactionSync(() => {
      if (!this.#current()) {
        return null;
      }
      const { sql } = this.#storage;
      const now = Date.now();
      let claim: Claim;
      if (journaled === undefined) {
        const key = stepKey(this.#run.run_uid, step);
        const { ordinal } = sql
          .exec<{ ordinal: number }>(
            "INSERT INTO steps (type, name, occurrence, idempotency_key, state, attempt) VALUES (?, ?, ?, ?, 'running', 1) RETURNING ordinal",
            step.type,
            step.name,
            step.occurrence,
            key
          )
          .one();
        claim = { ordinal, attempt: 1, key };
      } else {
        // An earlier attempt was cut off before its outcome was journaled:
        // this one goes out again under the same key.
        claim = {
          ordinal: journaled.ordinal,
          attempt: journaled.attempt + 1,
          key: journaled.idempotency_key,
        };
        sql.exec(
          "UPDATE steps SET attempt = ?, state = 'running' WHERE ordinal = ?",
          claim.attempt,
          claim.ordinal
        );
      }
      sql.exec(
        "INSERT INTO attempts (ordinal, attempt, generation, started_at) VALUES (?, ?, ?, ?)",
        claim.ordinal,
        claim.attempt,
        this.#generation,
        now
      );
      this.#renewLease(now);
      return claim;
    });
  }

  /**
   * Journals the attempt's outcome if this activation is current and the
   * attempt is still the step's latest; otherwise records that its answer
   * was ignored.
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
      if (!this.#current() || latest.attempt !== claim.attempt) {
        sql.exec(
          "UPDATE attempts SET ended_at = ?, ended = 'superseded' WHERE ordinal = ? AND attempt = ? AND ended_at IS NULL",
          now,
          claim.ordinal,
          claim.attempt
        );
        return false;
      }
      sql.exec(
        "UPDATE steps SET state = ?, value = ?, error = ? WHERE ordinal = ?",
        outcome.ok ? "succeeded" : "failed",
        outcome.ok ? outcome.value : null,
        outcome.ok ? null : outcome.error,
        claim.ordinal
      );
      sql.exec(
        "UPDATE attempts SET ended_at = ?, ended = ? WHERE ordinal = ? AND attempt = ?",
        now,
        outcome.ok ? "succeeded" : "failed",
        claim.ordinal,
        claim.attempt
      );
      this.#renewLease(now);
      return true;
    });
  }

  /** Runs the step's work once, journaling what it returned or threw. */
  async #attempt<T>(
    identity: StepIdentity,
    journaled: StepRow | undefined,
    work: StepWork<T>
  ): Promise<T> {
    const claim = this.#write(() => this.#claim(identity, journaled));
    if (claim === failed) {
      return await never();
    }
    if (claim === null) {
      return await this.#refuse();
    }
    await this.#renewWatchdog();
    let outcome: StepOutcome;
    try {
      const value = await work({
        step: { name: identity.name, count: identity.occurrence },
        attempt: claim.attempt,
        idempotencyKey: claim.key,
      });
      // A value the journal can't keep fails the step, as a throw would.
      outcome = { ok: true, value: encode(value) };
    } catch (error) {
      outcome = { ok: false, error: JSON.stringify(errorRecord(error)) };
    }
    const committed = this.#write(() => this.#commit(claim, outcome));
    if (committed === failed) {
      return await never();
    }
    if (!committed) {
      return await this.#refuse();
    }
    await this.#renewWatchdog();
    if (!outcome.ok) {
      throw rebuild(outcome.error);
    }
    // SAFETY: the work's own value through the codec, which is what every
    // replay of this step returns too.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return decode(outcome.value) as T;
  }

  /** The next occurrence of `name` among steps of `type`, from 1. */
  #occurrence(type: StepType, name: string): StepIdentity {
    const counter = JSON.stringify([type, name]);
    const occurrence = (this.#occurrences.get(counter) ?? 0) + 1;
    this.#occurrences.set(counter, occurrence);
    return { type, name, occurrence };
  }

  async #do<T>(name: string, work: StepWork<T>, rest: unknown[]): Promise<T> {
    const current = this.#write(() => this.#current());
    if (current === failed) {
      return await never();
    }
    if (!current) {
      return await this.#refuse();
    }
    assertStepName(name);
    if (typeof work !== "function" || rest.length > 0) {
      // A configured step (`do(name, config, callback)`) would retry and
      // time out; until retries are built it is refused, not run without.
      throw new TypeError(
        "step.do takes a name and a callback; configured steps aren't supported yet"
      );
    }
    const identity = this.#occurrence("do", name);
    const journaled = this.#write(() => readStep(this.#storage.sql, identity));
    if (journaled === failed) {
      return await never();
    }
    if (journaled?.state === "succeeded" && journaled.value !== null) {
      // SAFETY: what this step's work returned, through the codec, as the
      // attempt that journaled it returned it.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return decode(journaled.value) as T;
    }
    if (journaled?.state === "failed" && journaled.error !== null) {
      throw rebuild(journaled.error);
    }
    return await this.#attempt(identity, journaled, work);
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
    if (this.#waitPending) {
      // Racing a wait against a sleep would quietly lose the sleep: the
      // first suspends the activation, and the second is never reached.
      // Until parallel waits are built, the run ends saying so.
      return await this.#halt(
        namedError(
          "WorkflowParallelWaitError",
          `The ${plan.type} ${JSON.stringify(plan.name)} was reached while another sleep or wait of the run was pending; parallel waits aren't supported yet`
        )
      );
    }
    this.#waitPending = true;
    try {
      return await this.#waitAlone(plan);
    } finally {
      // Never reached by a wait that suspended: its call never settles.
      this.#waitPending = false;
    }
  }

  async #waitAlone(plan: WaitPlan): Promise<EventRow | undefined> {
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
