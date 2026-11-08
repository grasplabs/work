import type { Json } from "@grasp-os/shared/json";
import { z } from "zod";

import type { Backoff } from "./engine.ts";
import type { Person } from "./workflow-params.ts";

// Steps

/**
 * A time span: whole milliseconds, or e.g. `"30 minutes"` or `"3 days"`; at
 * most 365 days.
 */
export type Duration =
  | number
  | `${number} ${"second" | "minute" | "hour" | "day" | "week"}${"" | "s"}`;

/** What a step returns: JSON, which the engine records, or nothing. */
// oxlint-disable-next-line typescript/no-invalid-void-type -- a step may return nothing
type StepResult = Json | undefined | void;

/** Options every step takes. */
interface StepOptions {
  /** What the step does, in plain language; the UI shows it. */
  description: string;
  /**
   * Tells apart the runs of this step within one run, e.g. the ID of the
   * item a loop is on. Without it, a step runs once per run.
   */
  key?: string | number;
}

/**
 * How often to try a failing step again. `limit` counts retries, not
 * attempts (as in Cloudflare Workflows): `limit: 2` is three attempts in
 * all. Only failures trying again may fix are retried: a connection's
 * server that didn't take the call, a rate limit, a model or App that
 * failed or ran out of time, a model budget held by other calls still
 * under way. Any other error (a refusal, a tool's own error, one the
 * workflow throws) fails the step at once, and stops the run unless the
 * workflow catches it. At most 4 retries, five attempts in all (a
 * deployment may allow fewer); missing, 4 retries, 10 seconds apart,
 * backing off exponentially.
 */
export interface Retries {
  limit: number;
  /** Before the first retry. */
  delay?: Duration;
  /** How the delay grows. */
  backoff?: Backoff;
}

/** Options of a step that runs code, and so can fail and be tried again. */
interface AttemptOptions {
  retries?: Retries;
  /**
   * How long one attempt may take: at most a minute, and a minute when
   * missing. Longer work is split into steps.
   */
  timeout?: Duration;
}

/** What a step works on: JSON, or nothing. */
type StepInput = Json | undefined;

export interface DoOptions<Input extends StepInput = StepInput>
  extends StepOptions, AttemptOptions {
  /**
   * A generated workflow's only (its sealed build's run host asks it; any
   * other ignores it): once the step failed, past its retries, with a
   * failure a catch's retry policy around it may try again, which `try`
   * task's catch takes `error` (`by`), and whether that catch's retry
   * `when` holds; null when none takes it. The host holds the answer to
   * the policy, and runs the step again after its backoff.
   */
  retry?: (error: CaughtError) => Promise<RetryChoice | null>;
  /**
   * What the step works on, as JSON; the function gets it back as `input`.
   * It's recorded with the step.
   */
  input?: Input;
}

export interface DecisionOptions extends StepOptions {
  /**
   * Who decides; only they can answer, signed in, as they are then: a
   * person (`person:<user ID>`), a role (`role:admin`) or a team
   * (`team:<team ID>`). Whoever started the run never answers it, and
   * isn't asked, unless `from` names exactly them; a triggered run has no
   * starter. Every answer is audited under who gave it.
   */
  from: Person;
  /** Stop waiting this long after the decision opened, however long asking took. */
  timeout: Duration;
}

/**
 * How a decision ended: answered, by whom (their user ID) and with what
 * `payload` they sent (untrusted input, e.g. `{ comment }`), or timed out.
 * A timeout never means approval: nobody decided, so treat it as a no, or
 * ask again.
 */
export type Decision =
  | { timedOut: false; approved: boolean; by: string; payload: Json | null }
  | { timedOut: true };

export interface SleepOptions extends StepOptions {
  duration: Duration;
}

/**
 * An error a generated workflow's catch takes, as its run host maps the
 * failure: its kind (`type`) and `status`, the task it came from
 * (`instance`), and the platform's words for it. Whatever format the
 * workflow was written in, the host decides which kinds a catch may take.
 */
export interface CaughtError {
  readonly type: string;
  readonly status: number;
  readonly instance: string;
  readonly title?: string;
  readonly detail?: string;
}

export const caughtErrorSchema = z.strictObject({
  type: z.string(),
  status: z.int(),
  instance: z.string(),
  title: z.string().optional(),
  detail: z.string().optional(),
});

