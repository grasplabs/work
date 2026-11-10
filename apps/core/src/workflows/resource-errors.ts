import { expectedMessageOf } from "@grasp-os/shared/errors";
import { categoryOf, isRetryableCode } from "@grasp-os/shared/operations";
import type { SealedTask } from "@grasp-os/workflow-schema/sealed";

import type { StepError } from "./sealed-isolate.ts";

// The failures of a JSON workflow's steps as its `try` tasks' catches see
// them (spec 13.7): each an `AppError`-shaped failure, `{ code, message,
// step }`, mapped once, here, from what the host knows of the failure,
// never from what the isolate threw. Threat model, and how each is closed:
//
// - A catch swallowing what must stop the run. Only a failure of a step
//   of the run's own tasks may be caught, and not every one: the host's
//   refusals of a module (`workflow.invalid`), an attempt the engine let
//   go of (`execution.stale_attempt`) and an effect whose outcome is
//   unknown (its category `uncertain`, connect's `outcome_unknown`, and
//   a call that runs its effect once, or a connector call, that ran out
//   of time), and a step whose call took effect before it failed, are
//   never `catchable`: a run whose code goes on past one is refused
//   (sealed-run.ts), whatever its catches say. A wait, a pause or a
//   cancellation isn't a failure at all: the engine never settles the
//   call it suspends.
// - A workflow passing its own error off as the host's. A raise is the
//   workflow's own `AppError`, thrown by its code, never a step's
//   failure: `AppError` refuses a code in the platform's namespaces, the
//   format's check refuses one, and the host fails a run with an
//   `AppError` only of a code its build seals as a raise (sealed-run.ts,
//   `raisedFailure`). So a failure of a platform code a catch sees is
//   always the host's.
// - A module relabelling a failure. What a step failed with is what the
//   host answered one of its calls with (sealed-run.ts, `#hostFailures`),
//   never what the isolate reports; a failure only the isolate reports is
//   an expression's, a task's data's or the task's own runtime failure, in
//   the platform's words (sealed-run.ts, `isolateFailure`).
// - A caught error carrying what the run read. A host failure's message
//   is the platform's own words for its code, or a fixed one; it has no
//   details. The message a step failed with (which can hold data) never
//   reaches a catch.

/** The code of a task's own failure that names none. */
const unexpectedCode = "internal.unexpected";

/** The platform's words for a failure that has none of its own. */
const taskFailed = "The task failed.";

/** A step's failure, as a catch's `error` holds it (the SDK's `CaughtError`). */
export interface CaughtError {
  readonly code: string;
  readonly message: string;
  /** The step that failed: its task's ID. */
  readonly step: string;
}

/** The kinds of failure, as retrying reads them. */
type StandardType =
  | "authentication"
  | "authorization"
  | "communication"
  | "expression"
  | "runtime"
  | "timeout"
  | "validation";

/** A step's failure as a catch sees it: an error, or nothing it may take. */
export type Failure =
  | {
      readonly catchable: true;
      readonly error: CaughtError;
      /** The host's code for it, as bounded metadata: never the catch's. */
      readonly code?: string;
    }
  | { readonly catchable: false };

const uncatchable: Failure = Object.freeze({ catchable: false });

/** Failures no catch takes: the host's refusals, and unknown outcomes. */
const neverCaught: ReadonlySet<string> = new Set([
  "workflow.invalid",
  "execution.stale_attempt",
  // Its call took effect: a catch would take it as one that didn't.
  "workflow.failed_after_effect",
  // A branch a race or an `end` settled over (GRA-956): as a cancellation.
  "workflow.branch_cancelled",
  "connect.outcome_unknown",
  "connect.outcome_unknown_unresolved",
  // A test run's wait past what a test run may wait (a retry's backoff
  // past it too): production waits on, so a catch taking it would report
  // a path a run never takes.
  "workflow.candidate_wait_limit",
]);

/** The validation failures of a task's own data, not a contract's. */
const invalidData: ReadonlySet<string> = new Set([
  "workflow.task_data_invalid",
  "workflow.call_invalid",
  "workflow.arguments_too_deep",
  "workflow.output_invalid",
]);

/**
 * The calls whose step runs its effect once (sealed-run.ts,
 * `triedOnceCalls`): a model request, one of the workflow's own actions.
 */
const onceCalls: ReadonlySet<string> = new Set(["grasp.model", "grasp.action"]);

/**
 * The calls whose timeout leaves their effect unknown: those that run it
 * once, and a connector call, whose send may have gone out on an attempt
 * cut off; a step that ends timed out had no attempt with connect's
 * definite answer, which would have ended it otherwise.
 */
const timesOutUnknown: ReadonlySet<string> = new Set([
  ...onceCalls,
  "grasp.connector",
]);

/**
 * The codes of a task that ran out of time: an operation past its deadline,
 * a listen past its timeout.
 */
