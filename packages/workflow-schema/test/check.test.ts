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
    }).toStrictEqual({
      later: ["/steps/0/until/$expr"],
      itself: ["/steps/0/until/$expr"],
      notOutput: ["/steps/5/until/$expr"],
      insideIf: ["/steps/5/until/$expr"],
      earlier: "ok",
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
