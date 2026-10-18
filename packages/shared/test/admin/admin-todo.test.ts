import { describe, expect, it } from "vite-plus/test";

import { todoOf, todosAt } from "../../src/admin/admin-todo.ts";
import { adminViewOf } from "../../src/admin/admin-view.ts";
import { notesOf } from "../../src/admin/onboarding-admin.ts";
import type { Org, OrgState } from "../../src/admin/onboarding-admin.ts";
import { SAMPLE_ORGS } from "./fixtures/admin-sample.ts";

const [noordkade, veldkamp, vanrijn] = SAMPLE_ORGS;
const today = "2026-10-02";
const at = (org: Org, more: Partial<OrgState> = {}) =>
  adminViewOf(org, { ...org.seed, ...more }, today);

describe("what the stage an organization is at asks of Grasp", () => {
  it("lists the agreements while they are not all in, and which one holds it up", () => {
    const todo = todoOf(at(veldkamp));
    expect(todo.stage).toBe("agreed");
    expect(
      todo.todos.map((each) =>
        each.kind === "agreement" ? [each.what, each.done] : null
      )
    ).toStrictEqual([
      ["processing", true],
      ["assessment", true],
      ["council", false],
    ]);
    expect(todo).toMatchObject({ done: 2, of: 3 });
  });

  it("starts with the first conversation, brought in and not read yet", () => {
    const todo = todoOf(at(vanrijn));
    expect(todo.stage).toBe("conversation");
    expect(todo.todos.map((each) => [each.kind, each.done])).toStrictEqual([
      ["transcriptIn", true],
      ["transcriptRead", false],
      ["askSponsor", false],
    ]);
    expect(
      todoOf(at(vanrijn, { conversation: "none" })).todos[0]
    ).toStrictEqual({
      kind: "transcriptIn",
      done: false,
    });
  });

  it("counts who talked during the interviews, with whom the one reminder can still go to", () => {
    const todo = todoOf(at(noordkade));
    expect(todo.stage).toBe("interviews");
    const talked = todo.todos.find((each) => each.kind === "talked");
    expect(talked).toMatchObject({ kind: "talked", done: false });
    expect(
      talked?.kind === "talked" ? talked.remind.length : 0
    ).toBeGreaterThan(0);
    expect(
      todo.todos.find((each) => each.kind === "workflowsKnown")
    ).toMatchObject({ known: 5, of: 20 });
  });

  it("keeps what belongs to another stage, or to none, apart from the list", () => {
    const todo = todoOf(at(noordkade));
    expect(todo.elsewhere.map((need) => need.kind)).toStrictEqual([
      "go",
      "conflict",
      "ask",
      "signin",
    ]);
    // Reading the interviews belongs to this stage: it is on the list, not beside it.
    expect(
      todo.todos.some((each) => each.kind === "read" && !each.done)
    ).toBeTruthy();
  });

  it("asks for Grasp’s go once enough is known", () => {
    expect(
      todosAt(at(noordkade), "open").map((each) => [each.kind, each.done])
    ).toStrictEqual([
      ["known", true],
      ["go", false],
    ]);
    expect(
      todosAt(at(noordkade, { opened: 8 }), "open").every((each) => each.done)
    ).toBeTruthy();
  });
});

describe("Grasp’s notes on an organization", () => {
  it("carry a single text from before notes were a list as the first of the list", () => {
    expect(notesOf("Call Anne on Monday.")).toStrictEqual([
      { id: "note-0", at: 0, text: "Call Anne on Monday." },
    ]);
    expect(notesOf("   ")).toStrictEqual([]);
    expect(notesOf()).toStrictEqual([]);
    expect(
      notesOf([{ id: "a", at: 5, text: "x" }, { id: "b" }, null])
    ).toStrictEqual([{ id: "a", at: 5, text: "x" }]);
  });
});
