import { parse } from "@babel/parser";
import type { ParserOptions } from "@babel/parser";
import { describe, expect, it } from "vite-plus/test";

import { generateWorkflow } from "../src/generate.ts";
import {
  checked,
  decision,
  eventWait,
  everyStep,
  withDecisions,
  withEventWaits,
  withLoops,
} from "./fixtures.ts";

// The generator, from its threat model: no text of a document becomes
// code, whatever it holds (quotes, `*\/`, `${`, backticks, line
// separators, `__proto__`), no ID becomes a name, the module imports only
// the workflow SDK and has no loop, and the sealed table holds every call
// as the document has it.

/** How a generated module is parsed: TypeScript, as a module. */
const asModule = {
  sourceType: "module",
  plugins: ["typescript"],
} satisfies ParserOptions;

/** Every identifier and every call's callee name in `source`, a module. */
const namesIn = (source: string): Set<string> => {
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }
    if (typeof node !== "object" || node === null) {
      return;
    }
    if (
      "type" in node &&
      node.type === "Identifier" &&
      "name" in node &&
      typeof node.name === "string"
    ) {
      names.add(node.name);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== "loc" && key !== "start" && key !== "end") {
        visit(value);
      }
    }
  };
  visit(parse(source, asModule).program);
  return names;
};

/** Every node type in `source`, a module. */
const nodeTypesIn = (source: string): Set<string> => {
  const types = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }
    if (typeof node !== "object" || node === null) {
      return;
    }
    if ("type" in node && typeof node.type === "string") {
      types.add(node.type);
    }
    for (const value of Object.values(node)) {
      visit(value);
    }
  };
  visit(parse(source, asModule).program);
  return types;
};

const lineSeparator = String.fromCodePoint(0x20_28);
const paragraphSeparator = String.fromCodePoint(0x20_29);

const hostile = [
  '"); globalThis.pwned = 1; ("',
  "*/ globalThis.pwned = 1; /*",
  // oxlint-disable-next-line no-template-curly-in-string -- hostile on purpose
  "${globalThis.pwned = 1}",
  "` + globalThis.pwned + `",
  `${lineSeparator}globalThis.pwned = 1;${paragraphSeparator}`,
  '\\"); pwned(); //',
];

/** Arguments of every hostile text, as a key and as a value, `__proto__` too. */
const hostileArguments = (): Record<string, string> => {
  const entries: [string, string][] = [
    ["__proto__", hostile[0] ?? ""],
    ...hostile.map((text, index): [string, string] => [
      `${text}${index}`,
      text,
    ]),
  ];
  return Object.fromEntries(entries);
};

/** `steps`, each one, at every level (`catch.do` too), titled anew. */
const retitled = (steps: unknown): unknown =>
  Array.isArray(steps)
    ? steps.map((step: Record<string, unknown>) => ({
        ...step,
        title: `Renamed ${String(step.id)}`,
        ...Object.fromEntries(
          ["then", "else", "try"].flatMap((list) =>
            list in step ? [[list, retitled(step[list])]] : []
          )
        ),
        ...(typeof step.catch === "object" && step.catch !== null
          ? {
              catch: {
                ...step.catch,
                ...("do" in step.catch ? { do: retitled(step.catch.do) } : {}),
              },
            }
          : {}),
      }))
    : steps;

/** Any value, as a matcher. */
const anything: unknown = expect.anything();

/** What a node of a module's syntax tree has that this file reads. */
interface Node {
  readonly type: string;
  readonly start?: number | null;
  readonly end?: number | null;
  readonly name?: unknown;
  readonly callee?: unknown;
  readonly test?: unknown;
}

const isNode = (value: unknown): value is Node =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof value.type === "string";

/**
 * Where `source`, a generated module, evaluates anything between its
 * steps: every call of an expression's guards (`$read`, `$call`, `$opt`)
 * in no function but the workflow's own, and the test of each `if`
 * statement there, as written. A step's function is the second function
 * down, as is a try's condition, which only a step's function calls.
 */
const betweenSteps = (
  source: string
): { guards: string[]; conditions: string[] } => {
  const guards: string[] = [];
  const conditions: string[] = [];
  const guardNames = new Set(["$read", "$call", "$opt"]);
  const text = (node: unknown): string =>
    isNode(node) ? source.slice(node.start ?? 0, node.end ?? 0) : "";
  const visit = (node: unknown, functions: number): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, functions);
      }
      return;
    }
    if (!isNode(node)) {
      return;
    }
    const inside =
      node.type === "ArrowFunctionExpression" ? functions + 1 : functions;
    if (
      inside < 2 &&
      node.type === "CallExpression" &&
      isNode(node.callee) &&
      typeof node.callee.name === "string" &&
      guardNames.has(node.callee.name)
    ) {
      guards.push(text(node));
    }
    if (inside < 2 && node.type === "IfStatement") {
      conditions.push(text(node.test).replaceAll(/\d+/gu, ""));
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== "loc" && key !== "start" && key !== "end") {
        visit(value, inside);
      }
    }
  };
  visit(parse(source, asModule).program, 0);
  return { guards, conditions };
};

