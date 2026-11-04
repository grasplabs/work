/* oxlint-disable no-template-curly-in-string -- expressions are JavaScript source, template literals among them */
/**
 * Workflow expressions in JavaScript (`checkExpression`). The generator
 * writes a checked expression as it is into the workflow's generated
 * TypeScript, which runs in the workflow's isolate with no interpreter in
 * between: the check is the only thing between a workflow's author (a
 * builder, or the agent writing for them) and the isolate's JavaScript.
 * What can go wrong:
 *
 * 1. An expression reaches a global (`globalThis`, `Function`, `eval`,
 *    `fetch`), directly or through the prototype chain of the data it
 *    reads (`constructor`, `__proto__`, `prototype`), under a name the
 *    check reads differently from the engine (Unicode escapes, computed
 *    or template keys).
 * 2. It calls code the allowlist doesn't name: a method read as a value
 *    and passed where a callback goes, a tagged template, `new`, a getter
 *    or method defined in an object literal, or `__proto__` set by one.
 * 3. It changes state: assignment, `++`, `delete`, a mutating method.
 * 4. It parses as one thing here and another in the generated TypeScript:
 *    `a < b > (c)` is two comparisons in JavaScript and a generic call in
 *    TypeScript, which would call `a` with what the check took for data.
 * 5. It splices into the generated code as more than one expression: a
 *    comment or an unclosed bracket that swallows what follows.
 * 6. It runs without end: nested `map` over large arrays. JavaScript has
 *    no loops here and no recursion (no function can name itself), so
 *    the work is at most polynomial in the data's size; what bounds it is
 *    the isolate's CPU and memory limits, as for compute modules, not the
 *    check.
 */
import { describe, expect, it } from "vite-plus/test";

import { checkExpression, expressionCode } from "../src/expression-check.ts";

/** The code of the first error an expression fails with, or `ok`. */
const verdict = (source: string): string => {
  const checked = checkExpression(source);
  return checked.ok ? "ok" : (checked.errors[0]?.code ?? "no error");
};

describe("what a workflow expression may be", () => {
  it("reads the workflow's data and works on it with the allowed methods", () => {
    const allowed = [
      "steps.extract.output.statements",
      "input.lines?.[0]?.amount ?? 0",
      'input["first name"]',
      "input.lines.length > 0 && params.limit >= 3",
      "input.total * 1.21 - params.discount / 2 + 3 ** 2 % 5",
      "!input.done || -input.offset === +params.offset",
      "typeof input.note === 'string' ? input.note.trim() : ''",
      "`${input.name} (${run.id})`",
      "{ id: input.id, 'due date': input.due, total: input.lines.length, }",
      "[input.a, input.b, null, true, 1e3]",
      "input.lines.map((line) => line.amount * 2)",
      "input.lines.filter((line, index) => index < params.limit && line.ok)",
      "input.lines.some((line) => line.tags.includes('urgent'))",
      "input.lines.every((l) => l.total.toFixed(2) !== '0.00')",
      "input.people.find((p) => p.email.toLowerCase().endsWith('@acme.test'))?.name",
      "input.people.findIndex((p) => p.id === params.id)",
      "input.rows.map((row) => row.cells.map((cell) => cell.value).join(', '))",
      "input.name.split(' ').at(-1).toUpperCase().startsWith('A')",
      "input.items.slice(0, 3).concat(input.more).indexOf(input.pick)",
      "input.title.trimStart().trimEnd()",
      "{ ...input.record, status: 'done' }",
      "[...input.a, ...input.b]",
      "input.a == null ? params.fallback : input.a",
    ];
    expect(
      allowed.filter((source) => verdict(source) !== "ok"),
      "refused, though allowed"
    ).toStrictEqual([]);
  });

  it("gives the source back as it was written", () => {
    expect(checkExpression(" input.a ")).toStrictEqual({
      ok: true,
      source: " input.a ",
    });
  });
});

describe("reaching a global", () => {
  it("is refused under any name but the workflow's own", () => {
    expect(
      [
        "globalThis",
        "globalThis.fetch('https://example.com')",
        "Function('return this')()",
        "eval('1')",
        "fetch",
        "self",
        "window",
        "process.env",
        "Object.keys(input)",
        "JSON.stringify(input)",
        "Math.max(input.a, 1)",
        "Date.now()",
        "String(input.a)",
        "undefined",
        "NaN",
        "arguments",
        "require('fs')",
        "env",
        "ctx",
        // A callback's parameter is in scope inside it, not after.
        "input.lines.map((line) => line) && line",
      ].map(verdict)
    ).toStrictEqual(Array.from({ length: 20 }, () => "expression.global"));
  });

  it("is refused written with Unicode escapes", () => {
    expect([
      verdict(String.raw`globalTh\u0069s`),
      verdict(String.raw`\u{65}val('1')`),
    ]).toStrictEqual(["expression.global", "expression.global"]);
  });

  it("is refused through `this`, `import`, `new.target` and `import.meta`", () => {
    expect(
      ["this", "import('x')", "import.meta.url", "input.lines.map((l) => this)"]
        .map(verdict)
        .every((code) => code === "expression.syntax")
    ).toBeTruthy();
  });
});

