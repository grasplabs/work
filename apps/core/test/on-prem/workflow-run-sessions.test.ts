import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { isolateCall, runOwnerOf } from "../../src/workflows/code.ts";
import { fakeGateway } from "../ai-gateway.ts";
import { mockIdp } from "../idp.ts";
import {
  endLiveRuns,
  finished,
  liveStatus,
  sleeping,
  whileEngineRefuses,
  woken,
} from "../runs.ts";
import {
  bindModel,
  modelRegistration,
  workflowFiles,
} from "../workflow-apps.ts";
import { appsOf, oneStep, runTime, stepsOf } from "./workflow-runs.ts";

// A workflow's runs on-prem, in their sessions: one per load, let go of
// while a run waits, and waited for while the sandbox is full.

const appWith = appsOf(mockIdp());

const extractionModel = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

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

/**
 * What `run` returns with each activation's budget of time between steps
 * `ms` (between-steps.ts), the platform's again after it.
 */
const withBetweenStepsBudget = async <Result>(
  ms: number,
  run: () => Promise<Result>
): Promise<Result> => {
  const kept = env.WORKFLOW_BETWEEN_STEPS_MS;
  env.WORKFLOW_BETWEEN_STEPS_MS = String(ms);
  try {
    return await run();
  } finally {
    if (kept === undefined) {
      Reflect.deleteProperty(env, "WORKFLOW_BETWEEN_STEPS_MS");
    } else {
      env.WORKFLOW_BETWEEN_STEPS_MS = kept;
    }
  }
};

describe("a workflow's runs on-prem", runTime, () => {
  afterEach(endLiveRuns);

  it("runs its steps in a session, a model call going through the step's attempt host", async () => {
    const { builder, app } = await appWith({
      ...modelRegistration({ extractor: 6000 }),
      ...workflowFiles(
        "reader",
        `  const total = await step.llm("extract", {
    description: "Read the total",
    binding: "extractor",
    instructions: "Read the total in cents.",
    input: "Total 12.34 EUR",
    schema: z.object({ total: z.int() }),
    retries: { limit: 0 },
  });
  return await step.do("double", { description: "Double it" }, async () => total.total * 2);`,
        { extract: { total: 1 } }
      ),
    });
    // The App's model binding, approved: the step names it, not a model.
    await bindModel(app, "extractor", extractionModel);
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

  it("ends a run whose code waits on a timer between steps past its budget, and lets go of its session", async () => {
    const { builder, app } = await appWith({
      ...workflowFiles(
        "lingers",
        `  const real = await step.do("before", { description: "Before" }, async () => true);
  // Its tests mock the step: only a run waits.
  if (real) {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
  return await step.do("after", { description: "After" }, async () => 1);`,
        { before: false, after: 1 }
      ),
      ...oneStep,
    });
    const ended = await withBetweenStepsBudget(3000, async () => {
      const run = await builder.api.workflows.start(app, "lingers");
      await finished(run.id);
      // The App's runs hold one session at a time: this one loads at once
      // only if the first's session was let go of, its timer still set.
      const next = await builder.api.workflows.start(app, "single");
      await finished(next.id);
      return { run, next };
    });
    const { status, failure } = await builder.api.workflows.status(
      ended.run.id
    );
    expect({
      status,
      step: failure?.step,
      code: failure?.error.code,
      steps: await stepsOf(ended.run.id),
      next: await builder.api.workflows.status(ended.next.id),
    }).toMatchObject({
      status: "failed",
      step: null,
      code: "workflow.between_steps_limit",
      steps: [
        "workflow.step.completed $params",
        "workflow.step.completed before",
      ],
      next: { status: "completed", output: "done" },
    });
  });

  it("waits for a place while the sandbox is full, then loads, rather than failing the run, the wait no time of its code's between steps", async () => {
    const { builder, app } = await appWith(oneStep);
    // Both processes held, by calls of two others.
    const letGo = [holdPlace("app-full-a"), holdPlace("app-full-b")];
    // Its wait for a place is longer than its budget between steps.
    const { run, whileFull } = await withBetweenStepsBudget(3000, async () => {
      const started = await builder.api.workflows.start(app, "single");
      // Long enough for its load to be refused, the pool full, more than once.
      await scheduler.wait(8000);
      const status = await liveStatus(started.id);
      await Promise.all(
        letGo.map(async (free) => {
          await free();
        })
      );
      await finished(started.id);
      return { run: started, whileFull: status };
    });
    expect({
      whileFull,
      after: await builder.api.workflows.status(run.id),
    }).toMatchObject({
      whileFull: "running",
      after: { status: "completed", output: "done" },
    });
  });

  it("stops a run's wait for a place once the run is cancelled, its activation not yet ended: it never takes one", async () => {
    const { builder, app } = await appWith(oneStep);
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
});
