import { afterEach, describe, expect, it } from "vite-plus/test";

import { mockIdp } from "../idp.ts";
import { endLiveRuns } from "../runs.ts";
import { workflowFiles } from "../workflow-apps.ts";
import {
  appsOf,
  endedPastCpuTime,
  journaled,
  runTime,
} from "./workflow-runs.ts";

// A workflow's runs on-prem whose step's attempt the sandbox cut off past
// its CPU time, retried in a fresh session.

const appWith = appsOf(mockIdp());

describe("a workflow's runs on-prem", runTime, () => {
  afterEach(endLiveRuns);

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
});
