import { describe, expect, it } from "vite-plus/test";

import { generateWorkflow } from "../src/generate.ts";
import { sealedTableSchema } from "../src/sealed.ts";
import type { SealedTable } from "../src/sealed.ts";
import { checked, decision, withDecisions, withLoops } from "./fixtures.ts";

// The sealed table, from its threat model: the run host trusts it, so it
// takes exactly what the generator writes. A table holding anything else
// (a construct the format doesn't have, or a part of one the host would
// read) doesn't load, so the host never meets a step it has no rule for.

/** A table of every step kind: a loop, a decision, a try that retries. */
const genuine = (): SealedTable => {
  const generation = generateWorkflow(
    checked({
      ...withLoops(decision()),
      permissions: withDecisions().permissions,
    })
  );
  return sealedTableSchema.parse(
    structuredClone({
      tasks: generation.tasks,
      expressions: generation.expressions,
      workflow: generation.workflow,
      params: generation.params,
    })
  );
};

type Part = Record<string, unknown>;

/** `task[key]`, an object, to change. */
const partOf = (task: Part, key: string): Part => {
  const value = task[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`The task has no ${key}`);
  }
  return { ...value };
};

/** The genuine table with task `id` changed by `change`. */
const withTask = (id: string, change: (task: Part) => Part): unknown => {
  const table = genuine();
  if (!table.tasks.some((task) => task.id === id)) {
    throw new Error(`The table has no task ${id}`);
  }
  return {
    ...table,
    tasks: table.tasks.map((task) =>
      task.id === id ? change({ ...task }) : task
    ),
  };
};

/** The genuine table with `task` added. */
const withNewTask = (task: Part): unknown => {
  const table = genuine();
  return { ...table, tasks: [...table.tasks, task] };
};

/** `part` of `task` with `change` in it. */
const changed = (task: Part, part: string, change: Part): Part => ({
  ...task,
  [part]: { ...partOf(task, part), ...change },
});

/** `task` with its `key` left out. */
const without = (task: Part, key: string): Part =>
  Object.fromEntries(Object.entries(task).filter(([name]) => name !== key));

describe("a sealed table", () => {
  it("loads as the generator writes it", () => {
    expect(sealedTableSchema.safeParse(genuine()).success).toBeTruthy();
  });

  it("doesn't load holding anything the run host has no rule for", () => {
    const task = { pointer: "/steps/9", steps: ["task"], scope: [] };
    // One of each kind of strictness the table holds to.
    const forged: Record<string, unknown> = {
      taskKind: withNewTask({ ...task, id: "split", kind: "fork" }),
      callName: withTask("send", (send) => ({
        ...send,
        call: { name: "grasp.now" },
      })),
      taskKey: withTask("send", (send) => ({ ...send, schemas: {} })),
      nestedKey: withTask("guarded", (guarded) =>
        changed(guarded, "catch", { exceptWhen: 0 })
      ),
      stepPart: withTask("guarded", (guarded) => ({
        ...guarded,
        steps: ["catch"],
      })),
      valueOfOtherType: withTask("linger", (linger) => ({
        ...without(linger, "milliseconds"),
        duration: { slot: 0 },
      })),
      raiseOfPlatform: withTask("stop", (stop) =>
        changed(stop, "error", { code: "workflow.failed" })
      ),
      tableKey: { ...genuine(), limits: { maxSteps: 1 } },
      expressionStage: {
        ...genuine(),
        expressions: genuine().expressions.map((expression) =>
          expression.slot === 0
            ? { ...expression, stage: "taskInputFrom" }
            : expression
        ),
      },
    };
    expect(
      Object.entries(forged).flatMap(([name, table]) =>
        sealedTableSchema.safeParse(table).success ? [name] : []
      )
    ).toStrictEqual([]);
  });
});
