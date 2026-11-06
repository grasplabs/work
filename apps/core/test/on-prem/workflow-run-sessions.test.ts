import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { runInSession } from "../../src/sandbox-session.ts";
import { sessionHost } from "../../src/sandboxed.ts";
import { mockIdp } from "../idp.ts";
import {
  definitionOf,
  endedRun,
  endLiveResourceRuns,
  greetingTasks,
  jsonWorkflowAppsOf,
  objectSchema,
  publishedWorkflow,
  startedBy,
} from "../json-workflow-apps.ts";
import { fakeProviderFor } from "../model-provider.ts";
import { liveStatus, sleeping, woken } from "../runs.ts";
import { unique } from "../sign-in.ts";

// An independent JSON workflow's runs on-prem, in their sessions: one per
// load, owned by the workflow, let go of while a run waits, and waited for
// while the sandbox is full. Runs, the engine, the host and the sandbox
// supervisor are real; a run is started through its builder's session.
// Already covered: a load across a wait, and a listen's event after it
// (json-workflow-runs.test.ts). Not yet shown for a JSON run (GRA-1585):
// a cancel stopping a run that waits for a place.

const idp = mockIdp();
const { signedIn } = jsonWorkflowAppsOf(idp);

const extractionModel = "mistral/mistral-large-latest";

/** A load of each run here may wait out a full sandbox: room for a slow runner. */
const runTime = { timeout: 90_000 };

/**
 * Holds one of the sandbox's places as `owner`, spinning, until the
 * returned function lets go of it.
 */
const holdPlace = (owner: string): (() => Promise<void>) => {
  const giveUp = new AbortController();
  const host = sessionHost(env);
  if (host === undefined) {
    throw new Error("These tests run on-prem, with a sandbox host.");
  }
  const held = runInSession(
    host,
    {
      mainModule: "spin.js",
      modules: {
        "spin.js":
          'import { WorkerEntrypoint } from "cloudflare:workers"; export class Spin extends WorkerEntrypoint { async go() { for (;;) {} } }',
      },
      entrypoint: "Spin",
      method: "go",
      args: [],
      owner,
      cpuMs: 30_000,
      wallMs: 60_000,
    },
    { signal: giveUp.signal }
  ).catch(() => {
    // Let go of.
  });
  return async () => {
    giveUp.abort();
    await held;
  };
};

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
            type: "agent",
            binding: "extractor",
            instructions: "Read the total in cents.",
            input: { text: "Total 12.34 EUR" },
            output: objectSchema({ total: { type: "integer" } }),
          },
        ],
        {
          bindings: { extractor: { kind: "model", contract: key } },
          status: { $expr: '"Total " + steps.extract.output.total * 2' },
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
      alias: "extractor",
      target: { kind: "model", model: extractionModel },
      reviewed: { version: 1 },
    });
    const run = await endedRun(builder, id, await startedBy(builder, id));
    expect({ status: run.status, output: run.output }).toStrictEqual({
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
    expect({ status: run.status, output: run.output }).toStrictEqual({
      status: "completed",
      output: { status: "Hello, Ada" },
    });
  });

  it("waits for a place while the sandbox is full, then loads, rather than failing the run", async () => {
    const builder = await signedIn("builder");
    const { id } = await publishedWorkflow(builder, greetingTasks());
    // Both processes held, by calls of two others.
    const letGo = [holdPlace("app-full-a"), holdPlace("app-full-b")];
    const runId = await startedBy(builder, id);
    // Long enough for its load to be refused, the pool full, more than once.
    await scheduler.wait(8000);
    const whileFull = await liveStatus(runId);
    await Promise.all(
      letGo.map(async (free) => {
        await free();
      })
    );
    const run = await endedRun(builder, id, runId);
    expect({
      whileFull,
      after: { status: run.status, output: run.output },
    }).toStrictEqual({
      whileFull: "running",
      after: { status: "completed", output: { status: "Hello, Ada" } },
    });
  });
});
