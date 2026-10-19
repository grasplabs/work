/* oxlint-disable no-template-curly-in-string, unicorn/no-thenable -- workflow expressions are written as ${ … } strings, and transitions as then */
import type {
  DiagramNext,
  DiagramScope,
  DiagramTask,
} from "@grasp-os/shared/workflow-diagrams";
import { describe, expect, it } from "vite-plus/test";

import { workflowDiagram } from "../src/diagram.ts";
import { validateWorkflow } from "../src/validate.ts";
import {
  approval,
  documentAround,
  eventRecovery,
  options,
  parallelChildren,
  polling,
} from "./fixtures.ts";

// A workflow's diagram, drawn from definitions the profile accepts (13.9's
// examples): every declared case, branch and scope, each task by its ID,
// the transitions as written, and nothing of what source says through an
// expression.

const nextText = (next: DiagramNext | null): string => {
  if (next === null) {
    return "";
  }
  return next.kind === "task" ? ` → ${next.task}` : ` → ${next.kind}`;
};

/** A diagram as lines: each task, then its scopes indented under it. */
const outline = (tasks: readonly DiagramTask[], depth = 0): string[] =>
  tasks.flatMap((task) => [
    `${"  ".repeat(depth)}${task.id} (${task.kind}${task.guarded ? ", if" : ""})${task.detail === null ? "" : ` ${task.detail}`}${task.next.kind === "continue" ? "" : nextText(task.next)}`,
    ...task.scopes.flatMap((scope: DiagramScope) => [
      `${"  ".repeat(depth + 1)}[${scope.kind}${scope.name === null ? "" : ` ${scope.name}`}${scope.guarded ? ", when" : ""}]${nextText(scope.next)}`,
      ...outline(scope.tasks, depth + 2),
    ]),
  ]);

