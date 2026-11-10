import { parseProgram } from "@grasp-os/runtime/oxc-parse";
import { describe, expect, it } from "vite-plus/test";

import { checkWorkflow } from "../src/check.ts";
import { generateWorkflow } from "../src/generate.ts";
import { checked, fileSteps, withFiles } from "./fixtures.ts";

// Calls on the run's own files, on a Brain collection, and a connection
// call keeping a file or attaching run files, from their threat model
// (generate.ts, core's sealed-run.ts): each reaches only the permission
// and the action the document names, both sealed; a file's ID is the
// only thing an expression gives, and the host looks it up by the run's
// own; `into` and `from` name files permissions alone, sealed, and the
// code names the same.

/** A node of a parsed module, as this file reads it. */
interface Node {
  readonly type: string;
  readonly [key: string]: unknown;
}

const isNode = (value: unknown): value is Node =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof value.type === "string";

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
  visit(parseProgram(source, "ts").program);
  return nodes;
};

/** The dotted path of member expression `node` from its root name, if plain. */
const pathOf = (node: unknown): string | undefined => {
  if (!isNode(node)) {
    return undefined;
  }
  if (node.type === "Identifier") {
    return typeof node.name === "string" ? node.name : undefined;
  }
  if (node.type !== "MemberExpression" || node.computed === true) {
    return undefined;
  }
  const object = pathOf(node.object);
  const property = isNode(node.property) ? node.property.name : undefined;
  return object === undefined || typeof property !== "string"
    ? undefined
    : `${object}.${property}`;
};

/** The JSON literal `node` is, if it is one: what a declaration holds. */
const literalOf = (node: unknown): unknown => {
  if (!isNode(node)) {
    return undefined;
  }
  if (node.type === "Literal") {
    return node.value;
  }
  if (node.type === "ArrayExpression" && Array.isArray(node.elements)) {
    return node.elements.map((element: unknown) => literalOf(element));
  }
  if (node.type === "ObjectExpression" && Array.isArray(node.properties)) {
    return Object.fromEntries(
      node.properties.flatMap((property: unknown) => {
        if (!isNode(property) || !isNode(property.key)) {
          return [];
        }
        const { key } = property;
        const name = key.type === "Identifier" ? key.name : key.value;
        return typeof name === "string"
          ? [[name, literalOf(property.value)]]
          : [];
      })
    );
  }
  return undefined;
};

/**
 * Each `ctx` member call of `source`, by the step its options name: the
 * member it calls, and the files permissions it names (`into`, `from`).
 */
const callsOf = (source: string): Record<string, Record<string, unknown>> =>
  Object.fromEntries(
    nodesOf(source).flatMap((node) => {
      const member = pathOf(node.callee);
      const options = Array.isArray(node.arguments)
        ? literalOf(node.arguments[1])
        : undefined;
      if (
        node.type !== "CallExpression" ||
        member?.startsWith("ctx.") !== true ||
        typeof options !== "object" ||
        options === null ||
        !("step" in options)
      ) {
        return [];
      }
      const step: unknown = Reflect.get(options, "step");
      const into: unknown = Reflect.get(options, "into");
      const from: unknown = Reflect.get(options, "from");
      return [
        [
          String(step),
          {
            member,
            ...(into === undefined ? {} : { into }),
            ...(from === undefined ? {} : { from }),
          },
        ],
      ];
    })
  );

/** What `source`'s `defineWorkflow` declares as its permissions. */
const permissionsOf = (source: string): unknown =>
  literalOf(
    nodesOf(source).find(
      (node) =>
        node.type === "Property" &&
        isNode(node.key) &&
        node.key.name === "permissions"
    )?.value
  );

/** The codes of `document`'s problems by their pointers, or "ok". */
const codesAt = (document: unknown): unknown => {
  const result = checkWorkflow(document);
  return result.ok
    ? "ok"
    : Object.fromEntries(
        result.problems.map(({ pointer, code }) => [pointer, code])
      );
};

