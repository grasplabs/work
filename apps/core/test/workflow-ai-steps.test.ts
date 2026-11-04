/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { builtins, fingerprintOf, thisRelease } from "../src/builtins.ts";
import {
  approvalContract,
  modelStepContract,
} from "../src/release-contracts.ts";
import { confirmedAnswer } from "./decisions.ts";
import { mockIdp } from "./idp.ts";
import {
  askedModel,
  askingWorkflow,
  definitionOf,
  endedRun,
  jsonWorkflowAppsOf,
  objectSchema,
  publishedWorkflow,
  runFor,
  settles,
  startedBy,
} from "./json-workflow-apps.ts";
import { fakeProviderFor } from "./model-provider.ts";

// A JSON workflow's model task: the model's answer is the task's output
// only once it matches the task's own output schema, its email format
// included (the profile's only format),
// and a model task is asked once (resource-calls.ts, `askAgain`). The
// model provider behind connect is the outside system
// (test/model-provider.ts); the runs and the gateway are real.
//
// A model task asked once for its structured output, and never again on a
// replay or past its schema, is workflow-calls' "asks the gateway once for
// the task's structured output…" and "sends one request per model call…".
// A workflow with a model task and a decision end to end is below, bound
// to the general contracts every release ships (release-contracts.ts), as
// a fresh deployment's builder or chat writes one. Only App workflows had the
// rest, and they go with them: the sample App's invoice workflow, an App's
// model resource whose declared bound a model can't give, and a version
// made current with AI steps through anything but a text model it
// declares.

const idp = mockIdp();
const { signedIn } = jsonWorkflowAppsOf(idp);

/** A model step reading a total and who sent it, an email address. */
const readTasks = [
  {
    id: "read",
    type: "agent",
    binding: "reader",
    instructions: "Read the total in cents, and who sent it.",
    input: { text: "Total 12.34 EUR" },
    output: objectSchema({
      total: { type: "integer" },
      from: { type: "string", format: "email" },
    }),
  },
];

/** What the workflow reading `readTasks` ends with. */
const readStatus = {
  $expr: '"" + steps.read.output.total + " " + steps.read.output.from',
};

describe("a JSON workflow's model task", { timeout: 60_000 }, () => {
  it("takes a model's answer only as it matches the task's schema, its email format included, asking once", async () => {
    const admin = await signedIn("admin");
    const builder = await signedIn("builder");
    await fakeProviderFor([askedModel]);
    const { id } = await askingWorkflow(
      admin,
      builder,
      readTasks,
      askedModel,
      readStatus
    );
    /** A run whose model answers `text`, as it ended, and how often it was asked. */
    const runAnswered = async (text: string) => {
      const provider = await fakeProviderFor([askedModel], {
        text,
        inputTokens: 10,
        outputTokens: 5,
      });
      const run = await endedRun(builder, id, await startedBy(builder, id));
      return {
        status: run.status,
        output: run.output,
        asked: provider.requests.length,
      };
    };

    expect({
      wrongType: await runAnswered(
        '{"total": 12.34, "from": "anna@example.com"}'
      ),
      notAnEmail: await runAnswered('{"total": 1234, "from": "Anna"}'),
      fit: await runAnswered('{"total": 1234, "from": "anna@example.com"}'),
    }).toStrictEqual({
      wrongType: { status: "failed", output: undefined, asked: 1 },
      notAnEmail: { status: "failed", output: undefined, asked: 1 },
      fit: {
        status: "completed",
        output: { status: "1234 anna@example.com" },
        asked: 1,
      },
    });
  });
});

/**
 * A model task drafting a greeting through the release's model step, a
 * person's check of it through the release's approval, and the greeting
 * with their comment, or `declined`.
 */
const checkedTasks = [
  {
    draft: {
      call: "grasp.model",
      with: {
        binding: "writer",
        instructions: "Write a one-line greeting for them.",
        input: { who: "${ $workflow.input.who }" },
        outputSchema: objectSchema({ line: { type: "string" } }),
      },
      export: { as: "${ {line: .line} }" },
    },
  },
  {
    check: {
      call: "grasp.decision",
      with: {
        binding: "check",
        recipients: ["role:admin"],
        prompt: "Send this greeting?",
        input: '${ {draft: {line: $context.line, tags: ["greeting"]}} }',
      },
      export: { as: "${ $context + {check: .} }" },
    },
  },
  {
    report: {
      set: {
        status:
          '${ if $context.check.approved then $context.line + " / " + $context.check.value.comment else "declined" end }',
      },
    },
  },
];

describe("the release's general contracts", { timeout: 60_000 }, () => {
  it("let a fresh deployment's JSON workflow ask a model and wait for a person's approval, each approved by an admin", async () => {
    const admin = await signedIn("admin");
    const builder = await signedIn("builder");
    // A fresh deployment: nothing in the catalog but what the release installs.
    await builtins(env).ensureInstalled(await fingerprintOf(thisRelease));
    const catalog = await builder.api.workflowResources.catalog();
    const workflow = await publishedWorkflow(builder, () =>
      definitionOf(checkedTasks, {
        bindings: {
          writer: { kind: "model", contract: modelStepContract },
          check: { kind: "decision", contract: approvalContract },
        },
      })
    );
    await admin.api.workflowResources.approveBinding(workflow.id, {
      alias: "writer",
      target: { kind: "model", model: askedModel },
      reviewed: { version: 1 },
    });
    await admin.api.workflowResources.approveBinding(workflow.id, {
      alias: "check",
      target: { kind: "decision", deciders: ["role:admin"] },
      reviewed: { version: 1 },
    });
    const provider = await fakeProviderFor([askedModel], {
      text: '{"line": "Hello, Ada"}',
      inputTokens: 10,
      outputTokens: 5,
    });

    const runId = await startedBy(builder, workflow.id);
    const asked = await vi.waitFor(async () => {
      const waiting = await admin.api.decisions.waiting();
      const found = waiting.find(({ run }) => run === runId);
      if (found === undefined) {
        throw new Error("No decision yet");
      }
      return found;
    }, settles);
    const waitingRun = await runFor(builder, workflow.id, runId);
    await confirmedAnswer(admin, asked.id, {
      approved: true,
      payload: { comment: "Lovely" },
    });
    const run = await endedRun(builder, workflow.id, runId);

    expect({
      catalog: catalog
        .filter(({ key }) =>
          [modelStepContract, approvalContract].includes(key)
        )
        .map(({ key, kind, publishedBy }) => ({ key, kind, publishedBy })),
      asked: {
        description: asked.description,
        input: asked.input,
        modelCalls: provider.requests.length,
        endedAt: waitingRun.endedAt,
      },
      ended: { status: run.status, output: run.output },
      modelCalls: provider.requests.length,
    }).toStrictEqual({
      catalog: [
        { key: approvalContract, kind: "decision", publishedBy: "grasp" },
        { key: modelStepContract, kind: "model", publishedBy: "grasp" },
      ],
      asked: {
        description: "Send this greeting?",
        input: { draft: { line: "Hello, Ada", tags: ["greeting"] } },
        modelCalls: 1,
        endedAt: null,
      },
      ended: { status: "completed", output: { status: "Hello, Ada / Lovely" } },
      modelCalls: 1,
    });
  });
});
