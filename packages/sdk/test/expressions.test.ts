/**
 * The workflow SDK's `evaluate`, as code generated from a JSON workflow
 * calls it inside a run's isolate. The evaluator's own threat model is
 * workflow-expressions' (its attacks.test.ts); what this entry adds, and
 * what can go wrong with it:
 *
 * 1. Code that isn't the generator's (an App's, or a forged module)
 *    passes what the types forbid: a stage that isn't one, a variable its
 *    stage doesn't have, a result kind named after `Object.prototype`.
 * 2. A step spends more than one step may, one cheap evaluation at a time,
 *    and whether it may differs between runs or hosts.
 * 3. An error carries the values the expression ran on out of the step.
 */
import { expressionErrors } from "@grasp-os/workflow-expressions/errors";
import { describe, expect, it } from "vite-plus/test";

import {
  evaluate,
  evaluationFuel,
  expressionBudget,
  stepExpressionFuel,
} from "../src/workflow.ts";
import type {
  EvaluateOptions,
  Expression,
  ExpressionScope,
} from "../src/workflow.ts";

const task = (source: string): Expression<"taskDefinition"> => ({
  source,
  stage: "taskDefinition",
  pointer: "/do/0/check/set",
  scope: ["check"],
});

const definitionScope = (
  input: unknown,
  context: unknown = {}
): ExpressionScope<"taskDefinition"> =>
  // SAFETY: test values are plain JSON; hostile ones are passed on purpose.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  ({
    input,
    variables: {
      context,
      input,
      task: { name: "check" },
      workflow: { input: {} },
      params: { limit: 3 },
    },
  }) as ExpressionScope<"taskDefinition">;

/** The result, or the code of the expression error it failed with. */
const outcome = async (
  expression: Expression<"taskDefinition">,
  scope: ExpressionScope<"taskDefinition">,
  options?: EvaluateOptions
): Promise<{ result: unknown } | { error: string | undefined }> => {
  try {
    return { result: await evaluate(expression, scope, options) };
  } catch (error) {
    return { error: expressionErrors.codeOf(error) };
  }
};

/** A budget with enough for two small evaluations and part of a third. */
const nearlySpent = (): { fuel: number } => ({
  fuel: 2 ** 24 + 2 * evaluationFuel + 2 ** 16,
});

/** What a caller that isn't type-checked can pass. */
const unchecked = (value: unknown): never =>
  // SAFETY: invalid on purpose; evaluate checks it at run time.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  value as never;

