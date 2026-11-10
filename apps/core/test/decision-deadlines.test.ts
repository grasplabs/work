import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import {
  decidingWorkflow,
  decisionOf,
  endedRun,
  endLiveResourceRuns,
  jsonWorkflowAppsOf,
  startedBy,
} from "./json-workflow-apps.ts";
import { resumed, stopped } from "./runs.ts";

// Decisions past their deadline: a wait resumed after it ends timed out
// at once, never approved, and its decision closed as timed out. (Apart from
// decisions.test.ts: one file holds only so many runs' worth of workers.)
// Each run is an independent JSON workflow's.

const idp = mockIdp();

const { signedIn } = jsonWorkflowAppsOf(idp);

describe("decisions past their deadline", { timeout: 60_000 }, () => {
  afterEach(endLiveResourceRuns);

  it("end a decision wait resumed past its deadline as timed out at once", async () => {
    const admin = await signedIn("admin");
    const builder = await signedIn("builder");
    const decider = await signedIn("user");
    const workflow = await decidingWorkflow(
      { admin, builder },
      { recipient: `person:${decider.userId}`, timeout: 4 }
    );
    const runId = await startedBy(builder, workflow.id);
    const decision = await decisionOf(decider, runId);
    // Stopped while it waits for the answer, and resumed only once the
    // decision's deadline has passed: the new execution's wait would
    // otherwise run on for the whole timeout.
    await stopped(runId);
    const { expiresAt } = await decider.api.decisions.get(decision);
    await vi.waitFor(
      () => {
        expect(Date.now()).toBeGreaterThan(Date.parse(expiresAt));
      },
      { timeout: 10_000, interval: 100 }
    );
    await resumed(runId);
    const run = await endedRun(builder, workflow.id, runId);
    const { status } = await decider.api.decisions.get(decision);

    expect({
      end: { status: run.status, code: run.error?.code },
      decision: status,
    }).toStrictEqual({
      end: { status: "failed", code: "test.unanswered" },
      decision: "timed_out",
    });
  });
});
