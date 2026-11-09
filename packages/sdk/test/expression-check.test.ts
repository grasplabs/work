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

import { checkExpression } from "../src/expression-check.ts";
import { own } from "../src/expression-runtime.ts";

/** The code an expression runs as. */
const generated = (source: string): string => {
  const checked = checkExpression(source);
  if (!checked.ok) {
    throw new Error(`${source} is refused: ${checked.errors[0]?.code}`);
  }
  return checked.code;
};

/**
 * What an expression answers on `args`, run as the code it generates is,
 * with the guard it imports (`$own`).
 */
const evaluated = (source: string, args: unknown): unknown => {
  // oxlint-disable-next-line typescript/no-implied-eval, no-new-func -- runs the code the check generated, as a workflow's isolate does
  const code = new Function("args", "$own", `return ${generated(source)};`);
  const answered: unknown = Reflect.apply(code, undefined, [args, own]);
  return answered;
};

/** The code of the first error an expression fails with, or `ok`. */
const verdict = (source: string): string => {
  const checked = checkExpression(source);
  return checked.ok ? "ok" : (checked.errors[0]?.code ?? "no error");
};

describe("what a workflow expression may be", () => {
  it("reads the workflow's data and works on it with the allowed methods", () => {
    const allowed = [
      "args.extract.statements",
      "args.lines?.[0]?.amount ?? 0",
      'args["first name"]',
      "args.lines.length > 0 && params.limit >= 3",
      "args.total * 1.21 - params.discount / 2 + 3 ** 2 % 5",
      "!args.done || -args.offset === +params.offset",
      "typeof args.note === 'string' ? args.note.trim() : ''",
      "`${args.name} (${run.id})`",
      "{ id: args.id, 'due date': args.due, total: args.lines.length, }",
      "[args.a, args.b, null, true, 1e3]",
      "args.lines.map((line) => line.amount * 2)",
      "args.lines.filter((line, index) => index < params.limit && line.ok)",
      "args.lines.some((line) => line.tags.includes('urgent'))",
      "args.lines.every((l) => l.total.toFixed(2) !== '0.00')",
      "args.people.find((p) => p.email.toLowerCase().endsWith('@acme.test'))?.name",
      "args.people.findIndex((p) => p.id === params.id)",
      "args.rows.map((row) => row.cells.map((cell) => cell.value).join(', '))",
      "args.name.split(' ').at(-1).toUpperCase().startsWith('A')",
      "args.items.slice(0, 3).concat(args.more).indexOf(args.pick)",
      "args.title.trimStart().trimEnd()",
      "{ ...args.record, status: 'done' }",
      "[...args.a, ...args.b]",
      "args.a == null ? params.fallback : args.a",
    ];
    expect(
      allowed.filter((source) => verdict(source) !== "ok"),
      "refused, though allowed"
    ).toStrictEqual([]);
  });

  it("gives the source back as it was written, and the code to run", () => {
    expect(checkExpression(" args.a ")).toStrictEqual({
      ok: true,
      source: " args.a ",
      code: "(args.a)",
      reads: [{ root: "args", path: ["a"] }],
      literalDepth: 0,
    });
  });

  it("says how deep its literals nest, one in another", () => {
    expect(
      [
        "args.a",
        "[args]",
        "[{ a: [1] }, []]",
        "args.lines.map((line) => ({ at: [line] }))",
      ].map((source) => {
        const checked = checkExpression(source);
        return checked.ok ? checked.literalDepth : checked.errors;
      })
    ).toStrictEqual([0, 1, 3, 2]);
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
        "Object.keys(args)",
        "JSON.stringify(args)",
        "Math.max(args.a, 1)",
        "Date.now()",
        "String(args.a)",
        "NaN",
        "arguments",
        "require('fs')",
        "env",
        "ctx",
        // A callback's parameter is in scope inside it, not after.
        "args.lines.map((line) => line) && line",
      ].map(verdict)
    ).toStrictEqual(Array.from({ length: 19 }, () => "expression.global"));
  });

  it("reads `undefined` as the value it is, never a global's", () => {
    expect(
      [
        "undefined",
        "args.note !== undefined ? args.note : ''",
        "args.lines.filter((line) => line.note === undefined)",
      ].map(verdict)
    ).toStrictEqual(["ok", "ok", "ok"]);
  });

  it("is refused written with Unicode escapes", () => {
    expect([
      verdict(String.raw`globalTh\u0069s`),
      verdict(String.raw`\u{65}val('1')`),
    ]).toStrictEqual(["expression.global", "expression.global"]);
  });

  it("is refused through `this`, `import`, `new.target` and `import.meta`", () => {
    expect(
      ["this", "import('x')", "import.meta.url", "args.lines.map((l) => this)"]
        .map(verdict)
        .every((code) => code === "expression.syntax")
    ).toBeTruthy();
  });
});

