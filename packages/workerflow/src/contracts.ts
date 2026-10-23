// The engine-level contracts: what a workflow definition is handed and what
// a caller sees of a run. Their shapes follow Cloudflare Workflows' Workers
// API (`run(event, step)`, `step.do`, an instance's `status()`), so the same
// definition runs on either engine. They are generic: a definition is an
// opaque name and version, a run knows nothing of who started it or why.
//
// This profile is partial. It has named `do` steps with retries and
// timeouts, sleeps and event waits, persisted and replayed; step results
// are structured values (codec.ts) or byte streams (streams.ts), and a
// step may be `sensitive`, and may register a rollback. An instance can be
// paused, resumed, terminated (rolling back, too), restarted (from a step,
// too) and deleted (instance.ts); created and deleted in batches, and
// started by a schedule's occurrence (binding.ts); an ended run is kept
// for its retention, then purged (retention.ts).

/** What a run's definition is given when it runs. */
export interface WorkflowEvent<Params = unknown> {
  /** The params the run was created with, decoded afresh each activation. */
  readonly payload: Params;
  /** When the run was created: the same on every replay. */
  readonly timestamp: Date;
  readonly instanceId: string;
  /** The definition's name: the workflow the run is of. */
  readonly workflowName: string;
  /**
   * For a run a schedule started (the binding's `schedule`): the cron
   * expression and the time it fired for. Absent otherwise.
   */
  readonly schedule?: {
    readonly cron: string;
    /** Milliseconds since the Unix epoch. */
    readonly scheduledTime: number;
  };
}

/**
 * What a step's callback is given. `Delay` is the kind of retry delay the
 * step was configured with, as on Cloudflare (`do`'s overloads pick it from
 * the config): a static delay's context has its delay, a delay function's
 * has none. `idempotencyKey` is Workerflow's, beside Cloudflare's fields.
 */
export interface WorkflowStepContext<
  Delay extends WorkflowDuration | WorkflowDelayFunction = WorkflowDuration,
> {
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
    readonly retries: WorkflowContextRetries<Delay>;
    readonly timeout: WorkflowDuration;
    /** Present when the step is sensitive. */
    readonly sensitive?: "output";
  };
}

/**
 * A step's retries as its context tells them: the delay as given when it
 * is static, and none when it is a function.
 */
export type WorkflowContextRetries<
  Delay extends WorkflowDuration | WorkflowDelayFunction,
> = {
  readonly limit: number;
  readonly backoff: WorkflowBackoff;
} & (Delay extends WorkflowDelayFunction
  ? unknown
  : { readonly delay: WorkflowDuration });

/**
 * The context the engine itself hands out, of either delay kind: a step's
 * config is known only when it runs.
 */
export type AnyWorkflowStepContext = WorkflowStepContext<
  WorkflowDuration | WorkflowDelayFunction
>;

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
  ctx: WorkflowStepContext<WorkflowDelayFunction>;
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

/** A config whose retry delay is a function: its context has no delay. */
type WorkflowStepConfigWithDelayFunction = Omit<
  WorkflowStepConfig,
  "retries"
> & {
  readonly retries: {
    readonly limit: number;
    readonly delay: WorkflowDelayFunction;
    readonly backoff?: WorkflowBackoff;
  };
};

/** A config whose retry delay is static, or left out: its context has it. */
type WorkflowStepConfigWithStaticDelay = Omit<WorkflowStepConfig, "retries"> & {
  readonly retries?: {
    readonly limit: number;
    readonly delay: WorkflowDuration;
    readonly backoff?: WorkflowBackoff;
  };
};

/**
 * What a step's rollback is given, as Cloudflare gives it, and the key
 * and attempt of the rollback itself.
 */
export interface WorkflowRollbackContext<
  Output = unknown,
  Delay extends WorkflowDuration | WorkflowDelayFunction = WorkflowDuration,
> {
  /** The step's own context, as its latest attempt was given it. */
  readonly ctx: WorkflowStepContext<Delay>;
  /**
   * Why the run rolls back: the error that ended it, or, for a
   * `terminate({ rollback: true })`, an error named `Terminated`.
   */
  readonly error: Error;
  /** What the step returned; undefined if it failed or never answered. */
  readonly output: Output | undefined;
  /** @deprecated As Cloudflare's: `${name}-${count}`; use `ctx.step`. */
  readonly stepName: string;
  /**
   * The rollback's own key: the same for each of its attempts, and never
   * the step's (`ctx.idempotencyKey`), so a receiver tells undoing an
   * effect apart from doing it again.
   */
  readonly idempotencyKey: string;
  /** Which attempt at the rollback this is, from 1. */
  readonly attempt: number;
}

/** The rollback context the engine itself hands out, of either delay kind. */
export type AnyWorkflowRollbackContext<Output = unknown> =
  WorkflowRollbackContext<Output, WorkflowDuration | WorkflowDelayFunction>;

/**
 * A step's rollback: run, should the run roll back, after the rollbacks of
 * every step started after it. `rollbackConfig` takes `retries` and
 * `timeout`, with a step's defaults.
 */
