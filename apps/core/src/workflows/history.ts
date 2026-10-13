import { runIdSchema } from "@grasp-os/shared/ids";
import {
  outlineNameOf,
  runHistoryPageSchema,
  workflowErrors,
} from "@grasp-os/shared/workflows";
import type {
  RunHistoryEntry,
  RunHistoryError,
  RunHistoryPage,
} from "@grasp-os/shared/workflows";
import type { WorkflowError } from "@grasp-os/workerflow/contracts";
import type { HistoryRecord } from "@grasp-os/workerflow/run";

import { appFor } from "../apps.ts";
import type { Member } from "../auth/identity.ts";
import { decisionOfEventType } from "../decisions/decisions.ts";
import { runObjectOf } from "./engine.ts";
import { detailsRemoved } from "./retention.ts";
import { findRun, seesDetails } from "./runs.ts";

// A run's history, as Grasp's run pages show it: projected, page by page,
// from what the run's engine journaled (workerflow's `history`), never
// guessed from the run's code or its status. The engine alone records a
// run's steps, attempts, waits and lifecycle, each change once, numbered
// in the order it happened; this module only decides what of it a person
// sees, and in what words.
//
// Who may read it: anyone the run's status is shown to (a role in its
// App), checked again on every page, so a person whose role is taken
// away reads no further. Another App's run, or none, is
// `workflow.run_not_found`, whatever the person may do elsewhere.
//
// What it holds: metadata only. The engine hands core no params, output,
// step result or event payload for it, so none can reach a page: no
// input, output, reviewer or review. A step's key (`name:key`, from the
// App's data) is not shown either: an entry names its task by the step's
// outline name, and its step by an opaque ID. A failure's message is the
// workflow's own text, which can hold what the run read, so only those
// who see the run's details (`seesDetails`: admins, and the person it
// acts for) read it; anyone else reads its code and the code's words.
// Once the run's details are removed, its retention over, the history is
// empty, as the engine's record of it goes too.
//
// Each logical step is one `stepId` (the engine's ordinal for it, never
// given to another step): its attempts, a retry's included, are entries
// of it, numbered from 1; a replay journals nothing, so it adds none, and
// an attempt whose answer came after another took over records no
// outcome. Steps of the platform's own (named `$…`: the parameters, a
// decision's bookkeeping, a held effect's waits) are left out. A
// decision's wait is a wait of kind `decision` with the decision's ID;
// what the decision itself became (answered, timed out) is the decision's
// own record, read where decisions are.

/** The most engine records one page reads, a few at a time. */
const recordsPerRead = 200;

/** The most reads one page makes, however many records it leaves out. */
const maxReads = 5;

/** The longest failure message a page shows. */
const maxMessage = 1000;

/** What a step's failure reads as for those who don't see its message. */
const stepFailedText = workflowErrors.create("workflow.step_failed").message;

/** How a page shows failures, and why the run compensates. */
interface Shown {
  sees: boolean;
  cause: "failure" | "cancellation";
}

const errorShown = (
  error: WorkflowError | null,
  { sees }: Shown
): RunHistoryError => ({
  code: error?.code ?? "workflow.step_failed",
  message:
    sees && error !== null
      ? error.message.slice(0, maxMessage)
      : stepFailedText,
});

type LifecycleStatus = Exclude<
  Extract<RunHistoryEntry, { kind: "lifecycle" }>["status"],
  "compensating"
>;

/** The engine's events of the run's status, as the run's status. */
const lifecycleStatuses: Partial<
  Record<HistoryRecord["type"], LifecycleStatus>
> = {
  workflow_queued: "queued",
  workflow_running: "running",
  workflow_waiting: "waiting",
  workflow_paused: "paused",
  workflow_completed: "completed",
  workflow_errored: "failed",
  workflow_terminated: "cancelled",
};

/** The common fields of the entry `record` gives. */
const commonOf = (record: HistoryRecord, taskId: string | null) => ({
  id: `event-${record.eventId}`,
  sequence: record.eventId,
  taskId,
  at: record.at,
});

/** The entry an event of the run's own gives, if any. */
const lifecycleOf = (
  record: HistoryRecord,
  shown: Shown
): RunHistoryEntry | undefined => {
  if (record.type === "rollback_started") {
    return {
      ...commonOf(record, null),
      kind: "lifecycle",
      status: "compensating",
      cause: shown.cause,
      activity: "running",
    };
  }
  const status = lifecycleStatuses[record.type];
  return status === undefined
    ? undefined
    : { ...commonOf(record, null), kind: "lifecycle", status };
};

/** What an attempt's event tells of its step. */
const attemptStates: Partial<
  Record<HistoryRecord["type"], "started" | "completed" | "retrying">
> = {
  attempt_started: "started",
  attempt_completed: "completed",
  attempt_errored: "retrying",
};

/** What a rollback attempt's event tells of its compensation. */
const compensationStates: Partial<
  Record<HistoryRecord["type"], "started" | "completed" | "failed">
> = {
  rollback_attempt_started: "started",
  rollback_attempt_completed: "completed",
  rollback_attempt_errored: "failed",
};

/** What a sleep's or an event wait's event tells of the wait. */
const waitStates: Partial<Record<HistoryRecord["type"], "opened" | "closed">> =
  {
    sleep_started: "opened",
    wait_started: "opened",
    sleep_completed: "closed",
    wait_completed: "closed",
    wait_timed_out: "closed",
  };

