import { isExpectedCode } from "@grasp-os/shared/errors";
import { workflowErrors } from "@grasp-os/shared/workflows";
import type {
  RunHistoryEntry,
  RunHistoryError,
} from "@grasp-os/shared/workflows";
import type { WorkflowError } from "@grasp-os/workerflow/contracts";
import type {
  ReadableHistoryRecord,
  HistoryRecord,
  StepIdentitiesQuery,
  StepIdentity,
} from "@grasp-os/workerflow/run";

import { decisionOfEventType } from "../decisions/decisions.ts";
import { runObjectOf } from "./engine.ts";
import { waitKeyOf, waitStepPrefix } from "./host.ts";

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
// name its version's build names (`taskOf`), without the key an
// engine name adds (`name:key`, from the run's data); any other name can
// be made of what the run read, so its entries name no task, and the
// opaque `stepId` alone tells the step. A failure's message is the
// workflow's own text, which can hold what the run read, so only those
// who see the run's details (`seesDetails`: admins, and the person it
// acts for) read it, with the error's own code; anyone else reads a
// code the platform defines as it is (`isExpectedCode`), any other as
// `workflow.step_failed`, and
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
// the waits between them as `blocked` waits of it (`outcome_unknown` for
// an unknown outcome's, which its person resolves), while its held end is
// no completion. A sealed run's step its catch's retry policy runs again
// (`$grasp:wait:<key>:retry:<round>:…`) is told so too: each round's run
// more attempts of the step, a round's failure the retry follows as
// `retrying`, and the backoff before it as a `timer` wait of the step; a
// round's own held rounds are the step's as well. Core's other steps (named `$…`: the parameters, a
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

/**
 * One of core's steps of a round of a step (host.ts, `waitStep`): a held
 * step's run again, a wait between them or a check of it; or a retry's
 * decision, backoff or run again.
 */
const roundStep =
  /^\$grasp:wait:(?<key>[0-9a-f]{16}):(?<kind>held|unknown|retry):(?<round>[1-9]\d*):(?<rest>.+)$/u;

/** A step of a round, as `roundStep` reads its name. */
interface RoundName {
  /** The key of the step it is a round of (`waitKeyOf`). */
  key: string;
  kind: "held" | "unknown" | "retry";
  round: number;
  rest: string;
}

const roundOf = (name: string): RoundName | undefined => {
  const parts = roundStep.exec(name)?.groups;
  if (
    parts?.key === undefined ||
    parts.round === undefined ||
    parts.rest === undefined
  ) {
    return undefined;
  }
  const kind =
    parts.kind === "retry" || parts.kind === "unknown" ? parts.kind : "held";
  return { key: parts.key, kind, round: Number(parts.round), rest: parts.rest };
};

/** A step run again in rounds of core's, and those runs. */
interface RoundedStep {
  ordinal: number;
  name: string;
  /** Its key (`waitKeyOf`), which its own held rounds go by. */
  key: string;
  /** Its own attempts. */
  attempts: number;
  /** Each run again of it, by its ordinal: how many attempts it took. */
  runs: Map<number, number>;
  /** The ordinals of its retries' backoffs and runs: each follows a failed round. */
  retries: number[];
}

