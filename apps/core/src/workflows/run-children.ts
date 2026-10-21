import type { Json } from "@grasp-os/shared/json";
import {
  coreStartKeyPrefix,
  workflowResourceErrors,
} from "@grasp-os/shared/workflow-resources";
import { z } from "zod";

import { startWorkflow } from "../workflow-starts.ts";
import { runEngine } from "./engine.ts";
import { childEndType } from "./event-envelopes.ts";
import { admitChild } from "./quotas.ts";
import type { ChildRuns, HostedResourceRun } from "./resource-host.ts";
import { resultOf, runOf } from "./resource-runs.ts";

// Child runs of JSON workflows (platform specification 13.5 `run`, 14.3,
// 18): a `run` task starts exactly the workflow version its run's start
// froze for the task's binding, as a run of its own, and waits for it to
// end. Threat model, and how each is closed:
//
// - A child getting more than its parent may give it. A child is started
//   as any start is (workflow-starts.ts), by an invoker of its own kind
//   (`workflow`): admitted only on the parent workflow's own `start` grant
//   on the child's workflow, for the parent run's person while they have a
//   role in both workflows, while the parent run is still going. It runs
//   its own pinned version, with the parameters and bindings its own start
//   freezes, each with its own admin approval: nothing of the parent's
//   bindings, approvals, App, agent or trigger reaches it. A restricted
//   parent starts it restricted; nothing lifts that.
// - A child of another workflow than the one the parent's source named.
//   The binding is the sealed task's literal alias, which validation
//   matched to the binding's pinned workflow; the start names the frozen
//   binding's exact workflow and version, never anything the isolate
//   passes.
// - Recursion and fan-out. Each child is admitted into its parent's lineage
//   first (quotas.ts, `admitChild`): one level deeper, within the levels,
//   descendant runs and age a lineage may have, its slot never given back.
//   Its attempts, host calls and model requests count on the lineage's
//   root (resource-runs.ts). A workflow bound to itself stops at the
//   nesting limit. Each task runs at most once a run, so a run starts at
//   most one child per `run` task.
// - A start retried, or its answer lost. The child's lineage slot is
//   keyed by the parent run and the task, and its start by the task under
//   the parent run as invoker (`childKeyOf`): a retry, a restart or a
//   replay that starts it again gets the same child, in the same slot.
// - A child outliving its parent. A parent that ends stops its children
//   that haven't (resource-runs.ts, `projectResourceRun`), and every call a
//   child makes asks that its parent is still going (resource-authority.ts).
// - A parent waiting on an end it never hears. A child's end is told to
//   its parent each time the engine tells core of it, until core takes the
//   notification, and again as the parent starts to wait: an event under
//   the child's ID as its key, taken once (`remind`).

/** The start key of the child task `taskId` starts: one per task of a run. */
const childKeyOf = (taskId: string): string =>
  `${coreStartKeyPrefix}child:${taskId}`;

/**
 * Starts the child of `parent`'s task `taskId` through its workflow binding
 * `alias`, with `input`, once: its run's ID.
 */
const startChild = async (
  env: Env,
  parent: HostedResourceRun,
  alias: string,
  taskId: string,
  input: Json
): Promise<string> => {
  const binding = parent.calling.workflows?.get(alias);
  if (binding === undefined) {
    throw workflowResourceErrors.create("workflow.start_denied");
  }
  const place = await admitChild(
    env,
    {
      id: parent.runId,
      rootRunId:
        parent.rootRunId === undefined || parent.rootRunId === parent.runId
          ? null
          : parent.rootRunId,
      depth: parent.depth ?? 0,
    },
    `child:${parent.runId}:${taskId}`
  );
  const start = await startWorkflow(
    env,
    {
      type: "workflow",
      parent: {
        runId: parent.runId,
        workflowId: parent.workflowId,
        principal: parent.principal,
        restricted: parent.calling.restricted,
      },
      place,
    },
    binding.resourceId,
    {
      version: binding.resourceVersion,
      input,
      key: childKeyOf(taskId),
    }
  );
  if (start.runId === null) {
    throw workflowResourceErrors.create("workflow.child_unavailable");
  }
  return start.runId;
};

/**
 * Tells run `parentId` that its child `childId` ended: an event its wait
 * for that child takes, under the child's ID as its key, so telling it
 * again is the same event. A parent that ended takes none, which is no
 * error.
 */
export const tellParent = async (
  env: Env,
  parentId: string,
  childId: string
): Promise<void> => {
  await runEngine(env).sendEvent(parentId, childEndType(childId), childId);
};

/**
 * The output of `parentId`'s child `childId`, once it ended: what it
 * completed with; `workflow.child_failed` naming its code for a child that
 * failed or was cancelled.
 */
const outcomeOf = async (
  env: Env,
  parentId: string,
  childId: string
): Promise<Json> => {
  const row = await runOf(env, childId);
  if (row?.parentRunId !== parentId) {
    throw new Error(`Run ${childId} isn't run ${parentId}'s child`);
  }
  if (row.status === "completed") {
    const { output } = await resultOf(env, row);
    return z.json().parse(output ?? null);
  }
  if (row.status === "failed" || row.status === "cancelled") {
    const { error } = await resultOf(env, row);
    throw workflowResourceErrors.create("workflow.child_failed", {
      child: childId,
      status: row.status,
      code: error?.code ?? null,
    });
  }
  throw new Error(`Run ${childId} hasn't ended`);
};

/** Child runs as core starts them and reads how they ended. */
export const childRunsOf = (env: Env): ChildRuns => ({
  start: async (parent, alias, taskId, input) =>
    await startChild(env, parent, alias, taskId, input),
  remind: async (childId) => {
    const row = await runOf(env, childId);
    if (
      row?.parentRunId !== null &&
      row?.parentRunId !== undefined &&
      (row.status === "completed" ||
        row.status === "failed" ||
        row.status === "cancelled")
    ) {
      await tellParent(env, row.parentRunId, childId);
    }
  },
  outcome: async (parentId, childId) => await outcomeOf(env, parentId, childId),
});
