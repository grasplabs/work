/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import {
  askedModel,
  askingWorkflow,
  endedRun,
  jsonWorkflowAppsOf,
  objectSchema,
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
// the task's structured output…" and "sends one request per model call…";
// a workflow with a model task and a decision end to end, the builtin
// blueprints' (builtin-blueprints.test.ts). Only App workflows had the
// rest, and they go with them: the sample App's invoice workflow, an App's
// model resource whose declared bound a model can't give, and a version
// made current with AI steps through anything but a text model it
// declares.

const idp = mockIdp();
const { signedIn } = jsonWorkflowAppsOf(idp);

/** A model task reading a total and who sent it, an email address. */
const readTasks = [
  {
    read: {
      call: "grasp.model",
      with: {
        binding: "reader",
        instructions: "Read the total in cents, and who sent it.",
        input: { text: "Total 12.34 EUR" },
        outputSchema: objectSchema({
          total: { type: "integer" },
          from: { type: "string", format: "email" },
        }),
      },
      export: { as: "${ {read: .} }" },
    },
  },
  {
    report: {
      set: {
        status:
          '${ ($context.read.total | tostring) + " " + $context.read.from }',
      },
    },
  },
];

describe("a JSON workflow's model task", { timeout: 60_000 }, () => {
  it("takes a model's answer only as it matches the task's schema, its email format included, asking once", async () => {
    const admin = await signedIn("admin");
    const builder = await signedIn("builder");
    await fakeProviderFor([askedModel]);
    const { id } = await askingWorkflow(admin, builder, readTasks);
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
