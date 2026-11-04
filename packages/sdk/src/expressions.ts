import type { Json } from "@grasp-os/shared/json";
import { expressionError } from "@grasp-os/workflow-expressions/errors";
import {
  compileExpression,
  evaluateExpression,
} from "@grasp-os/workflow-expressions/evaluate";
import type {
  EvaluationScope,
  Stage,
} from "@grasp-os/workflow-expressions/evaluate";

/**
 * jq expressions of JSON workflows, evaluated where the workflow runs: the
 * pinned, metered jq build of `@grasp-os/workflow-expressions`, inside the
 * run's own isolate, so code generated from a JSON workflow needs no host
 * to evaluate its data flow. Every evaluation is held to the evaluator's
 * limits (fuel, memory, context and result size, depth), which are the
 * same wherever it runs: the same expression on the same values succeeds,
 * or fails with the same `expression.*` error, on every replay.
 *
 * A step's evaluations together may share a budget (`expressionBudget`),
 * so the same step spends the same fuel on core's host and here. The
 * budget makes a step deterministic; it isn't what bounds the isolate's
 * work, which runs in the isolate's own CPU time and is bounded by it.
 */

/** Where in a workflow's data flow an expression runs: its variables. */
export type ExpressionStage = Stage;

/** What an expression's result must be: a condition, a duration, or JSON. */
export type ExpressionResult = "boolean" | "duration" | "json";

/** An expression, as a JSON workflow has it, and where it sits. */
export interface Expression<S extends ExpressionStage = ExpressionStage> {
  /** jq, without the `${ … }` around it. */
  readonly source: string;
  readonly stage: S;
  /** JSON Pointer to it in its workflow definition, for errors. */
  readonly pointer: string;
  /** Task IDs from the workflow's top-level list down to its task. */
  readonly scope: readonly string[];
  /** Variables of the loops and catches around its task, outermost first. */
  readonly loopVariables?: readonly string[];
}

/** What an expression runs on: its input (`.`) and its stage's variables. */
export type ExpressionScope<S extends ExpressionStage = ExpressionStage> =
  EvaluationScope<S>;

/** Fuel a step's evaluations draw from together (`expressionBudget`). */
export interface ExpressionBudget {
  fuel: number;
}

/**
 * The fuel one step's evaluations may spend together: eight expressions'
 * worth of the evaluator's own per-expression fuel (2^24), as an attempt
 * of a step has on core's host.
 */
export const stepExpressionFuel = 2 ** 27;

/**
 * What each evaluation costs a budget before jq runs, as on core's host:
 * 1/32 of an expression's fuel, so a step runs at most 256 evaluations.
 */
export const evaluationFuel = 2 ** 19;

/** A fresh budget for one step's evaluations: {@link stepExpressionFuel}. */
export const expressionBudget = (): ExpressionBudget => ({
  fuel: stepExpressionFuel,
});

const resultContracts = {
  boolean: { kind: "boolean" },
  duration: { kind: "duration" },
  json: { kind: "json" },
} as const;

/** Options of one evaluation. */
export interface EvaluateOptions {
  /** What its result must be; one JSON value if unset. */
  readonly result?: ExpressionResult;
  /** The step's budget its fuel comes out of; none if unset. */
  readonly budget?: ExpressionBudget;
}

/**
 * Evaluates `expression` on `scope`, within the evaluator's limits: its one
 * result, held to `result` (a condition a boolean, a duration its whole
 * milliseconds). Fails with an `expression.*` error that never carries the
 * values: a source outside the profile, a variable its stage doesn't have,
 * a context or result over its limits, a jq failure, fuel or memory run
 * out, other than exactly one result, or a result of the wrong type. None
 * is worth retrying: the same evaluation fails the same way every time.
 */
export const evaluate = async <S extends ExpressionStage>(
  expression: Expression<S>,
  scope: ExpressionScope<S>,
  { result = "json", budget }: EvaluateOptions = {}
): Promise<Json> => {
  // The source is checked against the profile on every evaluation, but
  // not compiled by jq apart: that would spend fuel depending on whether
  // this isolate compiled it before. A jq syntax error fails as the
  // evaluation's own `expression.invalid`.
  const compiled = await compileExpression(
    expression.source,
    {
      stage: expression.stage,
      scope: expression.scope,
      pointer: expression.pointer,
      loopVariables: expression.loopVariables ?? [],
    },
    true
  );
  const { site } = compiled;
  if (!Object.hasOwn(resultContracts, result)) {
    throw expressionError("expression.invalid", site, {
      remedy: "Ask for a boolean, a duration or JSON.",
    });
  }
  if (budget !== undefined) {
    if (!(budget.fuel >= evaluationFuel)) {
      throw expressionError("expression.budget_exhausted", site, {
        remedy: "Do less work in the task's expressions, or split the task.",
      });
    }
    budget.fuel -= evaluationFuel;
  }
  return await evaluateExpression(
    compiled,
    scope,
    resultContracts[result],
    budget
  );
};
