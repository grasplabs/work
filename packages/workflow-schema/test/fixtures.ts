import { checkWorkflow } from "../src/check.ts";
import type { CheckedWorkflow } from "../src/check.ts";

/** A workflow with every step kind of the format, as a builder writes it. */
export const everyStep = () => ({
  $schema: "https://grasp.work/schemas/grasp-workflow/1.json",
  input: {
    type: "object",
    properties: { who: { type: "string" } },
    required: ["who"],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: "object",
      properties: { line: { type: "string" } },
      required: ["line"],
      additionalProperties: false,
    },
    value: { line: { $expr: "steps.greet.output.line" } },
  },
  params: {
    greeting: {
      kind: "text",
      label: "Greeting",
      default: "Hello",
      sensitive: false,
    },
    // Sensitive, as every parameter not marked otherwise.
    token: { kind: "text", label: "Token" },
  },
  bindings: {
    mail: { kind: "connector", contract: "composio.mail@1" },
    summary: { kind: "model", contract: "summary" },
  },
  steps: [
    { id: "linger", type: "wait", for: "1 hour" },
    {
      id: "send",
      type: "do",
      title: "Mail them",
      binding: "mail",
      operation: "mail.send",
      arguments: {
        to: { $expr: "input.who" },
        subject: { $expr: "params.token" },
        // Every shape an expression comes in: a literal, a list, an
        // object, a conditional and a call.
        priority: { $expr: "1" },
        cc: { $expr: "[input.who]" },
        headers: { $expr: "({ from: input.who })" },
        tone: { $expr: 'input.who === "Ada" ? "warm" : "plain"' },
        shout: { $expr: "input.who.toUpperCase()" },
      },
    },
    {
      id: "greet",
      type: "agent",
      binding: "summary",
      instructions: "Greet them.",
      input: {
        who: { $expr: "input.who" },
        tags: ["vip", { $expr: "input.who" }],
      },
      output: {
        type: "object",
        properties: { line: { type: "string" } },
        required: ["line"],
        additionalProperties: false,
      },
    },
    {
      id: "known",
      type: "if",
      condition: { $expr: 'input.who === "Ada"' },
      // oxlint-disable-next-line unicorn/no-thenable -- the if step's list
      then: [{ id: "pause", type: "wait", until: { $expr: "input.deadline" } }],
      else: [
        {
          id: "stop",
          type: "raise",
          error: {
            type: "urn:grasp:error:stop",
            status: 422,
            title: "Stopped.",
          },
        },
      ],
    },
    {
      id: "guarded",
      type: "try",
      try: [
        {
          id: "fetch",
          type: "do",
          binding: "mail",
          operation: "mail.send",
          arguments: { to: { $expr: "input.who" }, subject: "x" },
        },
      ],
      catch: {
        errors: { status: 500 },
        when: { $expr: 'error.type !== "urn:grasp:error:final"' },
        retry: {
          attempts: 3,
          delay: "1 second",
          backoff: "constant",
          // Not a boolean on its own: the generated choice makes it one.
          when: { $expr: "error.title" },
        },
        do: [
          {
            id: "notice",
            type: "do",
            binding: "mail",
            operation: "mail.send",
            arguments: {
              to: { $expr: "input.who" },
              subject: { $expr: "error.type" },
            },
          },
        ],
      },
    },
  ],
});

/** A workflow calling a binding of every kind a `do` step calls. */
export const everyBinding = () => ({
  $schema: "https://grasp.work/schemas/grasp-workflow/1.json",
  bindings: {
    mail: { kind: "connector", contract: "composio.mail@1" },
    lookup: { kind: "operation", contract: "crm.lookup@1" },
    total: { kind: "compute", contract: "local:code/total.ts#total" },
    note: { kind: "action", contract: "local:code/note.ts#note" },
  },
  steps: [
    {
      id: "send",
      type: "do",
      binding: "mail",
      operation: "mail.send",
      arguments: { to: { $expr: "input.who" }, subject: "Hi" },
    },
    {
      id: "find",
      type: "do",
      binding: "lookup",
      arguments: { name: { $expr: "input.who" } },
    },
    { id: "add", type: "do", binding: "total", arguments: [1, 2, 3] },
    {
      id: "tell",
      type: "do",
      binding: "note",
      arguments: { to: { $expr: "input.who" } },
      timeout: "30 seconds",
    },
  ],
});

/** `document` checked, failing the test when it isn't valid. */
export const checked = (document: unknown): CheckedWorkflow => {
  const result = checkWorkflow(document);
  if (!result.ok) {
    throw new Error(
      `Expected a valid workflow: ${JSON.stringify(result.problems)}`
    );
  }
  return result.workflow;
};
