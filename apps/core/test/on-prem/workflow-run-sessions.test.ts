/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { isolateCall, runOwnerOf } from "../../src/workflows/code.ts";
import { release } from "../apps.ts";
import { allEvents } from "../audit-events.ts";
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
import {
  endLiveRuns,
  finished,
  liveStatus,
  sleeping,
  whileEngineRefuses,
  woken,
} from "../runs.ts";
import { signedInApi, unique } from "../sign-in.ts";
import { evaluating, workflowFiles } from "../workflow-apps.ts";

// An independent JSON workflow's runs on-prem, in their sessions: one per
// load, owned by the workflow, let go of while a run waits, and waited for
// while the sandbox is full. Runs, the engine, the host and the sandbox
// supervisor are real; a run is started through its builder's session.
// Already covered: a load across a wait, and a listen's event after it
// (json-workflow-runs.test.ts). Gone with App workflows: the budget of
// time a run's own code spends between steps, which a JSON run has none
// of. Kept as an App run until JSON cancels have it, a platform gap: a
// run cancelled while the engine refuses the stop never takes a place (a
// JSON run still takes one and runs once one frees up).

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
  const held = isolateCall(env, {
    key: null,
    owner,
    mainModule: "spin.js",
    modules: async () =>
      await Promise.resolve({
        "spin.js":
          'import { WorkerEntrypoint } from "cloudflare:workers"; export class Spin extends WorkerEntrypoint { async go() { for (;;) {} } }',
      }),
    entrypoint: "Spin",
    method: "go",
    args: [],
    signal: giveUp.signal,
  }).catch(() => {
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
    const { id } = await publishedWorkflow(builder, (name) =>
      definitionOf(
        name,
        [
          {
            extract: {
              call: "grasp.model",
              with: {
                binding: "extractor",
                instructions: "Read the total in cents.",
                input: { text: "Total 12.34 EUR" },
                outputSchema: objectSchema({ total: { type: "integer" } }),
              },
              export: { as: "${ {total: .total} }" },
            },
          },
          {
            answer: {
              set: {
                status: '${ "Total " + ($context.total * 2 | tostring) }',
              },
            },
          },
        ],
        { bindings: { extractor: { kind: "model", contract: key } } }
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
    const { id } = await publishedWorkflow(builder, greetingTasks("P1D"));
    const first = await startedBy(builder, id);
    await sleeping(first, "task:hold");
    // The workflow's runs hold one session at a time: a second run loads
    // only once the first's, waiting, was let go of.
    const second = await startedBy(builder, id, { who: "Grace" });
    await sleeping(second, "task:hold");
    await woken(first, "task:hold");
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

/** A workflow of one step, as `workflowFiles` writes it. */
const oneStep = workflowFiles(
  "single",
  `  return await step.do("only", { description: "The only step" }, async () => "done");`,
  { only: "done" }
);

/** The steps of `run` the audit log has, each as its action and step. */
const stepsOf = async (run: string): Promise<string[]> => {
  const events = await allEvents();
  return events.flatMap(({ action, target, detail }) =>
    action.startsWith("workflow.step.") && target?.id === run
      ? [`${action} ${String(detail.step)}`]
      : []
  );
};

// Kept until JSON cancels stop a run waiting for a place: an App
// workflow's run, as before.
describe("an App workflow's runs on-prem", runTime, () => {
  afterEach(endLiveRuns);

  it("stops a run's wait for a place once the run is cancelled, its activation not yet ended: it never takes one", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id: app } = await builder.api.apps.create({ name: "Runs" });
    await release(builder, app, oneStep);
    // The App's runs' one place, held.
    const letGo = holdPlace(runOwnerOf(app));
    const run = await builder.api.workflows.start(app, "single");
    // Well into its wait: it has asked for a place, and been refused, more
    // than once.
    await scheduler.wait(12_000);
    // Marked cancelled in its object, but the engine not told yet: its
    // activation goes on, as it does until a cancel is finished.
    const cancelled = await whileEngineRefuses(
      (method) => method === "terminate",
      async () =>
        await builder.api.workflows.cancel(run.id).then(
          () => "cancelled",
          () => "cancelled, the engine not yet told"
        )
    );
    await letGo();
    // Longer than the longest wait between a load's asks (30 s): a load
    // still waiting would have taken the place by now, and run.
    await scheduler.wait(35_000);
    expect({
      cancelled: cancelled.startsWith("cancelled"),
      steps: await stepsOf(run.id),
    }).toStrictEqual({ cancelled: true, steps: [] });
  });

  it("evaluates its expressions in its session, with the release's jq", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id: app } = await builder.api.apps.create({ name: "Prices" });
    await release(builder, app, evaluating("{ total: (. // [] | add) }"));
    const run = await builder.api.workflows.start(app, "priced", [300, 900]);
    await finished(run.id, runTime.timeout);
    await expect(builder.api.workflows.status(run.id)).resolves.toMatchObject({
      status: "completed",
      output: { total: 1200 },
    });
  });
});
