import { isRecord } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import {
  expressionFailed,
  uncatchableFailureName,
} from "@grasp-os/shared/workflows";

import { AppError } from "./app-error.ts";
import { dataObject, frozenData } from "./workflow-data.ts";
import { WorkflowError } from "./workflow-error.ts";
import type { CallOptions, CaughtError } from "./workflow-steps.ts";

// A workflow's failures as a catch or a retry reads them (`CaughtError`):
// a step's, as the run host failed it, and the code's own.

/** A caught failure of `code` and `message`, as data (`dataObject`). */
const caughtOf = (
  code: string,
  message: string,
  details?: unknown,
  step?: string
): CaughtError =>
  dataObject({
    code,
    message,
    ...(details === undefined ? {} : { details: frozenData(details) }),
    ...(step === undefined ? {} : { step }),
  });

/**
 * A failure the run host sent, as a catch reads it: its code, its message
 * and its details, and its step where it names one; anything else of it
 * is dropped. Not of that shape, it is the platform's unexpected failure.
 */
const caughtFrom = (failure: Json): CaughtError => {
  if (
    isRecord(failure) &&
    typeof failure.code === "string" &&
    typeof failure.message === "string"
  ) {
    const { code, message, details, step } = failure;
    return caughtOf(
      code,
      message,
      details,
      typeof step === "string" ? step : undefined
    );
  }
  return caughtOf(expressionFailed, "The expression failed.");
};

/**
 * A call's failure, as the run host failed its step: its code, message
 * and details, and the step. Thrown on by the code where no catch takes
 * it, as the host's own failure.
 */
export class StepFailureError extends Error {
  readonly code: string;
  readonly caught: CaughtError;
  /**
   * Whether a catch may take it: the run host says one may not (an effect
   * already made, a refusal, a timeout), and every catch throws it on
   * (`caughtError`), so the run ends with it.
   */
  readonly catchable: boolean;

  constructor(caught: CaughtError, catchable = true) {
    super(caught.message);
    this.name = "StepFailureError";
    this.code = caught.code;
    this.caught = caught;
    this.catchable = catchable;
  }
}

/**
 * An error a call failed with, as a catch reads it: frozen data with no
 * prototype (`CaughtError`). A run host's failure keeps its code, its
 * message and its details; the workflow's own `AppError` likewise; a
 * failure of the code itself (an expression that read a field of `null`)
 * is `expression.failed`, its words the platform's, never a value's. A
 * failure the run host says no catch may take is thrown on, so every
 * catch ends the run with it.
 */
export const caughtError = (thrown: unknown): CaughtError => {
  if (thrown instanceof StepFailureError) {
    if (!thrown.catchable) {
      throw thrown;
    }
    return thrown.caught;
  }
  if (thrown instanceof AppError) {
    return caughtOf(thrown.code, thrown.message, thrown.details);
  }
  if (thrown instanceof WorkflowError) {
    return caughtOf(thrown.code, thrown.message);
  }
  return caughtOf(expressionFailed, "The expression failed.");
};

/** `error`, as a call's step failed with it, for its catch. */
export const failureOf = (error: unknown, step: string): unknown => {
  if (error instanceof Error && error.name === uncatchableFailureName) {
    const code: unknown = Reflect.get(error, "code");
    return new StepFailureError(
      caughtOf(
        typeof code === "string" ? code : "internal.unexpected",
        error.message,
        undefined,
        step
      ),
      false
    );
  }
  if (
    error instanceof StepFailureError ||
    error instanceof WorkflowError ||
    !(error instanceof Error)
  ) {
    return error;
  }
  const code: unknown = Reflect.get(error, "code");
  if (typeof code !== "string") {
    return error;
  }
  const details: unknown = Reflect.get(error, "details");
  return new StepFailureError(caughtOf(code, error.message, details, step));
};

/** The retry choice the run host asks once a call's step failed. */
export const retryOf = (
  retry: CallOptions["retry"]
): ((error: Json) => Promise<unknown>) | undefined => {
  if (retry === undefined) {
    return undefined;
  }
  if (retry === true) {
    return async () => await Promise.resolve(true);
  }
  return async (failure) => await Promise.resolve(retry(caughtFrom(failure)));
};
