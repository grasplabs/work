import { checkWorkflow } from "../src/check.ts";
import type { CheckedWorkflow } from "../src/check.ts";
import { workflowSchemaUrl } from "../src/format.ts";

/** A workflow with every step kind of the format, as a builder writes it. */
export const everyStep = () => ({
  $schema: workflowSchemaUrl,
  args: {
    kind: "object",
    fields: { who: { kind: "string" }, deadline: { kind: "number" } },
  },
  returns: { kind: "object", fields: { line: { kind: "string" } } },
  result: { line: { $expr: "greet.line" } },
  params: {
    greeting: {
      label: "Greeting",
      type: { kind: "string", default: "Hello" },
      sensitive: false,
    },
    // Sensitive, as every parameter not marked otherwise.
    token: { label: "Token", type: { kind: "string" } },
  },
  permissions: {
    ai: { contract: "summary" },
    connections: { mail: { contract: "composio.mail@1" } },
  },
  // What it keeps between runs: what `keeping` and its kin write.
  state: {
    last: { kind: "string" },
    previous: { kind: "string" },
    runs: { kind: "number", integer: true, min: 0 },
    kept: { kind: "array", item: { kind: "string" } },
    marked: { kind: "boolean" },
  },
  steps: [
    { id: "linger", type: "wait", for: "1 hour" },
    {
      id: "send",
      type: "call",
      title: "Mail them",
      connection: "mail",
      action: "mail.send",
      args: {
        to: { $expr: "args.who" },
        subject: { $expr: "params.token" },
        // Every shape an expression comes in: a literal, a list, an
        // object, a conditional and a call.
        priority: { $expr: "1" },
        cc: { $expr: "[args.who]" },
        headers: { $expr: "({ from: args.who })" },
        tone: { $expr: 'args.who === "Ada" ? "warm" : "plain"' },
        shout: { $expr: "args.who.toUpperCase()" },
      },
    },
    {
      id: "greet",
      type: "generate",
      instructions: "Greet them.",
      input: {
        who: { $expr: "args.who" },
        sent: { $expr: "send.id" },
        tags: ["vip", { $expr: "args.who" }],
      },
      returns: { kind: "object", fields: { line: { kind: "string" } } },
    },
    {
      id: "known",
      type: "if",
      condition: { $expr: 'args.who === "Ada"' },
      // oxlint-disable-next-line unicorn/no-thenable -- the if step's list
      then: [{ id: "pause", type: "wait", until: { $expr: "args.deadline" } }],
      else: [
        {
          id: "stop",
          type: "raise",
          error: { code: "greeting.stopped", message: "Stopped." },
        },
      ],
    },
    {
      id: "guarded",
      type: "try",
      try: [
        {
          id: "fetch",
          type: "call",
          connection: "mail",
          action: "mail.send",
          args: { to: { $expr: "args.who" }, subject: "x" },
        },
      ],
      catch: {
        code: "connect.unavailable",
        when: { $expr: 'error.message !== "final"' },
        retry: {
          attempts: 3,
          delay: "1 second",
          backoff: "constant",
          // Not a boolean on its own: the generated choice makes it one.
          when: { $expr: "error.details" },
        },
        do: [
          {
            id: "notice",
            type: "call",
            connection: "mail",
            action: "mail.send",
            args: {
              to: { $expr: "args.who" },
              subject: { $expr: "error.code" },
            },
          },
        ],
      },
    },
  ],
});

/** A workflow calling a permission of every kind a `call` step calls. */
export const everyCall = () => ({
  $schema: workflowSchemaUrl,
  args: { kind: "object", fields: { who: { kind: "string" } } },
  permissions: {
    connections: { mail: { contract: "composio.mail@1" } },
    modules: {
      total: { kind: "compute", contract: "local:code/total.ts#total" },
      note: { kind: "action", contract: "local:code/note.ts#note" },
    },
  },
  steps: [
    {
      id: "send",
      type: "call",
      connection: "mail",
      action: "mail.send",
      args: { to: { $expr: "args.who" }, subject: "Hi" },
    },
    { id: "add", type: "call", module: "total", args: [1, 2, 3] },
    {
      id: "tell",
      type: "call",
      module: "note",
      args: { to: { $expr: "args.who" } },
      timeout: "30 seconds",
    },
  ],
});

/**
 * A workflow whose expressions use every kind of operator on what they
 * read: arithmetic, comparisons, logic, conditionals and callbacks.
 */
