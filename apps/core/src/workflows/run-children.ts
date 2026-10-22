import type { Json } from "@grasp-os/shared/json";
import {
  coreStartKeyPrefix,
  workflowResourceErrors,
} from "@grasp-os/shared/workflow-resources";

import { startWorkflow } from "../workflow-starts.ts";
import { admitChild } from "./quotas.ts";
import type { ChildRuns, HostedResourceRun } from "./resource-host.ts";
import { runOf, tellParentOfEnd } from "./resource-runs.ts";

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
//   keyed by the parent run and the step that starts it, and its start by
//   that step under the parent run as invoker (`childKeyOf`): a retry, a
//   restart or a replay that starts it again gets the same child, in the
//   same slot.
// - A child outliving its parent. A parent that ends stops its children
//   that haven't (resource-runs.ts, `projectResourceRun`), and every call a
//   child makes asks that its parent is still going (resource-authority.ts).
// - A parent waiting on an end it never hears. A child's end is told to
//   its parent each time the engine tells core of it, until core takes the
//   notification, and again as the parent starts to wait: an event under
//   the child's ID as its key, taken once (resource-runs.ts,
//   `tellParentOfEnd`).
// - A parent reading another outcome on replay. The end's event carries
//   how the child ended, and its output (`ChildEnd`); the parent's wait
//   journals the event, so every replay reads the same, however long after
//   the child's own details are gone.

/**
 * The start key of the child step `stepName` starts: one per step of a
 * run. The step's name, not its task's ID, so a task run again under
 * another step name (a loop's iteration, a retried scope) starts a child
 * of its own, while a retry or a replay of the same step gets the same.
 */
const childKeyOf = (stepName: string): string =>
  `${coreStartKeyPrefix}child:${stepName}`;

/**
 * Starts the child of `parent`'s step `stepName` through its workflow
 * binding `alias`, with `input`, once: its run's ID.
 */
const startChild = async (
  env: Env,
  parent: HostedResourceRun,
  alias: string,
  stepName: string,
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
    `child:${parent.runId}:${stepName}`
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
      key: childKeyOf(stepName),
    },
    undefined,
    // Its audit names the run that started it and its step, besides the
    // invoker (that run) and the person it acts for.
    {
      parentRun: parent.runId,
      parentWorkflow: parent.workflowId,
      step: stepName,
    }
  );
  if (start.runId === null) {
    throw workflowResourceErrors.create("workflow.child_unavailable");
  }
  return start.runId;
};

/** Child runs as core starts them and reads how they ended. */
export const childRunsOf = (env: Env): ChildRuns => ({
  start: async (parent, alias, stepName, input) =>
    await startChild(env, parent, alias, stepName, input),
  remind: async (childId) => {
    const row = await runOf(env, childId);
    if (row !== undefined) {
      await tellParentOfEnd(env, row);
    }
  },
});
