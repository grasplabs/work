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
});

describe("generating calls on the run's files and the Brain", () => {
  it("calls typed members, and names a connection call's files permissions as sealed", () => {
    const { source } = generated();
    expect(
      [
        'const listed = await ctx.files.runFiles.list({}, { step: "listed" });',
        'const notes = await ctx.files.runFiles.read({ file: listed[0].file }, { step: "notes" });',
        'const searched = await ctx.brain.handbook.search({ text: notes.text }, { step: "searched" });',
        'files: { runFiles: ["list", "read", "write", "delete"] }',
        'brain: { handbook: ["search", "read", "recall"] }',
        '{ step: "attachment", into: "runFiles" }',
        '{ step: "forwarded", from: "runFiles" }',
      ].filter((line) => !source.includes(line))
    ).toStrictEqual([]);
  });

  it("declares only the actions its steps take, so no other is a member", () => {
    const { source } = generateWorkflow(
      checked(withFiles({ ...listed }, { ...searched }))
    );
    expect({
      files: source.includes('files: { runFiles: ["list"] }'),
      brain: source.includes('brain: { handbook: ["search"] }'),
      others: ['"write"', '"delete"', '"recall"'].filter((name) =>
        source.includes(name)
      ),
    }).toStrictEqual({ files: true, brain: true, others: [] });
  });

  it("seals each files and Brain call's permission and action, its arguments a template, and a connection's files permissions", () => {
    const { task } = generated();
    expect({
      listed: task("listed"),
      notes: task("notes"),
      searched: task("searched"),
      attachment: task("attachment"),
      forwarded: task("forwarded"),
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
      attachment: { call: { name: "grasp.connector", into: "runFiles" } },
      forwarded: { call: { name: "grasp.connector", from: "runFiles" } },
    });
  });

  it("seals a connection call's files permissions only where the step names them", () => {
    const { task } = generated();
    const keysOf = (id: string): string[] => {
      const sealed = task(id);
      return sealed?.kind === "call" ? Object.keys(sealed.call) : [];
    };
    expect({
      attachment: keysOf("attachment"),
      forwarded: keysOf("forwarded"),
    }).toStrictEqual({
      attachment: ["name", "binding", "operation", "arguments", "into"],
      forwarded: ["name", "binding", "operation", "arguments", "from"],
    });
  });
});
