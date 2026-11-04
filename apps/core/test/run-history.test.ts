/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import type { WorkflowRunTrace } from "@grasp-os/shared/workflow-diagrams";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { runObjectOf } from "../src/workflows/engine.ts";
import { mockIdp } from "./idp.ts";
import {
  endedRun,
  endLiveResourceRuns,
  greetingTasks,
  jsonWorkflowAppsOf,
  objectSchema,
  publishedWorkflow,
  runOnce,
  settles,
  startedBy,
} from "./json-workflow-apps.ts";
import type { Person } from "./json-workflow-apps.ts";
import { outcome } from "./sign-in.ts";

// A JSON workflow run's history, as its builders read it over the
// session API (`workflowResources.runTrace`, resource-run-trace.ts): its
// steps, read from the engine's own journal. What could go wrong, tried
// below: a wait told as done while the run still sleeps, or as still
// waiting once it slept; a value the run read or made (its input, a
// task's output, the data a failure was about) reaching the trace; a
// failure told by a code the run made up; someone whose builder role was
// taken away reading on; an event the engine can't read back breaking
// the trace, or changing how the rest is told. Who reads which run, the
// path through branches, loop items, failures' codes and retention are
// workflow-run-traces.test.ts's. A task's retries and their backoffs, a
// decision's wait, and paging a long trace are not tried here: the trace
// doesn't tell them yet, and GRA-1460's tests cover them as it does.

const idp = mockIdp();
const { signedIn } = jsonWorkflowAppsOf(idp);

/** Run `runId` of workflow `id`, as `person` reads its trace. */
const traceOf = async (
  person: Person,
  id: string,
  runId: string
): Promise<WorkflowRunTrace> =>
  await person.api.workflowResources.runTrace(id, runId);

/** A trace's steps: each one's task, state and failure's code. */
const told = ({ steps }: WorkflowRunTrace) =>
  steps.map(
    ({ task, state, errorCode }) => `${task} ${state} ${errorCode ?? "-"}`
  );

describe("a JSON workflow run's history", () => {
  afterEach(endLiveResourceRuns);

  it("tells a wait as waiting while the run sleeps, and as reached, with its end, once it slept", async () => {
    const builder = await signedIn("builder");
    const sleeping = await publishedWorkflow(builder, greetingTasks("1 hour"));
    const slept = await publishedWorkflow(builder, greetingTasks("1 second"));
    const sleepingRun = await startedBy(builder, sleeping.id);
    const sleptRun = await startedBy(builder, slept.id);
    await runOnce(
      builder,
      sleeping.id,
      sleepingRun,
      ({ status }) => status === "running"
    );
    await endedRun(builder, slept.id, sleptRun);

    const waiting = await vi.waitFor(async () => {
      const trace = await traceOf(builder, sleeping.id, sleepingRun);
      if (trace.steps.length === 0) {
        throw new Error("The engine hasn't journaled the sleep yet");
      }
      return trace;
    }, settles);
    const done = await traceOf(builder, slept.id, sleptRun);
    await builder.api.workflowResources.terminateRun(sleeping.id, sleepingRun);

    expect({
      waiting: told(waiting),
      waitingEnd: waiting.steps[0]?.endedAt,
      done: told(done),
      ended: done.steps.every(({ endedAt }) => endedAt !== null),
    }).toStrictEqual({
      waiting: ["hold waiting -"],
      waitingEnd: null,
      done: ["hold reached -", "greet reached -"],
      ended: true,
    });
  });

  it("tells a failure only by a code the platform defines, and nothing the run read or made", async () => {
    const builder = await signedIn("builder");
    const secret = `secret-${crypto.randomUUID()}`;
    // Greets with the input, then exports it where a number belongs.
    const workflow = await publishedWorkflow(builder, [
      { greet: { set: { status: '${ "Hello, " + $workflow.input.who }' } } },
      {
        mark: {
          set: "${ . }",
          export: {
            as: "${ {count: $workflow.input.who} }",
            schema: objectSchema({ count: { type: "integer" } }),
          },
        },
      },
    ]);
    const runId = await startedBy(builder, workflow.id, {
      who: secret,
    });
    const run = await endedRun(builder, workflow.id, runId);
    const trace = await traceOf(builder, workflow.id, runId);

    expect({ status: run.status, steps: told(trace) }).toStrictEqual({
      status: "failed",
      steps: ["greet reached -", "mark failed workflow.task_data_invalid"],
    });
    expect(JSON.stringify(trace)).not.toContain(secret);
  });

  it("is read by an admin and a builder it's shared with, and no further once that builder's role is taken away", async () => {
    const owner = await signedIn("builder");
    const shared = await signedIn("builder");
    const admin = await signedIn("admin");
    const workflow = await publishedWorkflow(owner, greetingTasks());
    await owner.api.workflowResources.share(workflow.id, {
      type: "person",
      id: shared.userId,
      role: "builder",
    });
    const runId = await startedBy(owner, workflow.id);
    await endedRun(owner, workflow.id, runId);

    const byOwner = told(await traceOf(owner, workflow.id, runId));
    const byAdmin = told(await traceOf(admin, workflow.id, runId));
    const byShared = told(await traceOf(shared, workflow.id, runId));
    await owner.api.workflowResources.unshare(workflow.id, {
      type: "person",
      id: shared.userId,
    });
    const revoked = await outcome(traceOf(shared, workflow.id, runId));

    expect({ byOwner, byAdmin, byShared, revoked }).toStrictEqual({
      byOwner: ["greet reached -"],
      byAdmin: ["greet reached -"],
      byShared: ["greet reached -"],
      revoked: "workflow.resource_unavailable",
    });
  });

  it("leaves out an event the engine can't read back, and tells the rest as it was", async () => {
    const builder = await signedIn("builder");
    const workflow = await publishedWorkflow(builder, [
      { first: { set: { status: "first" } } },
      { second: { set: { status: "second" } } },
      { third: { set: { status: "third" } } },
    ]);
    const runId = await startedBy(builder, workflow.id);
    await endedRun(builder, workflow.id, runId);
    const before = await traceOf(builder, workflow.id, runId);
    // The start of `second` as nothing the engine knows how to read.
    await runInDurableObject(runObjectOf(env, runId), (_, state) => {
      state.storage.sql.exec(
        "UPDATE history SET type = 'not-an-event' WHERE type = 'step_started' AND ordinal = (SELECT ordinal FROM steps WHERE name = 'task:second')"
      );
    });

    const after = await traceOf(builder, workflow.id, runId);

    expect({
      steps: told(after),
      truncated: after.truncated,
      // The steps around it, to the millisecond.
      around: after.steps.filter(({ task }) => task !== "second"),
    }).toStrictEqual({
      steps: told(before),
      truncated: false,
      around: before.steps.filter(({ task }) => task !== "second"),
    });
  });
});