describe("the prototype chain of the data", () => {
  it("is out of reach by every way of writing a property's name", () => {
    expect(
      [
        "input.constructor",
        "input.a.constructor.constructor('return globalThis')()",
        "input.__proto__",
        "input.lines.prototype",
        "input?.constructor",
        "input['constructor']",
        "input?.['__proto__']",
        String.raw`input.\u0063onstructor`,
        String.raw`input['\u0063onstructor']`,
        String.raw`input['\x5f_proto__']`,
        "input.__defineGetter__",
        "input.__lookupSetter__",
        "input.lines.map((l) => l.constructor)",
      ].map(verdict)
    ).toStrictEqual(Array.from({ length: 13 }, () => "expression.property"));
  });

  it("is out of reach by a computed name", () => {
    expect(
      [
        "input[params.key]",
        "input['con' + 'structor']",
        "input[`constructor`]",
        "input[`${params.key}`]",
        "input[input.a ? 'a' : 'b']",
      ].map(verdict)
    ).toStrictEqual(Array.from({ length: 5 }, () => "expression.computed-key"));
  });

  it("is out of reach by an object literal's `__proto__`", () => {
    expect(
      [
        "{ __proto__: input }",
        "{ '__proto__': input }",
        String.raw`{ \u005f_proto__: input }`,
        "{ constructor: input }",
      ].map(verdict)
    ).toStrictEqual(Array.from({ length: 4 }, () => "expression.property"));
  });
});

describe("calling code", () => {
  it("is only the allowed methods, by name", () => {
    expect(
      [
        "input.lines.push(1)",
        "input.lines.sort()",
        "input.lines.reverse()",
        "input.lines.splice(0)",
        "input.lines.fill(0)",
        "input.lines.reduce((a, b) => a + b)",
        "input.name.replace('a', 'b')",
        "input.name.repeat(1e9)",
        "input.name.padStart(1e9)",
        "input.toString()",
        "input.valueOf()",
        "input.hasOwnProperty('a')",
        "input.lines['map']((l) => l)",
        "input.lines[`map`]((l) => l)",
        "input.lines.map.call(input, (l) => l)",
        "input.lines.map.apply(input, [])",
        "input.lines.map.bind(input)",
        "input.f()",
        "(0, input.lines.map)((l) => l)",
        "params.run()",
      ]
        .map(verdict)
        .filter(
          (code) =>
            code !== "expression.method" && code !== "expression.computed-key"
        )
    ).toStrictEqual(["expression.syntax"]);
  });

  it("passes only an arrow function of its own where a callback goes", () => {
    expect(
      [
        // A method read as a value, called by `map` with `this` set to
        // what `thisArg` names: `push` would write into the data.
        "input.lines.map(input.other.push, input.target)",
        "input.lines.map((l) => l, input.target)",
        "input.lines.filter(input.check)",
        "input.lines.map()",
        "input.lines.join((l) => l)",
        "input.name.includes((l) => l)",
        "input.lines.map(...input.fns)",
      ].map(verdict)
    ).toStrictEqual(Array.from({ length: 7 }, () => "expression.callback"));
  });

  it("defines no function but such a callback, and none with a body", () => {
    expect(
      [
        "(l) => l",
        "{ f: (l) => l }",
        "[(l) => l]",
        "input.lines.map((l) => { return l; })",
        "input.lines.map(async (l) => l)",
        "input.lines.map(({ a }) => a)",
        "input.lines.map(([a]) => a)",
        "input.lines.map((a = globalThis) => a)",
        "input.lines.map((...rest) => rest)",
        "input.lines.map(function (l) { return l; })",
        "input.lines.map((l) => (m) => m)",
      ].map(verdict)
    ).toStrictEqual([
      "expression.callback",
      "expression.callback",
      "expression.callback",
      "expression.callback",
      "expression.callback",
      "expression.callback",
      "expression.callback",
      "expression.callback",
      "expression.callback",
      "expression.callback",
      "expression.callback",
    ]);
  });

  it("is never a tagged template, `new`, a getter or a method", () => {
    expect(
      [
        "input.lines.join`,`",
        "String.raw`a`",
        "new input.Thing()",
        "{ get total() { return 1; } }",
        "{ set total(v) {} }",
        "{ total() { return 1; } }",
        "{ [params.key]: 1 }",
        "class {}",
        "function () {}",
      ].map(verdict)
    ).toStrictEqual([
      "expression.syntax",
      "expression.syntax",
      "expression.syntax",
      "expression.syntax",
      "expression.syntax",
      "expression.syntax",
      "expression.computed-key",
      "expression.syntax",
      "expression.callback",
    ]);
  });

  it("spreads nothing into a call", () => {
    expect(verdict("input.lines.concat(...input.more)")).toBe(
      "expression.syntax"
    );
  });
});

