import { workflowDiagram } from "@grasp-os/open-workflow/diagram";
import type {
  TraceState,
  WorkflowRunTrace,
} from "@grasp-os/shared/workflow-diagrams";
import { z } from "zod";

import type { Acting } from "../auth/identity.ts";
import {
  requireWorkflowRole,
  workflowDefinition,
} from "../workflow-resources.ts";
import { runObjectOf } from "./engine.ts";
import { resourceRunFor } from "./resource-runs.ts";

// A run of an independent workflow laid over its version's diagram
// (platform specification 13.10): the tasks its journal reached, read from
// the engine's own history (workerflow's `history`), never inferred from
// the diagram, the run's status or its code. The generated code names each
// durable step of task `<id>` `task:<id>`, `enter:<id>` or `leave:<id>`
// (@grasp-os/sdk open-workflow), and only those names are read; any other
// step adds nothing. Records are metadata: no value of the run's reaches
// the trace. For the workflow's builders, who read its definitions.

/** How many history records one trace reads at most. */
const maxRecords = 2000;

/** Records per history read, the engine's own most. */
const pageRecords = 500;

const stepName = /^(?:task|enter|leave):(?<task>[a-z][a-z0-9-]{0,63})$/u;

/** The more telling of two states of one task's steps. */
const rank: Readonly<Record<TraceState, number>> = {
  reached: 0,
  waiting: 1,
  running: 2,
  failed: 3,
};

/** How a step stands after its event of `type`, for those that tell. */
const stateAfter: Readonly<Partial<Record<string, TraceState>>> = {
  step_started: "running",
  step_completed: "reached",
  step_errored: "failed",
  sleep_started: "waiting",
  sleep_completed: "reached",
};

interface TracedStep {
  task: string;
  state: TraceState;
  attempts: number;
}

/**
 * The steps of tasks that run `id`'s journal holds, by their ordinal, as
 * far as one trace reads it, and whether it read all of it.
 */
const tracedSteps = async (
  env: Env,
  id: string
): Promise<{ steps: Map<number, TracedStep>; complete: boolean }> => {
  const steps = new Map<number, TracedStep>();
  const stub = runObjectOf(env, id);
  let after = 0;
  let read = 0;
  let more = true;
  while (more && read < maxRecords) {
    // oxlint-disable-next-line no-await-in-loop -- each read goes on from the one before
    const page = await stub.history({ after, limit: pageRecords });
    if (page === undefined) {
      // Still starting: the engine has no record of it yet.
      return { steps, complete: true };
    }
    ({ more } = page);
    for (const record of page.records) {
      read += 1;
      after = record.eventId;
      const step = record.unreadable ? null : record.step;
      const task =
        step === null ? undefined : stepName.exec(step.name)?.groups?.task;
      if (step !== null && task !== undefined && !record.unreadable) {
        const known = steps.get(step.ordinal);
        steps.set(step.ordinal, {
          task,
          state: stateAfter[record.type] ?? known?.state ?? "running",
          attempts: Math.max(known?.attempts ?? 0, record.attempt ?? 0),
        });
      }
    }
  }
  return { steps, complete: !more };
};

/**
 * The trace of run `runId` of workflow `id`, for `by`, who must build it:
 * its version's diagram and the tasks its journal reached.
 */
export const resourceRunTrace = async (
  env: Env,
  by: Acting,
  id: unknown,
  runId: unknown
): Promise<WorkflowRunTrace> => {
  const workflow = await requireWorkflowRole(env, by, id, "builder");
  const run = await resourceRunFor(env, by, workflow.id, runId);
  const definition = await workflowDefinition(
    env,
    by,
    workflow.id,
    run.version
  );
  const diagram = workflowDiagram(z.json().parse(JSON.parse(definition)));
  const { steps, complete } = await tracedSteps(env, run.id);
  // A task's steps together: the most telling of their states, the most
  // attempts any made.
  const tasks = new Map<string, TracedStep>();
  for (const step of steps.values()) {
    const known = tasks.get(step.task);
    tasks.set(step.task, {
      task: step.task,
      state:
        known === undefined || rank[step.state] > rank[known.state]
          ? step.state
          : known.state,
      attempts: Math.max(step.attempts, known?.attempts ?? 0),
    });
  }
  return {
    runId: run.id,
    version: run.version,
    status: run.status,
    diagram,
    tasks: [...tasks.values()],
    complete,
  };
};
