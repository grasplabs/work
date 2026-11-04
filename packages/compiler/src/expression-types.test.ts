/* oxlint-disable no-template-curly-in-string -- expressions are JavaScript source, template literals among them */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { checkExpression } from "@grasp-os/sdk/expression-check";
import ts from "typescript";
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

/** How many type arguments TypeScript reads in an expression's code and type form. */
const withTypeArguments = (source: string): number => {
  const checked = checkExpression(source);
  if (!checked.ok) {
    throw new Error(`${source} is refused`);
  }
  let found = 0;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isCallExpression(node) || ts.isExpressionWithTypeArguments(node)) &&
      node.typeArguments !== undefined
    ) {
      found += 1;
    }
    ts.forEachChild(node, visit);
  };
  for (const code of [checked.code, checked.forTypes.code]) {
    visit(
      ts.createSourceFile("e.ts", `const e = ${code};`, ts.ScriptTarget.ES2022)
    );
  }
  return found;
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
      // A line separator ends a line, as TypeScript counts them.
      separated: {
        source: `input.customer +${String.fromCodePoint(0x20_28)}  steps.extrct.output`,
      },
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
      separated: [{ code: "TS2551", line: 2, column: 9 }],
      callback: [{ code: "TS2551", line: 1, column: 33 }],
      method: [{ code: "TS2551", line: 1, column: 16 }],
    });
  });

  it("reads what JavaScript reads: comparisons, never a generic call", () => {
    const { expressions } = checkExpressionTypes(
      { ...scope, input: "{ a: number; b: number; c: number; d: number }" },
      { pair: { source: "[input.a < input.b, input.c > (input.d)]" } },
      kitTypes
    );
    expect(expressions.pair).toStrictEqual([]);
  });

  it("runs code TypeScript reads as JavaScript does, with no type arguments", () => {
    expect(
      [
        "[input.a < input.b, input.c > (input.d)]",
        "[1 < 2, 3 > (4)]",
        "input.lines.map((x) => [x < 1, 2 > (x)])",
      ].map(withTypeArguments)
    ).toStrictEqual([0, 0, 0]);
  });

  it("maps an error back past the parentheses it adds, to the source", () => {
    const { expressions } = check({
      sum: { source: "1 + -input.lines.length * input.custmer" },
      lines: { source: "input.customer\n  // a note\n  + !input.lnes" },
    });
    expect(
      Object.fromEntries(
        Object.entries(expressions).map(([name, errors]) => [
          name,
          errors.map(({ code, line, column }) => ({ code, line, column })),
        ])
      )
    ).toStrictEqual({
      sum: [{ code: "TS2551", line: 1, column: 33 }],
      lines: [{ code: "TS2551", line: 3, column: 12 }],
    });
  });

  it("can't be silenced from inside an expression", () => {
    const { expressions } = check({
      ignored: { source: "// @ts-ignore\ninput.custmer" },
      // An emoji is two UTF-16 units: the error stays at its column after it.
      emoji: { source: "/*\u{1F600}*/ input.custmer < 1" },
    });
    expect(
      Object.fromEntries(
        Object.entries(expressions).map(([name, errors]) => [
          name,
          errors.map(({ code, line, column }) => ({ code, line, column })),
        ])
      )
    ).toStrictEqual({
      ignored: [{ code: "TS2551", line: 2, column: 7 }],
      emoji: [{ code: "TS2551", line: 1, column: 14 }],
    });
  });

  it("reads a data field named like a method, but no method without a call", () => {
    const { expressions } = checkExpressionTypes(
      {
        ...scope,
        input: "{ at: string; map: { join: number }; list: string[] }",
      },
      {
        field: { source: "input.at.trim() + input.map.join" },
        called: { source: "input.list.map((item) => item.at(0)).join(', ')" },
        method: { source: "input.list.map" },
        optional: { source: "[input.list?.join, input.at['trim']]" },
        inCallback: { source: "input.list.map((item) => item.trim)" },
      },
      kitTypes
    );
    expect(
      Object.fromEntries(
        Object.entries(expressions).map(([name, errors]) => [
          name,
          errors.map(({ code, line, column }) => ({ code, line, column })),
        ])
      )
    ).toStrictEqual({
      field: [],
      called: [],
      method: [{ code: "expression.method", line: 1, column: 12 }],
      optional: [
        { code: "expression.method", line: 1, column: 14 },
        { code: "expression.method", line: 1, column: 29 },
      ],
      inCallback: [{ code: "expression.method", line: 1, column: 31 }],
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

  it("reads a further root, such as a loop's item, by the type it is given", () => {
    const { expressions } = checkExpressionTypes(
      { ...scope, roots: { item: "{ amount: number }" } },
      {
        fine: { source: "item.amount > params.limit", result: "boolean" },
        wrong: { source: "item.amout" },
      },
      kitTypes
    );
    expect({
      fine: expressions.fine,
      wrong: expressions.wrong?.map(({ code, column }) => ({ code, column })),
    }).toStrictEqual({ fine: [], wrong: [{ code: "TS2551", column: 6 }] });
  });

  it("takes no root that is a default one again, or no plain identifier", () => {
    const refused = [
      "eval",
      "input",
      "item: unknown) => globalThis; ((x",
    ].filter((name) => {
      try {
        checkExpressionTypes(
          { ...scope, roots: { [name]: "unknown" } },
          {},
          kitTypes
        );
        return true;
      } catch {
        return false;
      }
    });
    expect(refused, "accepted as a root").toStrictEqual([]);
  });
});