describe("changing state", () => {
  it("is refused", () => {
    expect(
      [
        "input.a = 1",
        "input.a += 1",
        "input.a ??= 1",
        "input.a++",
        "--input.a",
        "delete input.a",
        "void input.a",
        "input.a, input.b",
        "await input.a",
        "yield input.a",
      ]
        .map(verdict)
        .every((code) => code === "expression.syntax")
    ).toBeTruthy();
  });
});

describe("what parses differently in TypeScript", () => {
  it("is refused: no comparison of a comparison, no bitwise operators", () => {
    expect(
      [
        // A generic call in TypeScript: `input.f<input.b>(input.c)`.
        "input.f < input.b > (input.c)",
        "input.f < input.b > input.c",
        "(input.a < input.b) >= input.c",
        "input.f < input.b <= input.c",
        // TypeScript's own generic call, which is JavaScript too.
        "input.f<string>(input.a)",
      ].map(verdict)
    ).toStrictEqual(
      Array.from({ length: 5 }, () => "expression.chained-comparison")
    );
    expect(
      [
        // `input.f<input.b | input.c>(input.d)` in TypeScript.
        "input.f < input.b | input.c > (input.d)",
        "input.f < input.b & input.c > (input.d)",
        "input.a ^ input.b",
        "~input.a",
        "input.f < (input.b >> input.c)",
        "input.a << 2",
        "input.a >>> 0",
        "'a' in input",
        "input instanceof input.b",
      ].map(verdict)
    ).toStrictEqual(Array.from({ length: 9 }, () => "expression.operator"));
  });

  it("is refused as TypeScript syntax, which JavaScript doesn't parse", () => {
    expect(
      [
        "input.a as string",
        "input.a!",
        "input.a satisfies string",
        "<string>input.a",
      ].map(verdict)
    ).toStrictEqual(Array.from({ length: 4 }, () => "expression.syntax"));
  });
});

describe("splicing into the generated code", () => {
  it("is one expression, whole, or nothing", () => {
    expect(
      [
        "input.a; globalThis.x",
        "input.a)\n;globalThis.fetch('x')\n;(",
        "input.a /*",
        "input.a } ; globalThis.x ; {",
        "",
        "   ",
        // Code in an HTML comment of a script, which a module doesn't have.
        "input.a <!-- globalThis",
      ].map(verdict)
    ).toStrictEqual(Array.from({ length: 7 }, () => "expression.syntax"));
  });

  it("keeps a trailing comment from swallowing the code after it", () => {
    const checked = checkExpression("input.a // the amount");
    expect(checked.ok && expressionCode(checked)).toBe(
      "(\ninput.a // the amount\n)"
    );
  });

  it("refuses a regular expression, whose work no limit of ours bounds", () => {
    expect(verdict("/(a+)+$/.test(input.name)")).toBe("expression.syntax");
  });
});

describe("the roots an expression reads", () => {
  it("are the default ones and those the caller adds, such as a loop's item", () => {
    expect({
      item: checkExpression("item.total > params.limit", { roots: ["item"] })
        .ok,
      // Added to the default ones, which stay in scope.
      error: checkExpression("error.message ?? run.id", { roots: ["error"] })
        .ok,
      // Only those named: without `item`, it is a global.
      byDefault: verdict("item.total"),
    }).toStrictEqual({
      item: true,
      error: true,
      byDefault: "expression.global",
    });
  });

  it("are never a global's name, or anything but a plain identifier", () => {
    const refused = [
      // The default ones again.
      "input",
      "run",
      // Globals, of this isolate or only of others (`window`, `document`,
      // `process`, `require`, `Deno`): one fixed list wherever it runs.
      "globalThis",
      "document",
      "require",
      "Deno",
      "Function",
      "eval",
      "fetch",
      "Object",
      "undefined",
      "arguments",
      "self",
      "window",
      "process",
      "this",
      "yield",
      "let",
      "await",
      "item.total",
      "a b",
      "",
      String.raw`\u0069tem`,
      "ítem",
      "item)=>globalThis;((x",
    ];
    expect(
      refused.filter((root) => {
        try {
          checkExpression("1", { roots: ["item", root] });
          return true;
        } catch {
          return false;
        }
      }),
      "accepted as a root"
    ).toStrictEqual([]);
  });
});

describe("an error", () => {
  it("says where it is and how to fix it", () => {
    const checked = checkExpression("input.lines.map((l) =>\n  globalThis)");
    expect(checked).toStrictEqual({
      ok: false,
      errors: [
        {
          code: "expression.global",
          message:
            "`globalThis` is not one of the workflow's values: input, steps, params, run.",
          fix: "Start from one of the values the message names, or a callback's own parameter.",
          offset: 25,
          line: 2,
          column: 3,
        },
      ],
    });
  });

  it("names every problem, not only the first", () => {
    const checked = checkExpression("eval(input.constructor)");
    expect(
      checked.ok ? [] : checked.errors.map(({ code }) => code)
    ).toStrictEqual(["expression.global", "expression.property"]);
  });

  it("of syntax has its position too", () => {
    const checked = checkExpression("input.a +");
    expect(checked.ok ? undefined : checked.errors[0]).toMatchObject({
      code: "expression.syntax",
      line: 1,
    });
  });
});