const timeoutCodes: ReadonlySet<string> = new Set([
  "function.deadline_exceeded",
  "workflow.event_timeout",
]);

/** The standard type of a failure of a step's work, by its code. */
const typeOf = (error: StepError): StandardType => {
  const { code } = error;
  if (
    error.name === "TimeoutError" ||
    (code !== undefined && timeoutCodes.has(code))
  ) {
    return "timeout";
  }
  if (code === undefined) {
    return "runtime";
  }
  if (code === "auth.unauthenticated") {
    return "authentication";
  }
  if (code.startsWith("permission.") || categoryOf(code) === "authorization") {
    return "authorization";
  }
  if (code.startsWith("expression.")) {
    return "expression";
  }
  if (invalidData.has(code) || categoryOf(code) === "contract") {
    return "validation";
  }
  if (code.startsWith("connect.")) {
    return "communication";
  }
  return "runtime";
};

/**
 * The failure `error` of a step of `task` is to a catch: its code and the
 * platform's words for it, for anything the host may let a catch take
 * (a timeout as `function.deadline_exceeded`, a failure with no code as
 * `internal.unexpected`), nothing for what it may not (see above), nor
 * for a step of no task (the workflow's own data flow), nor once the run
 * was refused (`tampered`).
 */
export const failureOf = (
  error: StepError,
  task: SealedTask | undefined,
  tampered: boolean
): Failure => {
  const { code } = error;
  if (
    tampered ||
    task === undefined ||
    (code !== undefined &&
      (neverCaught.has(code) || categoryOf(code) === "uncertain"))
  ) {
    return uncatchable;
  }
  // A call whose effect runs once (`onceCalls`) that ran out of time may
  // have taken effect: its outcome is unknown, never a catch's to take.
  const timedOut =
    error.name === "TimeoutError" || code === "function.deadline_exceeded";
  if (timedOut && task.kind === "call" && timesOutUnknown.has(task.call.name)) {
    return uncatchable;
  }
  const caughtCode =
    code ?? (timedOut ? "function.deadline_exceeded" : unexpectedCode);
  return Object.freeze({
    catchable: true,
    ...(code === undefined ? {} : { code }),
    error: Object.freeze({
      code: caughtCode,
      message: expectedMessageOf(caughtCode) ?? taskFailed,
      step: task.id,
    }),
  });
};

/** The failure of anything not a step's work: never a catch's to take. */
export const notCaught = (): Failure => uncatchable;

/**
 * Whether `error` has the code a catch takes (`SealedCatch.code`): a
 * catch with none takes every error.
 */
export const matchesFilter = (
  error: CaughtError,
  code: string | undefined
): boolean => code === undefined || error.code === code;

/** The kinds of failure trying again may fix. */
const transientTypes: ReadonlySet<StandardType> = new Set([
  "timeout",
  "communication",
  "runtime",
]);

/**
 * Failures trying again never fixes, however a retry policy reads (spec
 * 13.7): a conflict, a decline, and every budget or limit spent.
 */
const permanentCodes: ReadonlySet<string> = new Set([
  "data.conflict",
  "resource.idempotency_conflict",
  "resource.declined",
  "connect.declined",
  "resource.limit_reached",
  "workflow.model_call_limit",
  "workflow.action_call_limit",
  "workflow.too_many_steps",
  "workflow.too_many_attempts",
  // A step's state past what a workflow keeps: the same values, the
  // same size, every time.
  "workflow.state_too_large",
  "workflow.lineage_limit",
  "workflow.between_steps_limit",
  "workflow.queue_timeout",
  "workflow.candidate_time_limit",
  "workflow.candidate_wait_limit",
]);

/**
 * Whether a step of `task` that failed with `failure` may be tried again
 * under a catch's retry policy (spec 13.7): a failure a catch may take, of
 * a type trying again may fix (a timeout, a call outside the platform that
 * failed, a failure of the task's work), never a conflict, a decline, a
 * denial, invalid data, the workflow's own error (a permanent domain
 * error) or a budget spent; for a call that runs its effect once, only one
 * that says nothing was sent. No policy overrides this.
 */
export const retryable = (failure: Failure, task: SealedTask): boolean => {
  if (
    !failure.catchable ||
    !transientTypes.has(
      typeOf({ name: "Error", message: "", code: failure.error.code })
    )
  ) {
    return false;
  }
  const { code } = failure;
  if (code !== undefined && permanentCodes.has(code)) {
    return false;
  }
  // A call whose effect runs once runs again only after a failure that
  // says nothing was sent, as a busy store or a provider's rate limit do.
  // An action's says so only when none of its calls before took effect:
  // after one did, it fails as `workflow.failed_after_effect` instead,
  // which no catch takes (resource-action.ts, `callAction`).
  if (task.kind === "call" && onceCalls.has(task.call.name)) {
    return code !== undefined && isRetryableCode(code);
  }
  return true;
};
