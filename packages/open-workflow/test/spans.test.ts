/* oxlint-disable unicorn/no-thenable -- `then` is Open Workflow's flow directive, not a promise */
import { describe, expect, it } from "vite-plus/test";

import { generateWorkflow, taskAtLine } from "../src/generate.ts";
import { validateWorkflow } from "../src/validate.ts";
import { documentAround, options } from "./fixtures.ts";

// Where a line of a generated module is in the definition: the task whose
// code holds it, by its JSON Pointer and ID, so a build failure of the
// module (the platform's) is logged in the definition's terms.

const generated = async (tasks: unknown[]) => {
  const checked = await validateWorkflow(
    JSON.stringify(
      documentAround({ name: "spans", input: {}, required: [] }, tasks)
    ),
    options
  );
  if (!checked.ok) {
    throw new Error("The fixture definition doesn't validate");
  }
  const generation = generateWorkflow(checked.workflow);
  if (!generation.ok) {
    throw new Error("The fixture definition doesn't generate");
  }
  return generation;
};

describe("a generated module's lines, in the definition's terms", () => {
  it("names the innermost task whose code holds a line, and none for the module's own frame", async () => {
    const { source, spans } = await generated([
      { first: { set: { status: "one" } } },
      { outer: { do: [{ inner: { set: { status: "two" } } }] } },
    ]);
    const lines = source.split("\n");
    const lineOf = (text: string): number =>
      lines.findIndex((line) => line.includes(text)) + 1;
    expect({
      first: taskAtLine(spans, lineOf('"first"'))?.pointer,
      inner: taskAtLine(spans, lineOf('"inner"'))?.taskId,
      frame: taskAtLine(spans, 1),
    }).toStrictEqual({
      first: "/do/0/first",
      inner: "inner",
      frame: undefined,
    });
  });

  it("counts a task's transition as its own code", async () => {
    const { source, spans } = await generated([
      {
        outer: {
          do: [
            { inner: { set: { status: "two" }, then: "end" } },
            { after: { set: { status: "three" } } },
          ],
        },
      },
    ]);
    const lines = source.split("\n");
    const innerStart = lines.findIndex((line) => line.includes('"inner"'));
    // The first `break` after the inner task's statement: its `then: end`.
    const jump =
      lines.findIndex(
        (line, index) => index > innerStart && line.trim().startsWith("break")
      ) + 1;
    expect(taskAtLine(spans, jump)?.taskId).toBe("inner");
  });
});
