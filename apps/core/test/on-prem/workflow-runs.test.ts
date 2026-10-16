import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { isolateCall, runOwnerOf } from "../../src/workflows/code.ts";
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
  stepDone,
  whileEngineRefuses,
  woken,
} from "../runs.ts";
import { signedInApi } from "../sign-in.ts";
import {
  bindModel,
  modelRegistration,
  workflowFiles,
} from "../workflow-apps.ts";

// A workflow's runs on-prem: each load of a run (its start, and each
// resume after a wait) runs as a sandbox session owned by its App, through
// the real engine and host, with `SANDBOX_HOST` bound to the sandbox
// supervisor this project starts. Its two processes give each owner (an
// App's runs, the App's other calls) one session at a time.

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

/** Whether a run's failure says the sandbox stopped its code past its memory. */
const stoppedForMemory = (message: string | undefined): boolean =>
  message?.startsWith("The sandbox stopped the workflow's code: ") === true &&
  message.includes("memory");

/** A workflow of one step, as `workflowFiles` writes it. */
const oneStep = workflowFiles(
  "single",
  `  return await step.do("only", { description: "The only step" }, async () => "done");`,
  { only: "done" }
);

// Each test builds its App's workflows and runs their tests on the
// sandbox, then runs them: a minute is room for a slow runner.
const runTime = { timeout: 90_000 };

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

  it("retries a step whose attempt the sandbox cut off past its CPU time in a fresh session, and the run completes", async () => {
    const { builder, app } = await appWith(
      workflowFiles(
        "spendsOnce",
        `  const started = await step.do("start", { description: "Start" }, async () => Date.now());
  return await step.do("spin", { description: "Spin", retries: { limit: 1, delay: "1 second" } }, async () => {
    // Its first attempt, in the run's first session, spins past its CPU
    // time; its retry, in a session of its own past that time, answers.
    if (Date.now() - started < 10_000) {
      for (;;) {}
    }
    return 2;
  });`,
        { start: 0, spin: 2 }
      )
    );
    const run = await builder.api.workflows.start(app, "spendsOnce");
    await endedPastCpuTime(run.id);
    expect({
      status: await builder.api.workflows.status(run.id),
      spin: await journaled(run.id, "spin"),
    }).toMatchObject({
      status: { status: "completed", output: 2 },
      spin: [{ state: "succeeded", attempt: 2 }],
    });
  });

  it("fails a run whose step's last attempt the sandbox cut off past its CPU time, with that timeout", async () => {
    const { builder, app } = await appWith(
      workflowFiles(
        "spinner",
        `  await step.do("before", { description: "Before" }, async () => 1);
  return await step.do("spin", { description: "Spin", retries: { limit: 0 } }, async () => {
    for (;;) {}
  });`,
        { before: 1, spin: 1 }
      )
    );
    const run = await builder.api.workflows.start(app, "spinner");
    await stepDone(run.id, "before");
    // While the run's load holds its place, the App's next version is made
    // current: its tests run as the App's own calls, not as its runs.
    const released = await release(builder, app, oneStep).then(
      () => "released",
      (error: unknown) => (error instanceof Error ? error.message : "refused")
    );
    await endedPastCpuTime(run.id);
    const { status, failure } = await builder.api.workflows.status(run.id);
    expect({
      released,
      status,
      step: failure?.step,
      message: failure?.error.message,
      spin: await journaled(run.id, "spin"),
      steps: await stepsOf(run.id),
    }).toStrictEqual({
      released: "released",
      status: "failed",
      step: "spin",
      message: "The step ran out of CPU time.",
      spin: [{ state: "failed", attempt: 1 }],
      steps: [
        "workflow.step.completed $params",
        "workflow.step.completed before",
        "workflow.step.failed spin",
      ],
    });
  });

  it("retries the attempt the sandbox cut off past its CPU time, though an earlier step's attempt that timed out was still out in the session", async () => {
    const { builder, app } = await appWith(
      workflowFiles(
        "outlives",
        `  try {
    await step.do("hang", { description: "Hang", timeout: "1 second", retries: { limit: 0 } }, async () => {
      await new Promise(() => {});
    });
  } catch {
    // Timed out, its attempt still out in the session: caught, the run goes on.
  }
  const started = await step.do("start", { description: "Start" }, async () => Date.now());
  return await step.do("spin", { description: "Spin", retries: { limit: 1, delay: "1 second" } }, async () => {
    if (Date.now() - started < 10_000) {
      for (;;) {}
    }
    return 2;
  });`,
        { hang: null, start: 0, spin: 2 }
      )
    );
    const run = await builder.api.workflows.start(app, "outlives");
    await endedPastCpuTime(run.id);
    expect({
      status: await builder.api.workflows.status(run.id),
      spin: await journaled(run.id, "spin"),
    }).toMatchObject({
      status: { status: "completed", output: 2 },
      spin: [{ state: "succeeded", attempt: 2 }],
    });
  });

  it("fails a run whose code spins past its CPU time outside any step, retrying nothing", async () => {
    const { builder, app } = await appWith(
      workflowFiles(
        "spinsBetween",
        `  const spins = await step.do("before", { description: "Before" }, async () => true);
  // Its tests mock the step: only a run spins.
  if (spins) {
    for (;;) {}
  }
  return await step.do("after", { description: "After" }, async () => 1);`,
        { before: false, after: 1 }
      )
    );
    const run = await builder.api.workflows.start(app, "spinsBetween");
    await endedPastCpuTime(run.id);
    const { status, failure } = await builder.api.workflows.status(run.id);
    expect({
      status,
      step: failure?.step,
      error: failure?.error,
      steps: await stepsOf(run.id),
    }).toStrictEqual({
      status: "failed",
      step: null,
      error: {
        code: "workflow.run_failed",
        message: "The workflow's code ran out of CPU time outside any step.",
      },
      steps: [
        "workflow.step.completed $params",
        "workflow.step.completed before",
      ],
    });
  });

  it("fails a run whose step's code the sandbox stopped past its memory, the step never tried again, whatever retries it has left", async () => {
    const { builder, app } = await appWith(
      workflowFiles(
        "fills",
        `  await step.do("before", { description: "Before" }, async () => 1);
  return await step.do("fill", { description: "Fill", retries: { limit: 2, delay: "1 second" } }, async () => {
    const held = [];
    for (;;) {
      held.push(new Array(1_000_000).fill(held.length));
    }
  });`,
        { before: 1, fill: 1 }
      )
    );
    const run = await builder.api.workflows.start(app, "fills");
    await endedPastCpuTime(run.id);
    const { status, failure } = await builder.api.workflows.status(run.id);
    // The run's load ends with its session, as the run's failure; the
    // step's attempt failed for good, its retries never used.
    expect({
      status,
      stoppedForMemory: stoppedForMemory(failure?.error.message),
      fill: await journaled(run.id, "fill"),
    }).toStrictEqual({
      status: "failed",
      stoppedForMemory: true,
      fill: [{ state: "failed", attempt: 1 }],
    });
  });

  it("fails a run whose code the sandbox stopped past its memory outside any step, as the run's failure", async () => {
    const { builder, app } = await appWith(
      workflowFiles(
        "fillsBetween",
        `  const fills = await step.do("before", { description: "Before" }, async () => true);
  // Its tests mock the step: only a run fills its memory.
  if (fills) {
    const held = [];
    for (;;) {
      held.push(new Array(1_000_000).fill(held.length));
    }
  }
  return await step.do("after", { description: "After" }, async () => 1);`,
        { before: false, after: 1 }
      )
    );
    const run = await builder.api.workflows.start(app, "fillsBetween");
    await endedPastCpuTime(run.id);
    const { status, failure } = await builder.api.workflows.status(run.id);
    expect({
      status,
      step: failure?.step,
      code: failure?.error.code,
      stoppedForMemory: stoppedForMemory(failure?.error.message),
    }).toStrictEqual({
      status: "failed",
      step: null,
      code: "workflow.run_failed",
      stoppedForMemory: true,
    });
  });

  it("waits for a place while the sandbox is full, then loads, rather than failing the run", async () => {
    const { builder, app } = await appWith(oneStep);
    // Both processes held, by calls of two others.
    const letGo = [holdPlace("app-full-a"), holdPlace("app-full-b")];
    const run = await builder.api.workflows.start(app, "single");
    // Long enough for its load to be refused, the pool full, more than once.
    await scheduler.wait(8000);
    const whileFull = await liveStatus(run.id);
    await Promise.all(
      letGo.map(async (free) => {
        await free();
      })
    );
    await finished(run.id);
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
