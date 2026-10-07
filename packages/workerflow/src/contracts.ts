// The engine-level contracts: what a workflow definition is handed and what
// a caller sees of a run. Their shapes follow Cloudflare Workflows' Workers
// API (`run(event, step)`, `step.do`, an instance's `status()`), so the same
// definition runs on either engine. They are generic: a definition is an
// opaque name and version, a run knows nothing of who started it or why.
//
// This profile is partial. It has named `do` steps, sleeps and event waits,
// persisted and replayed. Retries, step configuration (and with it the step
// context's resolved `config`), step timeouts, pause, terminate, restart,
// rollbacks and retention come in later slices; until then they are absent
// or refused, never silently ignored.

/** What a run's definition is given when it runs. */
export interface WorkflowEvent<Params = unknown> {
  /** The params the run was created with, decoded afresh each activation. */
  readonly payload: Params;
  /** When the run was created: the same on every replay. */
  readonly timestamp: Date;
  readonly instanceId: string;
}

/** What a step's callback is given. */
export interface WorkflowStepContext {
  readonly step: {
    readonly name: string;
    /**
     * Which call of this name it is in the run, from 1: a definition that
     * calls `do("send", …)` twice has occurrences 1 and 2.
     */
    readonly count: number;
  };
  /**
   * Which attempt at this step this is, from 1. A step only runs again when
   * an earlier attempt was cut off before its outcome was journaled: the
   * process died, or the object was evicted or superseded.
   */
  readonly attempt: number;
  /**
   * The same for every attempt at this step occurrence, and different for
   * every other step and run. An effect whose attempt was cut off after it
   * left, but before the step was journaled, goes out again with the same
   * key, so a receiver that deduplicates by it applies it once. The engine
   * can't make an outside effect exactly-once on its own.
   */
  readonly idempotencyKey: string;
}

export type WorkflowDurationLabel =
  | "second"
  | "minute"
  | "hour"
  | "day"
  | "week"
  | "month"
  | "year";

/** Milliseconds, or a string such as "10 seconds" (durations.ts). */
export type WorkflowDuration =
  | number
  | `${number} ${WorkflowDurationLabel}${"s" | ""}`;

/** An event as a wait receives it. */
export interface WorkflowStepEvent<Payload = unknown> {
  readonly payload: Payload;
  /** When the run accepted the event: the same on every replay. */
  readonly timestamp: Date;
  readonly type: string;
}

export interface WorkflowStep {
  /**
   * Runs `callback` once and journals what it returned or threw under
   * `name`. Every later replay of the run returns that value, or throws
   * that error again, without calling `callback`.
   */
  do: <T>(
    name: string,
    callback: (context: WorkflowStepContext) => Promise<T> | T
  ) => Promise<T>;
  /**
   * Resolves once `duration` has passed since this sleep was first
   * reached. The deadline is journaled then: no replay, restart or
   * eviction moves it. Nothing of the run stays in memory meanwhile.
   */
  sleep: (name: string, duration: WorkflowDuration) => Promise<void>;
  /** As `sleep`, to a point in time; one already past resolves at once. */
  sleepUntil: (name: string, timestamp: Date | number) => Promise<void>;
  /**
   * Resolves with the oldest event of `type` the run accepted before the
   * wait's deadline (sent before the wait was reached, too) and not taken
   * by another wait. Rejects with a WorkflowTimeoutError when there was
   * none by the deadline, `timeout` (24 hours by default) after the wait
   * was first reached. Each replay returns the same event, or rejects the
   * same way.
   */
  waitForEvent: <Payload = unknown>(
    name: string,
    options: { type: string; timeout?: WorkflowDuration }
  ) => Promise<WorkflowStepEvent<Payload>>;
}

/** A workflow: what the host resolves a run's definition to. */
export interface WorkflowDefinition<Params = unknown> {
  run: (event: WorkflowEvent<Params>, step: WorkflowStep) => Promise<unknown>;
}

/** Which definition a run executes; both opaque to the engine. */
export interface DefinitionIdentity {
  readonly definition: string;
  readonly version: string | undefined;
}

/** A run's error as it crosses the journal: name and message survive. */
export interface WorkflowError {
  readonly name: string;
  readonly message: string;
}

export type InstanceStatus =
  /** Created; no activation has started yet. */
  | { readonly status: "queued" }
  /** An activation runs it, or one will after a crash or an eviction. */
  | { readonly status: "running" }
  /** Asleep or waiting for an event, with no activation alive. */
  | { readonly status: "waiting" }
  | { readonly status: "complete"; readonly output: unknown }
  | { readonly status: "errored"; readonly error: WorkflowError };
