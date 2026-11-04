/* oxlint-disable no-template-curly-in-string -- expressions are JavaScript source, template literals among them */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { checkExpressionTypes } from "./expression-types.ts";
import type {
  ExpressionScopeTypes,
  TypedExpression,
} from "./expression-types.ts";
import { libLocation } from "./type-check.ts";

// TypeScript's own declarations, where the kit has them: the check is
// pure (in memory), so tested on its own, with nothing of the kit but
// these.
const libDirectory = path.join(
  path.dirname(
    createRequire(import.meta.url).resolve("typescript/package.json")
  ),
  "lib"
);
const kitTypes = Object.fromEntries(
  readdirSync(libDirectory)
    .filter((name) => name.startsWith("lib.") && name.endsWith(".d.ts"))
    .map((name) => [
      `${libLocation}/${name}`,
      readFileSync(path.join(libDirectory, name), "utf-8"),
    ])
);

const scope: ExpressionScopeTypes = {
  input: "{ lines: { amount: number; tags: string[] }[]; customer: string }",
  steps: {
    extract: "{ statements: { id: string; total: number }[] }",
    "send-mail": "{ sent: boolean }",
  },
  params: "{ limit: number }",
  run: "{ id: string }",
};

const check = (expressions: Record<string, TypedExpression>) =>
  checkExpressionTypes(scope, expressions, kitTypes);

describe("type-checking a workflow's expressions", () => {
  it("passes what reads the values that are there", () => {
    expect(
      check({
        total: {
          source:
            "input.lines.map((line) => line.amount).filter((amount) => amount > params.limit)",
        },
        statement: {
          source:
            "steps.extract.output.statements.find((s) => s.total > 0)?.id ?? run.id",
        },
        sent: { source: "steps['send-mail'].output.sent", result: "boolean" },
        label: { source: "`${input.customer.trim()} (${input.lines.length})`" },
      })
    ).toStrictEqual({
      expressions: { total: [], statement: [], sent: [], label: [] },
      scope: [],
    });
  });

  it("finds a wrong reference, at its line and column in the expression", () => {
    const { expressions } = check({
      field: { source: "steps.extract.output.statments" },
      step: { source: "input.customer +\n  steps.extrct.output" },
      callback: {
        source: "input.lines.some((line) => line.tag.includes('x'))",
      },
      method: { source: "input.customer.toFixed(2)" },
    });
    expect(
      Object.fromEntries(
        Object.entries(expressions).map(([name, errors]) => [
          name,
          errors.map(({ code, line, column }) => ({ code, line, column })),
        ])
      )
    ).toStrictEqual({
      field: [{ code: "TS2551", line: 1, column: 22 }],
      step: [{ code: "TS2551", line: 2, column: 9 }],
      callback: [{ code: "TS2551", line: 1, column: 33 }],
      method: [{ code: "TS2551", line: 1, column: 16 }],
    });
  });

  it("holds a result to the type the workflow needs", () => {
    const { expressions } = check({
      condition: { source: "input.customer", result: "boolean" },
    });
    expect(
      expressions.condition?.map(({ code, line }) => ({ code, line }))
    ).toStrictEqual([{ code: "TS2322", line: 1 }]);
  });

  it("checks the subset before the types, and splices nothing it refuses", () => {
    const { expressions, scope: scopeErrors } = check({
      global: { source: "globalThis.fetch(input.customer)" },
      escape: { source: "input.customer)\n;globalThis.x\n;(" },
      fine: { source: "input.customer" },
    });
    expect({
      global: expressions.global?.map(({ code }) => code),
      escape: expressions.escape?.map(({ code }) => code),
      fine: expressions.fine,
      scopeErrors,
    }).toStrictEqual({
      global: ["expression.global", "expression.method"],
      escape: ["expression.syntax"],
      fine: [],
      scopeErrors: [],
    });
  });
});