describe("the prototype chain of the data", () => {
  it("is out of reach by every way of writing a property's name", () => {
    expect(
      [
        "args.constructor",
        "args.a.constructor.constructor('return globalThis')()",
        "args.__proto__",
        "args.lines.prototype",
        "args?.constructor",
        "args['constructor']",
        "args?.['__proto__']",
        String.raw`args.\u0063onstructor`,
        String.raw`args['\u0063onstructor']`,
        String.raw`args['\x5f_proto__']`,
        "args.__defineGetter__",
        "args.__lookupSetter__",
        "args.lines.map((l) => l.constructor)",
      ].map(verdict)
    ).toStrictEqual(Array.from({ length: 13 }, () => "expression.property"));
  });

  it("is out of reach by a computed name", () => {
    expect(
      [
        "args[params.key]",
        "args['con' + 'structor']",
        "args[`constructor`]",
        "args[`${params.key}`]",
        "args[args.a ? 'a' : 'b']",
      ].map(verdict)
    ).toStrictEqual(Array.from({ length: 5 }, () => "expression.computed-key"));
  });

  it("is out of reach by an object literal's `__proto__`", () => {
    expect(
      [
        "{ __proto__: args }",
        "{ '__proto__': args }",
        String.raw`{ \u005f_proto__: args }`,
        "{ constructor: args }",
      ].map(verdict)
    ).toStrictEqual(Array.from({ length: 4 }, () => "expression.property"));
  });
});

