import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { release } from "./apps.ts";
import { deadlinePassed } from "./decisions.ts";
import { mockIdp } from "./idp.ts";
import {
  decidingWorkflow,
  decisionOf,
  endedRun,
  endLiveResourceRuns,
  jsonWorkflowAppsOf,
  startedBy,
} from "./json-workflow-apps.ts";
import { endLiveRuns, finished, resumed, stopped, woken } from "./runs.ts";

// Decisions past their deadline: a wait resumed after it ends timed out
// at once, never approved, and its decision closed as timed out. (Apart
// from decisions.test.ts: one file holds only so many runs' worth of
// workers.) Each run is an independent JSON workflow's.
//
// Kept until JSON decisions have reminders: asking nobody for a reminder
// late in a run once its decision's deadline has passed, as an App run's,
// in its own block below. An independent workflow's decision asks once,
// as it opens.

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

// Kept until JSON decisions have reminders: an App run's, as before.
describe(
  "an App run's decisions past their deadline",
  { timeout: 60_000 },
  () => {
    afterEach(endLiveRuns);

    it("ask nobody once a decision's deadline has passed", async () => {
      const builder = await signedIn("builder");
      await signedIn("admin");
      // Written against the engine: it opens a decision, stops until told to
      // go on, then asks who may answer, as a reminder late in a run does.
      const { id: app } = await builder.api.apps.create({ name: "Late" });
      await release(builder, app, {
        "workflows/late.ts": `import type { WorkflowDefinition } from "@grasp-os/sdk/workflow";

// Past the SDK: the engine as the host hands it to a run's code.
type Engine = {
  do: <T>(name: string, options: object, fn: () => Promise<T>) => Promise<T>;
  sleep: (name: string, milliseconds: number) => Promise<void>;
  openDecision: (request: object) => Promise<{ decision: string }>;
  decisionRecipients: (decision: string, reminder: boolean) => Promise<unknown[]>;
};

export default {
  metadata: { id: "late", params: [] },
  run: async (engine: Engine) => {
    const { decision } = await engine.do("open", {}, async () =>
      await engine.openDecision({ step: "open", from: "role:admin", description: "Late", timeout: 500 })
    );
    await engine.sleep("gate", 86400000);
    const before = await engine.do("before", {}, async () => await engine.decisionRecipients(decision, true));
    return before.length;
  },
} as unknown as WorkflowDefinition<number>;
`,
        "workflows/late.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";
import definition from "./late.ts";
export default workflowTests(definition, [{ name: "runs", expect: {} }]);
`,
      });
      const run = await builder.api.workflows.start(app, "late");
      const decision = await vi.waitFor(
        async () => {
          const row = await env.DB.prepare(
            "SELECT id FROM workflow_decisions WHERE run_id = ?"
          )
            .bind(run.id)
            .first<{ id: string }>();
          if (!row) {
            throw new Error("No decision yet");
          }
          return row.id;
        },
        { timeout: 10_000 }
      );
      await vi.waitFor(
        async () => {
          await expect(deadlinePassed(decision)).resolves.toBeTruthy();
        },
        { timeout: 10_000, interval: 100 }
      );
      await woken(run.id, "gate");
      await finished(run.id);
      const { output } = await builder.api.workflows.status(run.id);
      expect(output).toBe(0);
    });
  }
);