/** The sealed listen of an event wait through `replies` for `types`. */
const listenFor = (...types: string[]) => ({
  binding: "replies",
  strategy: "any",
  filters: types.map((type) => ({ type, attributes: [] })),
});

describe("generating a workflow", () => {
  it("keeps every string, key and title of the document data", () => {
    const document = everyStep();
    const send = {
      ...document.steps[1],
      title: hostile.join(" "),
      arguments: hostileArguments(),
    };
    const generated = generateWorkflow(
      checked({
        ...document,
        params: {
          ...document.params,
          greeting: {
            kind: "text",
            label: hostile[1],
            default: hostile[2],
            sensitive: false,
          },
        },
        steps: [document.steps[0], send, ...document.steps.slice(2)],
      }),
      "workflow"
    );
    const names = namesIn(generated.source);
    expect({
      pwned: names.has("pwned"),
      // The only comment is the fixed header.
      comments: parse(generated.source, asModule).comments?.length,
      sealed: generated.tasks.find(({ id }) => id === "send")?.call,
    }).toStrictEqual({
      pwned: false,
      comments: 1,
      sealed: {
        name: "grasp.connector",
        binding: "mail",
        operation: "mail.send",
        arguments: {
          literal: hostileArguments(),
        },
      },
    });
  });

  it("makes no name of an ID, imports only the workflow SDK, and loops only as a forEach", () => {
    const generated = generateWorkflow(checked(withLoops()), "workflow");
    const { body } = parse(generated.source, asModule).program;
    const imports = body.flatMap((statement) =>
      statement.type === "ImportDeclaration" ? [statement.source.value] : []
    );
    const names = namesIn(generated.source);
    const types = nodeTypesIn(generated.source);
    expect({
      imports,
      ids: [
        "linger",
        "send",
        "greet",
        "known",
        "pause",
        "stop",
        "guarded",
        "fetch",
        "notice",
        "pages",
        "rows",
        "hold",
        "guard",
        "mail",
      ].filter((id) => names.has(id)),
      loops: [
        "ForStatement",
        "WhileStatement",
        "DoWhileStatement",
        "ForInStatement",
      ].filter((type) => types.has(type)),
    }).toStrictEqual({
      imports: ["@grasp-os/sdk/workflow"],
      ids: [],
      loops: [],
    });
  });

  it("seals a loop's tasks with the loops around them", () => {
    const generated = generateWorkflow(checked(withLoops()), "workflow");
    const slotOf = (pointer: string) =>
      generated.expressions.find((expression) => expression.pointer === pointer)
        ?.slot;
    const tasks = generated.tasks.filter(({ pointer }) =>
      pointer.startsWith("/steps/5")
    );
    expect({
      tasks: tasks.map(({ id, kind, steps, scope, branches, loop }) => ({
        id,
        kind,
        steps,
        scope,
        branches,
        ...(loop === undefined ? {} : { loop }),
      })),
    }).toStrictEqual({
      tasks: [
        {
          id: "pages",
          kind: "for",
          steps: ["enter"],
          scope: [],
          branches: [],
          loop: {
            in: { slot: slotOf("/steps/5/items") },
            each: "item",
            at: "index",
            concurrency: 1,
          },
        },
        {
          id: "rows",
          kind: "for",
          steps: ["enter", "item"],
          scope: ["pages"],
          branches: [null],
          loop: {
            in: { slot: slotOf("/steps/5/do/0/items") },
            each: "item",
            at: "index",
            concurrency: 1,
            while: slotOf("/steps/5/do/0/while"),
          },
        },
        {
          id: "hold",
          kind: "call",
          steps: ["enter", "task"],
          scope: ["pages", "rows"],
          branches: [null, null],
        },
        {
          id: "guard",
          kind: "try",
          steps: ["catch"],
          scope: ["pages", "rows"],
          branches: [null, null],
        },
        {
          id: "mail",
          kind: "call",
          steps: ["task"],
          scope: ["pages", "rows"],
          branches: [null, null],
        },
      ],
    });
  });

  it("seals each step's task as the run host checks it", () => {
    const generated = generateWorkflow(checked(everyStep()), "workflow");
    expect({
      tasks: generated.tasks.map(({ id, kind, pointer, steps }) => ({
        id,
        kind,
        pointer,
        steps,
      })),
      send: generated.tasks.find(({ id }) => id === "send")?.call,
      greet: generated.tasks.find(({ id }) => id === "greet")?.call,
      linger: generated.tasks.find(({ id }) => id === "linger")?.milliseconds,
      pause: generated.tasks.find(({ id }) => id === "pause")?.call,
      stop: generated.tasks.find(({ id }) => id === "stop")?.error,
      guarded: generated.tasks.find(({ id }) => id === "guarded")?.catch,
      params: generated.params,
      // Each slot, in the order the code evaluates them.
      slots: generated.expressions.map(({ slot, pointer, result }) => [
        slot,
        pointer,
        result,
      ]),
    }).toStrictEqual({
      tasks: [
        { id: "linger", kind: "wait", pointer: "/steps/0", steps: ["task"] },
        { id: "send", kind: "call", pointer: "/steps/1", steps: ["task"] },
        { id: "greet", kind: "call", pointer: "/steps/2", steps: ["task"] },
        { id: "known", kind: "switch", pointer: "/steps/3", steps: ["task"] },
        {
          id: "pause",
          kind: "call",
          pointer: "/steps/3/then/0",
          steps: ["enter", "task"],
        },
        {
          id: "stop",
          kind: "raise",
          pointer: "/steps/3/else/0",
          steps: ["task"],
        },
        { id: "guarded", kind: "try", pointer: "/steps/4", steps: ["catch"] },
        {
          id: "fetch",
          kind: "call",
          pointer: "/steps/4/try/0",
          steps: ["task"],
        },
        {
          id: "notice",
          kind: "call",
          pointer: "/steps/4/catch/do/0",
          steps: ["task"],
        },
      ],
      send: {
        name: "grasp.connector",
        binding: "mail",
        operation: "mail.send",
        arguments: {
          object: [
            ["to", { slot: 0 }],
            ["subject", { param: "token" }],
            ["priority", { slot: 1 }],
            ["cc", { slot: 2 }],
            ["headers", { slot: 3 }],
            ["tone", { slot: 4 }],
            ["shout", { slot: 5 }],
          ],
        },
      },
      greet: {
        name: "grasp.model",
        binding: "summary",
        instructions: { literal: "Greet them." },
        input: {
          object: [
            ["who", { slot: 6 }],
            [
              "tags",
              {
                array: [{ literal: "vip" }, { slot: 7 }],
              },
            ],
          ],
        },
        outputSchema: anything,
      },
      linger: 3_600_000,
      pause: {
        name: "grasp.sleepUntil",
        timestamp: { slot: 9 },
      },
      stop: { type: "urn:grasp:error:stop", status: 422, title: "Stopped." },
      guarded: {
        variable: "error",
        errors: { status: 500 },
        when: 10,
        retry: { attempts: 3, delayMs: 1000, backoff: "constant", when: 11 },
      },
      // The sensitive token is never handed to the run's code.
      params: ["greeting"],
      slots: [
        [0, "/steps/1/arguments/to", "json"],
        [1, "/steps/1/arguments/priority", "json"],
        [2, "/steps/1/arguments/cc", "json"],
        [3, "/steps/1/arguments/headers", "json"],
        [4, "/steps/1/arguments/tone", "json"],
        [5, "/steps/1/arguments/shout", "json"],
        [6, "/steps/2/input/who", "json"],
        [7, "/steps/2/input/tags/1", "json"],
        [8, "/steps/3/condition", "boolean"],
        [9, "/steps/3/then/0/until", "json"],
        [10, "/steps/4/catch/when", "boolean"],
        [11, "/steps/4/catch/retry/when", "boolean"],
        [12, "/steps/4/try/0/arguments/to", "json"],
        [13, "/steps/4/catch/do/0/arguments/to", "json"],
        [14, "/steps/4/catch/do/0/arguments/subject", "json"],
        [15, "/output/value/line", "json"],
      ],
    });
  });

  it("changes nothing it generates when steps and bindings are renamed", () => {
    const document = everyStep();
    const renamed = {
      ...document,
      bindings: {
        mail: { ...document.bindings.mail, title: "Outlook" },
        summary: { ...document.bindings.summary, title: "Writer" },
      },
      steps: retitled(document.steps),
    };
    expect(generateWorkflow(checked(renamed), "workflow")).toStrictEqual(
      generateWorkflow(checked(document), "workflow")
    );
  });

  it("seals a decision's whom, what, on what, and its timeout where it names one", () => {
    const generated = generateWorkflow(
      checked(
        withDecisions(
          decision({ if: { $expr: 'input.who !== "Ada"' } }),
          decision({ id: "later", timeout: "2 days" })
        )
      ),
      "workflow"
    );
    const slotOf = (pointer: string) =>
      generated.expressions.find((expression) => expression.pointer === pointer)
        ?.slot;
    const approve = generated.tasks.find(({ id }) => id === "approve");
    expect({
      approve: approve && {
        kind: approve.kind,
        steps: approve.steps,
        call: approve.call,
      },
      later: generated.tasks.find(({ id }) => id === "later")?.call,
    }).toStrictEqual({
      approve: {
        kind: "call",
        steps: ["enter", "task"],
        call: {
          name: "grasp.decision",
          binding: "approvers",
          recipients: {
            array: [
              { literal: "person:ada" },
              { slot: slotOf("/steps/5/recipients/1") },
            ],
          },
          prompt: { literal: "Approve this?" },
          input: {
            object: [["who", { slot: slotOf("/steps/5/input/who") }]],
          },
          // No timeoutMs: it names none, so the host's applies.
        },
      },
      later: {
        name: "grasp.decision",
        binding: "approvers",
        recipients: {
          array: [
            { literal: "person:ada" },
            { slot: slotOf("/steps/6/recipients/1") },
          ],
        },
        prompt: { literal: "Approve this?" },
        input: { object: [["who", { slot: slotOf("/steps/6/input/who") }]] },
        timeoutMs: 2 * 86_400_000,
      },
    });
  });

  it("seals an event wait's binding, types and timeout, and leaves what it takes to the host", () => {
    const generated = generateWorkflow(
      checked(
        withEventWaits(
          eventWait(),
          eventWait({
            id: "either",
            if: { $expr: "steps.reply.output.timedOut" },
            event: { from: "replies", type: ["grasp.a", "grasp.b"] },
            timeout: "52 weeks",
          }),
          {
            id: "items",
            type: "forEach",
            items: { $expr: "input.rows" },
            do: [eventWait({ id: "each" })],
          }
        )
      ),
      "workflow"
    );
    const taskOf = (id: string) => {
      const task = generated.tasks.find((each) => each.id === id);
      return (
        task && {
          kind: task.kind,
          steps: task.steps,
          scope: task.scope,
          listen: task.listen,
          timeoutMs: task.timeoutMs,
        }
      );
    };
    expect({
      reply: taskOf("reply"),
      either: taskOf("either"),
      each: taskOf("each"),
      // Its step names only itself: the host reads what it takes and
      // until when from the table, never from the code.
      listens: [
        ...generated.source.matchAll(
          /steps\["(?<id>[a-z]+)"\] = \{ output: await step\.listen\("\k<id>", \{ (?<options>[^}]*) \}\) \};/gu
        ),
      ].map((match) => [
        match.groups?.id,
        match.groups?.options?.replaceAll(/index\d+/gu, "i"),
      ]),
      // Its `if` decided in an enter step before it, as a sleep's.
      decidesInEnter:
        /step\.do\("either", \{ key: "enter", description: "either" \}, async \(\) => \([^\n]* \? \{ output: null \} : \{ skipped: true \}\)\);/u.test(
          generated.source
        ),
    }).toStrictEqual({
      reply: {
        kind: "listen",
        steps: ["task"],
        scope: [],
        listen: listenFor("grasp.reply.received"),
        timeoutMs: 3 * 86_400_000,
      },
      either: {
        kind: "listen",
        steps: ["enter", "task"],
        scope: [],
        listen: listenFor("grasp.a", "grasp.b"),
        timeoutMs: 52 * 7 * 86_400_000,
      },
      each: {
        kind: "listen",
        steps: ["task"],
        scope: ["items"],
        listen: listenFor("grasp.reply.received"),
        timeoutMs: 3 * 86_400_000,
      },
      listens: [
        ["reply", 'key: "task", description: "reply"'],
        ["either", 'key: "task", description: "either"'],
        ["each", 'key: "task@" + i, description: "each"'],
      ],
      decidesInEnter: true,
    });
  });

  it("evaluates every expression inside a recorded step, none between steps", () => {
    const generated = generateWorkflow(
      checked(
        withDecisions(decision({ if: { $expr: "input.who.length > 2" } }), {
          id: "late",
          type: "wait",
          if: { $expr: "input.who.length > 3" },
          for: "1 minute",
        })
      ),
      "workflow"
    );
    const nested = generateWorkflow(checked(withLoops()), "workflow");
    const { guards, conditions } = betweenSteps(generated.source);
    const inLoops = betweenSteps(nested.source);
    expect({
      guards: [...guards, ...inLoops.guards],
      // Only what a step recorded decides the code's flow.
      conditions: [
        ...new Set([...conditions, ...inLoops.conditions]),
      ].toSorted(),
    }).toStrictEqual({
      guards: [],
      conditions: [
        '"skipped" in decided',
        "!holds.while",
        "caught === undefined",
        "decided.then",
      ].toSorted(),
    });
  });

  it("generates the same module from the same document", () => {
    expect(generateWorkflow(checked(everyStep()), "workflow")).toStrictEqual(
      generateWorkflow(checked(everyStep()), "workflow")
    );
  });
});
