/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
/**
 * The evaluator's threat model, first. Expressions come from workflow
 * definitions, which agents and people write; the values they run on come
 * from users, models and connectors. Each can be hostile.
 *
 * 1. Source that steps outside the profile: definitions, modules,
 *    recursion, `input`/`env`/`$ENV`/`$__loc__`, side channels, or text
 *    that breaks out of the program jq is given (unbalanced brackets,
 *    comments).
 * 2. Data treated as code: an expression-looking string in a value is
 *    evaluated, or a value's text ends up in jq source.
 * 3. Malformed or hostile values: not JSON (functions, NaN, cycles, sparse
 *    arrays, class instances), `__proto__` keys that pollute prototypes,
 *    nesting that overflows a parser.
 * 4. Work without end: loops, exponential growth, memory, calls into jq's
 *    JavaScript runtime, output too large to hold. The run must stop,
 *    not merely be ignored.
 * 5. Reaching a capability: the network, bindings, the host's
 *    environment or anything outside jq's own runtime.
 * 6. Leaking values through errors.
 */
import { describe, expect, it } from "vite-plus/test";

import { expressionErrors } from "../src/errors.ts";
import { compileExpression, evaluateExpression } from "../src/evaluate.ts";
import jqModule from "../src/jq.wasm";
import { resolveEvaluate } from "../src/source.ts";
import { compileError, json, run } from "./run.ts";

/**
 * `value` as JSON, whatever it is: what a caller that isn't type-checked
 * (generated code, a value from the wire) can pass, which the evaluator
 * must refuse.
 */
const unchecked = (value: unknown): never =>
  // SAFETY: invalid on purpose; the evaluator checks values at run time.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  value as never;

/** An object whose `value` is 1 when first read, then `later`. */
const shifting = (later: unknown): unknown => {
  let reads = 0;
  return {
    get value(): unknown {
      reads += 1;
      return reads === 1 ? 1 : later;
    },
  };
};

