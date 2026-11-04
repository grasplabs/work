import { isExpectedCode } from "@grasp-os/shared/errors";
import type {
  TraceState,
  TraceStep,
  WorkflowRunTrace,
} from "@grasp-os/shared/workflow-diagrams";
import { decisionPollStepPrefix } from "@grasp-os/shared/workflows";
import type {
  HistoryRecord,
  ReadableHistoryRecord,
} from "@grasp-os/workerflow/run";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { Acting } from "../auth/identity.ts";
import { workflowStartReceipts } from "../db/core/schema.ts";
import { workflowDiagram } from "../workflow-diagram.ts";
import {
  requireWorkflowRole,
  workflowDefinition,
} from "../workflow-resources.ts";
import { runObjectOf } from "./engine.ts";
import { waitKeyOf, waitStepPrefix } from "./host.ts";
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
//   step, waiting while it backs off, its state the latest round's; on the
//   run host, under core's prefix by the step's key
//   (`$grasp:wait:<key>:retry:<n>:run|wait|decide`, `coreWait`), read
//   alike;
// - a decision task's call step first waits for its decision: the host
//   asks and looks in steps of its own (`<step>:decision:<look>`) and
//   waits for the decision's wake under core's prefix
//   (`$grasp:decision:<step>:<wait|woken>:<round>`): the task's step,
//   waiting until the decision has its outcome, then as its call goes;
// - a call connect held for its person to confirm ends its round held:
//   the host checks and waits in steps of the round's
//   (`<step>:held:<n>:<check>:check`, `<step>:held:<n>:<check>`), then
//   runs the step again (`<step>:held:<n>:run`), `<step>` its own name or
//   a retry's: the task's step, waiting until its person decided, then
//   its run again an attempt more, reached once confirmed, or
//   failed once declined.
//
// Any other step adds nothing. A failure a catch took still shows as its
// task's: it happened. Each step is shown too, in the order the run
// reached it, with its loop item, attempts and times (GRA-513): a run's
// step detail. Records are metadata: no value of the run's reaches the
// trace, and a failure only by a code the platform defines. For the
// workflow's builders, who read its definitions.
//
// A trace reads the first `maxRecords` of the run's journal's records,
// and says so (`truncated`) when the journal holds more: the steps those
// records tell, each as far as they go.

/** The most records of a run's journal one trace reads. */
const maxRecords = 2000;

/** Records per history read, the engine's own most. */
const pageRecords = 500;

// A step of a task inside a loop names the item it runs in after `@`
// (`task:<id>@<for>.<index>/…`), and a loop's check of its `while` is an
// `item:` step: each item's steps count as their task's. What the host
// adds to a step's name, if anything, follows (`part`).
const stepName =
  /^(?<base>(?:task|enter|leave|item|catch):(?<task>[a-z][a-z0-9-]{0,63})(?:@(?<item>[a-z0-9./-]{1,600}))?)(?<part>(?::[a-z0-9]+)*)$/u;

/**
 * A retry's round of a step, or a held call's run again in one (of the
 * step's own round, or of a retry's).
 */
const retryRound = /^(?::retry:[1-9]\d*)?(?::held:[1-9]\d*:run)?$/u;

/** A held call's check, or its wait for its person, in a round. */
const heldWait = /^(?::retry:[1-9]\d*)?:held:[1-9]\d*:\d+(?::check)?$/u;
const retryBackoff = /^:retry:[1-9]\d*:wait$/u;

/** A decision task's look at its decision, or its wait for its wake. */
const decisionPart =
  /^:decision:(?:asked|remind|reminded|reached|outcome|(?:wait|woken):\d+)$/u;

/** A decision's wait or look as core names it, past `decisionPollStepPrefix`. */
const decisionPoll = /^(?<step>.+):(?<part>wait|woken):(?<round>\d+)$/u;