/** How a page tells a run's steps. */
interface Context {
  /** Whether the person sees the run's details. */
  sees: boolean;
  /**
   * The task an engine step name is, as its version names it; null for a
   * name it doesn't.
   */
  taskOf: (engineStep: string) => string | null;
  /**
   * The run's steps run again, by the key core's steps of their rounds
   * name them by: their own, and each retry's run's (whose held rounds
   * are the step's too).
   */
  roundedByKey: ReadonlyMap<string, RoundedStep>;
  /** The same, by the step's own ordinal. */
  roundedByOrdinal: ReadonlyMap<number, RoundedStep>;
  /** Each held round there is (`<key>:<round>`), of an unknown outcome too. */
  heldRounds: ReadonlySet<string>;
  /** The key of each retry's run, by its ordinal (`waitKeyOf`). */
  retryKeys: ReadonlyMap<number, string>;
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
    // Only a code the platform defines: one merely in its namespaces can
    // still be made of what the run read.
    code: isExpectedCode(code) ? code : "workflow.step_failed",
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
  /** A retry runs it again after its failure, so it is no failure. */
  retried: boolean;
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
  if (record.type === "step_errored" && as.retried) {
    return { ...common, state: "retrying", attempt };
  }
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

/**
 * Whether a retry of `rounded` runs after its run at `ordinal`: told from
 * the retry's backoff or its run. While its decision is still being made
 * (or after one with no backoff, until its run starts), the round reads
 * as failed, as a held step's completion reads until its hold is
 * journaled; the decision's own record can't tell, as it records no
 * retry it declined differently.
 */
const retriedAfter = (rounded: RoundedStep, ordinal: number): boolean =>
  rounded.retries.some((retry) => retry > ordinal);

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
  const round = roundOf(step.name);
  const rounded =
    round === undefined ? undefined : context.roundedByKey.get(round.key);
  if (round === undefined || rounded === undefined) {
    return undefined;
  }
  const told = {
    stepId: `step-${rounded.ordinal}`,
    taskId: context.taskOf(rounded.name),
  };
  if (round.rest === "run" && step.kind === "do") {
    let offset = rounded.attempts;
    for (const [earlier, attempts] of rounded.runs) {
      if (earlier < step.ordinal) {
        offset += attempts;
      }
    }
    // A retry's run is held in rounds of its own key, a held round's in
    // the next round of its step's.
    const held =
      round.kind === "retry"
        ? context.heldRounds.has(`${context.retryKeys.get(step.ordinal)}:1`)
        : context.heldRounds.has(`${round.key}:${round.round + 1}`);
    return stepOf(
      record,
      { ...told, offset, held, retried: retriedAfter(rounded, step.ordinal) },
      context
    );
  }
  if (round.kind === "retry") {
    // Its backoff: a wait of the step's time. Its decision tells nothing.
    return round.rest === "wait" && step.kind === "sleep"
      ? waitOf(record, {
          taskId: told.taskId,
          waitId: told.stepId,
          waitKind: "timer",
        })
      : undefined;
  }
  // Its waits for the person: event waits their decision wakes, with
  // checks between (host.ts, `#waitWhileHeld`), and an unknown outcome's
  // first sleep.
  if (step.kind === "sleep" || step.kind === "waitForEvent") {
    return waitOf(record, {
      taskId: told.taskId,
      waitId: told.stepId,
      waitKind: round.kind === "unknown" ? "outcome_unknown" : "blocked",
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
    taskId: context.taskOf(step.name),
  };
  if (step.kind === "do") {
    const rounded = context.roundedByOrdinal.get(step.ordinal);
    return stepOf(
      record,
      {
        ...told,
        offset: 0,
        held:
          rounded !== undefined && context.heldRounds.has(`${rounded.key}:1`),
        retried: rounded !== undefined && retriedAfter(rounded, step.ordinal),
      },
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

/** How a read's records are told: `Context`'s own parts but the person's. */
type Rounds = Omit<Context, keyof HistoryTelling>;

/** No step run again. */
const noRounds: Rounds = {
  roundedByKey: new Map(),
  roundedByOrdinal: new Map(),
  heldRounds: new Set(),
  retryKeys: new Map(),
};

/** Whether core's wait steps `waits` hold any round of a step's. */
const anyRounds = (waits: readonly StepIdentity[]): boolean =>
  waits.some((wait) => roundOf(wait.name) !== undefined);

/**
 * The steps of `steps` run again in rounds core's wait steps `waits` tell
 * of, by the key core named their rounds by (`waitKeyOf`): a step's own,
 * and each of its retries' runs', whose held rounds are its too.
 */
const roundsOf = async (
  waits: readonly StepIdentity[],
  steps: readonly StepIdentity[]
): Promise<Rounds> => {
  const rounds = waits.flatMap((wait) => {
    const round = roundOf(wait.name);
    return round === undefined ? [] : [{ ...round, wait }];
  });
  const keys = new Set(rounds.map(({ key }) => key));
  const roundedByKey = new Map<string, RoundedStep>();
  const roundedByOrdinal = new Map<number, RoundedStep>();
  for (const step of steps) {
    if (!step.name.startsWith("$")) {
      // oxlint-disable-next-line no-await-in-loop -- a digest each, of names alone
      const key = await waitKeyOf(step.name);
      if (keys.has(key)) {
        const rounded: RoundedStep = {
          ordinal: step.ordinal,
          name: step.name,
          key,
          attempts: step.attempt,
          runs: new Map(),
          retries: [],
        };
        roundedByKey.set(key, rounded);
        roundedByOrdinal.set(step.ordinal, rounded);
      }
    }
  }
  // A retry's run goes by its step's key; a held round's by the key of
  // what it held, a retry's run's included, so retries come first.
  const retryKeys = new Map<number, string>();
  const ordered = rounds.toSorted(
    (a, b) => Number(b.kind === "retry") - Number(a.kind === "retry")
  );
  for (const { key, kind, rest, wait } of ordered) {
    const rounded = roundedByKey.get(key);
    // A retry's backoff starts it: its round's failure is retried from
    // then, though its run comes only once the backoff is over.
    if (rounded !== undefined && kind === "retry" && rest === "wait") {
      rounded.retries.push(wait.ordinal);
    }
    if (rounded !== undefined && rest === "run" && wait.kind === "do") {
      rounded.runs.set(wait.ordinal, wait.attempt);
      if (kind === "retry") {
        rounded.retries.push(wait.ordinal);
        // oxlint-disable-next-line no-await-in-loop -- a digest each, of names alone
        const own = await waitKeyOf(wait.name);
        retryKeys.set(wait.ordinal, own);
        roundedByKey.set(own, rounded);
      }
    }
  }
  return {
    roundedByKey,
    roundedByOrdinal,
    heldRounds: new Set(
      rounds.flatMap(({ key, kind, round }) =>
        kind === "retry" ? [] : [`${key}:${round}`]
      )
    ),
    retryKeys,
  };
};

/**
 * One read of the run's history after `after`, with the steps run again it
 * is told against, both of one moment: the engine reads the page and the
 * steps asked for in one synchronous turn (`history`). A step held
 * between two separate reads would otherwise show its held end as a
 * completion. Core's wait steps come with every read; every `do` step
 * only for a run whose waits show a step was run again, read again then
 * with its page, so the two still stand together.
 */
const readWithRounds = async (
  stub: RunStub,
  after: number,
  limit: number
): Promise<
  | {
      records: readonly HistoryRecord[];
      more: boolean;
      waits: readonly StepIdentity[];
      steps: readonly StepIdentity[];
    }
  | undefined
> => {
  const page = await stub.history({ after, limit, steps: [coreWaits] });
  if (page === undefined) {
    return undefined;
  }
  if (!anyRounds(page.steps[0] ?? [])) {
    return { records: page.records, more: page.more, waits: [], steps: [] };
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
  return { records: withSteps.records, more: withSteps.more, waits, steps };
};

/**
 * How one read's records are told as `telling` says, against the steps
 * run again its core wait steps (`waits`) and its `do` steps (`steps`),
 * both of the read's own moment, tell of: each record's entry, or none
 * for what a page leaves out.
 */
export const historyTeller = async (
  {
    waits,
    steps,
  }: {
    waits: readonly StepIdentity[];
    steps: readonly StepIdentity[];
  },
  telling: HistoryTelling
): Promise<(record: HistoryRecord) => RunHistoryEntry | undefined> => {
  const context: Context = {
    ...telling,
    ...(anyRounds(waits) ? await roundsOf(waits, steps) : noRounds),
  };
  return (record) => entryOf(record, context);
};

/** How a page of a run's history tells its steps: `Context`'s own two. */
export interface HistoryTelling {
  readonly sees: boolean;
  readonly taskOf: (engineStep: string) => string | null;
}

/** A page of a run's history entries, and where the next one starts. */
export interface HistoryEntries {
  readonly items: readonly RunHistoryEntry[];
  /** The engine event ID the page ended at, when more follow. */
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/**
 * Up to `pageSize` entries of run `id`'s history after engine event
 * `after`, oldest first, told as `telling` says, from at most `maxReads`
 * reads of its engine journal. Empty for a run the engine has no record
 * of: still starting, or never started. Who may read it is the caller's
 * to have checked.
 */
export const historyEntries = async (
  env: Env,
  id: string,
  { after: from, pageSize }: { after: number; pageSize: number },
  telling: HistoryTelling
): Promise<HistoryEntries> => {
  const done: HistoryEntries = { items: [], nextCursor: null, hasMore: false };
  const stub = runObjectOf(env, id);
  const limit = Math.min(maxRecordsPerRead, pageSize * 4);
  const items: RunHistoryEntry[] = [];
  let after = from;
  let more = true;
  for (
    let read = 0;
    read < maxReads && more && items.length < pageSize;
    read += 1
  ) {
    // oxlint-disable-next-line no-await-in-loop -- each read goes on from the one before
    const page = await readWithRounds(stub, after, limit);
    if (page === undefined) {
      // The engine has no record of it: still starting, or never started.
      return done;
    }
    // Each read is told against the steps run again of its own moment.
    // oxlint-disable-next-line no-await-in-loop -- each read is told as it is read
    const tell = await historyTeller(page, telling);
    const { records, more: followed } = page;
    more = followed;
    for (const record of records) {
      if (items.length === pageSize) {
        more = true;
        break;
      }
      after = record.eventId;
      const entry = tell(record);
      if (entry !== undefined) {
        items.push(entry);
      }
    }
  }
  return more
    ? { items, nextCursor: String(after), hasMore: true }
    : { items, nextCursor: null, hasMore: false };
};