/** What a catch step answers: the error its catch took, if any. */
export const caughtJournalSchema = z.union([
  z.strictObject({ caught: z.literal(false) }),
  z.strictObject({ caught: z.literal(true), error: caughtErrorSchema }),
]);

/** Which `try` task's catch takes a failure, and whether it retries it. */
export interface RetryChoice {
  by: string;
  retry: boolean;
}

/**
 * An event a generated workflow's wait took, as its run host admitted it
 * to the run: its ID, its type, who sent it (`source`, which the host
 * names, never the sender), what it is about, if the sender said, when the
 * run accepted it (ISO 8601) and its data, as its contract takes it.
 */
export interface WorkflowEvent {
  readonly id: string;
  readonly type: string;
  readonly source: string;
  readonly subject?: string;
  readonly time: string;
  readonly data: Json;
}

/**
 * How a generated workflow's event wait ended: the event it took, or
 * nothing by its timeout. A timeout is an outcome, not a failure.
 */
export type EventWait =
  | { readonly timedOut: false; readonly event: WorkflowEvent }
  | { readonly timedOut: true };

export const eventWaitSchema = z.union([
  z.strictObject({
    timedOut: z.literal(false),
    event: z.strictObject({
      id: z.string(),
      type: z.string(),
      source: z.string(),
      subject: z.string().optional(),
      time: z.string(),
      data: z.json(),
    }),
  }),
  z.strictObject({ timedOut: z.literal(true) }),
]);

/** A sleep until a deadline an earlier step recorded, in ms since the epoch. */
interface SleepUntilOptions extends StepOptions {
  until: number;
}

/**
 * Runs steps, one after another. Names and options are literals in the
 * code, so the step list can be read from it; a step name runs once per run
 * unless each run of it has its own `key`. A step never starts while another
 * step runs, e.g. from inside its function.
 */
export interface StepRunner {
  /**
   * Runs plain code. Its result must be JSON: it's recorded, and a replay
   * returns the recorded result instead of running the code again.
   */
  do: <T extends StepResult, Input extends StepInput = undefined>(
    name: string,
    options: DoOptions<Input>,
    fn: (context: { input: Input }) => Promise<T>
  ) => Promise<T>;
  /**
   * Asks a person to decide and durably waits for the answer, until the
   * timeout. The engine tells the people the decision is from, each with a
   * link to where they answer.
   */
  decision: (name: string, options: DecisionOptions) => Promise<Decision>;
  /** Durably pauses the run. */
  sleep: (name: string, options: SleepOptions) => Promise<void>;
  /**
   * A generated workflow's only: durably pauses the run until `until`,
   * the deadline an earlier step recorded, at once once past. Its run host
   * sleeps only until exactly that deadline.
   */
  sleepUntil: (name: string, options: SleepUntilOptions) => Promise<void>;
  /**
   * A generated workflow's only: a `try` task's catch, after a failure in
   * its list. Its run host offers `takes` the error, mapped by the host,
   * when the catch may take it, and `takes` says whether it does (the
   * catch's `when`). Answers the error it took, if it took one; the
   * failure goes on otherwise, which the code throws on.
   */
  caught: (
    name: string,
    options: StepOptions,
    takes: (error: CaughtError) => Promise<boolean>
  ) => Promise<CaughtError | undefined>;
  /**
   * A generated workflow's only: durably waits for an event sent to this
   * run. Its run host decides from the step alone what it takes (the
   * event binding and types its build seals, from the run's own inbox)
   * and until when (its sealed timeout), and answers the event, or that
   * none came in time.
   */
  listen: (name: string, options: StepOptions) => Promise<EventWait>;
}

// What the runner implements: the same steps, with their options checked at
// run time as well as by the types.
export interface UntypedStepRunner {
  do: (
    name: string,
    options: unknown,
    fn: (context: { input: StepInput }) => Promise<unknown>
  ) => Promise<unknown>;
  decision: (name: string, options: unknown) => Promise<Decision>;
  sleep: (name: string, options: unknown) => Promise<void>;
  sleepUntil: (name: string, options: unknown) => Promise<void>;
  caught: (
    name: string,
    options: unknown,
    takes: (error: CaughtError) => Promise<boolean>
  ) => Promise<CaughtError | undefined>;
  listen: (name: string, options: unknown) => Promise<EventWait>;
}
