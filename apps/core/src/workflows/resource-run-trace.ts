import { workflowDiagram } from "@grasp-os/open-workflow/diagram";
import { isExpectedCode } from "@grasp-os/shared/errors";
import type {
  TraceState,
  TraceStep,
  WorkflowRunTrace,
} from "@grasp-os/shared/workflow-diagrams";
import type { ReadableHistoryRecord } from "@grasp-os/workerflow/run";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import type { Acting } from "../auth/identity.ts";
import { workflowStartReceipts } from "../db/core/schema.ts";
import { withDoors } from "../workflow-doors.ts";
import {
  requireWorkflowRole,
  workflowDefinition,
} from "../workflow-resources.ts";
import { runObjectOf } from "./engine.ts";
import { resourceRunFor } from "./resource-runs.ts";
import { detailsRemoved } from "./retention.ts";

// A run of an independent workflow laid over its version's diagram
// (platform specification 13.10): the tasks its journal reached, read from
// the engine's own history (workerflow's `history`), never inferred from
// the diagram, the run's status or its code. The generated code names each
// durable step of task `<id>` `task:<id>`, `enter:<id>`, `leave:<id>` or
// `item:<id>` or `catch:<id>`, inside a loop with the item after `@`
// (@grasp-os/sdk open-workflow), and only those names are read; any other
// step adds nothing. A failure a catch took still shows as its task's: it
// happened. Each step is shown too, in the order the run reached it, with
// its loop item, attempts and times (GRA-513): a run's step detail.
// Records are metadata: no value of the run's reaches the trace, and a
// failure only by a code the platform defines. For the workflow's
// builders, who read its definitions.

/** How many history records one trace reads at most. */
const maxRecords = 2000;

/** Records per history read, the engine's own most. */
const pageRecords = 500;

// A step of a task inside a loop names the item it runs in after `@`
// (`task:<id>@<for>.<index>/…`), and a loop's check of its `while` is an
// `item:` step: each item's steps count as their task's.
const stepName =
  /^(?:task|enter|leave|item|catch):(?<task>[a-z][a-z0-9-]{0,63})(?:@(?<item>[a-z0-9./-]{1,600}))?$/u;

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

/** The steps of tasks one trace read, in the order the run reached them. */
interface TracedSteps {
  steps: TraceStep[];
  /** False when the journal held more than one trace reads. */
  complete: boolean;
}

/**
 * A failed step's code as a trace shows it: only a code the platform
 * defines. One a workflow raises, or one merely in a platform namespace,
 * can be made of what the run read.
 */
const shownCodeOf = (code: string | undefined): string =>
  code !== undefined && isExpectedCode(code) ? code : "workflow.step_failed";

/**
 * The step `known` (of task `task`, in loop item `item`) as `record`, one
 * of its events, leaves it: its state, its attempts, and, once it ended
 * for good, when and, for a failure, by which code.
 */
const steppedBy = (
  known: TraceStep | undefined,
  record: ReadableHistoryRecord & { step: object },
  task: string,
  item: string | null
): TraceStep => {
  const state = stateAfter[record.type] ?? known?.state ?? "running";
  const ended = state === "reached" || state === "failed";
  return {
    ordinal: record.step.ordinal,
    task,
    item,
    state,
    attempts: Math.max(known?.attempts ?? 0, record.attempt ?? 0),
    startedAt: known?.startedAt ?? new Date(record.at).toISOString(),
    endedAt: ended ? new Date(record.at).toISOString() : null,
    errorCode:
      state === "failed"
        ? shownCodeOf(record.error?.code ?? known?.errorCode ?? undefined)
        : null,
  };
};

/**
 * The steps of tasks that run `id`'s journal holds, in the order it
 * reached them, as far as one trace reads it, and whether it read all of
 * it. Read from the engine's own history, so a test run's as a run's.
 */
export const tracedSteps = async (
  env: Env,
  id: string
): Promise<TracedSteps> => {
  const steps = new Map<number, TraceStep>();
  const stub = runObjectOf(env, id);
  let after = 0;
  let read = 0;
  let more = true;
  while (more && read < maxRecords) {
    // oxlint-disable-next-line no-await-in-loop -- each read goes on from the one before
    const page = await stub.history({ after, limit: pageRecords });
    if (page === undefined) {
      // Still starting: the engine has no record of it yet.
      return { steps: [], complete: true };
    }
    ({ more } = page);
    // A page that says there is more but holds nothing would ask again
    // for the same page forever: what was read stands, as incomplete.
    if (page.records.length === 0) {
      break;
    }
    for (const record of page.records) {
      read += 1;
      after = record.eventId;
      if (record.unreadable || record.step === null) {
        continue;
      }
      const named = stepName.exec(record.step.name)?.groups;
      if (named?.task !== undefined) {
        const { ordinal } = record.step;
        steps.set(
          ordinal,
          steppedBy(
            steps.get(ordinal),
            { ...record, step: record.step },
            named.task,
            named.item ?? null
          )
        );
      }
    }
  }
  return {
    // A step's ordinal is its place in the run.
    steps: [...steps.values()].toSorted((a, b) => a.ordinal - b.ordinal),
    complete: !more,
  };
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
  const parsed = z.json().parse(JSON.parse(definition));
  const diagram = await withDoors(env, by, workflowDiagram(parsed), parsed);
  // Past its retention as the deployment has it now, or once swept, no
  // more of it is shown than of its result (resource-runs.ts): the engine
  // may still hold its journal for the retention it was admitted with.
  const receipt = await drizzle(env.DB)
    .select({ detailsRemovedAt: workflowStartReceipts.detailsRemovedAt })
    .from(workflowStartReceipts)
    .where(eq(workflowStartReceipts.id, run.id))
    .get();
  const removed = detailsRemoved(env, {
    endedAt: run.endedAt === null ? null : new Date(run.endedAt),
    detailsRemovedAt: receipt?.detailsRemovedAt ?? null,
  });
  if (removed) {
    return {
      runId: run.id,
      version: run.version,
      status: run.status,
      diagram,
      tasks: [],
      steps: [],
      complete: true,
      detailsRemoved: true,
    };
  }
  const { steps, complete } = await tracedSteps(env, run.id);
  // A task's steps together: the most telling of their states, the most
  // attempts any made.
  const tasks = new Map<string, WorkflowRunTrace["tasks"][number]>();
  for (const step of steps) {
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
    steps,
    complete,
    detailsRemoved: false,
  };
};
