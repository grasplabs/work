/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { v } from "@grasp-os/sdk";
import type { Json } from "@grasp-os/shared/json";
import { describe, expect, it } from "vite-plus/test";

import { runtimeDescriptor } from "../src/evaluate.ts";
import type { ResultContract, Stage } from "../src/evaluate.ts";
import {
  parseSlot,
  profileEvaluate,
  resolveEvaluate,
  stageVariables,
} from "../src/source.ts";
import { compileError, json, run } from "./run.ts";
import type { Values } from "./run.ts";

// Every expression of the profile's documented definitions (the summary
// workflow and the control-flow examples), at the stage it sits in, on
// the values it would see there. Param values are the documented defaults.

const params = {
  instructions: "Summarize the supplied note within the requested word limit.",
  maxWords: 120,
  approvalThreshold: 1000,
  reviewer: "person_reviewer",
  approvalPrompt: "Approve this invoice?",
  maxIterations: 3,
  pollDelayMs: 1500,
};
// Record IDs as the SDK mints them: UUIDv7.
const noteOne = "01928f3a-7b2c-7d4e-8f00-1a2b3c4d5e6f";
const noteTwo = "01928f3a-7b2c-7d4e-8f00-1a2b3c4d5e70";
const note = { _id: noteOne, _rev: 7, title: "Q3 plan", body: "Ship it." };
const startedAt = {
  iso8601: "2026-10-07T12:00:00Z",
  epoch: { seconds: 1_791_374_400, milliseconds: 1_791_374_400_000 },
};
const workflowFor = (input: Json): Json => ({ id: "run_1", input, startedAt });
const taskFor = (name: string, reference: string): Json => ({
  name,
  reference,
  startedAt,
});

interface Fixture {
  name: string;
  slot: string;
  stage: Stage;
  values: Values;
  contract?: ResultContract;
  expected: Json;
}

const summary: Fixture[] = [
  {
    name: "load-note: the note's ID, from the raw workflow input",
    slot: "${ $workflow.input.noteId }",
    stage: "taskDefinition",
    values: { variables: { workflow: workflowFor({ noteId: noteOne }) } },
    contract: { kind: "schema", schema: v.id("notes"), expected: "notes ID" },
    expected: noteOne,
  },
  {
    name: "load-note: export the loaded note into the context",
    slot: "${ $context + {note: .} }",
    stage: "taskExportAs",
    values: { input: note, variables: { context: {} } },
    expected: { note },
  },
  {
    name: "require-note: the guard is false while the note exists",
    slot: "${ $context.note == null }",
    stage: "taskIf",
    values: { input: note, variables: { context: { note } } },
    contract: { kind: "boolean" },
    expected: false,
  },
  {
    name: "require-note: the guard is true when the note is gone",
    slot: "${ $context.note == null }",
    stage: "taskIf",
    values: { input: null, variables: { context: { note: null } } },
    contract: { kind: "boolean" },
    expected: true,
  },
  {
    name: "summarize: the instructions param, at its default",
    slot: "${ $params.instructions }",
    stage: "taskDefinition",
    values: { variables: { params } },
    contract: { kind: "schema", schema: v.string(), expected: "string" },
    expected: params.instructions,
  },
  {
    name: "summarize: the note's title from the context",
    slot: "${ $context.note.title }",
    stage: "taskDefinition",
    values: { variables: { context: { note } } },
    expected: "Q3 plan",
  },
  {
    name: "summarize: the note's body from the context",
    slot: "${ $context.note.body }",
    stage: "taskDefinition",
    values: { variables: { context: { note } } },
    expected: "Ship it.",
  },
  {
    name: "summarize: the word limit param, at its default",
    slot: "${ $params.maxWords }",
    stage: "taskDefinition",
    values: { variables: { params } },
    contract: {
      kind: "schema",
      schema: v.number().integer(),
      expected: "integer",
    },
    expected: 120,
  },
  {
    name: "summarize: export the summary next to the note",
    slot: "${ $context + {summary: .summary} }",
    stage: "taskExportAs",
    values: { input: { summary: "Short." }, variables: { context: { note } } },
    expected: { note, summary: "Short." },
  },
  {
    name: "save-summary: the note's ID",
    slot: "${ $context.note._id }",
    stage: "taskDefinition",
    values: { variables: { context: { note, summary: "Short." } } },
    expected: noteOne,
  },
  {
    name: "save-summary: the expected revision",
    slot: "${ $context.note._rev }",
    stage: "taskDefinition",
    values: { variables: { context: { note, summary: "Short." } } },
    expected: 7,
  },
  {
    name: "save-summary: the summary",
    slot: "${ $context.summary }",
    stage: "taskDefinition",
    values: { variables: { context: { note, summary: "Short." } } },
    expected: "Short.",
  },
];