describe(evaluate, () => {
  it("runs a task's data flow on its input and variables", async () => {
    const invoice = { amount: 1200, lines: [{ sku: "a" }, { sku: "b" }] };
    expect({
      value: await outcome(
        task("{ total: .amount, count: (.lines | length) }"),
        definitionScope(invoice)
      ),
      variables: await outcome(
        task('$context.owner + " / " + $task.name'),
        definitionScope(invoice, { owner: "finance" })
      ),
      params: await outcome(task("$params.limit"), definitionScope(invoice)),
      runtime: await outcome(task("$runtime.name"), definitionScope(invoice)),
    }).toStrictEqual({
      value: { result: { total: 1200, count: 2 } },
      variables: { result: "finance / check" },
      params: { result: 3 },
      runtime: { result: "Grasp" },
    });
  });

  it("holds a condition to a boolean and a duration to milliseconds", async () => {
    const scope = definitionScope({ amount: 1200 });
    expect({
      holds: await outcome(task(".amount > 1000"), scope, {
        result: "boolean",
      }),
      truthy: await outcome(task(".amount"), scope, { result: "boolean" }),
      iso: await outcome(task('"PT2M"'), scope, { result: "duration" }),
      ms: await outcome(task("1500"), scope, { result: "duration" }),
    }).toStrictEqual({
      holds: { result: true },
      truthy: { error: "expression.type_mismatch" },
      iso: { result: 120_000 },
      ms: { result: 1500 },
    });
  });

  it("refuses what the types forbid, from code that isn't type-checked", async () => {
    const scope = definitionScope({});
    expect({
      stage: await outcome(
        { ...task("."), stage: unchecked("anywhere") },
        scope
      ),
      variable: await outcome(task("$secrets"), scope),
      notAStageVariable: await outcome(
        { ...task("$output"), stage: unchecked("taskInputFrom") },
        scope
      ),
      profile: await outcome(task("input"), scope),
      prototypeResult: await outcome(task("."), scope, {
        result: unchecked("__proto__"),
      }),
      otherResult: await outcome(task("."), scope, {
        result: unchecked("schema"),
      }),
      syntax: await outcome(task(". |"), scope),
    }).toStrictEqual({
      stage: { error: "expression.invalid" },
      variable: { error: "expression.unavailable_variable" },
      notAStageVariable: { error: "expression.unavailable_variable" },
      profile: { error: "expression.unsupported" },
      prototypeResult: { error: "expression.invalid" },
      otherResult: { error: "expression.invalid" },
      syntax: { error: "expression.invalid" },
    });
  });

  it("refuses values that aren't plain JSON, without running jq on them", async () => {
    const getter = {
      get amount(): number {
        throw new Error("read me");
      },
    };
    expect({
      getter: await outcome(task("."), definitionScope(getter)),
      polluted: await outcome(
        task("."),
        definitionScope(JSON.parse('{"__proto__": {"admin": true}}'))
      ),
      notJson: await outcome(task("."), definitionScope(Number.NaN)),
    }).toStrictEqual({
      getter: { error: "expression.context_invalid" },
      polluted: { error: "expression.context_invalid" },
      notJson: { error: "expression.context_invalid" },
    });
  });

  it("never carries the values it ran on in its error", async () => {
    const secret = "salary-81234";
    const thrown: unknown = await evaluate(
      task(".pay | tonumber"),
      definitionScope({ pay: secret })
    ).catch((error: unknown) => error);
    expect(expressionErrors.codeOf(thrown)).toBe("expression.failed");
    expect(JSON.stringify(thrown)).not.toContain(secret);
    expect(thrown instanceof Error ? thrown.message : "").not.toContain(secret);
  });

  it("stops a step's evaluations at its budget, the same way every time", async () => {
    const count = async (): Promise<{ ran: number; error?: string }> => {
      const budget = expressionBudget();
      let ran = 0;
      try {
        for (;;) {
          // oxlint-disable-next-line no-await-in-loop -- one after another, as a step evaluates
          await evaluate(task(". + 1"), definitionScope(ran), { budget });
          ran += 1;
        }
      } catch (error) {
        return { ran, error: expressionErrors.codeOf(error) };
      }
    };
    const first = await count();
    expect(first.error).toBe("expression.budget_exhausted");
    expect(first.ran).toBeLessThanOrEqual(stepExpressionFuel / evaluationFuel);
    expect(first.ran).toBeGreaterThan(0);
    await expect(count()).resolves.toStrictEqual(first);
  });

  it("ends evaluations started at once on a budget as one after another would", async () => {
    const sources = [
      "[range(0; 1000)] | length",
      "[range(0; 1000)] | length",
      "[range(0; 1000000)] | length",
      ". + 1",
    ];
    const inTurn = async () => {
      const budget = nearlySpent();
      const outcomes = [];
      for (const source of sources) {
        // oxlint-disable-next-line no-await-in-loop -- one after another, on purpose
        const one = await outcome(task(source), definitionScope(1), { budget });
        outcomes.push(one);
      }
      return { outcomes, left: budget.fuel };
    };
    const atOnce = async () => {
      const budget = nearlySpent();
      const outcomes = await Promise.all(
        sources.map(
          async (source) =>
            await outcome(task(source), definitionScope(1), { budget })
        )
      );
      return { outcomes, left: budget.fuel };
    };
    const expected = await inTurn();
    expect(expected.outcomes.map((one) => "error" in one)).toStrictEqual([
      false,
      false,
      true,
      true,
    ]);
    await expect(atOnce()).resolves.toStrictEqual(expected);
  });

  it("gives an evaluation no more fuel than its step has left", async () => {
    const spin = task("[range(0; 1000000)] | length");
    expect({
      alone: await outcome(spin, definitionScope(null)),
      inABudgetNearlySpent: await outcome(spin, definitionScope(null), {
        budget: { fuel: evaluationFuel + 1000 },
      }),
    }).toStrictEqual({
      alone: { error: "expression.resource_exhausted" },
      inABudgetNearlySpent: { error: "expression.budget_exhausted" },
    });
  });
});
