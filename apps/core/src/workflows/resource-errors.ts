import { expectedMessageOf } from "@grasp-os/shared/errors";
import { categoryOf } from "@grasp-os/shared/operations";

import type { SealedTask } from "../workflow-builds.ts";
import type { StepError } from "./code.ts";

// The failures of a JSON workflow's steps as its `try` tasks' catches see
// them (spec 13.7): each an upstream error (its type, status, title,
// detail and the task it came from as its instance), mapped once, here,
// from what the host knows of the failure, never from what the isolate
// threw. Threat model, and how each is closed:
//
// - A catch swallowing what must stop the run. Only a failure of a step
//   of the run's own tasks may be caught, and not every one: the host's
//   refusals of a module (`workflow.invalid`), an attempt the engine let
//   go of (`execution.stale_attempt`) and an effect whose outcome is
//   unknown (its category `uncertain`, connect's `outcome_unknown`, and
//   a call that runs its effect once, or a connector call, that ran out
//   of time), and a step whose call took effect before it failed, are
//   never `catchable`, so a run with them fails, whatever its catches
//   say: an unknown effect is reconciled first, never taken as one that
//   didn't happen. A wait, a pause or a cancellation isn't a failure at
//   all: the engine never settles the call it suspends.
// - A workflow passing its own error off as the host's. A `raise` raises
//   only the literal error its build sealed, of a domain type: validation
//   refuses the standard types and the statuses of authentication and
//   authorization (open-workflow's errors.ts), so an authorization error a
//   catch sees is always the host's.
// - A module relabelling a failure. What a step failed with is what the
//   host answered one of its calls with (resource-host.ts, `hostError`),
//   never what the isolate reports; one that failed without the host
//   failing anything of it is `workflow.invalid`.
// - A caught error carrying what the run read. A host error's title is
//   the platform's own words for its code, or a fixed one for its type;
//   it has no detail. The message a step failed with (which can hold
//   data) never reaches a catch.

/** Where the standard error types are, as the profile's examples write them. */
const standardTypes =
  "https://open-workflow-specification.org/spec/1.0.0/errors/";

/** The standard error types, each with its status, as upstream gives them. */
const standard = {
  configuration: 400,
  validation: 400,
  expression: 400,
  authentication: 401,
  authorization: 403,
  timeout: 408,
  communication: 500,
  runtime: 500,
} as const;

type StandardType = keyof typeof standard;

/** A standard type's own title, for a failure with no words of the platform's. */
const titles: Readonly<Record<StandardType, string>> = {
  configuration: "The workflow is configured in a way the host can't run.",
  validation: "A task's data didn't fit its contract.",
  expression: "An expression failed.",
  authentication: "The run's person isn't signed in.",
  authorization: "The run isn't allowed to do that.",
  timeout: "The task ran out of time.",
  communication: "A call outside the platform failed.",
  runtime: "The task failed.",
};

/** The code a `raise` task's step fails with. */
export const raisedCode = "workflow.raised";

/** An upstream error, as a catch's variable holds it. */
export interface CaughtError {
  readonly type: string;
  readonly status: number;
  readonly instance: string;
  readonly title?: string;
  readonly detail?: string;
}

/** A step's failure as a catch sees it: an error, or nothing it may take. */
export type Failure =
  | { readonly catchable: true; readonly error: CaughtError }
  | { readonly catchable: false };

const uncatchable: Failure = Object.freeze({ catchable: false });

/** Failures no catch takes: the host's refusals, and unknown outcomes. */
const neverCaught: ReadonlySet<string> = new Set([
  "workflow.invalid",
  "execution.stale_attempt",
  // Its call took effect: a catch would take it as one that didn't.
  "workflow.failed_after_effect",
  "connect.outcome_unknown",
  "connect.outcome_unknown_unresolved",
]);

/** The validation failures of a task's own data, not a contract's. */
const invalidData: ReadonlySet<string> = new Set([
  "workflow.task_data_invalid",
  "workflow.call_invalid",
  "workflow.output_invalid",
]);

/**
 * The calls whose step runs its effect once (core's resource-host.ts,
 * `triedOnce`): a store operation, a model request, one of the workflow's
 * own actions.
 */
const onceCalls: ReadonlySet<string> = new Set([
  "grasp.operation",
  "grasp.model",
  "grasp.action",
]);

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

/** The standard type of a failure of a step's work, by its code. */
const typeOf = (error: StepError): StandardType => {
  const { code } = error;
  if (error.name === "TimeoutError" || code === "operation.deadline_exceeded") {
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
 * The failure `error` of a step of `task` is to a catch: the error the
 * task's build sealed for a `raise`, a standard one for anything else the
 * host may let a catch take, nothing for what it may not (see above), nor
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
    error.name === "TimeoutError" || code === "operation.deadline_exceeded";
  if (timedOut && task.kind === "call" && timesOutUnknown.has(task.call.name)) {
    return uncatchable;
  }
  if (code === raisedCode) {
    // Only a raise fails with it, as the host fails its step.
    if (task.kind !== "raise") {
      return uncatchable;
    }
    const { type, status, title, detail } = task.error;
    return Object.freeze({
      catchable: true,
      error: Object.freeze({
        type,
        status,
        instance: task.pointer,
        ...(title === undefined ? {} : { title }),
        ...(detail === undefined ? {} : { detail }),
      }),
    });
  }
  const type = typeOf(error);
  return Object.freeze({
    catchable: true,
    error: Object.freeze({
      type: `${standardTypes}${type}`,
      status: standard[type],
      instance: task.pointer,
      title:
        (code === undefined ? undefined : expectedMessageOf(code)) ??
        titles[type],
    }),
  });
};

/** The failure of anything not a step's work: never a catch's to take. */
export const notCaught = (): Failure => uncatchable;

/**
 * Whether `error` has every property `filter` names, exactly (a catch's
 * `errors.with`): no filter takes every error.
 */
export const matchesFilter = (
  error: CaughtError,
  filter: Readonly<Record<string, string | number | undefined>> | undefined
): boolean => {
  if (filter === undefined) {
    return true;
  }
  const own = new Map<string, string | number | undefined>(
    Object.entries(error)
  );
  return Object.entries(filter).every(
    ([key, value]) => value === undefined || own.get(key) === value
  );
};