const approval: Fixture[] = [
  {
    name: "route: a large amount needs review",
    slot: "${ $workflow.input.amount > $params.approvalThreshold }",
    stage: "taskDefinition",
    values: { variables: { workflow: workflowFor({ amount: 1500 }), params } },
    contract: { kind: "boolean" },
    expected: true,
  },
  {
    name: "route: a small amount doesn't",
    slot: "${ $workflow.input.amount > $params.approvalThreshold }",
    stage: "taskDefinition",
    values: { variables: { workflow: workflowFor({ amount: 500 }), params } },
    contract: { kind: "boolean" },
    expected: false,
  },
  {
    name: "request-review: the reviewer as the recipients",
    slot: "${ [$params.reviewer] }",
    stage: "taskDefinition",
    values: { variables: { params } },
    expected: ["person_reviewer"],
  },
  {
    name: "request-review: the prompt param",
    slot: "${ $params.approvalPrompt }",
    stage: "taskDefinition",
    values: { variables: { params } },
    expected: "Approve this invoice?",
  },
  {
    name: "request-review: the raw workflow input as the decision's input",
    slot: "${ $workflow.input }",
    stage: "taskDefinition",
    values: { variables: { workflow: workflowFor({ amount: 1500 }) } },
    expected: { amount: 1500 },
  },
  {
    name: "request-review: export the decision",
    slot: "${ $context + {review: .} }",
    stage: "taskExportAs",
    values: {
      input: { answered: true, approved: false, by: "person_reviewer" },
      variables: { context: {} },
    },
    expected: {
      review: { answered: true, approved: false, by: "person_reviewer" },
    },
  },
  {
    name: "review-route: a declined review isn't accepted",
    slot: "${ $context.review.approved == true }",
    stage: "taskDefinition",
    values: { variables: { context: { review: { approved: false } } } },
    contract: { kind: "boolean" },
    expected: false,
  },
  {
    name: "finished: passes the branch's output on",
    slot: "${ . }",
    stage: "taskDefinition",
    values: { input: { status: "approved" } },
    expected: { status: "approved" },
  },
];

const polling: Fixture[] = [
  {
    name: "initialize: export the loop state",
    slot: "${ . }",
    stage: "taskExportAs",
    values: {
      input: { done: false, status: null },
      variables: { context: {} },
    },
    expected: { done: false, status: null },
  },
  {
    name: "poll: a finite list of attempts",
    slot: "${ [range(0; $params.maxIterations)] }",
    stage: "taskDefinition",
    values: { variables: { params } },
    expected: [0, 1, 2],
  },
  {
    name: "poll: keep going while not done",
    slot: "${ $context.done == false }",
    stage: "taskDefinition",
    values: {
      variables: { context: { done: false, status: null } },
      loop: { attempt: 0 },
    },
    contract: { kind: "boolean" },
    expected: true,
  },
  {
    name: "read-status: export the status and whether it completed",
    slot: '${ $context + {status: ., done: (.state == "completed")} }',
    stage: "taskExportAs",
    values: {
      input: { state: "completed" },
      variables: { context: { done: false, status: null } },
      loop: { attempt: 1 },
    },
    expected: { done: true, status: { state: "completed" } },
  },
  {
    name: "poll-delay: wait between attempts",
    slot: "${ $context.done == false and ($attempt + 1) < $params.maxIterations }",
    stage: "taskIf",
    values: {
      variables: { context: { done: false }, params },
      loop: { attempt: 0 },
    },
    contract: { kind: "boolean" },
    expected: true,
  },
  {
    name: "poll-delay: not after the last attempt",
    slot: "${ $context.done == false and ($attempt + 1) < $params.maxIterations }",
    stage: "taskIf",
    values: {
      variables: { context: { done: false }, params },
      loop: { attempt: 2 },
    },
    contract: { kind: "boolean" },
    expected: false,
  },
  {
    name: "poll-delay: the delay as a fixed ISO duration",
    slot: '${ "PT" + (($params.pollDelayMs / 1000) | tostring) + "S" }',
    stage: "taskDefinition",
    values: { variables: { params }, loop: { attempt: 0 } },
    expected: "PT1.5S",
  },
  {
    name: "poll-delay: the ISO delay meets the duration contract as its milliseconds",
    slot: '${ "PT" + (($params.pollDelayMs / 1000) | tostring) + "S" }',
    stage: "taskDefinition",
    values: { variables: { params }, loop: { attempt: 0 } },
    contract: { kind: "duration" },
    expected: 1500,
  },
  {
    name: "a wait of whole milliseconds, from an integer parameter",
    slot: "${ $params.maxWords }",
    stage: "taskDefinition",
    values: { variables: { params } },
    contract: { kind: "duration" },
    expected: 120,
  },
  {
    name: "exhausted: raised while still not done",
    slot: "${ $context.done == false }",
    stage: "taskIf",
    values: { variables: { context: { done: false } } },
    contract: { kind: "boolean" },
    expected: true,
  },
  {
    name: "job-result: the last status",
    slot: "${ $context.status }",
    stage: "taskDefinition",
    values: { variables: { context: { status: { state: "completed" } } } },
    expected: { state: "completed" },
  },
];

