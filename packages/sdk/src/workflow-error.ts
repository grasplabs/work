import { z } from "zod";

import type { ValueSchema } from "./value-descriptor.ts";

const workflowErrorCodes = [
  "workflow.invalid_definition",
  "workflow.invalid_step_call",
  "workflow.invalid_input",
  "workflow.invalid_param",
  "workflow.invalid_model_output",
] as const;
type WorkflowErrorCode = (typeof workflowErrorCodes)[number];

const isWorkflowErrorCode = (code: unknown): code is WorkflowErrorCode =>
  workflowErrorCodes.some((known) => known === code);

// The code rides in the name, which every engine keeps with the message.
const errorNamePattern = /^WorkflowError\((?<code>[\w.]+)\)$/u;

/**
 * Thrown for a workflow that is wrong: a bad definition, a bad step call, or
 * a value that doesn't match its schema.
 */
export class WorkflowError extends Error {
  /** Stable and machine-readable; branch on this, never on the message. */
  readonly code: WorkflowErrorCode;

  /**
   * Trying again can't fix one, so the engine doesn't retry the step it
   * failed; only a model's answer that doesn't fit is asked for again
   * (`isRetryable` in `@grasp-os/shared/workflows`).
   */
  constructor(code: WorkflowErrorCode, message: string) {
    super(message);
    // Not just the class name: the code rides in the name, which every
    // engine keeps with the message.
    // oxlint-disable-next-line unicorn/custom-error-definition -- see above
    this.name = `WorkflowError(${code})`;
    this.code = code;
  }

  /**
   * The workflow error `error` is, or was before an engine kept only its
   * name and message; undefined for any other error.
   */
  static from(error: unknown): WorkflowError | undefined {
    if (error instanceof WorkflowError) {
      return error;
    }
    if (!(error instanceof Error)) {
      return undefined;
    }
    const code = errorNamePattern.exec(error.name)?.groups?.code;
    return isWorkflowErrorCode(code)
      ? new WorkflowError(code, error.message)
      : undefined;
  }
}

export const invalidCall = (message: string): WorkflowError =>
  new WorkflowError("workflow.invalid_step_call", message);

export const parseOrThrow = <Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  code: WorkflowErrorCode,
  what: string
): z.output<Schema> => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new WorkflowError(code, `${what}: ${z.prettifyError(result.error)}`);
  }
  return result.data;
};

/** `value` checked by `schema`, a `v` schema, or `code` thrown naming `what`. */
export const checkOrThrow = <Input, Output>(
  schema: ValueSchema<Input, Output>,
  value: unknown,
  code: WorkflowErrorCode,
  what: string
): Output => {
  const result = schema["~standard"].validate(value);
  if (result.issues === undefined) {
    return result.value;
  }
  const [issue] = result.issues;
  const at = issue?.path.join(".") ?? "";
  throw new WorkflowError(
    code,
    `${what}${at === "" ? "" : ` at ${at}`}: ${issue?.message ?? "not of its schema"}`
  );
};