type RecordStep = NonNullable<HistoryRecord["step"]>;

/** The entry an event of a `do` step gives, if any. */
const stepOf = (
  record: HistoryRecord,
  step: RecordStep,
  shown: Shown
): RunHistoryEntry | undefined => {
  const common = {
    ...commonOf(record, outlineNameOf(step.name)),
    kind: "step" as const,
    stepId: `step-${step.ordinal}`,
  };
  if (record.type === "step_errored") {
    return {
      ...common,
      state: "failed",
      // The attempt it failed at; the first for one refused before any.
      attempt: Math.max(1, record.attempt ?? 1),
      error: errorShown(record.error, shown),
    };
  }
  const state = attemptStates[record.type];
  // The step's last failure is told once, as the step's.
  if (state === undefined || record.final) {
    return undefined;
  }
  return { ...common, state, attempt: record.attempt ?? 1 };
};

/** The entry an event of a rollback step gives, if any. */
const compensationOf = (
  record: HistoryRecord,
  step: RecordStep,
  shown: Shown
): RunHistoryEntry | undefined => {
  const state = compensationStates[record.type];
  if (state === undefined) {
    return undefined;
  }
  const common = {
    ...commonOf(record, outlineNameOf(step.name)),
    kind: "compensation" as const,
    stepId: `step-${step.ordinal}`,
    attempt: record.attempt ?? 1,
  };
  return state === "failed"
    ? { ...common, state, error: errorShown(record.error, shown) }
    : { ...common, state };
};

/** What a wait waits for: time, a decision, or another event. */
const waitKindOf = (
  step: RecordStep,
  decision: string | undefined
): "timer" | "event" | "decision" => {
  if (step.kind === "sleep") {
    return "timer";
  }
  return decision === undefined ? "event" : "decision";
};

/** The entry an event of a sleep or an event wait gives, if any. */
const waitOf = (
  record: HistoryRecord,
  step: RecordStep
): RunHistoryEntry | undefined => {
  const state = waitStates[record.type];
  if (state === undefined) {
    return undefined;
  }
  const decision =
    step.eventType === null ? undefined : decisionOfEventType(step.eventType);
  // A sleep's length is fixed as it starts; an event wait's deadline
  // moves when a paused run resumes, so none is told.
  const deadline =
    record.type === "sleep_started" && record.durationMs !== null
      ? record.at + record.durationMs
      : null;
  return {
    ...commonOf(record, outlineNameOf(step.name)),
    kind: "wait",
    waitId: decision ?? `step-${step.ordinal}`,
    waitKind: waitKindOf(step, decision),
    state,
    deadline,
  };
};

/** The entry `record` gives the page, or none for what it leaves out. */
export const entryOf = (
  record: HistoryRecord,
  shown: Shown
): RunHistoryEntry | undefined => {
  const { step } = record;
  if (step === null) {
    return lifecycleOf(record, shown);
  }
  // The platform's own steps are no task of the workflow's.
  if (step.name.startsWith("$")) {
    return undefined;
  }
  if (step.kind === "do") {
    return stepOf(record, step, shown);
  }
  if (step.kind === "rollback") {
    return compensationOf(record, step, shown);
  }
  return waitOf(record, step);
};

/**
 * A page of run `run`'s history for `by`, from `input`'s cursor (the
 * engine event ID the page before ended at): at most its page size of
 * entries, oldest first.
 */
export const runHistory = async (
  env: Env,
  by: Member,
  run: unknown,
  input?: unknown
): Promise<RunHistoryPage> => {
  const id = runIdSchema.safeParse(run);
  const query = runHistoryPageSchema.safeParse(input);
  if (!(id.success && query.success)) {
    throw workflowErrors.create("workflow.invalid");
  }
  const row = await findRun(env, id.data);
  if (row === undefined) {
    throw workflowErrors.create("workflow.run_not_found");
  }
  const { owner } = await appFor(env, by, row.appId, "user");
  const done: RunHistoryPage = { items: [], nextCursor: null, hasMore: false };
  if (detailsRemoved(env, row)) {
    return done;
  }
  const shown: Shown = {
    sees: seesDetails(by, row, owner),
    cause: row.cancelRequestedAt === null ? "failure" : "cancellation",
  };
  const { pageSize, cursor } = query.data;
  const stub = runObjectOf(env, row.id);
  const items: RunHistoryEntry[] = [];
  let after = cursor === null ? 0 : Number(cursor);
  let more = true;
  for (
    let read = 0;
    read < maxReads && more && items.length < pageSize;
    read += 1
  ) {
    // oxlint-disable-next-line no-await-in-loop -- each read goes on from the one before
    const page = await stub.history({ after, limit: recordsPerRead });
    if (page === undefined) {
      // The engine has no record of it: still starting, or never started.
      return done;
    }
    const { records, more: followed } = page;
    more = followed;
    for (const record of records) {
      if (items.length === pageSize) {
        more = true;
        break;
      }
      after = record.eventId;
      const entry = entryOf(record, shown);
      if (entry !== undefined) {
        items.push(entry);
      }
    }
  }
  return more
    ? { items, nextCursor: String(after), hasMore: true }
    : { items, nextCursor: null, hasMore: false };
};