const noteIds = [noteOne, noteTwo];
const others: Fixture[] = [
  {
    name: "summaries: the first branch's note",
    slot: "${ $workflow.input.noteIds[0] }",
    stage: "taskDefinition",
    values: { variables: { workflow: workflowFor({ noteIds }) } },
    expected: noteOne,
  },
  {
    name: "summaries: the second branch's note",
    slot: "${ $workflow.input.noteIds[1] }",
    stage: "taskDefinition",
    values: { variables: { workflow: workflowFor({ noteIds }) } },
    expected: noteTwo,
  },
  {
    name: "collection: the list a for loop goes over",
    slot: "${ $workflow.input.noteIds }",
    stage: "taskDefinition",
    values: { variables: { workflow: workflowFor({ noteIds }) } },
    expected: noteIds,
  },
  {
    name: "collection: each item's key is its loop variable",
    slot: "${ $noteId }",
    stage: "taskDefinition",
    values: { loop: { noteId: noteTwo, index: 1 } },
    expected: noteTwo,
  },
  {
    name: "await-job: the subject correlates the job",
    slot: "${ $workflow.input.jobId }",
    stage: "taskDefinition",
    values: { variables: { workflow: workflowFor({ jobId: "job_9" }) } },
    expected: "job_9",
  },
  {
    name: "completion: listen's array output becomes its one event's data",
    slot: "${ .[0] }",
    stage: "taskOutputAs",
    values: { input: [{ jobId: "job_9", state: "completed" }] },
    expected: { jobId: "job_9", state: "completed" },
  },
  {
    name: "calculate-total: the amounts as the compute module's arguments",
    slot: "${ $workflow.input.amounts }",
    stage: "taskDefinition",
    values: { variables: { workflow: workflowFor({ amounts: [120, 80] }) } },
    expected: [120, 80],
  },
];

const sourceOf = (slot: string): string => {
  const parsed = parseSlot(slot);
  if (parsed.kind !== "expression") {
    throw new Error(`${slot} isn't an expression`);
  }
  return parsed.source;
};

const isStage = (name: string): name is Stage =>
  Object.hasOwn(stageVariables, name);

describe("the profile's documented expressions", () => {
  it.each([...summary, ...approval, ...polling, ...others])(
    "$name",
    async ({ slot, values, contract, stage, expected }) => {
      await expect(
        run(sourceOf(slot), values, contract, { stage })
      ).resolves.toStrictEqual({ result: expected });
    }
  );
});

describe("expression settings and slots", () => {
  it("defaults a missing evaluate to strict jq and refuses any other", () => {
    expect({
      missing: resolveEvaluate(),
      explicit: resolveEvaluate({ language: "jq", mode: "strict" }),
      languageOnly: resolveEvaluate({ language: "jq" }),
      loose: resolveEvaluate({ language: "jq", mode: "loose" }),
      javascript: resolveEvaluate({ language: "javascript" }),
      cel: resolveEvaluate({ language: "cel", mode: "strict" }),
      unknownKey: resolveEvaluate({ language: "jq", version: "1.7" }),
      notAnObject: resolveEvaluate("jq"),
    }).toStrictEqual({
      missing: profileEvaluate,
      explicit: profileEvaluate,
      languageOnly: profileEvaluate,
      loose: undefined,
      javascript: undefined,
      cel: undefined,
      unknownKey: undefined,
      notAnObject: undefined,
    });
  });

  it("treats only a whole ${ … } string as an expression, and one with whitespace around it as neither", () => {
    expect(
      [
        "${ $workflow.input.noteId }",
        "${.}",
        "Summarize the supplied note within the requested word limit.",
        "Total: ${ .amount }",
        "${ .amount } in total",
        "$context.note",
        " ${ .amount }",
        "${ .amount }\n",
      ].map((value) => parseSlot(value))
    ).toStrictEqual([
      { kind: "expression", source: "$workflow.input.noteId" },
      { kind: "expression", source: "." },
      {
        kind: "literal",
        value: "Summarize the supplied note within the requested word limit.",
      },
      { kind: "literal", value: "Total: ${ .amount }" },
      { kind: "literal", value: "${ .amount } in total" },
      { kind: "literal", value: "$context.note" },
      // Upstream reads these as expressions; strict mode can't, so neither.
      { kind: "padded", value: " ${ .amount }" },
      { kind: "padded", value: "${ .amount }\n" },
    ]);
  });
});

