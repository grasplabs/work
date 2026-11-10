import { parseProgram } from "@grasp-os/runtime/check";
import { describe, expect, it } from "vite-plus/test";

import { generateWorkflow, taskAtLine } from "../src/generate.ts";
import type { Generation } from "../src/generate.ts";
import {
  checked,
  decision,
  eventWait,
  everyStep,
  followedBy,
  keeping,
  withDecisions,
  withEventWaits,
  withLoops,
} from "./fixtures.ts";

// The generator, from its threat model: no text of a document becomes
// code, whatever it holds (quotes, `*\/`, `${`, backticks, line
// separators, `__proto__`); a step's ID is only ever the `const` of its
// result; every `ctx` call names its step and journals itself, with no
// wrapper and no thunk; the module imports only the workflow SDK and its
// helpers and loops only over a forEach's items; and the sealed table
// holds every call as the document has it.

/** A generated module, parsed as TypeScript by oxc. */
const parse = (source: string) => parseProgram(source, "ts");

/** `document` generated. */
const generated = (document: unknown): Generation =>
  generateWorkflow(checked(document));

/** What a node of a module's syntax tree has that this file reads. */
interface Node {
  readonly type: string;
  readonly [key: string]: unknown;
}

const isNode = (value: unknown): value is Node =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof value.type === "string";

/** The nodes `value` lists, if it is a list. */
const nodesIn = (value: unknown): Node[] =>
  Array.isArray(value) ? value.filter((item: unknown) => isNode(item)) : [];

/** Any number, as a matcher: an expression's slot, which its place decides. */
const aSlot: unknown = expect.any(Number);

/** Every node of `source`, a module, in order. */
const nodesOf = (source: string): Node[] => {
  const nodes: Node[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (typeof value !== "object" || value === null) {
      return;
    }
    if (isNode(value)) {
      nodes.push(value);
    }
    for (const [key, item] of Object.entries(value)) {
      if (key !== "loc" && key !== "start" && key !== "end") {
        visit(item);
      }
    }
  };
  visit(parse(source).program);
  return nodes;
};

/** The names `source` binds: each variable it declares, and each parameter. */
const boundNames = (source: string): Set<string> => {
  const names = new Set<string>();
  for (const node of nodesOf(source)) {
    if (node.type === "VariableDeclarator" && isNode(node.id)) {
      const { id } = node;
      if (id.type === "Identifier") {
        names.add(String(id.name));
      } else if (id.type === "ObjectPattern") {
        for (const property of nodesIn(id.properties)) {
          if (isNode(property.value)) {
            names.add(String(property.value.name));
          }
        }
      }
    }
    if (node.type === "CatchClause" && isNode(node.param)) {
      names.add(String(node.param.name));
    }
    if (node.type === "ArrowFunctionExpression") {
      for (const param of nodesIn(node.params)) {
        names.add(String(param.name));
      }
    }
  }
  return names;
};

/** The `step` of each `ctx` call of `source`, in order. */
const ctxCallSteps = (source: string): string[] =>
  nodesOf(source).flatMap((node) => {
    if (node.type !== "CallExpression") {
      return [];
    }
    let callee: unknown = node.callee;
    while (isNode(callee) && callee.type === "MemberExpression") {
      callee = callee.object;
    }
    if (!(isNode(callee) && callee.name === "ctx")) {
      return [];
    }
    const options = nodesIn(node.arguments).at(-1);
    const step = nodesIn(options?.properties).find(
      (property) => isNode(property.key) && property.key.name === "step"
    );
    return isNode(step?.value) ? [String(step.value.value)] : ["(none)"];
  });

