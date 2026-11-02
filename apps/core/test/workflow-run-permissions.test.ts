import { afterEach, describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import {
  endedRun,
  endLiveResourceRuns,
  greetingTasks,
  jsonWorkflowAppsOf,
  publishedWorkflow,
  startedBy,
} from "./json-workflow-apps.ts";
import { finished, leave, sleeping, woken } from "./runs.ts";

// An independent JSON workflow's run acts for its person only while they
// are in the organization: once they have left, the run's next step is
// refused, and the run fails. Runs are real, on the engine; the run is
// started through its builder's session. Already covered for JSON runs:
// a run keeps the version it started on (workflow-starts.test.ts, "starts
// an exact version they have a role in, acting for themselves"); an
// approval serves only the exact version an admin reviewed
// (workflow-bindings.test.ts); the next call refused once its approval or
// permission is revoked mid-run (workflow-calls.test.ts); a trigger whose
// person is gone starting nothing (schedule-triggers.test.ts, "audit a
// start refused for good and go on: a grant revoked, a person gone"); and
// a run's output shown only to its person and the workflow's builders
// (workflow-resource-runs.test.ts). Gone with App workflows: a run's code
// cut off from the network and handed only its App's bindings, before or
// as its module loads, which a JSON run has no code of its own for.

const { signedIn } = jsonWorkflowAppsOf(mockIdp());

describe("an independent JSON workflow's run", { timeout: 60_000 }, () => {
  afterEach(endLiveResourceRuns);

  it("fails at its next step once the person it acts for has left", async () => {
    const builder = await signedIn("builder");
    const { id } = await publishedWorkflow(builder, greetingTasks("P1D"));
    const runId = await startedBy(builder, id);
    await sleeping(runId, "task:hold");
    // Gone while the run waits: its next step doesn't run.
    const rejoin = await leave(builder.userId);
    await woken(runId, "task:hold");
    await finished(runId);
    await rejoin();
    const run = await endedRun(builder, id, runId);
    expect({ status: run.status, code: run.error?.code }).toStrictEqual({
      status: "failed",
      code: "permission.person_inactive",
    });
  });
});
