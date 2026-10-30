import type {
  DiagramTask,
  WorkflowDiagram,
} from "@grasp-os/shared/workflow-diagrams";
import { describe, expect, it } from "vite-plus/test";

import { doorsOf, partsOf } from "./diagram-parts.ts";

// A workflow's parts and doors, as the canvas and its Overview read them
// from the diagram core drew: parts begin where a task names one, and
// each other workflow is one door, however many tasks lead to it.

const task = (id: string, more: Partial<DiagramTask> = {}): DiagramTask => ({
  id,
  pointer: `/do/${id}`,
  kind: "set",
  label: null,
  detail: null,
  guarded: false,
  next: { kind: "continue" },
  scopes: [],
  ...more,
});

const decision = (id: string) =>
  task(id, { kind: "call", detail: "grasp.decision · approval" });

describe(partsOf, () => {
  it("draws a workflow with no named part in no parts", () => {
    expect(partsOf({ tasks: [task("a"), task("b")] })).toStrictEqual([]);
  });

  it("begins a part at each task that names one, counting its steps and where people come in", () => {
    const diagram: WorkflowDiagram = {
      tasks: [
        task("before"),
        task("read", {
          section: { name: "Read", purpose: "Read it.", summary: null },
        }),
        task("check", {
          kind: "do",
          scopes: [
            {
              kind: "do",
              name: null,
              guarded: false,
              next: null,
              tasks: [decision("approve"), task("note")],
            },
          ],
        }),
        task("pay", {
          section: { name: "Pay", purpose: null, summary: "It pays." },
        }),
      ],
    };
    expect(
      partsOf(diagram).map(({ n, name, steps, decisions, summary }) => ({
        n,
        name,
        steps,
        decisions,
        summary,
      }))
    ).toStrictEqual([
      { n: 1, name: "", steps: 1, decisions: 0, summary: null },
      { n: 2, name: "Read", steps: 4, decisions: 1, summary: null },
      { n: 3, name: "Pay", steps: 1, decisions: 0, summary: "It pays." },
    ]);
  });
});

describe(doorsOf, () => {
  it("lists each workflow behind a door once, with every task leading to it, and keeps unseen ones apart", () => {
    const child = { flow: "waits" as const, workflowId: "w1", name: "child" };
    const unseen = { flow: "hands" as const, workflowId: null, name: null };
    const doors = doorsOf({
      tasks: [
        task("first", { kind: "run", doors: [child] }),
        task("again", { kind: "run", doors: [child] }),
        task("tell", { kind: "emit", doors: [unseen] }),
        task("tell-too", { kind: "emit", doors: [unseen] }),
        task("plain"),
      ],
    });
    expect(doors).toStrictEqual([
      { ...child, tasks: ["/do/first", "/do/again"] },
      { ...unseen, tasks: ["/do/tell"] },
      { ...unseen, tasks: ["/do/tell-too"] },
    ]);
  });
});
