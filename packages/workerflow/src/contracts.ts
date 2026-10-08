// The engine-level contracts: what a workflow definition is handed and what
// a caller sees of a run. Their shapes follow Cloudflare Workflows' Workers
// API (`run(event, step)`, `step.do`, an instance's `status()`), so the same
// definition runs on either engine. They are generic: a definition is an
// opaque name and version, a run knows nothing of who started it or why.
//
// This profile is partial. It has named `do` steps with retries and
// timeouts, sleeps and event waits, persisted and replayed; step results
// are structured values (codec.ts) or byte streams (streams.ts), and a
// step may be `sensitive`. Pause, terminate, restart, rollbacks and
// retention come in
// later slices; until then they are absent or refused, never silently
// ignored.

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
   * Which attempt at this step this is, from 1. A step runs again when an
   * attempt failed or timed out and its retries allow another, and when an
   * attempt was cut off before its outcome was journaled (the process
   * died, or the object was evicted or superseded). Every attempt has its
   * own number, and only the step's latest attempt can journal an outcome:
   * one that timed out, or was cut off, can't answer for the step. Every
   * attempt counts against the step's retries, a cut-off one too: one
   * found past its deadline timed out and waits its backoff, one cut off
   * before is retried at once.
   */
  readonly attempt: number;
  /**
   * The same for every attempt at this step occurrence, and different for
   * every other step and run. An attempt that timed out or was cut off may
   * still have had its effect, late: the next attempt goes out with the
   * same key, so a receiver that deduplicates by it applies it once. The
   * engine can't make an outside effect exactly-once on its own.
   */
  readonly idempotencyKey: string;
  /** The step's config, defaults filled in, as Cloudflare resolves it. */
  readonly config: {
    readonly retries: {
      readonly limit: number;
      /** As given; absent when the delay is a function. */
      readonly delay?: WorkflowDuration;
      readonly backoff: WorkflowBackoff;
    };
    readonly timeout: WorkflowDuration;
    /** Present when the step is sensitive. */
    readonly sensitive?: "output";
  };
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

/** How a step's retry delays grow: Cloudflare's three. */
export type WorkflowBackoff = "constant" | "linear" | "exponential";

/**
 * A retry delay said per failure: called once with the failed attempt's
 * context (no `delay` in its config) and error, and what it says is
 * journaled; it is never asked again for that attempt. It has 5 seconds.
 */
export type WorkflowDelayFunction = (input: {
  ctx: WorkflowStepContext;
  error: Error;
}) => WorkflowDuration | Promise<WorkflowDuration>;

/**
 * How a `do` step retries and times out; what is left out is Cloudflare's
 * default (config.ts). An attempt that runs past `timeout` fails with a
 * WorkflowTimeoutError, and its late answer is ignored.
 */
export interface WorkflowStepConfig {
  readonly retries?: {
    /** Retries after the first attempt. */
    readonly limit: number;
    readonly delay: WorkflowDuration | WorkflowDelayFunction;
    readonly backoff?: WorkflowBackoff;
  };
  /** Each attempt's; more than 0 and at most 14 minutes. */
  readonly timeout?: WorkflowDuration;
  /**
   * `"output"`: observers (the run's history) see `"[REDACTED]"` in place
   * of the step's result, and its errors' messages are redacted; the
   * journal keeps the result for the run's own replay and the host's
   * inspection.
   */
  readonly sensitive?: "output";
}

/** An event as a wait receives it. */
export interface WorkflowStepEvent<Payload = unknown> {
  readonly payload: Payload;
  /** When the run accepted the event: the same on every replay. */
  readonly timestamp: Date;
  readonly type: string;
}

export interface WorkflowStep {
  /**
   * Runs `callback` and journals what it returned, or what it threw once
   * its retries are spent, under `name`. Every later replay of the run
   * returns that value, or throws that error again, without calling
   * `callback`. A failed attempt is retried after a delay journaled as an
   * absolute time, with nothing of the run in memory meanwhile; a
   * NonRetryableError (errors.ts) is not retried. A `ReadableStream` of
   * bytes it returns is read to its end within the attempt and kept; the
   * step then returns, on every replay, a fresh stream of those bytes.
   */
  do: (<T>(
    name: string,
    callback: (context: WorkflowStepContext) => Promise<T> | T
  ) => Promise<T>) &
    (<T>(
      name: string,
      config: WorkflowStepConfig,
      callback: (context: WorkflowStepContext) => Promise<T> | T
    ) => Promise<T>);
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
   * none by the deadline, `timeout` after the wait was first reached (24
   * hours when it is missing or falsy, 0 included, as on Cloudflare). Each
   * replay returns the same event, or rejects the same way.
   *
   * Sleeps and waits run one at a time: racing one against another (say
   * `Promise.race([waitForEvent(…), sleep(…)])`) ends the run with a
   * WorkflowParallelWaitError until parallel waits are built.
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

/**
 * A run's error as it crosses the journal: name and message survive, and a
 * code when the error carried one in the safe shape (errors.ts).
 */
export interface WorkflowError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
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
