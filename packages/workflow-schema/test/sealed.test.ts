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

  it("doesn't load holding anything the generator never writes", () => {
    const task = { pointer: "/steps/9", steps: ["task"], scope: [] };
    const forged: Record<string, unknown> = {
      fork: withNewTask({
        ...task,
        id: "split",
        kind: "fork",
        fork: { branches: 2, compete: false, concurrency: 1 },
      }),
      childRun: withNewTask({
        ...task,
        id: "child",
        kind: "run",
        run: { binding: "other", input: { literal: null } },
      }),
      set: withNewTask({ ...task, id: "assign", kind: "set" }),
      clock: withTask("send", (send) => ({
        ...send,
        call: { name: "grasp.now" },
      })),
      itemsAtOnce: withTask("pages", (pages) =>
        changed(pages, "loop", { concurrency: 4 })
      ),
      loopKeys: withTask("pages", (pages) =>
        changed(pages, "loop", { keys: 0 })
      ),
      forkBranch: withTask("mailed", (mail) => ({ ...mail, branches: [0, 1] })),
      taskSchemas: withTask("send", (send) => ({ ...send, schemas: {} })),
      inputFrom: withTask("send", (send) => ({
        ...send,
        inputFrom: { slot: 0 },
      })),
      catchExceptWhen: withTask("guarded", (guarded) =>
        changed(guarded, "catch", { exceptWhen: 0 })
      ),
      retryJitter: withTask("guarded", (guarded) => {
        const caught = partOf(guarded, "catch");
        return {
          ...guarded,
          catch: {
            ...caught,
            retry: {
              ...partOf(caught, "retry"),
              jitter: { fromMs: 0, toMs: 1000 },
            },
          },
        };
      }),
      retryLimit: withTask("guarded", (guarded) => {
        const caught = partOf(guarded, "catch");
        return {
          ...guarded,
          catch: {
            ...caught,
            retry: { ...partOf(caught, "retry"), limitMs: 60_000 },
          },
        };
      }),
      modelChosen: withTask("greet", (greet) =>
        changed(greet, "call", { model: { literal: "another" } })
      ),
      outputTokens: withTask("greet", (greet) =>
        changed(greet, "call", { maxOutputTokens: { literal: 10 } })
      ),
      decisionAsks: withTask("approve", (approve) =>
        changed(approve, "call", {
          ask: { binding: "notify", module: "code/notify.ts", export: "ask" },
        })
      ),
      decisionReminds: withTask("approve", (approve) =>
        changed(approve, "call", { remindAfterMs: 60_000 })
      ),
      waitOfExpression: withTask("linger", (linger) => ({
        ...without(linger, "milliseconds"),
        duration: { slot: 0 },
      })),
      // grasp-workflow/1's step kinds, gone with its enter and catch steps.
      catchStep: withTask("guarded", (guarded) => ({
        ...guarded,
        steps: ["catch"],
      })),
      itemStep: withTask("rows", (rows) => ({ ...rows, steps: ["item"] })),
      loopIndex: withTask("pages", (pages) =>
        changed(pages, "loop", { at: "index" })
      ),
      catchByStatus: withTask("guarded", (guarded) =>
        changed(guarded, "catch", { errors: { status: 500 } })
      ),
      raiseByType: withTask("stop", (stop) => ({
        ...stop,
        error: { type: "urn:acme:error:stop", status: 422 },
      })),
      raisePlatformCode: withTask("stop", (stop) =>
        changed(stop, "error", { code: "Not a code" })
      ),
      workflowInput: { ...genuine(), workflow: { input: true, output: true } },
      ownLimits: { ...genuine(), limits: { maxSteps: 1 } },
      inputExpression: {
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
