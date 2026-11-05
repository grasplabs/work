import { describe, expect, it } from "vite-plus/test";

import { checkWorkflow } from "../src/check.ts";
import { everyStep } from "./fixtures.ts";

// Checking grasp-workflow/1: its JSON Schema through the standard
// validator, then only what a schema can't say. Each way a document can be
// wrong, refused with where it is.

/** The pointers of `document`'s problems, or "ok". */
const problemsAt = (document: unknown): unknown => {
  const result = checkWorkflow(document);
  return result.ok ? "ok" : result.problems.map(({ pointer }) => pointer);
};

/** The codes of `document`'s problems by their pointers, or "ok". */
const codesAt = (document: unknown): unknown => {
  const result = checkWorkflow(document);
  return result.ok
    ? "ok"
    : Object.fromEntries(
        result.problems.map(({ pointer, code }) => [pointer, code])
      );
};

/** A value nested `depth` lists deep. */
const nestedList = (depth: number): unknown => {
  let value: unknown = "leaf";
  for (let level = 0; level < depth; level += 1) {
    value = [value];
  }
  return value;
};

/** `everyStep` with its top-level steps changed by `change`. */
const withSteps = (change: (steps: unknown[]) => unknown[]) => {
  const document = everyStep();
  return { ...document, steps: change(document.steps) };
};

/** `everyStep` with `steps` first and an unmarked parameter, `apiKey`. */
const withKey = (steps: unknown[]) => {
  const document = everyStep();
  return {
    ...document,
    params: { ...document.params, apiKey: { kind: "text", label: "API key" } },
    steps: [...steps, ...document.steps],
  };
};

/** A connector call passing `to`. */
const send = (to: unknown) => ({
  id: "key",
  type: "do",
  binding: "mail",
  operation: "mail.send",
  arguments: { to },
});