describe("source outside the profile", () => {
  it("refuses definitions, modules, error handling and other grammar", async () => {
    const refused = {
      definition: "def f: f; f",
      import: 'import "a" as a; .',
      include: 'include "a"; .',
      moduleDirective: "module {}; .",
      try: "try .a",
      optional: ".a?",
      alternativeDestructuring: ". as [$a] ?// $a | $a",
      label: "label $out | 1",
      foreach: "foreach .[] as $x (0; . + $x)",
      recursion: "..",
      assignment: ".a = 1",
      update: ".a |= 1",
      arithmeticUpdate: ".a += 1",
      alternativeUpdate: ".a //= 1",
      format: "@base64",
      formatString: '@sh "echo \\(.)"',
      interpolation: '"\\(.)"',
      comment: "1 # comment",
      environment: "$ENV",
      environmentPath: "$ENV.PATH",
      arguments: "$ARGS",
      location: "$__loc__",
      locationKeyword: "__loc__",
      moduleQualified: "a::b",
    };
    const codes = Object.fromEntries(
      await Promise.all(
        Object.entries(refused).map(
          async ([name, source]) => [name, await compileError(source)] as const
        )
      )
    );
    expect(codes).toStrictEqual(
      Object.fromEntries(
        Object.keys(refused).map((name) => [name, "expression.unsupported"])
      )
    );
  });

  it("can't break out of the program it is placed in", async () => {
    expect({
      closeEarly: await compileError("1) | $ENV | (1"),
      closeAndReopen: await compileError(") | input_filename | ("),
      commentedOut: await compileError("1\n# )\n"),
      unbalancedIf: await compileError("if true then 1"),
      strayEnd: await compileError("1 end"),
      unterminatedString: await compileError('"abc'),
      // A closing bracket inside a string is only text.
      bracketInString: await run('")) | $ENV | (("'),
    }).toStrictEqual({
      closeEarly: "expression.unsupported",
      closeAndReopen: "expression.invalid",
      commentedOut: "expression.unsupported",
      unbalancedIf: "expression.invalid",
      strayEnd: "expression.invalid",
      unterminatedString: "expression.invalid",
      bracketInString: { result: ")) | $ENV | ((" },
    });
  });

  it("can't hide a refused builtin where an object key could be", async () => {
    const hidden = {
      // A `,` inside if … end, within an object, separates outputs.
      ifThen: "{a: if true then 1, now, 2 else 3 end}",
      ifThenEnv: "{a: if true then 1, env, 2 else 3 end}",
      ifThenFile: "{a: if true then 1, input_filename, 2 else 3 end}",
      ifThenHalt: '{a: if true then 1, halt_error("x"), 2 else 3 end}',
      elif: "{a: if false then 1 elif true then 2, env else 3 end}",
      else: "{a: if false then 1 else 2, now end}",
      nestedIf: "{a: if true then if true then 1, now else 2 end else 3 end}",
      ifInPattern: ". as {a: $x} | {b: if true then $x, now else 0 end}",
      reduceSource: "{a: reduce (1, now) as $x (0; .)}",
      reduceUpdate: "{a: reduce .[] as $x (0; ., now)}",
      reducePattern: "{a: reduce .[] as {b: $x} (0; ., env)}",
      foreach: "{a: foreach .[] as $x (0; .; ., now)}",
      label: "{a: label $out | 1, now}",
      array: "{a: [1, now]}",
      parentheses: "{a: (1, now)}",
      pipe: "{a: . | now, b: 1}",
      computedKey: "{(now): 1}",
      value: "{a: now}",
    };
    const codes = Object.fromEntries(
      await Promise.all(
        Object.entries(hidden).map(
          async ([name, source]) => [name, await compileError(source)] as const
        )
      )
    );
    expect(codes).toStrictEqual(
      Object.fromEntries(
        Object.keys(hidden).map((name) => [name, "expression.unsupported"])
      )
    );
  });

  it("keeps real object keys keys, keywords and builtin names included", async () => {
    await expect(
      run(
        '. as $in | {now, env: 1, if: 2, end: 3, "then": 4} | [.now, .env, .if, .end, .then, ($in | {input_filename} | .input_filename)]',
        { input: { now: "data", input_filename: "also data" } }
      )
    ).resolves.toStrictEqual({ result: ["data", 1, 2, 3, 4, "also data"] });
  });

  it("refuses raw control characters in strings", async () => {
    expect({
      inAString: await compileError('"a\nb"'),
      inADateFormat: await compileError('strftime("%Y\u0001")'),
      escaped: await compileError('"a\\nb"'),
    }).toStrictEqual({
      inAString: "expression.invalid",
      inADateFormat: "expression.invalid",
      escaped: undefined,
    });
  });

  it("reports what jq itself refuses as invalid", async () => {
    expect({
      syntax: await compileError("map("),
      missingOperand: await compileError(". +"),
      emptySource: await compileError(""),
    }).toStrictEqual({
      syntax: "expression.invalid",
      missingOperand: "expression.invalid",
      emptySource: "expression.invalid",
    });
  });

  it("counts only real as bindings when it checks variables", async () => {
    expect({
      keyNamedAs: await compileError("{as: $missing}"),
      keyNamedAsInAPattern: await run(". as {as: $x} | $x", {
        input: { as: 7 },
      }),
      computedPatternKey: await compileError(". as {($missing): $v} | $v"),
      reduceKeyNamedAs: await compileError(
        "reduce .[] as $x (0; {as: $missing})"
      ),
    }).toStrictEqual({
      keyNamedAs: "expression.unavailable_variable",
      keyNamedAsInAPattern: { result: 7 },
      computedPatternKey: "expression.unavailable_variable",
      reduceKeyNamedAs: "expression.unavailable_variable",
    });
  });

  it("refuses evaluate settings that aren't plain JSON", () => {
    expect({
      inherited: resolveEvaluate(Object.create({ mode: "loose" })),
      throwing: resolveEvaluate({
        get mode(): unknown {
          throw new Error("x");
        },
      }),
      array: resolveEvaluate([]),
    }).toStrictEqual({
      inherited: undefined,
      throwing: undefined,
      array: undefined,
    });
  });

  it("refuses loop variable names that aren't plain identifiers", async () => {
    expect({
      injected: await compileError(".", { loopVariables: ["x | $ENV"] }),
      environment: await compileError(".", { loopVariables: ["ENV"] }),
      secrets: await compileError(".", { loopVariables: ["secrets"] }),
      jqInternal: await compileError(".", { loopVariables: ["__loc__"] }),
      notText: await compileError(".", { loopVariables: unchecked([1]) }),
    }).toStrictEqual({
      injected: "expression.unavailable_variable",
      environment: "expression.unavailable_variable",
      secrets: "expression.unavailable_variable",
      jqInternal: "expression.unavailable_variable",
      notText: "expression.unavailable_variable",
    });
  });
});

describe("data is never code", () => {
  it("returns expression-looking values as the text they are", async () => {
    const hostile = {
      slot: "${ $ENV }",
      jq: "input_filename",
      breakout: ")) | env | ((",
    };
    await expect(
      run("[.slot, .jq, .breakout, $context.slot]", {
        input: hostile,
        variables: { context: hostile },
      })
    ).resolves.toStrictEqual({
      result: ["${ $ENV }", "input_filename", ")) | env | ((", "${ $ENV }"],
    });
  });

  it("never evaluates a result that looks like an expression", async () => {
    await expect(run('"${ $ENV }"')).resolves.toStrictEqual({
      result: "${ $ENV }",
    });
  });
});