describe("variables by stage", () => {
  it("gives each stage exactly its documented variables", async () => {
    const variables = [
      "context",
      "input",
      "output",
      "task",
      "workflow",
      "runtime",
      "params",
      "secrets",
      "authorization",
    ];
    const stages = Object.keys(stageVariables).filter(isStage);
    const available = Object.fromEntries(
      await Promise.all(
        stages.map(async (stage) => {
          const codes = await Promise.all(
            variables.map(
              async (name) => await compileError(`$${name}`, { stage })
            )
          );
          return [
            stage,
            variables.filter((_, index) => codes[index] === undefined),
          ] as const;
        })
      )
    );
    expect(available).toStrictEqual({
      workflowInputFrom: ["workflow", "runtime", "params"],
      taskIf: ["context", "task", "workflow", "runtime", "params"],
      taskInputFrom: ["context", "task", "workflow", "runtime", "params"],
      taskDefinition: [
        "context",
        "input",
        "task",
        "workflow",
        "runtime",
        "params",
      ],
      taskOutputAs: [
        "context",
        "input",
        "task",
        "workflow",
        "runtime",
        "params",
      ],
      taskExportAs: [
        "context",
        "input",
        "output",
        "task",
        "workflow",
        "runtime",
        "params",
      ],
      workflowOutputAs: ["context", "workflow", "runtime", "params"],
    });
  });

  it("evaluates workflow input.from on the raw input, and output.as on the last output", async () => {
    const raw = { noteId: noteOne, extra: true };
    expect({
      inputFrom: await run(
        "{noteId: .noteId, same: (. == $workflow.input)}",
        { input: raw, variables: { workflow: workflowFor(raw) } },
        json,
        { stage: "workflowInputFrom", scope: [] }
      ),
      outputAs: await run(
        "{noteId: $context.note._id, summary: .summary}",
        { input: { summary: "Short." }, variables: { context: { note } } },
        json,
        { stage: "workflowOutputAs", scope: [] }
      ),
    }).toStrictEqual({
      inputFrom: { result: { noteId: noteOne, same: true } },
      outputAs: { result: { noteId: noteOne, summary: "Short." } },
    });
  });

  it("pins $runtime to the profile and gives a task its own descriptor", async () => {
    await expect(
      run("{runtime: $runtime, task: $task.name}", {
        variables: { task: taskFor("load-note", "/do/0/load-note") },
      })
    ).resolves.toStrictEqual({
      result: { runtime: runtimeDescriptor, task: "load-note" },
    });
  });

  it("keeps loop variables to the loop's tasks", async () => {
    expect({
      inTask: await compileError("$attempt", {
        stage: "taskIf",
        loopVariables: ["attempt"],
      }),
      outsideTasks: await compileError("$attempt", {
        stage: "workflowOutputAs",
        loopVariables: ["attempt"],
      }),
      undeclared: await compileError("$attempt", { stage: "taskIf" }),
      shadowingAWorkflowVariable: await compileError("$context", {
        loopVariables: ["context"],
      }),
    }).toStrictEqual({
      inTask: undefined,
      outsideTasks: "expression.unavailable_variable",
      undeclared: "expression.unavailable_variable",
      shadowingAWorkflowVariable: "expression.unavailable_variable",
    });
  });

  it("binds variables an expression declares itself", async () => {
    await expect(
      run(
        ". as {amount: $amount} | reduce .lines[] as [$label, $value] (0; . + $value) | . + $amount",
        {
          input: {
            amount: 1,
            lines: [
              ["a", 2],
              ["b", 3],
            ],
          },
        }
      )
    ).resolves.toStrictEqual({ result: 6 });
  });
});
