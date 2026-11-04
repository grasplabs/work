import { parse } from "@babel/parser";
import { describe, expect, it } from "vite-plus/test";

import { generateWorkflow } from "../src/generate.ts";
import { checked, everyStep } from "./fixtures.ts";

// The generator, from its threat model: no text of a document becomes
// code, whatever it holds (quotes, `*\/`, `${`, backticks, line
// separators, `__proto__`), no ID becomes a name, the module imports only
// the workflow SDK and has no loop, and the sealed table holds every call
// as the document has it.

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
  visit(parse(source, { sourceType: "module" }).program);
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
  visit(parse(source, { sourceType: "module" }).program);
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

/** `steps`, each one, at every level, titled anew. */
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
      }))
    : steps;

/** Any value, as a matcher. */
const anything: unknown = expect.anything();

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
      comments: parse(generated.source, { sourceType: "module" }).comments
        ?.length,
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

  it("makes no name of an ID, imports only the workflow SDK, and has no loop", () => {
    const generated = generateWorkflow(checked(everyStep()), "workflow");
    const { body } = parse(generated.source, { sourceType: "module" }).program;
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
      ].filter((id) => names.has(id)),
      loops: [
        "ForStatement",
        "WhileStatement",
        "DoWhileStatement",
        "ForInStatement",
        "ForOfStatement",
      ].filter((type) => types.has(type)),
    }).toStrictEqual({
      imports: ["@grasp-os/sdk/workflow"],
      ids: [],
      loops: [],
    });
  });

  it("seals each step's task as the run host checks it", () => {
    const generated = generateWorkflow(checked(everyStep()), "workflow");
    const slotOf = (pointer: string) =>
      generated.expressions.find((expression) => expression.pointer === pointer)
        ?.slot;
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
    }).toStrictEqual({
      tasks: [
        { id: "linger", kind: "wait", pointer: "/steps/0", steps: ["task"] },
        { id: "send", kind: "call", pointer: "/steps/1", steps: ["task"] },
        { id: "greet", kind: "call", pointer: "/steps/2", steps: ["task"] },
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
            ["to", { slot: slotOf("/steps/1/arguments/to") }],
            ["subject", { param: "token" }],
            ...["priority", "cc", "headers", "tone", "shout"].map(
              (name) =>
                [name, { slot: slotOf(`/steps/1/arguments/${name}`) }] as const
            ),
          ],
        },
      },
      greet: {
        name: "grasp.model",
        binding: "summary",
        instructions: { literal: "Greet them." },
        input: {
          object: [
            ["who", { slot: slotOf("/steps/2/input/who") }],
            [
              "tags",
              {
                array: [
                  { literal: "vip" },
                  { slot: slotOf("/steps/2/input/tags/1") },
                ],
              },
            ],
          ],
        },
        outputSchema: anything,
      },
      linger: 3_600_000,
      pause: {
        name: "grasp.sleepUntil",
        timestamp: { slot: slotOf("/steps/3/then/0/until") },
      },
      stop: { type: "urn:grasp:error:stop", status: 422, title: "Stopped." },
      guarded: {
        variable: "error",
        errors: { status: 500 },
        retry: { attempts: 3, delayMs: 1000, backoff: "constant" },
      },
      // The sensitive token is never handed to the run's code.
      params: ["greeting"],
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

  it("generates the same module from the same document", () => {
    expect(generateWorkflow(checked(everyStep()), "workflow")).toStrictEqual(
      generateWorkflow(checked(everyStep()), "workflow")
    );
  });
});
