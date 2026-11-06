/* oxlint-disable no-template-curly-in-string -- expressions are JavaScript source, template literals among them */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { describe, expect, it } from "vite-plus/test";

import { expressionTypeCheck } from "./expression-types.ts";
import type {
  ExpressionScopeTypes,
  TypedExpression,
} from "./expression-types.ts";
import { typeCheck } from "./type-check.ts";

// The check is pure (in memory) on both sides of the checker's isolate,
// so tested on its own: the request it builds, run by tsrs as the
// isolate runs it (checker.ts), with nothing of the kit, and its
// diagnostics read back.
const tsrs: unknown = Reflect.construct(WebAssembly.Module, [
  readFileSync(createRequire(import.meta.url).resolve("@tsrs/wasm/tsrs.wasm")),
]);
if (!(tsrs instanceof WebAssembly.Module)) {
  throw new TypeError("tsrs's WebAssembly didn't compile");
}

const scope: ExpressionScopeTypes = {
  input: "{ lines: { amount: number; tags: string[] }[]; customer: string }",
  steps: {
    extract: "{ statements: { id: string; total: number }[] }",
    "send-mail": "{ sent: boolean }",
  },
  params: "{ limit: number }",
  run: "{ id: string }",
};

/** `expressions` checked against `types`, as core and the checker check them. */
const typed = (
  types: ExpressionScopeTypes,
  expressions: Record<string, TypedExpression>
) => {
  const { request, checked } = expressionTypeCheck(types, expressions);
  return checked(
    request === undefined
      ? []
      : typeCheck(tsrs, { files: {}, resolved: {} }, request)
  );
};

const check = (expressions: Record<string, TypedExpression>) =>
  typed(scope, expressions);

/** Each expression's problems, by code, line and column. */
const placesOf = (
  expressions: Readonly<
    Record<string, { code: string; line: number; column: number }[]>
  >
) =>
  Object.fromEntries(
    Object.entries(expressions).map(([name, errors]) => [
      name,
      errors.map(({ code, line, column }) => ({ code, line, column })),
    ])
  );

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
        sent: { source: "steps['send-mail'].output.sent" },
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
    const { expressions } = typed(
      { ...scope, input: "{ a: number; b: number; c: number; d: number }" },
      { pair: { source: "[input.a < input.b, input.c > (input.d)]" } }
    );
    expect(expressions.pair).toStrictEqual([]);
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
    const { expressions } = typed(
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
      }
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

  it("refuses a read that may be a method, by a union", () => {
    const { expressions } = typed(
      {
        ...scope,
        input: "{ un: string[] | { map: number }; list: string[] }",
      },
      {
        union: { source: "input.un.map" },
        notAllowed: { source: "input.list.push" },
      }
    );
    expect(
      Object.fromEntries(
        Object.entries(expressions).map(([name, errors]) => [
          name,
          errors.map(({ code, column, message }) => ({
            code,
            column,
            message,
          })),
        ])
      )
    ).toStrictEqual({
      union: [
        {
          code: "expression.method",
          column: 10,
          message: "`map` is a method, read without a call: it has no value.",
        },
      ],
      notAllowed: [
        {
          code: "expression.method",
          column: 12,
          message: "`push` is not one of the methods an expression can call.",
        },
      ],
    });
  });

  it("reads any field of a value typed `any`, one named like a method too", () => {
    const { expressions } = typed(
      {
        ...scope,
        steps: { ...scope.steps, loose: "any" },
        roots: { item: "any" },
      },
      {
        at: { source: "item.at" },
        computed: { source: "item['map']" },
        output: { source: "steps.loose.output.slice" },
        field: { source: "steps.loose.output.total" },
      }
    );
    expect(placesOf(expressions)).toStrictEqual({
      at: [],
      computed: [],
      output: [],
      field: [],
    });
  });

  it("refuses a method read once, not again at the reads of what holds it", () => {
    const { expressions } = typed(
      { ...scope, input: "{ s: string }" },
      {
        inArray: { source: "[input.s.trim][0]" },
        inObject: { source: "({ f: input.s.trim }).f" },
      }
    );
    expect(placesOf(expressions)).toStrictEqual({
      inArray: [{ code: "expression.method", line: 1, column: 10 }],
      inObject: [{ code: "expression.method", line: 1, column: 15 }],
    });
  });

  it("narrows a field by a check of it, as TypeScript does", () => {
    const { expressions } = typed(
      {
        ...scope,
        input:
          '{ note?: string; v: string | number; shape: { kind: "circle"; radius: number } | { kind: "square"; side: number }; maybe: { a: number } | null; s: string }',
      },
      {
        and: { source: "input.note && input.note.trim()" },
        typeofCheck: {
          source: "typeof input.v === 'string' ? input.v.trim() : ''",
        },
        discriminant: {
          source: "input.shape.kind === 'circle' ? input.shape.radius : 0",
        },
        nullCheck: { source: "input.maybe === null ? 0 : input.maybe.a" },
        undefinedCheck: {
          source: "input.note !== undefined ? input.note.trim() : ''",
        },
        notNarrowed: { source: "input.maybe.a" },
      }
    );
    expect(placesOf(expressions)).toStrictEqual({
      and: [],
      typeofCheck: [],
      discriminant: [],
      nullCheck: [],
      undefinedCheck: [],
      notNarrowed: [{ code: "TS18047", line: 1, column: 1 }],
    });
  });

  it("refuses a method read inside an optional chain, at its name", () => {
    const { expressions } = typed(
      {
        ...scope,
        input: "{ s?: string; maybe: { a: number } | null; list?: string[] }",
      },
      {
        chain: { source: "input.s?.trim.length" },
        deeper: { source: "input.maybe?.a.toFixed.length" },
        last: { source: "input.list?.join" },
        called: { source: "input.s?.trim().length ?? 0" },
      }
    );
    expect(placesOf(expressions)).toStrictEqual({
      chain: [{ code: "expression.method", line: 1, column: 10 }],
      deeper: [{ code: "expression.method", line: 1, column: 16 }],
      last: [{ code: "expression.method", line: 1, column: 13 }],
      called: [],
    });
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
    const { expressions } = typed(
      { ...scope, roots: { item: "{ amount: number }" } },
      {
        fine: { source: "item.amount > params.limit" },
        wrong: { source: "item.amout" },
      }
    );
    expect({
      fine: expressions.fine,
      wrong: expressions.wrong?.map(({ code, column }) => ({ code, column })),
    }).toStrictEqual({ fine: [], wrong: [{ code: "TS2551", column: 6 }] });
  });

  it("reads a file, an amount, a schedule and an ID by the SDK's value types", () => {
    const { expressions, scope: problems } = typed(
      {
        ...scope,
        input:
          '{ doc: FileValue; price: MoneyValue; when: ScheduleValue; row: Id<"rows"> }',
      },
      {
        fine: {
          source:
            "input.doc.id + input.price.currency + input.when.cron + input.row + input.price.minorUnits",
        },
        wrong: { source: "input.doc.name" },
      }
    );
    expect({
      problems,
      fine: expressions.fine,
      wrong: expressions.wrong?.map(({ code }) => code),
    }).toStrictEqual({ problems: [], fine: [], wrong: ["TS2339"] });
  });

  it("takes no root that is a default one again, or no plain identifier", () => {
    const refused = [
      "eval",
      "input",
      "item: unknown) => globalThis; ((x",
    ].filter((name) => {
      try {
        typed({ ...scope, roots: { [name]: "unknown" } }, {});
        return true;
      } catch {
        return false;
      }
    });
    expect(refused, "accepted as a root").toStrictEqual([]);
  });
});