describe("calling code", () => {
  it("is only the allowed methods, by name", () => {
    expect(
      [
        "args.lines.push(1)",
        "args.lines.sort()",
        "args.lines.reverse()",
        "args.lines.splice(0)",
        "args.lines.fill(0)",
        "args.lines.reduce((a, b) => a + b)",
        "args.name.replace('a', 'b')",
        "args.name.repeat(1e9)",
        "args.name.padStart(1e9)",
        "args.toString()",
        "args.valueOf()",
        "args.hasOwnProperty('a')",
        "args.lines['map']((l) => l)",
        "args.lines[`map`]((l) => l)",
        "args.lines.map.call(args, (l) => l)",
        "args.lines.map.apply(args, [])",
        "args.lines.map.bind(args)",
        "args.f()",
        "(0, args.lines.map)((l) => l)",
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
        "args.lines.map(args.other.push, args.target)",
        "args.lines.map((l) => l, args.target)",
        "args.lines.filter(args.check)",
        "args.lines.map()",
        "args.lines.join((l) => l)",
        "args.name.includes((l) => l)",
        "args.lines.map(...args.fns)",
      ].map(verdict)
    ).toStrictEqual(Array.from({ length: 7 }, () => "expression.callback"));
  });

  it("defines no function but such a callback, and none with a body", () => {
    expect(
      [
        "(l) => l",
        "{ f: (l) => l }",
        "[(l) => l]",
        "args.lines.map((l) => { return l; })",
        "args.lines.map(async (l) => l)",
        "args.lines.map(({ a }) => a)",
        "args.lines.map(([a]) => a)",
        "args.lines.map((a = globalThis) => a)",
        "args.lines.map((...rest) => rest)",
        "args.lines.map(function (l) { return l; })",
        "args.lines.map((l) => (m) => m)",
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
        "args.lines.join`,`",
        "String.raw`a`",
        "new args.Thing()",
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

  it("reads a data field named like a method, as `$read` reads own data", () => {
    expect(
      ["args.at", "args.list.map", "args?.join", "{ at: args.at }"].map(verdict)
    ).toStrictEqual(["ok", "ok", "ok", "ok"]);
  });

  it("spreads nothing into a call", () => {
    expect(verdict("args.lines.concat(...args.more)")).toBe(
      "expression.syntax"
    );
  });
});

describe("changing state", () => {
  it("is refused", () => {
    expect(
      [
        "args.a = 1",
        "args.a += 1",
        "args.a ??= 1",
        "args.a++",
        "--args.a",
        "delete args.a",
        "void args.a",
        "args.a, args.b",
        "await args.a",
        "yield args.a",
      ]
        .map(verdict)
        .every((code) => code === "expression.syntax")
    ).toBeTruthy();
  });
});

describe("operators", () => {
  it("are those that work on values: no bitwise ones, no `in` or `instanceof`", () => {
    expect(
      [
        "args.a | args.b",
        "args.a & args.b",
        "args.a ^ args.b",
        "~args.a",
        "args.a >> 1",
        "args.a << 2",
        "args.a >>> 0",
        "'a' in args",
        "args instanceof args.b",
      ].map(verdict)
    ).toStrictEqual(Array.from({ length: 9 }, () => "expression.operator"));
  });

  it("are JavaScript's: TypeScript's own syntax doesn't parse", () => {
    expect(
      [
        "args.a as string",
        "args.a!",
        "args.a satisfies string",
        "<string>args.a",
      ].map(verdict)
    ).toStrictEqual(Array.from({ length: 4 }, () => "expression.syntax"));
  });
});

describe("splicing into the generated code", () => {
  it("is one expression, whole, or nothing", () => {
    expect(
      [
        "args.a; globalThis.x",
        "args.a)\n;globalThis.fetch('x')\n;(",
        "args.a /*",
        "args.a } ; globalThis.x ; {",
        "",
        "   ",
        // Code in an HTML comment of a script, which a module doesn't have.
        "args.a <!-- globalThis",
      ].map(verdict)
    ).toStrictEqual(Array.from({ length: 7 }, () => "expression.syntax"));
  });

  it("generates code with no comment to swallow the code after it", () => {
    const checked = checkExpression("args.a // the amount\n");
    expect(checked.ok && checked.code).toBe("(args.a)");
  });

  it("refuses one nested too deep to read, rather than throwing", () => {
    expect(
      [3000, 9999].map((depth) => verdict(`${"1+".repeat(depth)}1`))
    ).toStrictEqual(["expression.syntax", "expression.syntax"]);
  });

  it("refuses a regular expression, whose work no limit of ours bounds", () => {
    expect(verdict("/(a+)+$/.test(args.name)")).toBe("expression.syntax");
  });
});

describe("the code generated from an expression", () => {
  it("reads and calls as plain JavaScript, printed from its tree", () => {
    expect(generated("args.lines.map((line) => line.amount).at(-1)")).toBe(
      "(args.lines.map(line => line.amount).at(-1))"
    );
    expect(generated("args.lines[0].total")).toBe("(args.lines[0].total)");
  });

  it("reads a field named like a built-in's method as the value's own field, never the method", () => {
    const lines = Object.freeze([{ total: 3 }]);
    expect({
      values: evaluated("args.values.length", { values: [1, 2] }),
      noField: evaluated("args.lines.at", { lines }),
      held: evaluated("({ at: args.lines.at, map: args.lines.forEach })", {
        lines,
      }),
      called: evaluated("args.lines.at(0).total", { lines }),
    }).toStrictEqual({
      values: 2,
      noField: undefined,
      held: { at: undefined, map: undefined },
      called: 3,
    });
  });

  it("short-circuits a `?.` chain past such a field as JavaScript does", () => {
    const thrown = (source: string, args: unknown): string => {
      try {
        evaluated(source, args);
        return "read";
      } catch {
        return "threw";
      }
    };
    expect({
      nullish: evaluated("args.a?.toString.x", { a: null }),
      own: evaluated("args.a?.toString.x", { a: { toString: { x: 1 } } }),
      inherited: thrown("args.a?.toString.x", { a: {} }),
      after: thrown("args.a?.b.toString", { a: {} }),
      shortCircuited: evaluated("args.a?.b.toString", { a: undefined }),
    }).toStrictEqual({
      nullish: undefined,
      own: 1,
      inherited: "threw",
      after: "threw",
      shortCircuited: undefined,
    });
  });

  it("short-circuits such a chain to undefined whatever a callback's parameter is named", () => {
    expect(
      evaluated("args.list.map((undefined) => args.a?.b.at)", {
        list: [1],
        a: null,
      })
    ).toStrictEqual([undefined]);
  });

  it("keeps a template's line breaks in its text, whatever indents the code around it", () => {
    // A line break written in the template, which the code must not carry
    // as one: the generator indents every line of the code it writes.
    const written = "`${args.a}\n\u2028${args.b}`";
    expect({
      read: evaluated(written, { a: "x", b: "y" }),
      breaks: /[\n\r\u2028\u2029]/u.test(generated(written)),
    }).toStrictEqual({ read: "x\n\u2028y", breaks: false });
  });

  it("reads a template's line continuation as nothing, as JavaScript does", () => {
    expect({
      continued: evaluated("`a\\\nb`", {}),
      crlf: evaluated("`a\\\r\nb`", {}),
      escapedSlash: evaluated("`a\\\\\nb`", {}),
    }).toStrictEqual({ continued: "ab", crlf: "ab", escapedSlash: "a\\\nb" });
  });

  it("puts every comparison in parentheses, so TypeScript reads no type arguments", () => {
    // `args.a<args.b, args.c>(args.d)`, a generic call, in TypeScript.
    expect(generated("[args.a < args.b, args.c > (args.d)]")).toBe(
      "([(args.a < args.b), (args.c > args.d)])"
    );
  });

  it("writes an object's keys plainly where they are names, quoted otherwise", () => {
    expect(generated("{ a: args.a, 'b c': 1, 2: null, ...args.d }")).toBe(
      '({\n  a: args.a,\n  "b c": 1,\n  "2": null,\n  ...args.d\n})'
    );
  });

  it("short-circuits a `?.` chain as JavaScript does", () => {
    expect(generated("args.a?.b.c")).toBe("(args.a?.b.c)");
  });

  it("can't be shadowed: no root or parameter starts with `$`", () => {
    expect(verdict("args.lines.map(($own) => $own)")).toBe(
      "expression.callback"
    );
    expect(() => checkExpression("1", { roots: ["$own"] })).toThrow(
      "plain identifier"
    );
  });

  it("writes a number too large for a double as a number, which no parameter can shadow", () => {
    // `Infinity` as a name would read the callback's parameter.
    expect(generated("args.items.map((Infinity) => 1e400 > Infinity)")).toBe(
      "(args.items.map(Infinity => (1e999 > Infinity)))"
    );
  });

  it("calls no method optionally: `?.()` is refused", () => {
    expect(verdict("args.lines.map?.((line) => line)")).toBe(
      "expression.syntax"
    );
  });
});

/** What `source` reads, or why it is refused. */
const readsOf = (source: string) => {
  const checked = checkExpression(source);
  return checked.ok ? checked.reads : checked.errors;
};

describe("a chain in parentheses", () => {
  it("is a chain of its own: `(a?.b).c` reads `.c` of whatever `a?.b` gives", () => {
    expect(generated("(args.a?.b).c")).toBe("((args.a?.b).c)");
  });

  it("reads the whole chain through its parentheses, once", () => {
    expect({
      member: readsOf("(args.fetch).output"),
      nested: readsOf("((args.a).b).c"),
      called: readsOf("(args.lines.map((line) => line.total)).length"),
    }).toStrictEqual({
      member: [{ root: "args", path: ["fetch", "output"] }],
      nested: [{ root: "args", path: ["a", "b", "c"] }],
      called: [{ root: "args", path: ["lines"] }],
    });
  });

  it("is never a method's callee: `(a?.map)(f)` would call `undefined`", () => {
    expect([
      verdict("(args.list?.map)((x) => x)"),
      verdict("(args.list.join)(', ')"),
    ]).toStrictEqual(["expression.syntax", "expression.syntax"]);
  });
});

describe("what an expression reads", () => {
  it("is each read of a root, by its path up to a call or computed step", () => {
    const checked = checkExpression(
      "args.extract.lines.map((line) => line.total)[0] + params.limit + args"
    );
    expect(checked.ok ? checked.reads : []).toStrictEqual([
      { root: "args", path: ["extract", "lines"] },
      { root: "params", path: ["limit"] },
      { root: "args", path: [] },
    ]);
  });

  it("isn't a callback parameter that shadows a root", () => {
    const checked = checkExpression("args.items.map((steps) => steps.total)");
    expect(checked.ok ? checked.reads : []).toStrictEqual([
      { root: "args", path: ["items"] },
    ]);
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

  it("are plain identifiers, bound as parameters, and not a default one again", () => {
    const refused = [
      // The default ones again.
      "args",
      "run",
      // Not bindable as a parameter in a module.
      "eval",
      "arguments",
      "this",
      "yield",
      "let",
      "await",
      // Not a plain identifier, so not spliced into code as one.
      "item.total",
      "a b",
      "",
      "$item",
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
    // Bound as a parameter, a root named like a global reads the root.
    expect(checkExpression("fetch.url", { roots: ["fetch"] })).toMatchObject({
      ok: true,
      code: "(fetch.url)",
    });
  });
});

describe("an error", () => {
  it("says where it is and how to fix it", () => {
    const checked = checkExpression("args.lines.map((l) =>\n  globalThis)");
    expect(checked).toStrictEqual({
      ok: false,
      errors: [
        {
          code: "expression.global",
          message:
            "`globalThis` is not one of the workflow's values: args, params, run.",
          fix: "Start from one of the values the message names, or a callback's own parameter.",
          offset: 24,
          line: 2,
          column: 3,
        },
      ],
    });
  });

  it("names every problem, not only the first", () => {
    const checked = checkExpression("eval(args.constructor)");
    expect(
      checked.ok ? [] : checked.errors.map(({ code }) => code)
    ).toStrictEqual(["expression.global", "expression.property"]);
  });

  it("of syntax has its position too", () => {
    const checked = checkExpression("args.a +");
    expect(checked.ok ? undefined : checked.errors[0]).toMatchObject({
      code: "expression.syntax",
      line: 1,
    });
  });
});