export interface WorkflowStepRollbackOptions<
  Output = unknown,
  Delay extends WorkflowDuration | WorkflowDelayFunction = WorkflowDuration,
> {
  readonly rollback: (
    context: WorkflowRollbackContext<Output, Delay>
  ) => Promise<void> | void;
  readonly rollbackConfig?: Pick<WorkflowStepConfig, "retries" | "timeout">;
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
   *
   * A step started with a rollback is rolled back when the run is: when
   * its definition throws, or it is terminated with `rollback: true`.
   * Rollbacks run in the reverse order their steps started in, each with
   * its own retries, journaled; the first that fails ends the rolling
   * back, and the run's status says so beside its own error.
   *
   * As on Cloudflare, the config's overloads pick the context's type by
   * its retry delay: a function's context has no delay. The broad config
   * stays last, or it would shadow them; its delay could be either kind,
   * so its context may lack the delay, where Cloudflare's promises it.
   */
  do: (<T>(
    name: string,
    callback: (context: WorkflowStepContext) => Promise<T> | T,
    rollback?: WorkflowStepRollbackOptions<T>
  ) => Promise<T>) &
    (<T>(
      name: string,
      config: WorkflowStepConfigWithDelayFunction,
      callback: (
        context: WorkflowStepContext<WorkflowDelayFunction>
      ) => Promise<T> | T,
      rollback?: WorkflowStepRollbackOptions<T, WorkflowDelayFunction>
    ) => Promise<T>) &
    (<T>(
      name: string,
      config: WorkflowStepConfigWithStaticDelay,
      callback: (context: WorkflowStepContext) => Promise<T> | T,
      rollback?: WorkflowStepRollbackOptions<T>
    ) => Promise<T>) &
    (<T>(
      name: string,
      config: WorkflowStepConfig,
      callback: (context: AnyWorkflowStepContext) => Promise<T> | T,
      rollback?: WorkflowStepRollbackOptions<
        T,
        WorkflowDuration | WorkflowDelayFunction
      >
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
   * Sleeps and waits run one at a time, and never beside a step, until
   * parallel waits are built. The run ends with a
   * WorkflowParallelWaitError when a definition reaches:
   *
   * - a sleep or a wait while another is pending (say
   *   `Promise.race([waitForEvent(…), sleep(…)])`);
   * - a sleep or a wait while a `do` step is out, whether at its effect or
   *   waiting for its retry, a sleep or a wait called from inside a step's
   *   callback included, as that step is out;
   * - a `do` step while a sleep or a wait is pending.
   *
   * `do` steps may run side by side, and a step's callback may call `do`
   * itself while its attempt is out; a call from a callback whose attempt
   * has ended (it timed out and went on) is never answered.
   */
  waitForEvent: <Payload = unknown>(
    name: string,
    options: { type: string; timeout?: WorkflowDuration }
  ) => Promise<WorkflowStepEvent<Payload>>;
  /**
   * As `waitForEvent`, for the oldest event matching any of `match`, until
   * the absolute time `until` (in ms since the epoch, or a Date, at most
   * 365 days ahead): Workerflow's own, beyond Cloudflare's. An event
   * matches an entry when its type is the entry's and it was sent with
   * every one of the entry's attributes, each with exactly that value
   * (`deliverEvent`'s `attributes`); it may carry others. A deadline
   * already past takes an event already there, or times out at once.
   * Each replay returns the same event, or rejects the same way, and must
   * give the same `match`; `until` may be computed afresh, as
   * `sleepUntil`'s may: the deadline journaled when the wait was first
   * reached decides.
   */
  waitForMatch: <Payload = unknown>(
    name: string,
    options: { match: readonly EventMatch[]; until: Date | number }
  ) => Promise<WorkflowStepEvent<Payload>>;
}

/**
 * One of the events a `waitForMatch` takes: its type, and the attributes
 * (CloudEvents' rule for names: 1 to 20 lowercase letters and digits) it
 * must have been sent with, each with exactly that value.
 */
export interface EventMatch {
  readonly type: string;
  readonly attributes?: Readonly<Record<string, string>>;
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

/** How a run's rolling back ended. */
export type RollbackOutcome =
  | { readonly status: "complete" }
  | { readonly status: "errored"; readonly error: WorkflowError };

export type InstanceStatus =
  /** Created; no activation has started yet. */
  | { readonly status: "queued" }
  /** An activation runs it, or one will after a crash or an eviction. */
  | { readonly status: "running" }
  /**
   * Asleep, waiting for an event, or waiting for a step's retry (or for a
   * fresh activation to run an attempt), with no activation alive.
   */
  | { readonly status: "waiting" }
  /**
   * Asked to pause while an activation ran: it finishes the steps it has
   * out, and starts nothing new.
   */
  | { readonly status: "waitingForPause" }
  /** Paused: nothing runs, and no deadline of its comes due, until resumed. */
  | { readonly status: "paused" }
  /**
   * Running its steps' rollbacks: its definition threw, or it was
   * terminated with `rollback: true`. It ends errored or terminated.
   */
  | { readonly status: "rollingBack" }
  | { readonly status: "complete"; readonly output: unknown }
  | {
      readonly status: "errored";
      readonly error: WorkflowError;
      /** Present when the run rolled back: how that went, apart. */
      readonly rollback?: RollbackOutcome;
    }
  /** Ended by `terminate`. */
  | { readonly status: "terminated"; readonly rollback?: RollbackOutcome };

/** Where `restart` starts the run again from: a step it has started. */
export interface RestartFrom {
  readonly name: string;
  /** Which occurrence of the name, from 1; 1 when left out. */
  readonly count?: number;
  /** The step's type, when names are shared across types; `do` when left out. */
  readonly type?: "do" | "sleep" | "waitForEvent";
}

/** A step's config as observers are told it: its values in milliseconds. */
export interface WorkflowStepEventConfig {
  readonly retries: {
    readonly limit: number;
    /** `"[dynamic]"` when a function says the delay per failure. */
    readonly delay: WorkflowDuration | "[dynamic]";
    readonly backoff?: WorkflowBackoff;
  };
  readonly timeout: WorkflowDuration;
  readonly sensitive?: "output";
}

/** An error as observers see it. */
export interface WorkflowEventError {
  readonly name: string;
  readonly message: string;
}

/**
 * What a subscription delivers, in the reference's shape: each event of
 * the run, numbered from 1 in the order it happened (`eventId`, the
 * cursor's unit), with when (`timestamp`, ms since the epoch). A step is
 * named `${name}-${count}`, as the reference names it to observers. A
 * sensitive step's `output` is `"[REDACTED]"`; a stream result's is a
 * fresh stream of its bytes.
 */
export type WorkflowInstanceEvent = {
  readonly instanceId: string;
  readonly eventId: number;
  readonly timestamp: number;
} & (
  | { readonly type: "workflow_queued" }
  | { readonly type: "workflow_started"; readonly params?: unknown }
  | { readonly type: "workflow_running" }
  | { readonly type: "workflow_paused" }
  | { readonly type: "workflow_waiting_for_pause" }
  | { readonly type: "workflow_waiting" }
  | { readonly type: "workflow_completed"; readonly output?: unknown }
  | { readonly type: "workflow_errored"; readonly error: WorkflowEventError }
  | { readonly type: "workflow_terminated" }
  | {
      readonly type: "step_started";
      readonly stepName: string;
      readonly config?: WorkflowStepEventConfig;
    }
  | {
      readonly type: "step_completed";
      readonly stepName: string;
      readonly output?: unknown;
    }
  | { readonly type: "step_errored"; readonly stepName: string }
  | {
      readonly type: "attempt_started";
      readonly stepName: string;
      readonly attempt: number;
    }
  | {
      readonly type: "attempt_completed";
      readonly stepName: string;
      readonly attempt: number;
    }
  | {
      readonly type: "attempt_errored";
      readonly stepName: string;
      readonly attempt: number;
      readonly retryDelayMs?: number;
      readonly error: WorkflowEventError;
    }
  | {
      readonly type: "sleep_started";
      readonly stepName: string;
      readonly durationMs: number;
    }
  | { readonly type: "sleep_completed"; readonly stepName: string }
  | {
      readonly type: "wait_started";
      readonly stepName: string;
      readonly eventType: string;
    }
  | { readonly type: "wait_completed"; readonly stepName: string }
  | { readonly type: "wait_timed_out"; readonly stepName: string }
  | { readonly type: "rollback_started" }
  | {
      readonly type: "rollback_step_started";
      readonly stepName: string;
      readonly config?: WorkflowStepEventConfig;
    }
  | { readonly type: "rollback_step_completed"; readonly stepName: string }
  | {
      readonly type: "rollback_step_errored";
      readonly stepName: string;
      readonly error: WorkflowEventError;
    }
  | {
      readonly type: "rollback_attempt_started";
      readonly stepName: string;
      readonly attempt: number;
    }
  | {
      readonly type: "rollback_attempt_completed";
      readonly stepName: string;
      readonly attempt: number;
    }
  | {
      readonly type: "rollback_attempt_errored";
      readonly stepName: string;
      readonly attempt: number;
      readonly retryDelayMs?: number;
      readonly error: WorkflowEventError;
    }
  | { readonly type: "rollback_completed" }
  | { readonly type: "rollback_errored" }
);

export type WorkflowInstanceEventType = WorkflowInstanceEvent["type"];

/** What `subscribe` takes, as the reference does. */
export interface WorkflowInstanceSubscribeOptions {
  /** The last event already seen: delivery starts after it. */
  readonly cursor?: number;
  /** Only these types are delivered; a run's end still ends it. */
  readonly filter?: readonly WorkflowInstanceEventType[];
}

/**
 * A subscription to a run's events: those it kept, then those to come,
 * until the run ends (`done: true` then, and at every later call), or the
 * subscription is disposed, or the run is removed.
 */
export interface WorkflowInstanceSubscription extends Disposable {
  next: () => Promise<IteratorResult<WorkflowInstanceEvent, undefined>>;
}
