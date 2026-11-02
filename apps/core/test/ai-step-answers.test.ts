import { runActorOf } from "@grasp-os/shared/audit";
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import {
  appWith,
  anthropic,
  withDeploymentRules,
  modelActions,
  eventsOf,
} from "./model-rules.ts";
import { finished } from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import { bindModel, workflowFiles } from "./workflow-apps.ts";

// How a workflow's AI step asks the model gateway across its attempts: a
// later attempt waits for an earlier one's call still in flight, rather
// than ask, and pay, beside it. The model provider behind connect is the
// outside system (test/model-provider.ts). Everything else is real, down
// to the audit log and the run.

const idp = mockIdp();

// A workflow release activates by running its tests, and the run waits on
// a paused answer: longer than Vitest's default five seconds.
describe("an AI step", { timeout: 60_000 }, () => {
  it("gives its next attempt the answer its timed-out attempt was still waiting for, asking and paying once", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "reader",
        `  return await step.llm("extract", {
    description: "Read the total",
    binding: "reader",
    instructions: "Read the total in cents.",
    input: "Total 12.34 EUR",
    schema: z.object({ total: z.int() }),
    timeout: 1000,
    retries: { limit: 3, delay: 1 },
  });`,
        { extract: { total: 1234 } }
      )
    );
    const release = Promise.withResolvers<boolean>();

    // The provider answers the first attempt only after its second.
    const { result } = await withDeploymentRules(
      [
        {
          text: '{ "total": 1234 }',
          inputTokens: 10,
          outputTokens: 5,
          pause: { at: 1, until: release.promise },
        },
        { text: '{ "total": 9999 }', inputTokens: 10, outputTokens: 5 },
      ],
      async () => {
        await bindModel(app, "reader", anthropic);
        const run = await builder.api.workflows.start(app, "reader");
        await scheduler.wait(2500);
        release.resolve(true);
        await finished(run.id);
        return {
          run: await builder.api.workflows.status(run.id),
          events: await eventsOf(
            runActorOf({ runId: run.id, app, workflow: "reader" })
          ),
        };
      }
    );

    expect({
      run: result.run,
      models: modelActions(result.events),
    }).toMatchObject({
      run: { status: "completed", output: { total: 1234 } },
      models: ["model.call"],
    });
  });
});
