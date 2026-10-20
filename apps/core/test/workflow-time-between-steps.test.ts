import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vite-plus/test";

import { withCpuKills } from "./cpu-kills.ts";
import { mockIdp } from "./idp.ts";
import {
  endLiveRuns,
  finished,
  runObject,
  sleeping,
  stopped,
  woken,
} from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// The time a run's code spends outside its steps (between-steps.ts): each
// activation gets a budget of it, past which the run ends. Runs, the
// engine, the host and the run's isolate are real; the budget is the
// tests' shorter one (`WORKFLOW_BETWEEN_STEPS_MS`), and the code between
// steps waits on its own timers. Each workflow waits only in a real run:
// its tests mock its first step's `true` as `false`, so activating the
// App waits for nothing.

const idp = mockIdp();

/** The budget of time between steps the tests set, per activation. */
const budgetMs = 3000;

/** Most of the budget, but within it with room for a slow runner. */
const withinMs = 1800;

/** Well past the budget. */
const pastMs = 6000;

/** How long a run here may take to end. */
const runEnds = 30_000;

/** Code that waits `ms` on a timer, outside any step, in a real run only. */
const waits = (ms: number): string =>
  `  if (real) { await new Promise((resolve) => setTimeout(resolve, ${ms})); }`;

/** The first step of each workflow here: whether this is a real run. */
const realStep = `  const real = await step.do("real", { description: "Real" }, async () => true);`;

/** The steps the engine journaled for `run`, in order: their names and states. */
const journal = async (run: string) =>
  await runInDurableObject(runObject(run), (_object, state) =>
    state.storage.sql
      .exec<{ name: string; state: string }>(
        "SELECT name, state FROM steps WHERE name NOT LIKE '$%' ORDER BY ordinal"
      )
      .toArray()
      .map(({ name, state: stepState }) => `${name} ${stepState}`)
  );

/** A builder's App with workflow `id` of `body`, and the builder. */
const workflowApp = async (id: string, body: string) => {
  const builder = await signedInApi(idp, "builder");
  const app = await appWith(
    builder,
    workflowFiles(id, `${realStep}\n${body}`, { real: false })
  );
  return { builder, app };
};

/** How `run` ended: its status and, if it failed, where and with what code. */
const endOf = async (
  builder: Awaited<ReturnType<typeof signedInApi>>,
  run: string
) => {
  const { status, output, failure } = await builder.api.workflows.status(run);
  return failure === undefined || failure === null
    ? { status, output }
    : { status, step: failure.step, code: failure.error.code };
};

describe("a workflow run's time between steps", { timeout: 90_000 }, () => {
  let kept: string | undefined;
  beforeAll(() => {
    kept = env.WORKFLOW_BETWEEN_STEPS_MS;
    env.WORKFLOW_BETWEEN_STEPS_MS = String(budgetMs);
  });

  afterEach(endLiveRuns);

  afterAll(() => {
    if (kept === undefined) {
      Reflect.deleteProperty(env, "WORKFLOW_BETWEEN_STEPS_MS");
    } else {
      env.WORKFLOW_BETWEEN_STEPS_MS = kept;
    }
  });

  it("ends a run whose code waits on a timer between steps past its budget, keeping the steps before and running none after", async () => {
    const { builder, app } = await workflowApp(
      "lingers",
      `${waits(pastMs)}
  return await step.do("after", { description: "After" }, async () => 1);`
    );
    const started = Date.now();
    const run = await builder.api.workflows.start(app, "lingers");
    await finished(run.id, runEnds);
    const tookMs = Date.now() - started;
    // The isolate's timer fires after the run ended: its step is refused.
    await scheduler.wait(pastMs);

    expect({
      end: await endOf(builder, run.id),
      endedBeforeTheTimer: tookMs < pastMs,
      steps: await journal(run.id),
    }).toStrictEqual({
      end: {
        status: "failed",
        step: null,
        code: "workflow.between_steps_limit",
      },
      endedBeforeTheTimer: true,
      steps: ["real succeeded"],
    });
  });

  it("never refills the budget at a step: short waits between quick steps add up", async () => {
    const { builder, app } = await workflowApp(
      "dawdles",
      `  for (let tick = 0; tick < 10; tick += 1) {
${waits(700)}
    await step.do(\`tick-\${tick}\`, { description: "Tick" }, async () => tick);
  }
  return "done";`
    );
    const run = await builder.api.workflows.start(app, "dawdles");
    await finished(run.id, runEnds);
    const steps = await journal(run.id);

    expect({
      end: await endOf(builder, run.id),
      ticked: steps.length - 1 < 10,
    }).toStrictEqual({
      end: {
        status: "failed",
        step: null,
        code: "workflow.between_steps_limit",
      },
      ticked: true,
    });
  });

  it("counts none of a step's own time: a long attempt and quick code between completes", async () => {
    const { builder, app } = await workflowApp(
      "works",
      `  const slept = await step.do("slow", { description: "Slow", timeout: "20 seconds" }, async () => {
    if (real) { await new Promise((resolve) => setTimeout(resolve, ${pastMs})); }
    return 2;
  });
${waits(withinMs)}
  return slept;`
    );
    const run = await builder.api.workflows.start(app, "works");
    await finished(run.id, runEnds);

    await expect(endOf(builder, run.id)).resolves.toStrictEqual({
      status: "completed",
      output: 2,
    });
  });

  it("gives each activation its own budget: a run stopped and restarted while it waits replays its code and completes", async () => {
    const { builder, app } = await workflowApp(
      "naps",
      `${waits(withinMs)}
  await step.sleep("nap", { description: "Nap", duration: "1 day" });
  return await step.do("after", { description: "After" }, async () => 1);`
    );
    const run = await builder.api.workflows.start(app, "naps");
    await sleeping(run.id, "nap");
    // A crash or a deploy while it sleeps: resumed, its sleep due, it
    // replays from its start, its wait between steps again.
    await stopped(run.id);
    await woken(run.id, "nap");
    await finished(run.id, runEnds);

    expect({
      end: await endOf(builder, run.id),
      steps: await journal(run.id),
    }).toStrictEqual({
      end: { status: "completed", output: 1 },
      steps: ["real succeeded", "nap succeeded", "after succeeded"],
    });
  });

  it("counts the code a replay runs again: a run whose activation replays past the budget ends", async () => {
    const { builder, app } = await workflowApp(
      "replays",
      `${waits(withinMs)}
  await step.sleep("nap", { description: "Nap", duration: "1 day" });
${waits(withinMs)}
  return await step.do("after", { description: "After" }, async () => 1);`
    );
    const run = await builder.api.workflows.start(app, "replays");
    await sleeping(run.id, "nap");
    await woken(run.id, "nap");
    await finished(run.id, runEnds);

    expect({
      end: await endOf(builder, run.id),
      steps: await journal(run.id),
    }).toStrictEqual({
      end: {
        status: "failed",
        step: null,
        code: "workflow.between_steps_limit",
      },
      steps: ["real succeeded", "nap succeeded"],
    });
  });

  it("gives the activation that retries a step its isolate killed mid-step its own budget, and the run completes", async () => {
    const { builder, app } = await workflowApp(
      "survives",
      `${waits(withinMs)}
  return await step.do("work", { description: "Work" }, async () => 2);`
    );
    const end = await withCpuKills(
      "work",
      (attempt) => attempt === 1,
      async () => {
        const run = await builder.api.workflows.start(app, "survives");
        await finished(run.id, runEnds);
        return await endOf(builder, run.id);
      }
    );

    expect(end).toStrictEqual({ status: "completed", output: 2 });
  });
});