/** Each of `cases`' documents' problems, by the case's name. */
const codesOf = (cases: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(
    Object.entries(cases).map(([name, document]) => [name, codesAt(document)])
  );

const listed = {
  id: "listed",
  type: "call",
  files: "runFiles",
  action: "list",
  args: {},
};

const searched = {
  id: "searched",
  type: "call",
  brain: "handbook",
  action: "search",
  args: { text: "refunds" },
};

const attachment = {
  id: "attachment",
  type: "call",
  connection: "mail",
  action: "mail.readAttachment",
  args: { message: "m1", attachment: "a1" },
  into: "runFiles",
};

/** Any number, as a matcher: an expression's slot, which its place decides. */
const aSlot: unknown = expect.any(Number);

/** What `fileSteps` generate: the module, and each step's task by its ID. */
const generated = () => {
  const generation = generateWorkflow(checked(withFiles(...fileSteps())));
  return {
    source: generation.source,
    task: (id: string) => generation.tasks.find((task) => task.id === id),
  };
};

describe("calls on the run's files and the Brain", () => {
  it("checks a call of each action, and connection calls keeping and attaching files", () => {
    expect(codesAt(withFiles(...fileSteps()))).toBe("ok");
  });

  it("refuses an action not on the fixed lists, and a call naming two members", () => {
    const twoMembers = { "/steps/5": "workflow.call_kind" };
    expect(
      codesOf({
        // An action's own (`open`, which an action's files use streams
        // by), or another kind's, is no member of `ctx.files` or
        // `ctx.brain`.
        open: withFiles({ ...listed, action: "open" }),
        brainDelete: withFiles({ ...searched, action: "delete" }),
        both: withFiles({ ...listed, connection: "mail" }),
        // `into` and `from` are a connection call's alone.
        filesInto: withFiles({ ...listed, into: "runFiles" }),
        brainFrom: withFiles({ ...searched, from: "runFiles" }),
      })
    ).toStrictEqual({
      open: { "/steps/5/action": "workflow.unknown_action" },
      brainDelete: { "/steps/5/action": "workflow.unknown_action" },
      both: twoMembers,
      filesInto: twoMembers,
      brainFrom: twoMembers,
    });
  });

  it("refuses a permission of another kind or none, `into` and `from` included", () => {
    expect(
      codesOf({
        filesOnBrain: withFiles({ ...listed, files: "handbook" }),
        brainOnFiles: withFiles({ ...searched, brain: "runFiles" }),
        filesNowhere: withFiles({ ...listed, files: "elsewhere" }),
        intoConnection: withFiles({ ...attachment, into: "mail" }),
        intoBrain: withFiles({ ...attachment, into: "handbook" }),
        fromNowhere: withFiles({ ...attachment, from: "nobody" }),
      })
    ).toStrictEqual({
      filesOnBrain: { "/steps/5/files": "workflow.permission_kind" },
      brainOnFiles: { "/steps/5/brain": "workflow.permission_kind" },
      filesNowhere: { "/steps/5/files": "workflow.unknown_permission" },
      intoConnection: { "/steps/5/into": "workflow.permission_kind" },
      intoBrain: { "/steps/5/into": "workflow.permission_kind" },
      fromNowhere: { "/steps/5/from": "workflow.unknown_permission" },
    });
  });

  it("refuses a sensitive parameter anywhere but a connection call's arguments", () => {
    expect(
      codesOf({
        search: withFiles({
          ...searched,
          args: { text: { $expr: "params.token" } },
        }),
        write: withFiles({
          id: "written",
          type: "call",
          files: "runFiles",
          action: "write",
          args: {
            name: "token.txt",
            type: "text/plain",
            text: { $expr: "params.token" },
          },
        }),
      })
    ).toStrictEqual({
      search: { "/steps/5/args/text/$expr": "workflow.sensitive" },
      write: { "/steps/5/args/text/$expr": "workflow.sensitive" },
    });
  });

  it("refuses a read that passes a sensitive parameter keeping a file, which could hold it", () => {
    const passing = {
      ...attachment,
      args: { message: { $expr: "params.token" }, attachment: "a1" },
    };
    const { into: _into, ...notKept } = passing;
    expect(
      codesOf({ kept: withFiles(passing), notKept: withFiles(notKept) })
    ).toStrictEqual({
      kept: { "/steps/5/into": "workflow.sensitive" },
      notKept: "ok",
    });
  });
});

describe("generating calls on the run's files and the Brain", () => {
  it("calls each step's member with its step, and a connection's files permissions as sealed", () => {
    expect(callsOf(generated().source)).toMatchObject({
      listed: { member: "ctx.files.runFiles.list" },
      notes: { member: "ctx.files.runFiles.read" },
      searched: { member: "ctx.brain.handbook.search" },
      doc: { member: "ctx.brain.handbook.read" },
      recalled: { member: "ctx.brain.handbook.recall" },
      summary: { member: "ctx.files.runFiles.write" },
      attachment: {
        member: "ctx.connections.mail.readAttachment",
        into: "runFiles",
      },
      forwarded: { member: "ctx.connections.mail.send", from: "runFiles" },
      removed: { member: "ctx.files.runFiles.delete" },
    });
  });

  it("declares only the actions its steps take, so no other is a member", () => {
    const declared = (...steps: unknown[]) =>
      permissionsOf(generateWorkflow(checked(withFiles(...steps))).source);
    expect({
      some: declared({ ...listed }, { ...searched }),
      every: declared(...fileSteps()),
    }).toMatchObject({
      some: { files: { runFiles: ["list"] }, brain: { handbook: ["search"] } },
      every: {
        files: { runFiles: ["list", "read", "write", "delete"] },
        brain: { handbook: ["search", "read", "recall"] },
      },
    });
  });

  it("seals each files and Brain call's permission and action, its arguments a template, and a connection's files permissions only where the step names them", () => {
    const { task } = generated();
    const filesOf = (id: string) => {
      const sealed = task(id);
      return sealed?.kind === "call" && sealed.call.name === "grasp.connector"
        ? { into: sealed.call.into ?? null, from: sealed.call.from ?? null }
        : null;
    };
    expect({
      listed: task("listed"),
      notes: task("notes"),
      searched: task("searched"),
      files: {
        attachment: filesOf("attachment"),
        forwarded: filesOf("forwarded"),
      },
    }).toMatchObject({
      listed: {
        kind: "call",
        call: {
          name: "grasp.files",
          binding: "runFiles",
          operation: "list",
          arguments: { literal: {} },
        },
      },
      notes: {
        call: {
          name: "grasp.files",
          binding: "runFiles",
          operation: "read",
          arguments: { object: [["file", { slot: aSlot }]] },
        },
      },
      searched: {
        call: { name: "grasp.brain", binding: "handbook", operation: "search" },
      },
      files: {
        attachment: { into: "runFiles", from: null },
        forwarded: { into: null, from: "runFiles" },
      },
    });
  });
});