describe("hostile values", () => {
  it("refuses values that aren't plain JSON", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    // oxlint-disable-next-line no-sparse-arrays -- a sparse array is the attack
    const sparse = [1, , 3];
    const values: Record<string, unknown> = {
      function: () => 1,
      undefinedInAnArray: [undefined],
      notANumber: Number.NaN,
      infinity: Number.NEGATIVE_INFINITY,
      bigint: 1n,
      symbol: Symbol("x"),
      date: new Date(0),
      map: new Map(),
      inherited: Object.create({ inherited: true }),
      cyclic,
      sparse,
    };
    const codes = Object.fromEntries(
      await Promise.all(
        Object.entries(values).map(
          async ([name, value]) =>
            [name, await run(".", { input: unchecked({ value }) })] as const
        )
      )
    );
    expect(codes).toStrictEqual(
      Object.fromEntries(
        Object.keys(values).map((name) => [
          name,
          { error: "expression.context_invalid" },
        ])
      )
    );
  });

  it("checks the values jq gets, not what a getter answered first", async () => {
    let deep: unknown = 0;
    for (let level = 0; level < 40; level += 1) {
      deep = [deep];
    }
    expect({
      deepLater: await run(".", { input: unchecked(shifting(deep)) }),
      protoLater: await run(".", {
        input: unchecked(shifting(JSON.parse('{"__proto__": {"x": 1}}'))),
      }),
    }).toStrictEqual({
      deepLater: { error: "expression.context_invalid" },
      protoLater: { error: "expression.context_invalid" },
    });
  });

  it("refuses a context that throws or changes while it is read, without its message", async () => {
    const secret = "getter-secret-51c9";
    const throwing = {
      get value(): unknown {
        throw new Error(secret);
      },
    };
    let reads = 0;
    const throwingLater = {
      get value(): unknown {
        reads += 1;
        if (reads > 1) {
          throw new Error(secret);
        }
        return 1;
      },
    };
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error(secret);
        },
      }
    );
    const throwingScope = Object.defineProperty({ input: null }, "variables", {
      get: (): unknown => {
        throw new Error(secret);
      },
    });
    const outcomes = {
      throwing: await run(".", { input: unchecked(throwing) }),
      throwingWhenSerialised: await run(".", {
        input: unchecked(throwingLater),
      }),
      proxy: await run(".", { input: unchecked(proxy) }),
      inAVariable: await run("1", { variables: { context: unchecked(proxy) } }),
    };
    const expression = await compileExpression(".", {
      stage: "taskDefinition",
      scope: ["task"],
      pointer: "/do/0/task",
    });
    const scopeError: unknown = await evaluateExpression(
      expression,
      unchecked(throwingScope),
      json
    ).catch((error: unknown) => error);
    expect({
      outcomes,
      scope: expressionErrors.codeOf(scopeError),
      leaks: JSON.stringify(scopeError).includes(secret),
    }).toStrictEqual({
      outcomes: {
        throwing: { error: "expression.context_invalid" },
        throwingWhenSerialised: { error: "expression.context_invalid" },
        proxy: { error: "expression.context_invalid" },
        inAVariable: { error: "expression.context_invalid" },
      },
      scope: "expression.context_invalid",
      leaks: false,
    });
  });

  it("takes each variable only from its own group", async () => {
    const expression = await compileExpression("[$context, $attempt]", {
      stage: "taskIf",
      scope: ["poll"],
      pointer: "/do/0/poll/if",
      loopVariables: ["attempt"],
    });
    const variables = {
      context: { done: false },
      task: null,
      workflow: null,
      params: null,
    };
    const outcome = async (scope: unknown) =>
      await evaluateExpression(expression, unchecked(scope), json).then(
        (result) => ({ result }),
        (error: unknown) => ({ error: expressionErrors.codeOf(error) })
      );
    expect({
      own: await outcome({ input: null, variables, loop: { attempt: 0 } }),
      loopOverridesContext: await outcome({
        input: null,
        variables,
        loop: { attempt: 0, context: { done: true } },
      }),
      undeclaredLoopVariable: await outcome({
        input: null,
        variables,
        loop: { attempt: 0, other: 1 },
      }),
      loopVariableAmongStageVariables: await outcome({
        input: null,
        variables: { ...variables, attempt: 5 },
        loop: { attempt: 0 },
      }),
    }).toStrictEqual({
      own: { result: [{ done: false }, 0] },
      loopOverridesContext: { error: "expression.context_invalid" },
      undeclaredLoopVariable: { error: "expression.context_invalid" },
      loopVariableAmongStageVariables: { error: "expression.context_invalid" },
    });
  });

  it("refuses __proto__ keys in, and out, without polluting prototypes", async () => {
    const polluting = unchecked(
      JSON.parse('{"__proto__": {"polluted": true}}')
    );
    expect({
      in: await run(".", { input: polluting }),
      inAVariable: await run("1", { variables: { context: polluting } }),
      built: await run('{"__proto__": {"polluted": true}}'),
      set: await run('setpath(["__proto__", "polluted"]; true)', { input: {} }),
      constructorIsData: await run(
        "{constructor: {prototype: {polluted: true}}} | .constructor.prototype.polluted"
      ),
      prototypes: [
        Object.hasOwn(Object.prototype, "polluted"),
        Object.hasOwn(Array.prototype, "polluted"),
      ],
    }).toStrictEqual({
      in: { error: "expression.context_invalid" },
      inAVariable: { error: "expression.context_invalid" },
      built: { error: "expression.result_invalid" },
      set: { error: "expression.result_invalid" },
      constructorIsData: { result: true },
      prototypes: [false, false],
    });
  });

  it("fails on values jq can't work with, and refuses text that isn't Unicode", async () => {
    expect({
      notANumber: await run("tonumber", { input: "12abc" }),
      wrongType: await run(".a + 1", { input: { a: "x" } }),
      indexing: await run(".a", { input: "text" }),
      loneSurrogate: await run("length", { input: "\uD800" }),
      loneSurrogateKey: await run("length", { input: { "\uDC00": 1 } }),
    }).toStrictEqual({
      notANumber: { error: "expression.failed" },
      wrongType: { error: "expression.failed" },
      indexing: { error: "expression.failed" },
      loneSurrogate: { error: "expression.context_invalid" },
      loneSurrogateKey: { error: "expression.context_invalid" },
    });
  });
});

