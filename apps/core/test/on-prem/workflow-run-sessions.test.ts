import { afterEach, describe, expect, it } from "vite-plus/test";

import { mockIdpWith } from "../idp.ts";
import {
  definitionOf,
  endedRun,
  endLiveResourceRuns,
  greetingTasks,
  objectSchema,
  publishedWorkflow,
  startedBy,
} from "../json-workflow-apps.ts";
import { fakeProviderFor } from "../model-provider.ts";
import { sleeping, woken } from "../runs.ts";
import { unique } from "../sign-in.ts";
import {
  extractionModel,
  idp,
  runTime,
  signedIn,
} from "./workflow-run-sessions-harness.ts";

// An independent JSON workflow's runs on-prem, in their sessions: one per
// load, owned by the workflow, let go of while a run waits, and waited for
// while the sandbox is full. Runs, the engine, the host and the sandbox
// supervisor are real; a run is started through its builder's session.
// Already covered: a load across a wait, and a listen's event after it
// (json-workflow-runs.test.ts). Not yet shown for a JSON run (GRA-1585):
// a cancel stopping a run that waits for a place.

mockIdpWith(idp);

describe("an independent JSON workflow's runs on-prem", runTime, () => {
  afterEach(endLiveResourceRuns);

  it("runs a model call in its session, through the run's host", async () => {
    const [admin, builder] = await Promise.all([
      signedIn("admin"),
      signedIn("builder"),
    ]);
    const key = `extractor-${unique()}`;
    await admin.api.workflowResources.publishContract({ key, kind: "model" });
    const { id } = await publishedWorkflow(builder, () =>
      definitionOf(
        [
          {
            id: "extract",
            type: "generate",
            instructions: "Read the total in cents.",
            input: { text: "Total 12.34 EUR" },
            returns: objectSchema({ total: { kind: "number", integer: true } }),
          },
        ],
        {
          permissions: { ai: { contract: key } },
          status: { $expr: '"Total " + extract.total * 2' },
        }
      )
    );
    // The organization's model, and the workflow's binding to it, approved:
    // the task names the binding, not a model.
    await fakeProviderFor([extractionModel], {
      text: '{"total": 1234}',
      inputTokens: 10,
      outputTokens: 5,
    });
    await admin.api.workflowResources.approveBinding(id, {
      alias: "ai",
      target: { kind: "model", model: extractionModel },
      reviewed: { version: 1 },
    });
    const run = await endedRun(builder, id, await startedBy(builder, id));
    expect({ status: run.status, output: run.result }).toStrictEqual({
      status: "completed",
      output: { status: "Total 2468" },
    });
  });

  it("lets go of a run's session while it waits, so the workflow's next run loads, and resumes it in a new one", async () => {
    const builder = await signedIn("builder");
    const { id } = await publishedWorkflow(builder, greetingTasks("1 day"));
    const first = await startedBy(builder, id);
    await sleeping(first, "hold:task");
    // The workflow's runs hold one session at a time: a second run loads
    // only once the first's, waiting, was let go of.
    const second = await startedBy(builder, id, { who: "Grace" });
    await sleeping(second, "hold:task");
    await woken(first, "hold:task");
    const run = await endedRun(builder, id, first);
    expect({ status: run.status, output: run.result }).toStrictEqual({
      status: "completed",
      output: { status: "Hello, Ada" },
    });
  });
});
