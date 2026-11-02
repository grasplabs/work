import { workflowDiagram } from "@grasp-os/open-workflow/diagram";
import { isExpectedCode } from "@grasp-os/shared/errors";
import type {
  TraceState,
  TraceStep,
  WorkflowRunTrace,
} from "@grasp-os/shared/workflow-diagrams";
import {
  workflowResourceErrors,
  workflowRunTraceMaxPageSize,
  workflowRunTraceOptionsSchema,
} from "@grasp-os/shared/workflow-resources";
import { decisionPollStepPrefix } from "@grasp-os/shared/workflows";
import type {
  HistoryRecord,
  ReadableHistoryRecord,
} from "@grasp-os/workerflow/run";
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
// (@grasp-os/sdk open-workflow), and the host adds steps of its own to a
// step of a task (resource-host.ts), read here as part of that step:
//
// - a try's retry of a failed step runs it again under `<step>:retry:<n>`,
//   after a backoff sleep (`<step>:retry:<n>:wait`) the host decided in a
//   step of its own (`…:decide`): each round more attempts of the same
//   step, waiting while it backs off, its state the latest round's;
// - a decision task's call step first waits for its decision: the host
//   asks and looks in steps of its own (`<step>:decision:<look>`) and
//   waits for the decision's wake under core's prefix
//   (`$grasp:decision:<step>:<wait|woken>:<round>`): the task's step,
//   waiting until the decision has its outcome, then as its call goes.
//
// Any other step adds nothing. A failure a catch took still shows as its
// task's: it happened. Each step is shown too, in the order the run
// reached it, with its loop item, attempts and times (GRA-513): a run's
// step detail. Records are metadata: no value of the run's reaches the
// trace, and a failure only by a code the platform defines. For the
// workflow's builders, who read its definitions.
//
// A trace is read a page of steps at a time, in the order the run reached
// them, each page going on after the last step of the one before (its
// ordinal, the cursor): no step is left out or told twice. A step is told
// whole on its page, its retries included, however far its rounds are from
// its first: a page reads the journal from its start, and stops early
// only once it has a step beyond its own and each of its own has reached
// its end, which no later record changes.

/** Records per history read, the engine's own most. */
const pageRecords = 500;

// A step of a task inside a loop names the item it runs in after `@`
// (`task:<id>@<for>.<index>/…`), and a loop's check of its `while` is an
// `item:` step: each item's steps count as their task's. What the host
// adds to a step's name, if anything, follows (`part`).
const stepName =
  /^(?<base>(?:task|enter|leave|item|catch):(?<task>[a-z][a-z0-9-]{0,63})(?:@(?<item>[a-z0-9./-]{1,600}))?)(?<part>(?::[a-z0-9]+)*)$/u;

/** A retry's round of a step, and its backoff before it. */
const retryRound = /^:retry:[1-9]\d*$/u;
const retryBackoff = /^:retry:[1-9]\d*:wait$/u;

/** A decision task's look at its decision, or its wait for its wake. */
const decisionPart =
  /^:decision:(?:asked|reached|outcome|(?:wait|woken):\d+)$/u;

/** A decision's wait or look as core names it, past `decisionPollStepPrefix`. */
const decisionPoll = /^(?<step>.+):(?<part>wait|woken):(?<round>\d+)$/u;

/**
 * What a step is of the task step it is part of: a round of it (its own
 * attempts, or a retry's), a retry's backoff, or its decision's wait.
 */
type Role = "round" | "backoff" | "decision";

/** The role of a step, by what the host added to its name (`part`). */
const roleOf = (part: string): Role | undefined => {
  if (part === "" || retryRound.test(part)) {
    return "round";
  }
  if (retryBackoff.test(part)) {
    return "backoff";
  }
  return decisionPart.test(part) ? "decision" : undefined;
};

/**
 * `name` as its task step's: a decision's wait or look under core's prefix
 * read as `<step>:decision:<wait|woken>:<round>`; any other as it is.
 */
const unprefixed = (name: string): string => {
  if (!name.startsWith(decisionPollStepPrefix)) {
    return name;
  }
  const { step, part, round } =
    decisionPoll.exec(name.slice(decisionPollStepPrefix.length))?.groups ?? {};
  return step === undefined || part === undefined || round === undefined
    ? name
    : `${step}:decision:${part}:${round}`;
};

