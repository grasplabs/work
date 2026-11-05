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

/**
 * A workflow whose expressions use every kind of operator on what they
 * read: arithmetic, comparisons, logic, conditionals and callbacks.
 */
export const everyOperator = () => ({
  $schema: "https://grasp.work/schemas/grasp-workflow/1.json",
  bindings: { mail: { kind: "connector", contract: "composio.mail@1" } },
  steps: [
    {
      id: "later",
      type: "wait",
      until: { $expr: "input.at + 60 * 1000" },
    },
    {
      id: "sized",
      type: "if",
      condition: { $expr: "input.count > 2 && input.count * 2 <= 10" },
      // oxlint-disable-next-line unicorn/no-thenable -- the if step's list
      then: [
        {
          id: "send",
          type: "do",
          binding: "mail",
          operation: "mail.send",
          arguments: {
            to: { $expr: "input.who" },
            subject: { $expr: '"Order " + (input.count + 1)' },
            share: { $expr: "input.total / input.count - 1" },
            negative: { $expr: "-input.count" },
            rest: { $expr: "input.count % 3" },
            large: { $expr: "input.total >= 100 ? 'large' : 'small'" },
            long: {
              $expr: "input.lines.filter((line) => line.total > 10).length",
            },
            sum: {
              $expr: "input.lines.map((line) => line.total * 2)",
            },
            missing: { $expr: "input.note ?? 'none'" },
            known: { $expr: "!input.unknown || input.count < 0" },
          },
        },
      ],
    },
  ],
});

/**
 * `everyStep` with a decision binding, `approvers`, and `steps` after its
 * own: the first of them is at `/steps/5`.
 */
export const withDecisions = (...steps: unknown[]) => {
  const document = everyStep();
  return {
    ...document,
    bindings: {
      ...document.bindings,
      approvers: { kind: "decision", contract: "grasp.approvals@1" },
    },
    steps: [...document.steps, ...steps],
  };
};

/** A decision step asking a person and someone of the input. */
export const decision = (change: Record<string, unknown> = {}) => ({
  id: "approve",
  type: "decision",
  binding: "approvers",
  recipients: ["person:ada", { $expr: "input.who" }],
  prompt: "Approve this?",
  input: { who: { $expr: "input.who" } },
  ...change,
});

/**
 * `everyStep` with `steps` after its own (the first at `/steps/5`): pages
 * of rows, the rows of each page mailed while they have a name, a deadline
 * waited for and a failure caught in each row.
 */
export const withLoops = (...steps: unknown[]) => ({
  ...everyStep(),
  steps: [
    ...everyStep().steps,
    {
      id: "pages",
      type: "forEach",
      items: { $expr: "input.pages" },
      do: [
        {
          id: "rows",
          type: "forEach",
          items: { $expr: "item.rows" },
          while: { $expr: 'item.name !== ""' },
          do: [
            { id: "hold", type: "wait", until: { $expr: "item.due" } },
            {
              id: "guard",
              type: "try",
              try: [
                {
                  id: "mail",
                  type: "do",
                  binding: "mail",
                  operation: "mail.send",
                  arguments: {
                    to: { $expr: "item.name" },
                    subject: { $expr: "steps.hold.output" },
                  },
                },
              ],
              catch: {
                retry: { attempts: 2, delay: "1 minute", backoff: "constant" },
              },
            },
          ],
        },
      ],
    },
    ...steps,
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
