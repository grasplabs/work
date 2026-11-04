/* oxlint-disable no-template-curly-in-string, unicorn/no-thenable -- expressions are JavaScript source, and `then` is one of the attacks */
/**
 * Workflow expressions as they run: the code `checkExpression` generates,
 * evaluated with the guards `@grasp-os/sdk/workflow` gives it, as a
 * generated workflow module imports them (`runtimeNames`). Here, in
 * Node, because workerd doesn't compile code from strings; what runs is
 * the same JavaScript.
 *
 * The attacks are those that pass the syntactic check: a built-in method
 * read as a plain member (`list.forEach`, `.push`, `.reverse`) is a
 * value, which an object literal can file under an allowed name and call
 * with any `this`, or hand to an implicit conversion. The guards answer
 * them at run time, whatever the data's field names are.
 */
import { checkExpression } from "@grasp-os/sdk/expression-check";
import {
  callMethod,
  jsonValue,
  optionalChain,
  readMember,
} from "@grasp-os/sdk/workflow";
import { describe, expect, it } from "vite-plus/test";

const roots = ["input", "steps", "params", "run"] as const;

/** Runs an expression as its generated code would, on fresh copies of its values. */
const run = (
  source: string,
  values: Partial<Record<(typeof roots)[number], unknown>>
): unknown => {
  const checked = checkExpression(source);
  if (!checked.ok) {
    throw new Error(`refused: ${checked.errors[0]?.code}`);
  }
  // The code is what `checkExpression` generated, the subject under
  // test; a workflow module runs it so, with the guards by these names.
  // oxlint-disable-next-line eslint/no-new-func, typescript/no-implied-eval -- see above
  const evaluate = new Function(
    "$read",
    "$call",
    "$opt",
    ...roots,
    `return ${checked.code};`
  );
  return Reflect.apply(evaluate, undefined, [
    readMember,
    callMethod,
    optionalChain,
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

/** A value as JSON gives it, as a run's are. */
const parsed = (json: string): unknown => JSON.parse(json);

/** A step's output, as JSON gives it. */
const stepOutput = () => ({
  a: { output: parsed('{ "items": [3, 1, 2] }') },
});

describe("what an expression computes", () => {
  it("is what JavaScript computes", () => {
    const input = parsed(
      '{ "lines": [{ "amount": 2, "tags": ["urgent"] }, { "amount": 5, "tags": [] }], "name": " Ada Lovelace ", "note": null }'
    );
    expect({
      total: run(
        "input.lines.map((line) => line.amount).filter((a) => a > params.limit)",
        { input, params: { limit: 3 } }
      ),
      urgent: run("input.lines.some((line) => line.tags.includes('urgent'))", {
        input,
      }),
      last: run("input.name.trim().split(' ').at(-1).toUpperCase()", {
        input,
      }),
      template: run("`${input.lines.length} lines, ${(1.5).toFixed(2)}`", {
        input,
      }),
      optional: run("input.note?.text.length ?? 'none'", { input }),
      missing: run("input.nothing", { input }),
      merged: run("{ ...input.lines[0], amount: 9 }", {
        input,
      }),
      compare: run("[1 < 2, 3 > (4)]", {}),
    }).toStrictEqual({
      total: [5],
      urgent: true,
      last: "LOVELACE",
      template: "2 lines, 1.50",
      optional: "none",
      missing: undefined,
      merged: { amount: 9, tags: ["urgent"] },
      compare: [true, false],
    });
  });
});

describe("a built-in method, read as a value", () => {
  it("is never there: a member read gives own data only", () => {
    const input = { list: [1, 2] };
    expect(
      [
        "input.list.forEach",
        "input.list.push",
        "input.list.reverse",
        "input.name.padStart",
        "[].forEach",
        "'x'.repeat",
      ].map((source) => run(source, { input: { ...input, name: "x" } }))
    ).toStrictEqual(Array.from({ length: 6 }));
  });

  it("is not a data field of that name, which reads as data", () => {
    expect(
      run("[input.at, input.map.join]", {
        input: parsed('{ "at": "x", "map": { "join": 1 } }'),
      })
    ).toStrictEqual(["x", 1]);
  });

  it("can't be filed under an allowed name and called with any `this`", () => {
    const steps = stepOutput();
    expect({
      outcome: outcome(
        "({ at: [].forEach, length: 1, 0: steps.a.output.items }).at(steps.a.output.items.push, steps.a.output.items)",
        { steps }
      ),
      items: steps.a.output,
    }).toStrictEqual({
      outcome: { threw: "TypeError" },
      items: { items: [3, 1, 2] },
    });
  });

  it("can't stand in for an array to do unbounded work", () => {
    const started = performance.now();
    expect(
      outcome("({ indexOf: input.list.forEach, length: 1e15 }).indexOf(1)", {
        input: { list: [1] },
      })
    ).toStrictEqual({ threw: "TypeError" });
    // Refused before any work, not stopped by a limit.
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("can't be reached through an implicit conversion", () => {
    const input = parsed('{ "list": [1, 2, 3] }');
    const results = {
      toString: outcome("`${{ toString: input.list.reverse }}`", { input }),
      valueOf: outcome("{ valueOf: input.list.reverse } + 1", { input }),
      toJSON: outcome("{ toJSON: input.list.reverse }", { input }),
      then: outcome("{ then: input.list.push }", { input }),
      compared: outcome("{ valueOf: input.list.reverse } < 1", { input }),
    };
    const list: unknown = readMember(input, "list");
    expect({ results, list }).toStrictEqual({
      results: {
        // No `toString` to call: JavaScript's own TypeError, the list untouched.
        toString: { threw: "TypeError" },
        valueOf: { value: "[object Object]1" },
        toJSON: { value: { toJSON: undefined } },
        then: { value: { then: undefined } },
        compared: { value: false },
      },
      list: [1, 2, 3],
    });
  });
});

describe("a method call", () => {
  it("is an allowed built-in, on a real array, string or number only", () => {
    expect(
      [
        "({ map: 1, length: 2 }).map((x) => x)",
        "({ join: 1 }).join(',')",
        "input.count.trim()",
        "input.name.toFixed(2)",
        "input.list.split(',')",
        "(1).at(0)",
        "true.includes(1)",
        "null.at(0)",
      ].map((source) =>
        outcome(source, { input: { count: 1, name: "x", list: [] } })
      )
    ).toStrictEqual(Array.from({ length: 8 }, () => ({ threw: "TypeError" })));
  });

  it("takes a function only where a callback goes", () => {
    expect(
      [
        callMethod.bind(undefined, [1], "map", [Number, [2]]),
        callMethod.bind(undefined, [1], "map", []),
        callMethod.bind(undefined, [1], "join", [Number]),
        callMethod.bind(undefined, "a", "includes", [Number]),
        callMethod.bind(undefined, [1], "push", [2]),
        callMethod.bind(undefined, [1], "constructor", []),
        callMethod.bind(undefined, [1], "__proto__", []),
      ].map((call) => {
        try {
          call();
          return "called";
        } catch (error) {
          return error instanceof TypeError ? "refused" : "other";
        }
      })
    ).toStrictEqual(Array.from({ length: 7 }).fill("refused"));
  });
});

describe("a member read", () => {
  // Roots are JSON by the run host's contract; should one carry a getter
  // or a function after all, no expression reaches it.
  it("refuses a getter and a function, even through a spread", () => {
    const getter = Object.defineProperty({}, "a", {
      get: () => 1,
      enumerable: true,
    });
    expect([
      outcome("input.a", { input: getter }),
      outcome("input.f", { input: { f: () => 1 } }),
      outcome("({ ...input }).f", { input: { f: () => 1 } }),
      outcome("[...input.list][0]", { input: { list: [() => 1] } }),
      outcome("input.a.b", { input: { a: null } }),
    ]).toStrictEqual(Array.from({ length: 5 }, () => ({ threw: "TypeError" })));
  });

  it("reads an own `__proto__` field as data, never the prototype", () => {
    const input = parsed('{ "__proto__": { "x": 1 } }');
    expect(readMember(input, "__proto__")).toStrictEqual({ x: 1 });
    expect(readMember({}, "__proto__")).toBeUndefined();
    expect(readMember([], "constructor")).toBeUndefined();
  });
});

describe("an optional chain", () => {
  it("short-circuits within its parentheses only, as JavaScript does", () => {
    const input = { a: null };
    expect({
      grouped: outcome("(input.a?.b).c", { input }),
      chained: outcome("input.a?.b.c", { input }),
      called: outcome("input.a?.b.join(',')", { input }),
    }).toStrictEqual({
      grouped: { threw: "TypeError" },
      chained: { value: undefined },
      called: { value: undefined },
    });
  });
});

describe("an expression's whole value", () => {
  it("is the JSON `JSON.stringify` writes of it, whatever its shape", () => {
    const values = {
      missing: undefined,
      text: "Ada",
      list: [undefined, 1, [undefined]],
      object: { from: undefined, to: "Ada", nested: { at: undefined } },
      // Numbers JSON can't write, on their own and inside.
      notNumber: Number.NaN,
      infinite: [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
      negativeZero: { at: -0 },
    };
    expect(
      Object.fromEntries(
        Object.entries(values).map(([name, value]) => [name, jsonValue(value)])
      )
    ).toStrictEqual({
      missing: null,
      text: "Ada",
      list: parsed(JSON.stringify(values.list)),
      object: parsed(JSON.stringify(values.object)),
      notNumber: null,
      infinite: [null, null],
      // `toStrictEqual` tells `-0` from `0`.
      negativeZero: { at: 0 },
    });
  });
});
