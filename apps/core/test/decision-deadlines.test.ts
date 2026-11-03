import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { allEvents } from "./audit-events.ts";
import {
  asking,
  asksOf,
  deadlinePassed,
  outputOf,
  reminding,
} from "./decisions.ts";
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
// at once, never approved, and its decision closed as timed out; a
// reminder that would come after it asks nobody. (Apart from
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
      end: { status: "failed", code: "workflow.decision_timed_out" },
      decision: "timed_out",
    });
  });
});

describe(
  "reminders of decisions past their deadline",
  { timeout: 60_000 },
  () => {
    afterEach(endLiveResourceRuns);

    it(
      "remind nobody once a decision's deadline has passed, and tell nobody again",
      { timeout: 90_000 },
      async () => {
        const admin = await signedIn("admin");
        const builder = await signedIn("builder");
        const decider = await signedIn("user");
        const { run, decision } = await asking(
          { admin, builder },
          { from: `person:${decider.userId}`, ...reminding }
        );
        // Stopped before its reminder is due, and resumed only once the
        // decision's deadline has passed: the reminder would come too late.
        await stopped(run.run);
        const before = await asksOf(run);
        await vi.waitFor(
          async () => {
            await expect(deadlinePassed(decision)).resolves.toBeTruthy();
          },
          { timeout: 30_000, interval: 100 }
        );
        await resumed(run.run);
        const output = await outputOf(run);
        const asks = await asksOf(run);
        const audited = await allEvents();

        expect({
          output,
          stoppedBeforeReminder: before.length,
          asks: asks.map(({ reminder }) => reminder),
          asked: audited.filter(
            ({ action, target }) =>
              action === "workflow.decision.asked" && target?.id === decision
          ).length,
        }).toStrictEqual({
          output: { status: "failed", code: "workflow.decision_timed_out" },
          stoppedBeforeReminder: 1,
          asks: [false],
          asked: 1,
        });
      }
    );
  }
);