/** The more telling of two states of one task's steps. */
const rank: Readonly<Record<TraceState, number>> = {
  reached: 0,
  waiting: 1,
  running: 2,
  failed: 3,
};

/** How a round stands after its event of `type`, for those that tell. */
const stateAfter: Readonly<Partial<Record<string, TraceState>>> = {
  step_started: "running",
  step_completed: "reached",
  step_errored: "failed",
  sleep_started: "waiting",
  sleep_completed: "reached",
};

/** How a retry's backoff leaves its step: waiting, then to run again. */
const backoffAfter: Readonly<Partial<Record<string, TraceState>>> = {
  sleep_started: "waiting",
  sleep_completed: "running",
};

/** A task step as a trace reads it: what it shows, and its rounds. */
interface Folded {
  step: TraceStep;
  /** Each round's engine step, by ordinal, and the attempts it made. */
  rounds: Map<number, number>;
  /** Whether its own step (not a decision's wait before it) was reached. */
  own: boolean;
}

/** A page of the steps of tasks one trace read. */
interface TracedSteps {
  /** The page's steps, in the order the run reached them. */
  steps: TraceStep[];
  /** Those and every step before them: the run's tasks so far. */
  through: TraceStep[];
  /** False when more steps follow on a page after this one. */
  complete: boolean;
  /** The last step's ordinal, when more follow: the next page's cursor. */
  nextCursor: string | null;
}

/**
 * A failed step's code as a trace shows it: only a code the platform
 * defines. One a workflow raises, or one merely in a platform namespace,
 * can be made of what the run read.
 */
const shownCodeOf = (code: string | undefined): string =>
  code !== undefined && isExpectedCode(code) ? code : "workflow.step_failed";

/**
 * Task step `folded` as `record`, an event of one of its engine steps in
 * role `role`, leaves it: its state, its attempts, and, once it ended for
 * good, when and, for a failure, by which code.
 */
const fold = (
  folded: Folded,
  record: ReadableHistoryRecord & { step: { ordinal: number } },
  role: Role
): void => {
  const known = folded.step;
  let state: TraceState;
  if (role === "round") {
    state = stateAfter[record.type] ?? known.state;
    const { ordinal } = record.step;
    folded.rounds.set(
      ordinal,
      Math.max(folded.rounds.get(ordinal) ?? 0, record.attempt ?? 0)
    );
  } else if (role === "backoff") {
    state = backoffAfter[record.type] ?? known.state;
  } else {
    // Waiting for its decision until its call runs, unless a look failed.
    state = record.type === "step_errored" ? "failed" : "waiting";
  }
  const ended = state === "reached" || state === "failed";
  let attempts = 0;
  for (const made of folded.rounds.values()) {
    attempts += made;
  }
  folded.step = {
    ...known,
    state,
    attempts,
    endedAt: ended ? new Date(record.at).toISOString() : null,
    errorCode:
      state === "failed"
        ? shownCodeOf(record.error?.code ?? known.errorCode ?? undefined)
        : null,
  };
};

/**
 * Folds the steps of tasks from `records` into `folded`, by the ordinal
 * of each task step's first engine step, `byOrdinal` and `current` (the
 * latest task step of each step name) as the records before left them.
 */
const foldAll = (
  records: readonly HistoryRecord[],
  folded: Map<number, Folded>,
  byOrdinal: Map<number, Folded>,
  current: Map<string, Folded>
): void => {
  for (const record of records) {
    if (record.unreadable || record.step === null) {
      continue;
    }
    const { ordinal } = record.step;
    const named = stepName.exec(unprefixed(record.step.name))?.groups;
    const role = roleOf(named?.part ?? "");
    if (named?.base === undefined || named.task === undefined || !role) {
      continue;
    }
    let into = byOrdinal.get(ordinal);
    if (into === undefined) {
      const latest = current.get(named.base);
      // A round of its own, a retry or a decision's wait goes on the task
      // step it is of: a retry's after its first round, a decision's wait
      // before its own step, and its own step after its decision's wait.
      const own = role === "round" && named.part === "";
      const beforeOwn = own || role === "decision";
      const goesOn = latest !== undefined && !(beforeOwn && latest.own);
      into = goesOn
        ? latest
        : {
            step: {
              ordinal,
              task: named.task,
              item: named.item ?? null,
              state: "running",
              attempts: 0,
              startedAt: new Date(record.at).toISOString(),
              endedAt: null,
              errorCode: null,
            },
            rounds: new Map(),
            own: false,
          };
      if (!goesOn) {
        folded.set(ordinal, into);
        current.set(named.base, into);
      }
      into.own ||= own;
      byOrdinal.set(ordinal, into);
    }
    fold(into, { ...record, step: record.step }, role);
  }
};

