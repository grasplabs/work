import { afterEach, describe, expect, it } from "vite-plus/test";

import { mockIdp } from "../idp.ts";
import { endLiveRuns } from "../runs.ts";
import { workflowFiles } from "../workflow-apps.ts";
import { appsOf, endedPastCpuTime, runTime, stepsOf } from "./workflow-runs.ts";

// A workflow's runs on-prem whose code spins past its CPU time outside any
// step: the run fails, nothing retried.

const appWith = appsOf(mockIdp());

describe("a workflow's runs on-prem", runTime, () => {
  afterEach(endLiveRuns);

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

  it("fails a run whose code spins past its CPU time outside any step, though an earlier step's attempt that timed out was still out in the session", async () => {
    const { builder, app } = await appWith(
      workflowFiles(
        "spinsAfterHang",
        `  try {
    await step.do("hang", { description: "Hang", timeout: "1 second", retries: { limit: 0 } }, async () => {
      await new Promise(() => {});
    });
  } catch {
    // Timed out, its attempt still out in the session: caught, the run goes on.
  }
  const spins = await step.do("before", { description: "Before" }, async () => true);
  // Its tests mock the step: only a run spins.
  if (spins) {
    for (;;) {}
  }
  return await step.do("after", { description: "After" }, async () => 1);`,
        { hang: null, before: false, after: 1 }
      )
    );
    const run = await builder.api.workflows.start(app, "spinsAfterHang");
    await endedPastCpuTime(run.id);
    const { status, failure } = await builder.api.workflows.status(run.id);
    expect({
      status,
      step: failure?.step,
      error: failure?.error,
    }).toStrictEqual({
      status: "failed",
      step: null,
      error: {
        code: "workflow.run_failed",
        message: "The workflow's code ran out of CPU time outside any step.",
      },
    });
  });
});