export const everyOperator = () => ({
  $schema: workflowSchemaUrl,
  permissions: { connections: { mail: { contract: "composio.mail@1" } } },
  steps: [
    {
      id: "later",
      type: "wait",
      until: { $expr: "args.at + 60 * 1000" },
    },
    {
      id: "sized",
      type: "if",
      condition: { $expr: "args.count > 2 && args.count * 2 <= 10" },
      // oxlint-disable-next-line unicorn/no-thenable -- the if step's list
      then: [
        {
          id: "send",
          type: "call",
          connection: "mail",
          action: "mail.send",
          args: {
            to: { $expr: "args.who" },
            subject: { $expr: '"Order " + (args.count + 1)' },
            share: { $expr: "args.total / args.count - 1" },
            negative: { $expr: "-args.count" },
            rest: { $expr: "args.count % 3" },
            large: { $expr: "args.total >= 100 ? 'large' : 'small'" },
            long: {
              $expr: "args.lines.filter((line) => line.total > 10).length",
            },
            sum: {
              $expr: "args.lines.map((line) => line.total * 2)",
            },
            missing: { $expr: "args.note ?? 'none'" },
            known: { $expr: "!args.unknown || args.count < 0" },
          },
        },
      ],
    },
  ],
});

/**
 * `everyStep` with a decision permission, `approvers`, and `steps` after
 * its own: the first of them is at `/steps/5`.
 */
export const withDecisions = (...steps: unknown[]) => {
  const document = everyStep();
  return {
    ...document,
    permissions: {
      ...document.permissions,
      decisions: { approvers: { contract: "grasp.approvals@1" } },
    },
    steps: [...document.steps, ...steps],
  };
};

/** A decision step asking a person and someone of the args. */
export const decision = (change: Record<string, unknown> = {}) => ({
  id: "approve",
  type: "decide",
  decision: "approvers",
  recipients: ["person:ada", { $expr: "args.who" }],
  prompt: "Approve this?",
  input: { who: { $expr: "args.who" } },
  ...change,
});

/**
 * `everyStep` with an event permission, `replies`, and `steps` after its
 * own: the first of them is at `/steps/5`.
 */
export const withEventWaits = (...steps: unknown[]) => {
  const document = everyStep();
  return {
    ...document,
    permissions: {
      ...document.permissions,
      events: { replies: { contract: "grasp.replies@1" } },
    },
    steps: [...document.steps, ...steps],
  };
};

/**
 * An event type of `count` emoji: each one code point but two UTF-16
 * units, so a length counted in units is twice the count.
 */
export const emojiType = (count: number): string => "\u{1F600}".repeat(count);

/** An event wait for a reply through `replies`, for at most 3 days. */
export const eventWait = (change: Record<string, unknown> = {}) => ({
  id: "reply",
  type: "waitForEvent",
  events: "replies",
  eventType: "grasp.reply.received",
  timeout: "3 days",
  ...change,
});

/** `everyStep` with `steps` after its own: the first of them at `/steps/5`. */
export const followedBy = (...steps: unknown[]) => {
  const document = everyStep();
  return { ...document, steps: [...document.steps, ...steps] };
};

/**
 * A connection call keeping in state what it answered (`output`), what an
 * earlier run kept, a count of the runs that kept it, a list and a
 * literal, its subject read from the state.
 */
export const keeping = (change: Record<string, unknown> = {}) => ({
  id: "remember",
  type: "call",
  connection: "mail",
  action: "mail.send",
  args: {
    to: { $expr: "args.who" },
    subject: { $expr: 'state.last ?? "none"' },
  },
  state: {
    last: { $expr: "output.id" },
    previous: { $expr: 'state.last ?? "none"' },
    runs: { $expr: "(state.runs ?? 0) + 1" },
    kept: ["kept", { $expr: "output.id" }],
    marked: true,
  },
  ...change,
});

/**
 * `everyStep` with `steps` after its own (the first at `/steps/5`): pages
 * of rows, the rows of each page mailed while they have a name, a deadline
 * waited for and a failure retried in each row.
 */
export const withLoops = (...steps: unknown[]) => ({
  ...everyStep(),
  steps: [
    ...everyStep().steps,
    {
      id: "pages",
      type: "forEach",
      items: { $expr: "args.pages" },
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
                  id: "mailed",
                  type: "call",
                  connection: "mail",
                  action: "mail.send",
                  args: { to: { $expr: "item.name" }, subject: "Due" },
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

/** The problems `document` has, as `[pointer, code]` pairs. */
export const problemsOf = (document: unknown): [string, string][] => {
  const result = checkWorkflow(document);
  return result.ok
    ? []
    : result.problems.map(({ pointer, code }) => [pointer, code]);
};