/**
 * One of core's waits of a round of a step (resource-host.ts, `#rounds`;
 * host.ts, `waitStep`), by the round's key: for its turn (`busy`) or its
 * AI provider (`key`), a record of waiting (`:waiting`), the round's run
 * again (`:run`), and a wait for its AI provider that ran out
 * (`:timed_out`), failed with the step's error. On the run host, a
 * catch's retry of the step (`retry`) too: its decision (`:decide`), its
 * backoff (`:wait`) and its run again (`:run`), whose own waits go by its
 * name's key.
 */
const coreWait = new RegExp(
  `^${waitStepPrefix.replaceAll("$", "\\$")}(?<key>[0-9a-f]{16}):(?:(?:busy|key):\\d+(?<rest>:waiting|:run|:timed_out)?|retry:[1-9]\\d*:(?<retry>decide|wait|run))$`,
  "u"
);

/**
 * What a step is of the task step it is part of: a round of it (its own
 * attempts, a retry's, or a held call's run again), a retry's backoff,
 * its decision's wait, or its held call's wait for its person.
 */
type Role = "round" | "backoff" | "decision" | "held";

/** The role of a step, by what the host added to its name (`part`). */
const roleOf = (part: string): Role | undefined => {
  if (retryRound.test(part)) {
    return "round";
  }
  if (retryBackoff.test(part)) {
    return "backoff";
  }
  if (heldWait.test(part)) {
    return "held";
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

/** The steps of tasks one trace read. */
interface TracedSteps {
  /** In the order the run reached them. */
  steps: TraceStep[];
  /** Whether the journal holds more records than one trace reads. */
  truncated: boolean;
}

/**
 * Where an engine step stands in a task's steps: a step of the task's own
 * name (`base`, its `part` what the host added) or one of core's waits of
 * a round of it, by the round's key (`waitKeyOf` of its name).
 */
type Place =
  | {
      kind: "task";
      base: string;
      task: string;
      item: string | null;
      part: string;
      role: Role;
    }
  | {
      kind: "wait";
      key: string;
      role: Role;
      /** A retry's run again, whose own waits go by its name's key. */
      keyed: boolean;
    };

/** Where engine step `name` stands, if it is part of a task's step. */
const placeOf = (name: string): Place | undefined => {
  const waited = coreWait.exec(name)?.groups;
  if (waited?.key !== undefined) {
    const { key, retry } = waited;
    if (retry !== undefined) {
      // A retry's run again is a round of the step, its backoff its own;
      // its decision tells nothing.
      if (retry === "decide") {
        return undefined;
      }
      const round = retry === "run";
      return {
        kind: "wait",
        key,
        role: round ? "round" : "backoff",
        keyed: round,
      };
    }
    // Its waits and a timed-out wait's failure tell the step's state; its
    // runs again are its attempts.
    return {
      kind: "wait",
      key,
      role: waited.rest === ":run" ? "round" : "held",
      keyed: false,
    };
  }
  const named = stepName.exec(unprefixed(name))?.groups;
  const part = named?.part ?? "";
  const role = roleOf(part);
  return named?.base === undefined || named.task === undefined || !role
    ? undefined
    : {
        kind: "task",
        base: named.base,
        task: named.task,
        item: named.item ?? null,
        part,
        role,
      };
};

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
    // Waiting for its decision until its call runs, or for its person, its
    // AI provider or its turn until it runs again, unless a check failed.
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

/** One trace's read of a run's journal: the task steps it folded. */
interface Reading {
  /** By their first engine step's ordinal. */
  readonly folded: Map<number, Folded>;
  /** The task step each engine step is part of. */
  readonly byOrdinal: Map<number, Folded>;
  /** The latest task step of each step name. */
  readonly current: Map<string, Folded>;
  /** The task step each round's waits are of, by the round's key. */
  readonly byKey: Map<string, Folded>;
}

/**
 * The task step engine step `ordinal`, first read in `record` at `place`,
 * is part of: one already folded, or a new one; undefined for a wait of a
 * round no record read.
 */
const placed = async (
  reading: Reading,
  record: ReadableHistoryRecord & { step: { ordinal: number; name: string } },
  place: Place
): Promise<Folded | undefined> => {
  if (place.kind === "wait") {
    const into = reading.byKey.get(place.key);
    if (into !== undefined && place.keyed) {
      reading.byKey.set(await waitKeyOf(record.step.name), into);
    }
    return into;
  }
  const { ordinal } = record.step;
  // A round of its own, a retry, a held call or a decision's wait goes on
  // the task step it is of: a decision's wait before its own step, its own
  // step after its decision's wait, the rest after its own step.
  const own = place.role === "round" && place.part === "";
  const starts = own || place.role === "decision";
  const latest = reading.current.get(place.base);
  let into = latest;
  if (into === undefined || (starts && into.own)) {
    into = {
      step: {
        ordinal,
        task: place.task,
        item: place.item,
        state: "running",
        attempts: 0,
        startedAt: new Date(record.at).toISOString(),
        endedAt: null,
        errorCode: null,
      },
      rounds: new Map(),
      own: false,
    };
    reading.folded.set(ordinal, into);
    reading.current.set(place.base, into);
  }
  into.own ||= own;
  // A round's waits for its turn or its AI provider are named by its key.
  if (place.role === "round" && !place.part.includes(":held:")) {
    reading.byKey.set(await waitKeyOf(record.step.name), into);
  }
  return into;
};

/** Folds `record` into the task step it is part of, if any (`placed`). */
const foldRecord = async (
  reading: Reading,
  record: HistoryRecord
): Promise<void> => {
  if (record.unreadable || record.step === null) {
    return;
  }
  const place = placeOf(record.step.name);
  if (place === undefined) {
    return;
  }
  const { ordinal } = record.step;
  const step = { ...record, step: record.step };
  let into = reading.byOrdinal.get(ordinal);
  if (into === undefined) {
    into = await placed(reading, step, place);
    if (into === undefined) {
      return;
    }
    reading.byOrdinal.set(ordinal, into);
  }
  fold(into, step, place.role);
};

/**
 * A read of a run's journal, record by record in the order it journaled
 * them (`fold`), and the steps of tasks those records tell so far, in the
 * order the run reached them (`steps`).
 */
export const traceReading = (): {
  fold: (record: HistoryRecord) => Promise<void>;
  steps: () => TraceStep[];
} => {
  const reading: Reading = {
    folded: new Map(),
    byOrdinal: new Map(),
    current: new Map(),
    byKey: new Map(),
  };
  return {
    fold: async (record) => {
      await foldRecord(reading, record);
    },
    // A step's ordinal is its place in the run.
    steps: () =>
      [...reading.folded.values()]
        .map(({ step }) => step)
        .toSorted((a, b) => a.ordinal - b.ordinal),
  };
};

/**
 * The steps of tasks that run `id`'s journal holds, in the order it
 * reached them, as far as its first `maxRecords` records tell, and whether
 * it holds more. Read from the engine's own history, so a test run's as a
 * run's.
 */
export const tracedSteps = async (
  env: Env,
  id: string
): Promise<TracedSteps> => {
  const stub = runObjectOf(env, id);
  const reading = traceReading();
  let after = 0;
  let read = 0;
  let more = true;
  while (more && read < maxRecords) {
    // oxlint-disable-next-line no-await-in-loop -- each read goes on from the one before
    const page = await stub.history({
      after,
      limit: Math.min(pageRecords, maxRecords - read),
    });
    if (page === undefined) {
      // Still starting: the engine has no record of it yet.
      return { steps: [], truncated: false };
    }
    ({ more } = page);
    // A page that says there is more but holds nothing would ask again
    // for the same page forever: what was read stands, as truncated.
    if (page.records.length === 0) {
      break;
    }
    for (const record of page.records) {
      read += 1;
      after = record.eventId;
      // oxlint-disable-next-line no-await-in-loop -- in the order the run journaled them
      await reading.fold(record);
    }
  }
  return { steps: reading.steps(), truncated: more };
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
  const diagram = workflowDiagram(definition);
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
      truncated: false,
      detailsRemoved: true,
    };
  }
  const { steps, truncated } = await tracedSteps(env, run.id);
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
    truncated,
    detailsRemoved: false,
    ...(run.aiProvider === undefined ? {} : { aiProvider: run.aiProvider }),
  };
};
