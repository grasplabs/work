import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { fakeGateway } from "../ai-gateway.ts";
import { release } from "../apps.ts";
import { allEvents } from "../audit-events.ts";
import { mockIdp } from "../idp.ts";
import {
  endLiveRuns,
  finished,
  liveStatus,
  runObject,
  sleeping,
  woken,
} from "../runs.ts";
import { signedInApi } from "../sign-in.ts";
import { workflowFiles } from "../workflow-apps.ts";

// A workflow's runs on-prem: each load of a run (its start, and each
// resume after a wait) runs as a sandbox session owned by its App, through
// the real engine and host, with `SANDBOX_HOST` bound to the sandbox
// supervisor this project starts. Its two processes give each App one
// session at a time.

const idp = mockIdp();

const extractionModel = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** A builder's new App with `files` as its current version. */
const appWith = async (files: Record<string, string>) => {
  const builder = await signedInApi(idp, "builder");
  const { id } = await builder.api.apps.create({ name: "Runs" });
  await release(builder, id, files);
  return { builder, app: id };
};

/** The steps of `run` the audit log has, each as its action and step. */
const stepsOf = async (run: string): Promise<string[]> => {
  const events = await allEvents();
  return events.flatMap(({ action, target, detail }) =>
    action.startsWith("workflow.step.") && target?.id === run
      ? [`${action} ${String(detail.step)}`]
      : []
  );
};

/**
 * Once the run has ended: as `finished`, with room for a step's CPU time
 * (30 s) to run out first.
 */
const endedPastCpuTime = async (run: string): Promise<void> => {
  await vi.waitFor(
    async () => {
      expect(["complete", "errored", "terminated"]).toContain(
        await liveStatus(run)
      );
    },
    { timeout: 60_000, interval: 500 }
  );
};

/** The step `name` as the engine journaled it: its state and attempts. */
const journaled = async (run: string, name: string) =>
  await runInDurableObject(runObject(run), (_object, state) =>
    state.storage.sql
      .exec<{
        state: string;
        attempt: number;
      }>("SELECT state, attempt FROM steps WHERE name = ?", name)
      .toArray()
  );

// Each test builds its App's workflows and runs their tests on the
// sandbox, then runs them: a minute is room for a slow runner.
const runTime = { timeout: 90_000 };

describe("a workflow's runs on-prem", runTime, () => {
  afterEach(endLiveRuns);

  it("runs its steps in a session, a model call going through the step's attempt host", async () => {
    const { builder, app } = await appWith(
      workflowFiles(
        "reader",
        `  const total = await step.llm("extract", {
    description: "Read the total",
    model: "${extractionModel}",
    instructions: "Read the total in cents.",
    input: "Total 12.34 EUR",
    schema: z.object({ total: z.int() }),
    retries: { limit: 0 },
  });
  return await step.do("double", { description: "Double it" }, async () => total.total * 2);`,
        { extract: { total: 1 } }
      )
    );
    const gateway = fakeGateway({
      text: '{"total": 1234}',
      inputTokens: 10,
      outputTokens: 5,
    });
    const ai: AiBinding = env.AI;
    const answering = vi
      .spyOn(ai, "fetch")
      .mockImplementation(gateway.binding.fetch);
    try {
      const run = await builder.api.workflows.start(app, "reader");
      await finished(run.id);
      await expect(builder.api.workflows.status(run.id)).resolves.toMatchObject(
        { status: "completed", output: 2468 }
      );
    } finally {
      answering.mockRestore();
    }
  });

  it("lets go of a run's session while it waits, and resumes it in a new one, its steps replayed", async () => {
    const { builder, app } = await appWith(
      workflowFiles(
        "waiter",
        `  const before = await step.do("before", { description: "Before" }, async () => 1);
  await step.sleep("go", { description: "Wait", duration: "1 day" });
  return await step.do("after", { description: "After" }, async () => before + 1);`,
        { before: 1, after: 2 }
      )
    );
    const first = await builder.api.workflows.start(app, "waiter");
    await sleeping(first.id, "go");
    // The App holds one session at a time: a second run loads only once
    // the first's, waiting, was let go of.
    const second = await builder.api.workflows.start(app, "waiter");
    await sleeping(second.id, "go");
    await woken(first.id);
    await finished(first.id);
    await expect(builder.api.workflows.status(first.id)).resolves.toMatchObject(
      { status: "completed", output: 2 }
    );
    await expect(stepsOf(first.id)).resolves.toStrictEqual([
      "workflow.step.completed $params",
      "workflow.step.completed before",
      "workflow.step.completed after",
    ]);
  });

  it("fails a run whose step spins, as the App's, once: its process killed mid-step, the step never tried again", async () => {
    const { builder, app } = await appWith(
      workflowFiles(
        "spinner",
        `  await step.do("before", { description: "Before" }, async () => 1);
  return await step.do("spin", { description: "Spin", retries: { limit: 3, delay: "1 second" } }, async () => {
    for (;;) {}
  });`,
        { before: 1, spin: 1 }
      )
    );
    const run = await builder.api.workflows.start(app, "spinner");
    await endedPastCpuTime(run.id);
    const { status, error } = await builder.api.workflows.status(run.id);
    expect({
      status,
      stoppedForCpu: error?.message.includes("CPU time"),
      spin: await journaled(run.id, "spin"),
      steps: await stepsOf(run.id),
    }).toStrictEqual({
      status: "failed",
      stoppedForCpu: true,
      spin: [{ state: "failed", attempt: 1 }],
      steps: [
        "workflow.step.completed $params",
        "workflow.step.completed before",
        "workflow.step.failed spin",
      ],
    });
  });
});
