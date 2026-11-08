// What the engine adapter implements; workflow code never imports it.
import type { RunId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import type { z } from "zod";

/** One call to the model gateway, made on behalf of an AI step. */
export interface ModelRequest {
  /** The step the call is made for, for the audit log and cost reporting. */
  step: string;
  /**
   * The alias of the App's model resource the call goes through: an
   * approved binding of it names the model and caps what it may spend.
   */
  binding: string;
  /** What the model is asked to do. */
  instructions: string;
  /** What it works on. */
  input: Json;
  /** The model must answer with JSON that matches this schema. */
  outputSchema: z.core.JSONSchema.JSONSchema;
}

/** An answer to a decision, as a test gives it (`@grasp-os/sdk/testing`). */
export interface DecisionAnswer {
  approved: boolean;
  /** The person who answered. */
  by: string;
  /** Anything more they sent, e.g. `{ comment }`. */
  payload?: Json;
}

/**
 * How a decision stands when a wait for it ends: answered, by a person
 * the runtime checked may answer it, or not (yet).
 */
export type EngineDecision =
  | { answered: true; approved: boolean; by: string; payload: Json | null }
  | { answered: false };

/** A person a decision asks, and where they answer it. */
export interface DecisionRecipient {
  userId: string;
  name: string;
  email: string;
  /** Leads them, once signed in, to the decision: `/decisions/<id>`. */
  link: string;
}

/**
 * A method of a binding: it takes JSON and answers with it. The answer is
 * typed `unknown`, as a binding's name doesn't say what it is (a
 * connection, an App, a collection): a workflow's code narrows what it
 * reads, to the answer's shape or to `Json` to return it from a step.
 */
type BindingMethod = (...args: Json[]) => Promise<unknown>;

/**
 * What a run reaches outside its own code, by binding name: the
 * connections its version binds (`env.NAME.call(action, input, {
 * idempotencyKey })`). Each call is checked against the permissions as
 * they are then, and acts for the person the run acts for. They work only
 * inside a step (a replay doesn't call them again), and a connection call
 * takes that step's `idempotencyKey` or none.
 */
export type WorkflowEnv = Readonly<
  Record<string, Readonly<Record<string, BindingMethod>>>
>;

/** How the delay between attempts grows. */
export type Backoff = "constant" | "linear" | "exponential";

/**
 * How often to try a failing step again. `limit` counts retries, not
 * attempts: `limit: 2` is three attempts in all.
 */
interface EngineRetries {
  limit: number;
  /** Before the first retry, in milliseconds; the engine's when missing. */
  delay?: number;
  /** The engine's when missing. */
  backoff?: Backoff;
}

/** What the SDK tells the engine about a step it runs. */
interface EngineStepOptions {
  /** The engine's defaults when missing. */
  retries?: EngineRetries;
  /** How long one attempt may take, in milliseconds; a minute when missing. */
  timeout?: number;
  /**
   * The step changes something outside Grasp. A dry run records it with its
   * input instead of running it.
   */
  sideEffect?: boolean;
  /** What the step works on, for run history and dry-run reports. */
  input?: Json;
}

/**
 * What a durable runtime implements to run workflows written with
 * `@grasp-os/sdk/workflow`. Workflow code never sees it, so the engine
 * underneath (the cloud runtime, or an on-prem one) can change without
 * touching a single workflow. It stays close to the common durable-execution
 * primitives (a named step whose result is recorded, a durable sleep, a
 * durable wait for a decision), so any durable runtime maps onto it directly.
 *
 * Implemented once per run execution. A run can be replayed
 * from the start at any time: every method that takes a step name must return
 * the recorded outcome when that name already completed in this run.
 *
 * The SDK reads `params` and calls `callModel`, `openDecision` and
 * `decisionRecipients` only inside `do`, so they need not be durable
 * themselves.
 *
 * Engines may keep only a failed step's error name and message (Cloudflare
 * Workflows does); the SDK puts what it needs to recover into both.
 */
export interface WorkflowEngine {
  readonly runId: RunId;
  /**
   * Parameter values people set, by name; missing ones use the default. The
   * SDK records them in the run's first step, so a run keeps the values it
   * started with even when people change them before it resumes.
   */
  readonly params: Readonly<Record<string, unknown>>;
  /**
   * Where outsiders send the run's events, by its event binding's alias
   * (see `WorkflowContext.inbox`). Only a sealed build's run host has it.
   */
  readonly inbox?: Readonly<Record<string, string>>;
  /**
   * What the workflow kept between its runs, by key, as the run's start
   * froze it: the same in every execution of the run, whatever later
   * runs write meanwhile.
   */
  readonly state: Readonly<Record<string, Json>>;
  /** The run's bindings, built for this execution of it (see `WorkflowEnv`). */
  readonly env: WorkflowEnv;
  /**
   * Runs `fn` as a durable step and records its result. Retries a failing
   * `fn` as `retries` says, while it fails with an error for which
   * `isRetryable` (`@grasp-os/shared/workflows`) holds, and then fails the
   * step with the last error. Any other error fails the step at once (the
   * Cloudflare adapter throws it on as a `NonRetryableError`).
   */
  do: <T>(
    name: string,
    options: EngineStepOptions,
    fn: () => Promise<T>,
    /**
     * A generated workflow's choice of a retry once the step failed (see
     * `DoOptions.retry`): only a sealed build's run host asks it; any other
     * engine ignores it.
     */
    retry?: (error: Json) => Promise<unknown>
  ) => Promise<T>;
  /** Durably pauses the run. */
  sleep: (name: string, milliseconds: number) => Promise<void>;
  /**
   * Durably pauses the run until `until`, in ms since the epoch, recorded
   * by an earlier step: a generated workflow's (`step.sleepUntil`). Only a
   * sealed build's run host has it.
   */
  sleepUntil?: (name: string, until: number) => Promise<void>;
  /**
   * A generated workflow's event wait (`step.listen`): the engine decides
   * what it waits for, and how long, from the step alone, and answers how
   * it ended. Only a sealed build's run host has it.
   */
  listen?: (name: string) => Promise<unknown>;
  /**
   * A generated workflow's catch step (`step.caught`): `takes` is asked
   * whether its catch takes the error the engine offers, and the step
   * answers what it recorded. Only a sealed build's run host has it.
   */
  caught?: (
    name: string,
    options: EngineStepOptions,
    takes: (error: Json) => Promise<boolean>
  ) => Promise<unknown>;
  /** Calls the model gateway and returns the model's JSON answer. */
  callModel: (request: ModelRequest) => Promise<unknown>;
  /**
   * Opens a decision on `step` in this run, answered only by the people
   * `from` names, never the run's starter unless `from` is exactly
   * `person:<them>`, for `timeout` milliseconds. Returns its ID and its
   * deadline (milliseconds since the epoch), which the engine sets.
   *
   * Idempotent per run and step: the SDK calls it inside a step, which a
   * crash before the step is recorded runs again, so a second call for the
   * same `step` returns what the first did and opens nothing new.
   */
  openDecision: (request: {
    step: string;
    from: string;
    description: string;
    timeout: number;
  }) => Promise<{ decision: string; deadline: number }>;
  /**
   * The people an open decision asks now, each with the decision's link;
   * nobody once it's answered. Called inside the step that asks them.
   */
  decisionRecipients: (
    decision: string,
    reminder: boolean
  ) => Promise<DecisionRecipient[]>;
  /**
   * Durably waits up to `timeout` milliseconds (0: not at all) for an
   * answer to a decision, and returns how it stands then. With `last`, a
   * decision still unanswered is closed, so no answer counts after it. A
   * replay returns what the wait returned.
   */
  waitForDecision: (
    name: string,
    options: { decision: string; timeout: number; last: boolean }
  ) => Promise<EngineDecision>;
}
