import { afterEach, describe, expect, it } from "vite-plus/test";

import { release } from "../apps.ts";
import { mockIdp } from "../idp.ts";
import { endLiveRuns, stepDone } from "../runs.ts";
import { workflowFiles } from "../workflow-apps.ts";
import {
  appsOf,
  endedPastCpuTime,
  journaled,
  oneStep,
  runTime,
  stepsOf,
} from "./workflow-runs.ts";

// A workflow's runs on-prem that the sandbox stopped: a step's last attempt
// past its CPU time, and code past its memory, in a step or outside one.

const appWith = appsOf(mockIdp());

/** Whether a run's failure says the sandbox stopped its code past its memory. */
const stoppedForMemory = (message: string | undefined): boolean =>
  message?.startsWith("The sandbox stopped the workflow's code: ") === true &&
  message.includes("memory");

describe("a workflow's runs on-prem", runTime, () => {
  afterEach(endLiveRuns);

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
});
