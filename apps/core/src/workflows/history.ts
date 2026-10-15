import { appErrors } from "@grasp-os/shared/apps";
import {
  appIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import { isPlatformCode } from "@grasp-os/shared/operations";
import {
  reviewedTaskOf,
  runHistoryPageSchema,
  workflowErrors,
} from "@grasp-os/shared/workflows";
import type {
  RunHistoryEntry,
  RunHistoryError,
  RunHistoryPage,
  WorkflowCalls,
} from "@grasp-os/shared/workflows";
import type { WorkflowError } from "@grasp-os/workerflow/contracts";
import type {
  ReadableHistoryRecord,
  HistoryRecord,
  StepIdentitiesQuery,
  StepIdentity,
} from "@grasp-os/workerflow/run";

import { callsFor, appFor } from "../apps.ts";
import type { Member } from "../auth/identity.ts";
import { decisionOfEventType } from "../decisions/decisions.ts";
import { runObjectOf } from "./engine.ts";
import { waitKeyOf, waitStepPrefix } from "./host.ts";
import { detailsRemoved } from "./retention.ts";
import { findRun, seesDetails } from "./runs.ts";
import type { RunRow } from "./runs.ts";

// A run's history, as Grasp's run pages show it: projected, page by page,
// from what the run's engine journaled (workerflow's `history`), never
// guessed from the run's code or its status. The engine alone records a
// run's steps, attempts, waits and lifecycle, each change once, numbered
// in the order it happened; this module only decides what of it a person
// sees, and in what words.
//
// Who may read it: anyone the run's status is shown to (a role in its
// App), checked again on every page, so a person whose role is taken
// away reads no further. Someone with no role in the run's App finds it
// as the App isn't there (`app.not_found`), whatever they may do in
// other Apps; a run that isn't there is `workflow.run_not_found`.
//
// What it holds: metadata only. The engine hands core no params, output,
// step result or event payload for it, so none can reach a page: no
// input, output, reviewer or review. A step is named (`taskId`) only by a
// name its version's review shows (`reviewedTaskOf`), without the key an
// engine name adds (`name:key`, from the App's data); any other name can
// be made of what the run read, so its entries name no task, and the
// opaque `stepId` alone tells the step. A failure's message is the
// workflow's own text, which can hold what the run read, so only those
// who see the run's details (`seesDetails`: admins, and the person it
// acts for) read it, with the error's own code; anyone else reads a
// platform code as it is, any other as `workflow.step_failed`, and
// generic words. Once the run's details are removed, its retention over,
// the history is empty, as the engine's record of it goes too.
//
// Each logical step is one `stepId` (the engine's ordinal for it, never
// given to another step): its attempts, a retry's included, are entries
// of it, numbered from 1; a replay journals nothing, so it adds none, and
// an attempt whose answer came after another took over records no
// outcome. A step whose side effect connect held ends as held, and runs
// again once the person decided, in steps of core's own
// (`$grasp:wait:<key>:held:<round>:…`, or `:unknown:`, host.ts): those runs are told as
// more attempts of the step that was held, numbered on from its own, and
// the waits between them as `blocked` waits of it, while its held end is
// no completion. Core's other steps (named `$…`: the parameters, a
// decision's bookkeeping, a held effect's checks) are left out. A
// decision's wait is a wait of kind `decision` with the decision's ID;
// what the decision itself became (answered, timed out) is the decision's
// own record, read where decisions are. An event the engine can't read
// back is told by its place alone (`unreadable`), and the rest still is.

/** The most engine records one read asks for. */
const maxRecordsPerRead = 200;

/** The most reads one page makes, however many records it leaves out. */
const maxReads = 5;

/** The longest failure message a page shows. */
const maxMessage = 1000;

/** What a step's failure reads as for those who don't see its message. */
const stepFailedText = workflowErrors.create("workflow.step_failed").message;

/** A held step's run again, a wait between them, or a check of it. */
const heldStep =
  /^\$grasp:wait:(?<key>[0-9a-f]{16}):(?:held|unknown):(?<round>[1-9]\d*):(?<rest>.+)$/u;

/** A step whose side effect was held, and its runs since. */
interface HeldStep {
  ordinal: number;
  name: string;
  /** Its own attempts, the last of which ended as held. */
  attempts: number;
  /** Each round of runs again so far: how many attempts its run took. */
  rounds: Map<number, number>;
}

/** How a page tells a run's steps. */
interface Context {
  /** Whether the person sees the run's details. */
  sees: boolean;
  /** What the run's version's review shows of it; none when none is kept. */
  reviewed: WorkflowCalls | undefined;
  /** The run's held steps, by the key core's steps name them by. */
  heldByKey: ReadonlyMap<string, HeldStep>;
  /** The same, by the held step's ordinal. */
  heldByOrdinal: ReadonlyMap<number, HeldStep>;
}

const errorShown = (
  error: WorkflowError | null,
  { sees }: Context
): RunHistoryError => {
  const code = error?.code ?? "workflow.step_failed";
  if (sees && error !== null) {
    return { code, message: error.message.slice(0, maxMessage) };
  }
  return {
    code: isPlatformCode(code) ? code : "workflow.step_failed",
    message: stepFailedText,
  };
};

type LifecycleStatus = Exclude<
  Extract<RunHistoryEntry, { kind: "lifecycle" }>["status"],
  "compensating"
>;

/** The engine's events of the run's status, as the run's status. */
const lifecycleStatuses: Partial<
  Record<ReadableHistoryRecord["type"], LifecycleStatus>
> = {
  workflow_queued: "queued",
  workflow_running: "running",
  workflow_waiting: "waiting",
  workflow_paused: "paused",
  workflow_completed: "completed",
  workflow_errored: "failed",
  workflow_terminated: "cancelled",
};

/** What an attempt's event tells of its step. */
const attemptStates: Partial<
  Record<ReadableHistoryRecord["type"], "started" | "completed" | "retrying">
> = {
  attempt_started: "started",
  attempt_completed: "completed",
  attempt_errored: "retrying",
};

/** What a rollback attempt's event tells of its compensation. */
const compensationStates: Partial<
  Record<ReadableHistoryRecord["type"], "started" | "completed" | "retrying">
> = {
  rollback_attempt_started: "started",
  rollback_attempt_completed: "completed",
  rollback_attempt_errored: "retrying",
};

/** What a sleep's or an event wait's event tells of the wait. */
const waitStates: Partial<
  Record<ReadableHistoryRecord["type"], "opened" | "closed">
> = {
  sleep_started: "opened",
  wait_started: "opened",
  sleep_completed: "closed",
  wait_completed: "closed",
  wait_timed_out: "closed",
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
  record: ReadableHistoryRecord
): RunHistoryEntry | undefined => {
  if (record.type === "rollback_started") {
    return {
      ...commonOf(record, null),
      kind: "lifecycle",
      status: "compensating",
      // How the run ends once it rolled back, as journaled when it began.
      cause: record.rollbackEnd === "terminated" ? "cancellation" : "failure",
      activity: "running",
    };
  }
  const status = lifecycleStatuses[record.type];
  return status === undefined
    ? undefined
    : { ...commonOf(record, null), kind: "lifecycle", status };
};

/** The step an entry is told of: its ID and task. */
interface Told {
  stepId: string;
  taskId: string | null;
}

/** How a `do` step's events are told. */
interface AsStep extends Told {
  /** What its attempts are numbered on from. */
  offset: number;
  /** Its completion ended as held, so it is no completion. */
  held: boolean;
}

/** The entry an event of a `do` step gives, if any. */
const stepOf = (
  record: ReadableHistoryRecord,
  as: AsStep,
  context: Context
): RunHistoryEntry | undefined => {
  const common = {
    ...commonOf(record, as.taskId),
    kind: "step" as const,
    stepId: as.stepId,
  };
  const attempt = as.offset + Math.max(1, record.attempt ?? 1);
  if (record.type === "step_errored") {
    return {
      ...common,
      state: "failed",
      attempt,
      error: errorShown(record.error, context),
    };
  }
  const state = attemptStates[record.type];
  // The step's last failure is told once, as the step's; a held end is
  // the start of a wait, told by the wait.
  if (
    state === undefined ||
    record.final ||
    (state === "completed" && as.held)
  ) {
    return undefined;
  }
  return { ...common, state, attempt };
};

/** The entry an event of a rollback step gives, if any. */
const compensationOf = (
  record: ReadableHistoryRecord,
  as: Told,
  context: Context
): RunHistoryEntry | undefined => {
  const common = {
    ...commonOf(record, as.taskId),
    kind: "compensation" as const,
    stepId: as.stepId,
    attempt: Math.max(1, record.attempt ?? 1),
  };
  if (record.type === "rollback_step_errored") {
    return {
      ...common,
      state: "failed",
      error: errorShown(record.error, context),
    };
  }
  const state = compensationStates[record.type];
  // A rollback's last failure is told once, as the rollback's.
  return state === undefined || record.final ? undefined : { ...common, state };
};

type WaitKind = Extract<RunHistoryEntry, { kind: "wait" }>["waitKind"];

/** The entry an event of a sleep or an event wait gives, if any. */
const waitOf = (
  record: ReadableHistoryRecord,
  as: { taskId: string | null; waitId: string; waitKind: WaitKind }
): RunHistoryEntry | undefined => {
  const state = waitStates[record.type];
  if (state === undefined) {
    return undefined;
  }
  // A sleep's length is fixed as it starts; an event wait's deadline
  // moves when a paused run resumes, so none is told.
  const deadline =
    record.type === "sleep_started" && record.durationMs !== null
      ? record.at + record.durationMs
      : null;
  return {
    ...commonOf(record, as.taskId),
    kind: "wait",
    ...as,
    state,
    deadline,
  };
};

/** The entry an event of one of core's own steps gives, if any. */
const coreStepOf = (
  record: ReadableHistoryRecord,
  step: NonNullable<ReadableHistoryRecord["step"]>,
  context: Context
): RunHistoryEntry | undefined => {
  // A decision's wait again, after a wake that answered nothing: the
  // same decision's wait, as its first is.
  const decision =
    step.kind === "waitForEvent" && step.eventType !== null
      ? decisionOfEventType(step.eventType)
      : undefined;
  if (decision !== undefined) {
    return waitOf(record, {
      taskId: null,
      waitId: decision,
      waitKind: "decision",
    });
  }
  const parts = heldStep.exec(step.name)?.groups;
  const held =
    parts?.key === undefined ? undefined : context.heldByKey.get(parts.key);
  if (parts === undefined || held === undefined) {
    return undefined;
  }
  const round = Number(parts.round);
  const told = {
    stepId: `step-${held.ordinal}`,
    taskId: reviewedTaskOf(context.reviewed, held.name),
  };
  if (parts.rest === "run" && step.kind === "do") {
    let offset = held.attempts;
    for (const [earlier, attempts] of held.rounds) {
      if (earlier < round) {
        offset += attempts;
      }
    }
    return stepOf(
      record,
      { ...told, offset, held: held.rounds.has(round + 1) },
      context
    );
  }
  // Its waits for the person: event waits their decision wakes, with
  // checks between (host.ts, `#waitWhileHeld`), and an unknown outcome's
  // first sleep.
  if (step.kind === "sleep" || step.kind === "waitForEvent") {
    return waitOf(record, {
      taskId: told.taskId,
      waitId: told.stepId,
      waitKind: "blocked",
    });
  }
  return undefined;
};

/** What a wait waits for: time, a decision, or another event. */
const waitKindOf = (
  step: NonNullable<ReadableHistoryRecord["step"]>,
  decision: string | undefined
): WaitKind => {
  if (step.kind === "sleep") {
    return "timer";
  }
  return decision === undefined ? "event" : "decision";
};

/** The entry `record` gives the page, or none for what it leaves out. */
const entryOf = (
  record: HistoryRecord,
  context: Context
): RunHistoryEntry | undefined => {
  if (record.unreadable) {
    return { ...commonOf(record, null), kind: "unreadable" };
  }
  const { step } = record;
  if (step === null) {
    return lifecycleOf(record);
  }
  if (step.name.startsWith("$")) {
    return coreStepOf(record, step, context);
  }
  const told = {
    stepId: `step-${step.ordinal}`,
    taskId: reviewedTaskOf(context.reviewed, step.name),
  };
  if (step.kind === "do") {
    const held = context.heldByOrdinal.get(step.ordinal);
    return stepOf(
      record,
      { ...told, offset: 0, held: held?.rounds.has(1) === true },
      context
    );
  }
  if (step.kind === "rollback") {
    return compensationOf(record, told, context);
  }
  const decision =
    step.eventType === null ? undefined : decisionOfEventType(step.eventType);
  return waitOf(record, {
    taskId: told.taskId,
    waitId: decision ?? told.stepId,
    waitKind: waitKindOf(step, decision),
  });
};

type RunStub = ReturnType<typeof runObjectOf>;

/** Core's wait steps, a held step's runs again among them. */
const coreWaits: StepIdentitiesQuery = { kind: null, prefix: waitStepPrefix };

/** Every `do` step, to find which a held step's runs again are of. */
const doSteps: StepIdentitiesQuery = { kind: "do", prefix: null };

/** The rounds of runs again core's wait steps `waits` tell of, by key. */
const roundsIn = (
  waits: readonly StepIdentity[]
): Map<string, Map<number, number>> => {
  const rounds = new Map<string, Map<number, number>>();
  for (const wait of waits) {
    const parts = heldStep.exec(wait.name)?.groups;
    if (parts?.key !== undefined) {
      const ofKey = rounds.get(parts.key) ?? new Map<number, number>();
      const round = Number(parts.round);
      const attempts =
        parts.rest === "run" && wait.kind === "do" ? wait.attempt : 0;
      ofKey.set(round, Math.max(ofKey.get(round) ?? 0, attempts));
      rounds.set(parts.key, ofKey);
    }
  }
  return rounds;
};

/**
 * The steps of `steps` whose side effect was held, by the key core named
 * their runs again by (`waitKeyOf`), with their rounds (`rounds`).
 */
const heldOf = async (
  steps: readonly StepIdentity[],
  rounds: ReadonlyMap<string, Map<number, number>>
): Promise<Map<string, HeldStep>> => {
  const held = new Map<string, HeldStep>();
  for (const step of steps) {
    if (!step.name.startsWith("$")) {
      // oxlint-disable-next-line no-await-in-loop -- a digest each, of names alone
      const key = await waitKeyOf(step.name);
      const ofKey = rounds.get(key);
      if (ofKey !== undefined) {
        held.set(key, {
          ordinal: step.ordinal,
          name: step.name,
          attempts: step.attempt,
          rounds: ofKey,
        });
      }
    }
  }
  return held;
};

/**
 * One read of the run's history after `after`, with the held steps it is
 * told against, both of one moment: the engine reads the page and the
 * steps asked for in one synchronous turn (`history`). A step held
 * between two separate reads would otherwise show its held end as a
 * completion. Core's wait steps come with every read; every `do` step
 * only for a run whose waits show a step was held, read again then with
 * its page, so the two still stand together.
 */
const readWithHeld = async (
  stub: RunStub,
  after: number,
  limit: number
): Promise<
  | {
      records: readonly HistoryRecord[];
      more: boolean;
      held: Map<string, HeldStep>;
    }
  | undefined
> => {
  const page = await stub.history({ after, limit, steps: [coreWaits] });
  if (page === undefined) {
    return undefined;
  }
  if (roundsIn(page.steps[0] ?? []).size === 0) {
    return { records: page.records, more: page.more, held: new Map() };
  }
  const withSteps = await stub.history({
    after,
    limit,
    steps: [coreWaits, doSteps],
  });
  if (withSteps === undefined) {
    return undefined;
  }
  const [waits = [], steps = []] = withSteps.steps;
  return {
    records: withSteps.records,
    more: withSteps.more,
    held: await heldOf(steps, roundsIn(waits)),
  };
};

/**
 * What the run's version's review shows of its workflow; none when the
 * version keeps none (or is gone), and then no step is named.
 */
const reviewedOf = async (
  env: Env,
  row: RunRow
): Promise<WorkflowCalls | undefined> => {
  try {
    return await callsFor(env, {
      app: appIdSchema.parse(row.appId),
      version: row.version,
      workflow: workflowIdSchema.parse(row.workflowId),
    });
  } catch (error) {
    if (
      workflowErrors.codeOf(error) === "workflow.calls_not_kept" ||
      appErrors.codeOf(error) === "app.version_not_found"
    ) {
      return undefined;
    }
    throw error;
  }
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
  const stub = runObjectOf(env, row.id);
  const sees = seesDetails(by, row, owner);
  const reviewed = await reviewedOf(env, row);
  const { pageSize, cursor } = query.data;
  const limit = Math.min(maxRecordsPerRead, pageSize * 4);
  const items: RunHistoryEntry[] = [];
  let after = cursor === null ? 0 : Number(cursor);
  let more = true;
  for (
    let read = 0;
    read < maxReads && more && items.length < pageSize;
    read += 1
  ) {
    // oxlint-disable-next-line no-await-in-loop -- each read goes on from the one before
    const page = await readWithHeld(stub, after, limit);
    if (page === undefined) {
      // The engine has no record of it: still starting, or never started.
      return done;
    }
    // Each read is told against the held steps of its own moment.
    const context: Context = {
      sees,
      reviewed,
      heldByKey: page.held,
      heldByOrdinal: new Map(
        [...page.held.values()].map((step) => [step.ordinal, step])
      ),
    };
    const { records, more: followed } = page;
    more = followed;
    for (const record of records) {
      if (items.length === pageSize) {
        more = true;
        break;
      }
      after = record.eventId;
      const entry = entryOf(record, context);
      if (entry !== undefined) {
        items.push(entry);
      }
    }
  }
  return more
    ? { items, nextCursor: String(after), hasMore: true }
    : { items, nextCursor: null, hasMore: false };
};