/** A mail to a loop's row. */
const mailingRow = {
  id: "mailedRow",
  type: "call",
  connection: "mail",
  action: "mail.send",
  args: { to: { $expr: "item.name" }, subject: "Due" },
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

/** Args of every hostile text, as a key and as a value, `__proto__` too. */
const hostileArgs = (): Record<string, string> =>
  Object.fromEntries([
    ["__proto__", hostile[0] ?? ""],
    ...hostile.map((text, index): [string, string] => [
      `${text}${index}`,
      text,
    ]),
  ]);

/** `steps`, each one, at every level (`catch.do` too), titled anew. */
const retitled = (steps: unknown): unknown =>
  Array.isArray(steps)
    ? steps.map((step: Record<string, unknown>) => ({
        ...step,
        title: `Renamed ${String(step.id)}`,
        ...Object.fromEntries(
          ["then", "else", "try", "do"].flatMap((list) =>
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

describe("generating a workflow", () => {
  it("keeps every string, key and title of the document data", () => {
    const { source } = generated(
      followedBy(
        {
          id: "hostile",
          type: "call",
          title: hostile.join(" "),
          connection: "mail",
          action: "mail.send",
          args: hostileArgs(),
        },
        {
          id: "refused",
          type: "raise",
          error: { code: "acme.refused", message: hostile.join(" ") },
        }
      )
    );
    const identifiers = nodesOf(source).flatMap((node) =>
      node.type === "Identifier" ? [String(node.name)] : []
    );
    expect(identifiers).not.toContain("pwned");
    expect(identifiers).not.toContain("globalThis");
    expect(source).not.toContain(hostile.join(" "));
    // `__proto__` stays a key: a computed one, never the prototype.
    expect(source).toContain('["__proto__"]: ');
    expect(source).not.toMatch(/[{,] __proto__: /u);
  });

  it("binds each step's result to a `const` of its ID, and nothing else of the document", () => {
    const { source, tasks } = generated(withLoops());
    const resulting = new Set(
      tasks
        .filter((task) => task.kind === "call" || task.kind === "listen")
        .filter(
          (task) =>
            !(task.kind === "call" && task.call.name === "grasp.sleepUntil")
        )
        .map(({ id }) => id)
    );
    const own = new Set([
      "ctx",
      "args",
      "item",
      "thrown",
      "error",
      "output",
      "$$rows",
      "guardedRetries",
    ]);
    for (const name of boundNames(source)) {
      expect(resulting.has(name) || own.has(name)).toBeTruthy();
    }
  });

  it("names its step in every ctx call, once a step, and wraps none in another step", () => {
    const document = withDecisions(
      decision(),
      eventWait(),
      keeping({ id: "kept" })
    );
    const { source, tasks } = generated({
      ...document,
      permissions: {
        ...document.permissions,
        ...withEventWaits().permissions,
      },
    });
    const steps = ctxCallSteps(source);
    expect(steps).not.toContain("(none)");
    expect(new Set(steps).size).toBe(steps.length);
    // Every task that journals anything is a `ctx` call of its own.
    const called = tasks
      .filter(({ steps: parts }) => parts.length > 0)
      .map(({ id }) => id);
    expect(steps.toSorted()).toStrictEqual(called.toSorted());
  });

  it("imports only the workflow SDK and its helpers, and loops only over a forEach's items", () => {
    const { source } = generated(withLoops());
    const nodes = nodesOf(source);
    expect(
      nodes
        .filter(({ type }) => type === "ImportDeclaration")
        .map((node) => (isNode(node.source) ? node.source.value : undefined))
    ).toStrictEqual(["@grasp-os/sdk/workflow", "@grasp-os/runtime/workflow"]);
    const types = new Set(nodes.map(({ type }) => type));
    for (const loop of [
      "ForStatement",
      "ForInStatement",
      "WhileStatement",
      "DoWhileStatement",
      "FunctionDeclaration",
      "ClassDeclaration",
    ]) {
      expect(types.has(loop)).toBeFalsy();
    }
    expect(nodes.filter(({ type }) => type === "ForOfStatement")).toHaveLength(
      2
    );
  });

  it("declares exactly the permissions its steps use, by alias, with their actions and types", () => {
    expect(generated(withDecisions(decision())).source).toContain(
      'permissions: { ai: true, connections: { mail: { send: "mail.send" } }, decisions: ["approvers"] },'
    );
    expect(generated(withEventWaits(eventWait())).source).toContain(
      'events: { replies: ["grasp.reply.received"] }'
    );
    // An action not of its contract's group keeps its whole name, a path.
    expect(
      generated({
        ...followedBy({
          id: "noted",
          type: "call",
          connection: "crm",
          action: "notes.add",
        }),
        permissions: {
          ...everyStep().permissions,
          connections: {
            ...everyStep().permissions.connections,
            crm: { contract: "acme.crm@1" },
          },
        },
      }).source
    ).toContain(
      'const noted = await ctx.connections.crm.notes.add({}, { step: "noted" });'
    );
  });

  it("names a hyphenated action's member as an App does, and sends the action's own name", () => {
    const { source, tasks } = generated({
      ...followedBy({
        id: "attachment",
        type: "call",
        connection: "mail",
        action: "mail.read-attachment",
      }),
    });
    expect(source).toContain(
      'const attachment = await ctx.connections.mail.readAttachment({}, { step: "attachment" });'
    );
    expect(source).toContain('readAttachment: "mail.read-attachment"');
    expect(source).not.toContain('"read-attachment":');
    expect(tasks.find(({ id }) => id === "attachment")).toMatchObject({
      call: { operation: "mail.read-attachment" },
    });
  });

  it("seals each step's task as the run host checks it", () => {
    const { tasks, workflow } = generated(
      withDecisions(decision({ timeout: "2 days" }))
    );
    const byId = Object.fromEntries(tasks.map((task) => [task.id, task]));
    expect(byId).toMatchObject({
      linger: { kind: "wait", steps: ["task"], milliseconds: 3_600_000 },
      send: {
        kind: "call",
        steps: ["task"],
        call: {
          name: "grasp.connector",
          binding: "mail",
          operation: "mail.send",
        },
      },
      greet: { call: { name: "grasp.model", binding: "ai" } },
      known: { kind: "switch", steps: [] },
      pause: { steps: ["enter", "task"], call: { name: "grasp.sleepUntil" } },
      guarded: {
        kind: "try",
        steps: [],
        catch: {
          code: "connect.unavailable",
          retry: { attempts: 3, delayMs: 1000, backoff: "constant" },
        },
      },
      approve: {
        steps: ["enter", "task"],
        call: {
          name: "grasp.decision",
          binding: "approvers",
          recipients: { array: [{ literal: "person:ada" }, { slot: aSlot }] },
          prompt: { literal: "Approve this?" },
          timeoutMs: 172_800_000,
        },
      },
    });
    expect(byId.stop).toStrictEqual({
      id: "stop",
      kind: "raise",
      pointer: "/steps/3/else/0",
      steps: [],
      scope: [],
      error: { code: "greeting.stopped", message: "Stopped." },
    });
    expect(workflow).toStrictEqual({ output: true });
  });

  it("seals an event wait's permission, types and timeout, its match recorded in an enter step", () => {
    const plain = generated(withEventWaits(eventWait()));
    expect(plain.tasks.find(({ id }) => id === "reply")).toMatchObject({
      kind: "listen",
      steps: ["task"],
      timeoutMs: 259_200_000,
      listen: {
        binding: "replies",
        strategy: "any",
        filters: [{ type: "grasp.reply.received", attributes: [] }],
      },
    });
    const matching = generated(
      withEventWaits(
        eventWait({
          match: { field: "/invoice", equals: { $expr: "send.id" } },
        })
      )
    );
    expect(matching.tasks.find(({ id }) => id === "reply")).toMatchObject({
      steps: ["enter", "task"],
      listen: {
        match: { field: "/invoice", equals: { slot: aSlot } },
      },
    });
    expect(matching.source).toContain(
      'ctx.events.replies.waitFor({ type: "grasp.reply.received", match: { field: "/invoice", equals: send.id }, timeout: "3 days" }, { step: "reply" })'
    );
  });

  it("seals a loop's tasks with the loops around them", () => {
    const { tasks } = generated(withLoops());
    const scopes = Object.fromEntries(
      tasks.map(({ id, scope }) => [id, scope])
    );
    expect(scopes).toMatchObject({
      pages: [],
      rows: ["pages"],
      hold: ["pages", "rows"],
      guard: ["pages", "rows"],
      mailed: ["pages", "rows"],
    });
    expect(tasks.find(({ id }) => id === "rows")).toMatchObject({
      kind: "for",
      steps: [],
      loop: { each: "item", while: aSlot },
    });
  });

  it("seals what a call keeps in state, and keeps it from its result in its own record", () => {
    const { tasks, source } = generated(followedBy(keeping()));
    expect(tasks.find(({ id }) => id === "remember")).toMatchObject({
      state: {
        last: {
          template: { slot: aSlot },
          value: { kind: "string" },
        },
        marked: { template: { literal: true }, value: { kind: "boolean" } },
      },
    });
    expect(source).toContain(
      'state: (output) => ({ last: output.id, previous: state.last ?? "none", runs: (state.runs ?? 0) + 1, kept: ["kept", output.id], marked: true })'
    );
    expect(source).toContain("const { state } = ctx;");
  });

  it("passes a retrying try's policy to each call it covers, and reads a catch's failure as data", () => {
    const { source } = generated(everyStep());
    expect(
      [
        '{ step: "fetch", retry: guardedRetries }',
        "const error = caughtError(thrown);",
        'if (!(error.code === "connect.unavailable" && (error.message !== "final"))) throw thrown;',
        // A call in the catch's own list isn't retried by it.
        '{ step: "notice" }',
      ].filter((line) => !source.includes(line))
    ).toStrictEqual([]);
  });

  it("decides a retry's `when` where its try is written, so it reads that loop's `item`", () => {
    const { source, expressions } = generated(
      followedBy({
        id: "pagesLoop",
        type: "forEach",
        items: { $expr: "args.pages" },
        do: [
          {
            id: "page",
            type: "try",
            try: [
              {
                id: "rowsLoop",
                type: "forEach",
                items: { $expr: "item.rows" },
                do: [mailingRow],
              },
            ],
            catch: {
              retry: {
                attempts: 2,
                delay: "1 minute",
                backoff: "constant",
                when: { $expr: "item.open" },
              },
            },
          },
        ],
      })
    );
    const lines = source.split("\n");
    const declared = lines.findIndex((line) =>
      line.includes(
        "const pageRetries = (error: CaughtError) => Boolean(item.open);"
      )
    );
    const inner = lines.findIndex((line) =>
      line.includes("for (const item of $$rowsLoop)")
    );
    expect({
      declaredBeforeInnerLoop: declared !== -1 && declared < inner,
      passed: source.includes('{ step: "mailedRow", retry: pageRetries }'),
      // One `when` a retrying try, sealed once: this one and `everyStep`'s.
      whens: expressions.filter(({ pointer }) =>
        pointer.endsWith("/catch/retry/when")
      ).length,
    }).toStrictEqual({
      declaredBeforeInnerLoop: true,
      passed: true,
      whens: 2,
    });
  });

  it("ties each line of a step's code to that step", () => {
    const { source, spans } = generated(withLoops());
    const lines = source.split("\n");
    const lineOf = (text: string): number =>
      lines.findIndex((line) => line.includes(text)) + 1;
    expect(taskAtLine(spans, lineOf('{ step: "mailed"'))?.taskId).toBe(
      "mailed"
    );
    expect(taskAtLine(spans, lineOf("const $$rows"))?.taskId).toBe("rows");
    expect(taskAtLine(spans, lineOf("throw new AppError"))?.taskId).toBe(
      "stop"
    );
    expect(taskAtLine(spans, 1)).toBeUndefined();
  });

  it("generates the same module from the same document, whatever its titles say", () => {
    const document = withLoops(decision());
    const { permissions } = withDecisions();
    const first = generated({ ...document, permissions });
    const again = generated({ ...document, permissions });
    const renamed = generated({
      ...document,
      permissions,
      steps: retitled(document.steps),
    });
    expect(again).toStrictEqual(first);
    expect(renamed.source).toBe(first.source);
    expect(renamed.tasks).toStrictEqual(first.tasks);
  });
});