describe("work without end", () => {
  it("stops exponential and unbounded work", async () => {
    expect({
      doublingArray: await run(
        "reduce range(0; 64) as $i ([1]; . + .) | length"
      ),
      doublingString: await run(
        'reduce range(0; 64) as $i ("ab"; . + .) | length'
      ),
      nestedRanges: await run("[range(0; 1e6) as $a | range(0; 1e6)] | length"),
      quadraticSort: await run("[range(0; 1e7)] | sort_by(-.) | length"),
      repeatedRegexFreeSplit: await run(
        '("a," * 1000000) as $s | reduce range(0; 1e9) as $i (0; ($s | split(",") | length) + .)'
      ),
      oversizedOutput: await run('[range(0; 1e7) | tostring] | join(",")'),
      deepRecursionByData: await run(
        "reduce range(0; 1e6) as $i (null; [.]) | flatten | length"
      ),
    }).toStrictEqual({
      doublingArray: { error: "expression.resource_exhausted" },
      doublingString: { error: "expression.resource_exhausted" },
      nestedRanges: { error: "expression.resource_exhausted" },
      quadraticSort: { error: "expression.resource_exhausted" },
      repeatedRegexFreeSplit: { error: "expression.resource_exhausted" },
      oversizedOutput: { error: "expression.resource_exhausted" },
      deepRecursionByData: { error: "expression.resource_exhausted" },
    });
  });
});

describe("capabilities", () => {
  it("gives jq nothing but its own runtime's functions", () => {
    const imports = WebAssembly.Module.imports(jqModule);
    expect({
      namespaces: [...new Set(imports.map(({ module }) => module))],
      kinds: [...new Set(imports.map(({ kind }) => kind))],
    }).toStrictEqual({ namespaces: ["a"], kinds: ["function"] });
  });

  it("can't reach the environment, files or input beyond its own", async () => {
    const attempts = [
      "env",
      "$ENV",
      "input",
      "inputs",
      "input_filename",
      "$__prog_args",
      "get_search_list",
      'import "/etc/passwd" as $p; $p',
      "now",
    ];
    const codes = await Promise.all(
      attempts.map(async (source) => await compileError(source))
    );
    expect(codes).toStrictEqual(attempts.map(() => "expression.unsupported"));
  });
});

describe("errors", () => {
  it("never puts values in its errors", async () => {
    const secret = "secret-value-8f3a";
    const expression = await compileExpression(".a + 1", {
      stage: "taskDefinition",
      scope: ["charge-card"],
      pointer: "/do/2/charge-card/with/arguments/amount",
    });
    const failure: unknown = await evaluateExpression(
      expression,
      {
        input: { a: secret },
        variables: {
          context: { secret },
          input: null,
          task: null,
          workflow: null,
          params: null,
        },
      },
      { kind: "json" }
    ).catch((error: unknown) => error);
    expect({
      error: failure,
      leaks:
        JSON.stringify(failure).includes(secret) ||
        String(failure).includes(secret),
    }).toMatchObject({
      error: {
        code: "expression.failed",
        details: {
          type: "https://open-workflow-specification.org/spec/1.0.0/errors/expression",
          status: 400,
          taskId: "charge-card",
          pointer: "/do/2/charge-card/with/arguments/amount",
        },
      },
      leaks: false,
    });
  });
});
