import { defineErrorFamily } from "@grasp-os/shared/errors";
import type { ErrorPayload } from "@grasp-os/shared/errors";

import { evaluatorLimits, sizeText, sourceLimits } from "./limits.ts";

/**
 * Why an expression was refused or failed. Every code is a real expression
 * failure (Open Workflow's expression error, status 400): there is no
 * fallback value. Messages and details never carry the values the
 * expression ran on, only its source position, the contract it broke and a
 * remedy.
 */
export const expressionErrors = defineErrorFamily({
  "expression.unsupported_language":
    "Expressions are jq in strict mode; no other language or mode is available.",
  "expression.too_large": `The expression is longer than ${sizeText(sourceLimits.maxBytes)}.`,
  "expression.too_deep": `The expression nests deeper than ${sourceLimits.maxNesting} levels.`,
  "expression.scope_too_deep": `The task nests deeper than ${evaluatorLimits.maxTaskScopes} scopes.`,
  "expression.invalid": "The expression isn't valid jq.",
  "expression.unsupported":
    "The expression uses something outside the workflow expression profile.",
  "expression.unavailable_variable":
    "The expression uses a variable that isn't available where it runs.",
  "expression.context_invalid":
    "The expression's input or variables aren't plain JSON within the limits.",
  "expression.context_too_large": `The expression's input and variables are over ${sizeText(evaluatorLimits.maxContextBytes)} together.`,
  "expression.failed": "The expression failed.",
  "expression.resource_exhausted":
    "The expression ran out of its computation or memory budget.",
  "expression.result_count": "The expression must produce exactly one result.",
  "expression.result_too_large": `The expression's result is over ${sizeText(evaluatorLimits.maxResultBytes)}.`,
  "expression.result_invalid": `The expression's result nests deeper than ${evaluatorLimits.maxJsonDepth} levels, or has a number or key that isn't allowed.`,
  "expression.type_mismatch":
    "The expression's result doesn't have the type its place requires.",
});

export type ExpressionErrorCode = Parameters<typeof expressionErrors.create>[0];

/** Where an expression sits in its workflow definition. */
export interface ExpressionSite {
  /** The stable ID of the task it belongs to; none at the workflow level. */
  taskId?: string;
  /** JSON Pointer to the expression in the definition. */
  pointer: string;
}

/** Open Workflow's error type for expression failures, and its status. */
export const expressionErrorType =
  "https://open-workflow-specification.org/spec/1.0.0/errors/expression";
export const expressionErrorStatus = 400;

/**
 * An expression error at `site`. `details` are bounded texts about the
 * source and the contract, never input or result values.
 */
export const expressionError = (
  code: ExpressionErrorCode,
  site: ExpressionSite,
  details: { expected?: string; remedy: string; reason?: string }
) => {
  const payload: NonNullable<ErrorPayload["details"]> = {
    type: expressionErrorType,
    status: expressionErrorStatus,
    pointer: site.pointer,
    remedy: details.remedy,
  };
  if (site.taskId !== undefined) {
    payload.taskId = site.taskId;
  }
  if (details.expected !== undefined) {
    payload.expected = details.expected;
  }
  if (details.reason !== undefined) {
    payload.reason = details.reason;
  }
  return expressionErrors.create(code, payload);
};