/**
 * A page of the steps of tasks that run `id`'s journal holds, in the order
 * it reached them: at most `pageSize`, after the step whose ordinal is
 * `cursor` (from the first when null). Read from the engine's own
 * history, so a test run's as a run's.
 */
export const tracedSteps = async (
  env: Env,
  id: string,
  {
    pageSize = workflowRunTraceMaxPageSize,
    cursor = null,
  }: { pageSize?: number; cursor?: string | null } = {}
): Promise<TracedSteps> => {
  const from = cursor === null ? -1 : Number(cursor);
  const folded = new Map<number, Folded>();
  const byOrdinal = new Map<number, Folded>();
  const current = new Map<string, Folded>();
  const stub = runObjectOf(env, id);
  const shownOf = () =>
    [...folded.values()]
      .map(({ step }) => step)
      .filter(({ ordinal }) => ordinal > from)
      .toSorted((a, b) => a.ordinal - b.ordinal);
  let after = 0;
  let more = true;
  while (more) {
    // oxlint-disable-next-line no-await-in-loop -- each read goes on from the one before
    const page = await stub.history({ after, limit: pageRecords });
    if (page === undefined) {
      // Still starting: the engine has no record of it yet.
      return { steps: [], through: [], complete: true, nextCursor: null };
    }
    ({ more } = page);
    // A page that says there is more but holds nothing would ask again
    // for the same page forever: what was read stands.
    const last = page.records.at(-1);
    if (last === undefined) {
      break;
    }
    after = last.eventId;
    foldAll(page.records, folded, byOrdinal, current);
    // Its own steps all at their end, and one beyond them: no later
    // record changes this page.
    const shown = shownOf();
    if (
      shown.length > pageSize &&
      shown.slice(0, pageSize).every(({ state }) => state === "reached")
    ) {
      break;
    }
  }
  const shown = shownOf();
  const steps = shown.slice(0, pageSize);
  const end = steps.at(-1)?.ordinal ?? from;
  const through = [...folded.values()]
    .map(({ step }) => step)
    .filter(({ ordinal }) => ordinal <= end);
  return shown.length > pageSize
    ? { steps, through, complete: false, nextCursor: String(end) }
    : { steps, through, complete: true, nextCursor: null };
};

/**
 * The trace of run `runId` of workflow `id`, for `by`, who must build it:
 * its version's diagram and the tasks its journal reached.
 */
export const resourceRunTrace = async (
  env: Env,
  by: Acting,
  id: unknown,
  runId: unknown,
  options?: unknown
): Promise<WorkflowRunTrace> => {
  const { doors, pageSize, cursor } = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    workflowRunTraceOptionsSchema,
    options
  );
  const workflow = await requireWorkflowRole(env, by, id, "builder");
  const run = await resourceRunFor(env, by, workflow.id, runId);
  const definition = await workflowDefinition(
    env,
    by,
    workflow.id,
    run.version
  );
  const parsed = z.json().parse(JSON.parse(definition));
  // Its doors once per trace view: a trace followed again draws none.
  const drawn = workflowDiagram(parsed);
  const diagram = doors ? await withDoors(env, by, drawn, parsed) : drawn;
  // Past its retention, or once swept, no more of it is shown than of its
  // result (resource-runs.ts): the engine may still hold its journal a
  // moment longer, on its own clock.
  const receipt = await drizzle(env.DB)
    .select({ detailsRemovedAt: workflowStartReceipts.detailsRemovedAt })
    .from(workflowStartReceipts)
    .where(eq(workflowStartReceipts.id, run.id))
    .get();
  const removed = detailsRemoved({
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
      nextCursor: null,
      detailsRemoved: true,
    };
  }
  const { steps, through, complete, nextCursor } = await tracedSteps(
    env,
    run.id,
    { pageSize, cursor }
  );
  // A task's steps together, this page's and those before it: the most
  // telling of their states, the most attempts any made.
  const tasks = new Map<string, WorkflowRunTrace["tasks"][number]>();
  for (const step of through) {
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
    nextCursor,
    detailsRemoved: false,
    ...(run.aiProvider === undefined ? {} : { aiProvider: run.aiProvider }),
  };
};
