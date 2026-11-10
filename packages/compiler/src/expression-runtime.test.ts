/* oxlint-disable no-template-curly-in-string, unicorn/no-thenable -- expressions are JavaScript source, and `then` is one of the attacks */
/**
 * Workflow expressions as they run: the code `checkExpression` generates,
 * plain JavaScript, evaluated with the one guard
 * `@grasp-os/runtime/workflow` gives it (`own`, as `$own`), over
 * data as the workflow runtime hands it: JSON with no prototype, frozen.
 * Here, in Node, because workerd doesn't compile code from strings; what
 * runs is the same JavaScript.
 *
 * The attacks are those that pass the syntactic check: a built-in method
 * read as a plain member (`list.forEach`, `.push`, `.reverse`) would be a
 * value, which an object literal could file under an allowed name and
 * call with any `this`, or hand to an implicit conversion. A read of such
 * a name gives only an own field, so no expression ever holds one.
 */
import { checkExpression } from "@grasp-os/runtime/check";
import { own } from "@grasp-os/runtime/workflow";
import { describe, expect, it } from "vite-plus/test";

const roots = ["args", "params", "run", "fetched"] as const;

/** `value` as a run hands it to its code: no prototype, frozen all the way down. */
const frozen = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item: unknown) => frozen(item)));
  }
  const copy: Record<string, unknown> = {};
  Object.setPrototypeOf(copy, null);
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(copy, key, { value: frozen(item), enumerable: true });
  }
  return Object.freeze(copy);
};

/** `value` as plain JSON, its prototypes back, to compare. */
const plain = (value: unknown): unknown => {
  const copy: unknown = structuredClone(value);
  return copy;
};

/** JSON as a run hands it to its code. */
const data = (json: string): unknown => {
  const value: unknown = JSON.parse(json);
  return frozen(value);
};

/** Runs an expression as its generated code would. */
const run = (
  source: string,
  values: Partial<Record<(typeof roots)[number], unknown>>
): unknown => {
  const checked = checkExpression(source, { roots: ["fetched"] });
  if (!checked.ok) {
    throw new Error(`refused: ${checked.errors[0]?.code}`);
  }
  // The code is what `checkExpression` generated, the subject under
  // test; a workflow module runs it so, with its guard by this name.
  // oxlint-disable-next-line eslint/no-new-func, typescript/no-implied-eval -- see above
  const evaluate = new Function("$own", ...roots, `return ${checked.code};`);
  return Reflect.apply(evaluate, undefined, [
    own,
    ...roots.map((root) => values[root]),
  ]);
};

/** What running it ended in: its value, or the error it threw. */
const outcome = (
  source: string,
  values: Partial<Record<(typeof roots)[number], unknown>>
): { value: unknown } | { threw: string } => {
  try {
    return { value: run(source, values) };
  } catch (error) {
    return { threw: error instanceof Error ? error.name : String(error) };
  }
};

describe("what an expression computes", () => {
  it("is what JavaScript computes", () => {
    const args = data(
      '{ "lines": [{ "amount": 2, "tags": ["urgent"] }, { "amount": 5, "tags": [] }], "name": " Ada Lovelace ", "note": null }'
    );
    expect({
      total: run(
        "args.lines.map((line) => line.amount).filter((a) => a > params.limit)",
        { args, params: { limit: 3 } }
      ),
      urgent: run("args.lines.some((line) => line.tags.includes('urgent'))", {
        args,
      }),
      last: run("args.name.trim().split(' ').at(-1).toUpperCase()", { args }),
      template: run("`${args.lines.length} lines, ${(1.5).toFixed(2)}`", {
        args,
      }),
      optional: run("args.note?.text.length ?? 'none'", { args }),
      missing: run("args.nothing", { args }),
      first: run("args.lines[0].amount", { args }),
      merged: run("{ ...args.lines[0], amount: 9 }", { args }),
      compare: run("[1 < 2, 3 > (4)]", {}),
      step: run("fetched.items.length", {
        fetched: data('{ "items": [3, 1, 2] }'),
      }),
    }).toStrictEqual({
      total: [5],
      urgent: true,
      last: "LOVELACE",
      template: "2 lines, 1.50",
      optional: "none",
      missing: undefined,
      first: 2,
      merged: { amount: 9, tags: ["urgent"] },
      compare: [true, false],
      step: 3,
    });
  });
});