describe("checking a workflow", () => {
  it("accepts every step kind of the format", () => {
    expect(problemsAt(everyStep())).toBe("ok");
  });

  it("refuses what its JSON Schema doesn't allow, where it is", () => {
    expect({
      schema: problemsAt({
        ...everyStep(),
        $schema: "https://grasp.work/schemas/grasp-workflow/2.json",
      }),
      kind: problemsAt(
        withSteps((steps) => [...steps, { id: "later", type: "listen" }])
      ),
      id: problemsAt(
        withSteps((steps) => [
          ...steps,
          { id: "Bad ID", type: "wait", for: "1 hour" },
        ])
      ),
      extra: problemsAt(
        withSteps((steps) => [
          ...steps,
          { id: "later", type: "wait", for: "1 hour", jq: ".x" },
        ])
      ),
      expression: problemsAt(
        withSteps((steps) => [
          ...steps,
          {
            id: "later",
            type: "wait",
            until: { $expr: "input.at", also: 1 },
          },
        ])
      ),
      money: problemsAt({
        ...everyStep(),
        params: {
          fee: { kind: "money", label: "Fee", default: 5, sensitive: false },
        },
      }),
      local: problemsAt({
        ...everyStep(),
        bindings: {
          ...everyStep().bindings,
          own: { kind: "compute", contract: "composio.mail@1" },
        },
      }),
    }).toStrictEqual({
      schema: ["/$schema"],
      kind: ["/steps/5/type"],
      id: ["/steps/5/id"],
      extra: ["/steps/5/jq"],
      expression: ["/steps/5/until/also"],
      money: ["/params/fee"],
      local: ["/bindings/own/contract"],
    });
  });

  it("refuses two steps of one ID, and a binding of another kind or none", () => {
    expect({
      twice: problemsAt(
        withSteps((steps) => [
          ...steps,
          { id: "fetch", type: "wait", for: "1 hour" },
        ])
      ),
      kind: problemsAt(
        withSteps((steps) => [
          ...steps,
          {
            id: "ask",
            type: "agent",
            binding: "mail",
            instructions: "x",
            input: null,
            output: { type: "string" },
          },
        ])
      ),
      none: problemsAt(
        withSteps((steps) => [
          ...steps,
          { id: "call", type: "do", binding: "nobody", arguments: {} },
        ])
      ),
      operation: problemsAt(
        withSteps((steps) => [
          ...steps,
          { id: "call", type: "do", binding: "mail", arguments: {} },
        ])
      ),
    }).toStrictEqual({
      twice: ["/steps/5/id"],
      kind: ["/steps/5/binding"],
      none: ["/steps/5/binding"],
      operation: ["/steps/5"],
    });
  });

  it("lets an expression read only steps that ran before it, as their output", () => {
    const reading = (source: string) =>
      problemsAt(
        withSteps((steps) => [
          { id: "first", type: "wait", until: { $expr: source } },
          ...steps,
        ])
      );
    const insideIf = problemsAt(
      withSteps((steps) => [
        ...steps,
        { id: "late", type: "wait", until: { $expr: "steps.pause.output" } },
      ])
    );
    expect({
      later: reading("steps.send.output"),
      itself: reading("steps.first.output"),
      notOutput: problemsAt(
        withSteps((steps) => [
          ...steps,
          { id: "late", type: "wait", until: { $expr: "steps.send.input" } },
        ])
      ),
      insideIf,
      earlier: problemsAt(
        withSteps((steps) => [
          ...steps,
          {
            id: "late",
            type: "wait",
            until: { $expr: "steps.send.output.sent" },
          },
        ])
      ),
      // Parentheses change nothing of what it reads.
      parenthesised: problemsAt(
        withSteps((steps) => [
          ...steps,
          {
            id: "late",
            type: "wait",
            until: { $expr: "(steps.send).output.sent" },
          },
        ])
      ),
    }).toStrictEqual({
      later: ["/steps/0/until/$expr"],
      itself: ["/steps/0/until/$expr"],
      notOutput: ["/steps/5/until/$expr"],
      insideIf: ["/steps/5/until/$expr"],
      earlier: "ok",
      parenthesised: "ok",
    });
  });

  it("keeps a sensitive parameter to a connector call's arguments, whole", () => {
    const agentReading = withSteps((steps) => [
      ...steps,
      {
        id: "leak",
        type: "agent",
        binding: "summary",
        instructions: { $expr: "params.token" },
        input: null,
        output: { type: "string" },
      },
    ]);
    const inside = withSteps((steps) => [
      ...steps,
      {
        id: "leak",
        type: "do",
        binding: "mail",
        operation: "mail.send",
        arguments: { to: { $expr: 'params.token + "@x"' } },
      },
    ]);
    expect({
      agent: problemsAt(agentReading),
      inside: problemsAt(inside),
      undeclared: problemsAt(
        withSteps((steps) => [
          ...steps,
          { id: "late", type: "wait", until: { $expr: "params.nothing" } },
        ])
      ),
    }).toStrictEqual({
      agent: ["/steps/5/instructions/$expr"],
      inside: ["/steps/5/arguments/to/$expr"],
      undeclared: ["/steps/5/until/$expr"],
    });
  });

  it("treats a parameter not marked otherwise as sensitive", () => {
    const whole = checkWorkflow(withKey([send({ $expr: "params.apiKey" })]));
    expect({
      whole: whole.ok
        ? [...whole.workflow.placeholders.entries()]
        : whole.problems,
      inside: problemsAt(withKey([send({ $expr: 'params.apiKey + "!"' })])),
      condition: problemsAt(
        withKey([
          {
            id: "late",
            type: "wait",
            for: "1 hour",
            if: { $expr: "params.apiKey" },
          },
        ])
      ),
      agent: problemsAt(
        withKey([
          {
            id: "ask",
            type: "agent",
            binding: "summary",
            instructions: "Go.",
            input: { $expr: "params.apiKey" },
            output: { type: "string" },
          },
        ])
      ),
      all: problemsAt(withKey([send({ $expr: "params" })])),
    }).toStrictEqual({
      // The fixture's own unmarked token passes as its connector's argument.
      whole: [
        ["/steps/0/arguments/to", "apiKey"],
        ["/steps/2/arguments/subject", "token"],
      ],
      inside: ["/steps/0/arguments/to/$expr"],
      condition: ["/steps/0/if/$expr"],
      agent: ["/steps/0/input/$expr"],
      all: ["/steps/0/arguments/to/$expr"],
    });
  });

  it("keeps every sensitive parameter's value out of the document", () => {
    const withParam = (param: Record<string, unknown>) =>
      problemsAt({ ...everyStep(), params: { token: param } });
    expect({
      unmarked: withParam({ kind: "text", label: "Key", default: "sk-live" }),
      marked: withParam({
        kind: "text",
        label: "Key",
        default: "sk-live",
        sensitive: true,
      }),
      empty: withParam({ kind: "text", label: "Key", default: "" }),
      plainWithout: withParam({ kind: "text", label: "Key", sensitive: false }),
      sensitiveWithout: withParam({ kind: "text", label: "Key" }),
    }).toStrictEqual({
      unmarked: ["/params/token"],
      marked: ["/params/token"],
      empty: ["/params/token"],
      plainWithout: ["/params/token"],
      sensitiveWithout: "ok",
    });
  });

  it("lets `error` be read only in a catch", () => {
    expect(
      problemsAt(
        withSteps((steps) => [
          ...steps,
          { id: "late", type: "wait", until: { $expr: "error.status" } },
        ])
      )
    ).toStrictEqual(["/steps/5/until/$expr"]);
  });

  it("refuses expressions that do more than read the run's values", () => {
    const refused = [
      "fetch('https://example.com')",
      "globalThis.process",
      "input.constructor",
      'input["__proto__"]',
      "input[input.key]",
      "(() => 1)()",
      "input.lines.push(1)",
      "input.lines.map(input.f)",
      "input.x = 1",
      "new Date()",
      "this",
      "input.a, input.b",
    ];
    expect(
      refused.map((source) =>
        problemsAt(
          withSteps((steps) => [
            ...steps,
            { id: "late", type: "wait", until: { $expr: source } },
          ])
        )
      )
    ).toStrictEqual(refused.map(() => ["/steps/5/until/$expr"]));
  });

  it("names each problem with a code and a remedy", () => {
    const result = checkWorkflow(
      withSteps((steps) => [
        ...steps,
        { id: "Bad ID", type: "wait", for: "1 hour" },
        { id: "both", type: "wait", for: "1 hour", until: { $expr: "0" } },
        { id: "extra", type: "wait", for: "1 hour", jq: ".x" },
        { id: "ask", type: "do" },
        { id: "later", type: "listen" },
        { id: "pause", type: "wait", for: "soon" },
        {
          id: "stop",
          type: "raise",
          error: { type: "not a uri", status: 200 },
        },
      ])
    );
    expect(
      result.ok
        ? []
        : result.problems.map(({ pointer, code, remedy }) => ({
            pointer,
            code,
            remedied: remedy.length > 0,
          }))
    ).toStrictEqual(
      [
        ["/steps/5/id", "workflow.invalid_id"],
        ["/steps/6", "workflow.wait_kind"],
        ["/steps/7/jq", "workflow.unknown_property"],
        ["/steps/8", "workflow.missing_property"],
        ["/steps/9/type", "workflow.unknown_step_type"],
        ["/steps/10/for", "workflow.invalid_duration"],
        ["/steps/11/error/type", "workflow.invalid_uri"],
        ["/steps/11/error/status", "workflow.out_of_bounds"],
      ].map(([pointer, code]) => ({ pointer, code, remedied: true }))
    );
  });

  it("names an expression's problem by the expression checker's code", () => {
    expect(
      codesAt(
        withSteps((steps) => [
          ...steps,
          { id: "late", type: "wait", until: { $expr: "input.constructor" } },
          { id: "later", type: "wait", until: { $expr: "steps.nope.output" } },
        ])
      )
    ).toStrictEqual({
      "/steps/5/until/$expr": "expression.property",
      "/steps/6/until/$expr": "workflow.unreadable",
    });
  });

  it("refuses a step ID an expression can never read", () => {
    expect(
      ["constructor", "prototype"].map((id) =>
        codesAt(
          withSteps((steps) => [...steps, { id, type: "wait", for: "1 hour" }])
        )
      )
    ).toStrictEqual([
      { "/steps/5/id": "workflow.reserved_id" },
      { "/steps/5/id": "workflow.reserved_id" },
    ]);
  });

  it("refuses a document nested past its depth, and a call past the host's, as a problem, not a crash", () => {
    let steps: unknown = [{ id: "leaf", type: "wait", for: "1 hour" }];
    for (let level = 0; level < 3000; level += 1) {
      steps = [
        {
          id: `level-${level}`,
          type: "if",
          condition: { $expr: "true" },
          // oxlint-disable-next-line unicorn/no-thenable -- the if step's list
          then: steps,
        },
      ];
    }
    expect({
      // Past the stack of the validator, which recurses.
      deepValue: codesAt(withKey([send(nestedList(3000))])),
      deepSteps: codesAt({
        $schema: "https://grasp.work/schemas/grasp-workflow/1.json",
        steps,
      }),
      // As deep as the host takes a call's arguments (`callDepth`, 34):
      // the arguments object and 33 lists.
      atCallDepth: codesAt(withKey([send(nestedList(33))])),
      pastCallDepth: codesAt(withKey([send(nestedList(34))])),
      // An expression nests at least as deep as its own literals, around
      // a value or around what it reads.
      expressionLiteral: codesAt(
        withKey([send({ $expr: `${"[".repeat(34)}1${"]".repeat(34)}` })])
      ),
      expressionAround: codesAt(
        withKey([send({ $expr: `${"[".repeat(34)}input${"]".repeat(34)}` })])
      ),
      expressionAtDepth: codesAt(
        withKey([send({ $expr: `${"[".repeat(33)}1${"]".repeat(33)}` })])
      ),
      // A model call's input sits in one object more.
      pastModelDepth: codesAt(
        withKey([
          {
            id: "ask",
            type: "agent",
            binding: "summary",
            instructions: "Go.",
            input: nestedList(34),
            output: { type: "string" },
          },
        ])
      ),
    }).toStrictEqual({
      deepValue: { "": "workflow.too_deep" },
      deepSteps: { "": "workflow.too_deep" },
      atCallDepth: "ok",
      pastCallDepth: { "/steps/0/arguments": "workflow.arguments_too_deep" },
      expressionLiteral: {
        "/steps/0/arguments": "workflow.arguments_too_deep",
      },
      expressionAround: {
        "/steps/0/arguments": "workflow.arguments_too_deep",
      },
      expressionAtDepth: "ok",
      pastModelDepth: { "/steps/0/input": "workflow.arguments_too_deep" },
    });
  });

  it("refuses what a sealed build can't hold, where it is", () => {
    const longKey = "k".repeat(1025);
    const reads = `input${".a".repeat(700)}`;
    const many = Array.from({ length: 1025 }, () => ({ $expr: "input.who" }));
    expect({
      key: codesAt(withKey([send({ [longKey]: { $expr: "input.who" } })])),
      items: codesAt(withKey([send(many)])),
      fields: codesAt(
        withKey([
          send(
            Object.fromEntries(many.map((item, index) => [`f${index}`, item]))
          ),
        ])
      ),
      // Each key within its bound, but the place they make longer than a
      // sealed pointer.
      deep: codesAt(
        withKey([
          send({
            ["k".repeat(1024)]: { ["k".repeat(1024)]: { $expr: "input" } },
          }),
        ])
      ),
      // Within the source's length, but longer as the code it lowers to.
      lowered: codesAt(
        withSteps((steps) => [
          ...steps,
          { id: "late", type: "wait", until: { $expr: reads } },
        ])
      ),
    }).toStrictEqual({
      key: { [`/steps/0/arguments/to/${longKey}`]: "workflow.out_of_bounds" },
      items: { "/steps/0/arguments/to": "workflow.out_of_bounds" },
      fields: { "/steps/0/arguments/to": "workflow.out_of_bounds" },
      deep: {
        [`/steps/0/arguments/to/${"k".repeat(1024)}/${"k".repeat(1024)}/$expr`]:
          "workflow.pointer_too_long",
      },
      lowered: { "/steps/5/until/$expr": "workflow.expression_too_long" },
    });
  });

  it("refuses a duration longer than a year, wherever it is", () => {
    /** `everyStep` with step `id` changed by `change`. */
    const changed = (
      id: string,
      change: (step: Record<string, unknown>) => Record<string, unknown>
    ) =>
      withSteps((steps) =>
        steps.map((step) =>
          typeof step === "object" &&
          step !== null &&
          "id" in step &&
          step.id === id
            ? change({ ...step })
            : step
        )
      );
    const huge = "999999999 weeks";
    expect({
      wait: codesAt(changed("linger", (step) => ({ ...step, for: huge }))),
      timeout: codesAt(changed("send", (step) => ({ ...step, timeout: huge }))),
      agent: codesAt(
        changed("greet", (step) => ({ ...step, timeout: "53 weeks" }))
      ),
      delay: codesAt(
        changed("guarded", (step) => ({
          ...step,
          catch: { retry: { attempts: 2, delay: huge, backoff: "constant" } },
        }))
      ),
      year: codesAt(
        changed("linger", (step) => ({ ...step, for: "365 days" }))
      ),
    }).toStrictEqual({
      wait: { "/steps/0/for": "workflow.duration_too_long" },
      timeout: { "/steps/1/timeout": "workflow.duration_too_long" },
      agent: { "/steps/2/timeout": "workflow.duration_too_long" },
      delay: { "/steps/4/catch/retry/delay": "workflow.duration_too_long" },
      year: "ok",
    });
  });

  it("refuses lists nested deeper than the format allows", () => {
    let nested: unknown = { id: "leaf", type: "wait", for: "1 hour" };
    for (let depth = 0; depth < 8; depth += 1) {
      nested = {
        id: `level-${depth}`,
        type: "if",
        condition: { $expr: "true" },
        // oxlint-disable-next-line unicorn/no-thenable -- the if step's list
        then: [nested],
      };
    }
    const result = checkWorkflow({
      $schema: "https://grasp.work/schemas/grasp-workflow/1.json",
      steps: [nested],
    });
    expect(result.ok).toBeFalsy();
  });
});
