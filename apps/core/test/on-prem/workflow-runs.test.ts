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
  woken,
} from "../runs.ts";
import { signedInApi } from "../sign-in.ts";
import { workflowFiles } from "../workflow-apps.ts";

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
    await stepDone(run.id, "before");
    // While the run's load holds its place, the App's next version is made
    // current: its tests run as the App's own calls, not as its runs.
    const released = await release(builder, app, oneStep).then(
      () => "released",
      (error: unknown) => (error instanceof Error ? error.message : "refused")
    );
    await endedPastCpuTime(run.id);
    const { status, error } = await builder.api.workflows.status(run.id);
    expect({
      released,
      status,
      stoppedForCpu: error?.message.includes("CPU time"),
      spin: await journaled(run.id, "spin"),
      steps: await stepsOf(run.id),
    }).toStrictEqual({
      released: "released",
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

  it("stops a run's wait for a place once the run is cancelled: it never loads", async () => {
    const { builder, app } = await appWith(oneStep);
    // The App's runs' one place, held.
    const letGo = holdPlace(runOwnerOf(app));
    const run = await builder.api.workflows.start(app, "single");
    await scheduler.wait(2000);
    await builder.api.workflows.cancel(run.id);
    await letGo();
    // The App's next run takes the place at once: the cancelled one, no
    // longer waiting, never took it.
    const next = await builder.api.workflows.start(app, "single");
    await finished(next.id);
    expect({
      cancelled: await stepsOf(run.id),
      next: await builder.api.workflows.status(next.id),
    }).toMatchObject({ cancelled: [], next: { status: "completed" } });
  });
});