describe("a built-in method, read as a value", () => {
  it("is never there: a read of its name gives own data only", () => {
    const args = data('{ "list": [1, 2], "name": "x" }');
    expect(
      [
        "args.list.forEach",
        "args.list.push",
        "args.list.reverse",
        "args.name.padStart",
        "args.list.at",
        "args.list.map",
        "[].forEach",
        "'x'.repeat",
        "args.toString",
        "args?.list?.values",
      ].map((source) => run(source, { args }))
    ).toStrictEqual(Array.from({ length: 10 }));
  });

  it("is not a data field of that name, which reads as data", () => {
    expect(
      run("[args.at, args.map.join, args.values]", {
        args: data('{ "at": "x", "map": { "join": 1 }, "values": [2] }'),
      })
    ).toStrictEqual(["x", 1, [2]]);
  });

  it("can't be filed under an allowed name and called with any `this`", () => {
    const fetched = data('{ "items": [3, 1, 2] }');
    expect({
      outcome: outcome(
        "({ at: [].forEach, length: 1, 0: fetched.items }).at(fetched.items.push, fetched.items)",
        { fetched }
      ),
      items: plain(fetched),
    }).toStrictEqual({
      outcome: { threw: "TypeError" },
      items: { items: [3, 1, 2] },
    });
  });

  it("can't stand in for an array to do unbounded work", () => {
    const started = performance.now();
    expect(
      outcome("({ indexOf: args.list.forEach, length: 1e15 }).indexOf(1)", {
        args: data('{ "list": [1] }'),
      })
    ).toStrictEqual({ threw: "TypeError" });
    // Refused before any work, not stopped by a limit.
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("can't be reached through an implicit conversion", () => {
    const args = data('{ "list": [1, 2, 3] }');
    expect({
      toString: outcome("`${{ toString: args.list.reverse }}`", { args }),
      valueOf: outcome("{ valueOf: args.list.reverse } + 1", { args }),
      toJSON: outcome("{ toJSON: args.list.reverse }", { args }),
      then: outcome("{ then: args.list.push }", { args }),
      dataAsText: outcome("`${args}`", { args }),
      list: plain(args),
    }).toStrictEqual({
      // Nothing to call: JavaScript's own TypeError, the list untouched.
      toString: { threw: "TypeError" },
      // No `valueOf` to call: the object's own words, the list untouched.
      valueOf: { value: "[object Object]1" },
      toJSON: { value: { toJSON: undefined } },
      then: { value: { then: undefined } },
      // Data has no prototype, so no `toString` of its own either.
      dataAsText: { threw: "TypeError" },
      list: { list: [1, 2, 3] },
    });
  });
});

describe("a method call", () => {
  it("calls a built-in only on a value whose kind has it", () => {
    expect(
      [
        "({ map: 1, length: 2 }).map((x) => x)",
        "({ join: 1 }).join(',')",
        "args.count.trim()",
        "args.name.toFixed(2)",
        "args.list.split(',')",
        "(1).at(0)",
        "true.includes(1)",
        "args.data.map((x) => x)",
      ].map((source) =>
        outcome(source, {
          args: data('{ "count": 1, "name": "x", "list": [], "data": {} }'),
        })
      )
    ).toStrictEqual(Array.from({ length: 8 }, () => ({ threw: "TypeError" })));
  });

  it("changes nothing it reads: data is frozen", () => {
    const args = data('{ "list": [3, 1, 2] }');
    run("args.list.slice(0).concat([4]).map((x) => x)", { args });
    const list: unknown =
      typeof args === "object" && args !== null
        ? Reflect.get(args, "list")
        : undefined;
    expect({ list, frozen: Object.isFrozen(list) }).toStrictEqual({
      list: [3, 1, 2],
      frozen: true,
    });
  });
});

describe("the prototype chain", () => {
  it("is out of data's reach: `__proto__` and `constructor` are data or nothing", () => {
    const args = data(
      '{ "__proto__": { "x": 1 }, "inner": { "constructor": { "y": 2 } } }'
    );
    expect({
      // Read by a bracketed literal is refused by the check; an own field
      // holding data is read as data through a spread.
      spread: JSON.stringify(run("({ ...args }).inner", { args })),
      missing: run("args.inner.x", { args }),
    }).toStrictEqual({ spread: '{"constructor":{"y":2}}', missing: undefined });
    expect(plain(own(args, "__proto__"))).toStrictEqual({ x: 1 });
    expect(own({}, "__proto__")).toBeUndefined();
    expect(own([], "constructor")).toBeUndefined();
  });
});

describe("an optional chain", () => {
  it("short-circuits within its parentheses only, as JavaScript does", () => {
    const args = data('{ "a": null }');
    expect({
      grouped: outcome("(args.a?.b).c", { args }),
      chained: outcome("args.a?.b.c", { args }),
      called: outcome("args.a?.b.join(',')", { args }),
      guarded: outcome("args.a?.values", { args }),
    }).toStrictEqual({
      grouped: { threw: "TypeError" },
      chained: { value: undefined },
      called: { value: undefined },
      guarded: { value: undefined },
    });
  });
});

describe("a failure", () => {
  it("of a guarded read names only what the expression wrote, never a value it read", () => {
    expect(
      outcome("args.a.values", { args: data('{ "a": null }') })
    ).toStrictEqual({ threw: "ExpressionFailedError" });
    const failure: unknown = expect.objectContaining({
      code: "expression.failed",
      message: 'Cannot read "values" of null.',
    });
    expect(() => {
      own(null, "values");
    }).toThrow(failure);
  });
});