/** The diagram of `definition`, which must first pass the profile. */
const diagramOf = async (definition: unknown): Promise<string[]> => {
  const result = await validateWorkflow(JSON.stringify(definition), options);
  if (!result.ok) {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return outline(workflowDiagram(result.workflow.definition).tasks);
};

/** A two-task workflow whose first task has `label`, as diagrammed. */
const labelled = async (label: string) => {
  const definition = documentAround(
    {
      name: "labelled",
      params: {
        pause: {
          schema: { type: "integer", minimum: 1, maximum: 60 },
          label: "Pause",
          default: 5,
          sensitive: false,
        },
      },
      input: {},
      required: [],
    },
    [
      {
        pause: {
          wait: '${ "PT" + ($params.pause | tostring) + "S" }',
          metadata: { grasp: { label, position: { x: 1, y: 2 } } },
        },
      },
      { done: { set: { status: "done" } } },
    ]
  );
  const result = await validateWorkflow(JSON.stringify(definition), options);
  if (!result.ok) {
    throw new Error(JSON.stringify(result.diagnostics));
  }
  return workflowDiagram(result.workflow.definition);
};

describe("a workflow's diagram", () => {
  it("shows every case of a switch with where it goes, and the tasks they join at", async () => {
    await expect(diagramOf(approval)).resolves.toStrictEqual([
      "route (switch)",
      "  [case large, when] → request-review",
      "  [case small] → approved",
      "request-review (call) grasp.decision · invoiceApproval",
      "review-route (switch)",
      "  [case accepted, when] → approved",
      "  [case declined] → rejected",
      "approved (set) → finished",
      "rejected (set) → finished",
      "finished (set)",
    ]);
  });

  it("shows a bounded loop's body, guarded steps and the raise it can end in", async () => {
    await expect(diagramOf(polling)).resolves.toStrictEqual([
      "initialize (set)",
      "poll (for)",
      "  [each attempt, when]",
      "    read-status (call) grasp.connector · jobStatus",
      "    poll-delay (wait, if)",
      "exhausted (raise, if) The job did not complete within the polling limit.",
      "job-result (set)",
    ]);
  });

  it("shows every branch of a fork, and a try with what its catch does", async () => {
    const [fork, events] = await Promise.all([
      diagramOf(parallelChildren),
      diagramOf(eventRecovery),
    ]);
    expect({ fork, events }).toStrictEqual({
      fork: [
        "summaries (fork)",
        "  [branch first-summary]",
        "    first-summary (do)",
        "      [do]",
        "        summarize-first (run) summarize-note 1.0.0",
        "  [branch second-summary]",
        "    second-summary (do)",
        "      [do]",
        "        summarize-second (run) summarize-note 1.0.0",
      ],
      events: [
        "await-job (try)",
        "  [try]",
        "    completion (listen) jobEvents",
        "  [catch]",
        "    publish-timeout (emit) jobEvents",
        "    timeout-result (set) → end",
      ],
    });
  });

  it("shows where a catch sends a caught failure, apart from where its try goes", async () => {
    await expect(
      diagramOf(
        documentAround({ name: "caught", input: {}, required: [] }, [
          {
            guarded: {
              try: [{ attempt: { set: { status: "tried" } } }],
              catch: {
                do: [{ note: { set: { status: "caught" } } }],
                then: "fallback",
              },
              then: "done",
            },
          },
          { fallback: { set: { status: "fallback" }, then: "end" } },
          { done: { set: { status: "done" } } },
        ])
      )
    ).resolves.toStrictEqual([
      "guarded (try) → done",
      "  [try]",
      "    attempt (set)",
      "  [catch] → fallback",
      "    note (set)",
      "fallback (set) → end",
      "done (set)",
    ]);
  });

  it("names a reusable error a raise raises", async () => {
    await expect(
      diagramOf(
        documentAround(
          {
            name: "raising",
            input: {},
            required: [],
            use: {
              errors: {
                overBudget: {
                  type: "urn:grasp:error:budget.over",
                  status: 400,
                  title: "Over budget.",
                },
              },
            },
          },
          [{ refuse: { raise: { error: "overBudget" } } }]
        )
      )
    ).resolves.toStrictEqual(["refuse (raise) overBudget"]);
  });

  it("shows a literal wait's duration, written as text or as fixed units", async () => {
    await expect(
      diagramOf(
        documentAround({ name: "waiting", input: {}, required: [] }, [
          { short: { wait: "PT5M" } },
          { long: { wait: { days: 1, hours: 2, minutes: 30 } } },
          { brief: { wait: { seconds: 1, milliseconds: 500 } } },
          { done: { set: { status: "done" } } },
        ])
      )
    ).resolves.toStrictEqual([
      "short (wait) PT5M",
      "long (wait) P1DT2H30M",
      "brief (wait) PT1.5S",
      "done (set)",
    ]);
  });

  it("keeps each task's ID and place when only its label changes, and never shows an expression's value", async () => {
    const [first, second] = await Promise.all([
      labelled("Pause"),
      labelled("Wait a while"),
    ]);
    expect({
      ids: second.tasks.map(({ id, pointer }) => `${id} ${pointer}`),
      same:
        first.tasks.map(({ id }) => id).join(",") ===
        second.tasks.map(({ id }) => id).join(","),
      labels: [first.tasks[0]?.label, second.tasks[0]?.label],
      detail: second.tasks[0]?.detail,
    }).toStrictEqual({
      ids: ["pause /do/0/pause", "done /do/1/done"],
      same: true,
      labels: ["Pause", "Wait a while"],
      detail: null,
    });
  });

  it("answers what it can read of anything else, and never throws", () => {
    expect({
      notObject: workflowDiagram("text").tasks,
      noTasks: workflowDiagram({ do: "x" }).tasks,
      odd: workflowDiagram({
        do: [1, { x: {} }, { y: { set: {} } }],
      }).tasks.map(({ id, kind }) => `${id} ${kind}`),
    }).toStrictEqual({ notObject: [], noTasks: [], odd: ["y set"] });
  });
});
