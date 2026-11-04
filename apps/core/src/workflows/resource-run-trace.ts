import { workflowDiagram } from "@grasp-os/open-workflow/diagram";
import { isExpectedCode } from "@grasp-os/shared/errors";
import { errorFields, log } from "@grasp-os/shared/log";
import type {
  TraceState,
  TraceStep,
  WorkflowRunTrace,
} from "@grasp-os/shared/workflow-diagrams";
import {
  workflowResourceErrors,
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
import type { LoadedBuild } from "../workflow-builds.ts";
import { loadWorkflowBuild } from "../workflow-builds.ts";
import { withDoors } from "../workflow-doors.ts";
import {
  requireWorkflowRole,
  workflowDefinition,
} from "../workflow-resources.ts";
import { runObjectOf } from "./engine.ts";
import { waitKeyOf, waitStepPrefix } from "./host.ts";
import { resourceRunFor } from "./resource-runs.ts";
import { detailsRemoved } from "./retention.ts";
import { sealedStepOf, sealedStepsOf } from "./sealed-steps.ts";
import type { SealedSteps } from "./sealed-steps.ts";

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
// A run of a build generated for the run host (sealed-run.ts) names a
// task's steps `<task>:<kind>`, a loop item's indices after `@`, each
// placed by its build's table of tasks (sealed-steps.ts): a catch's retry
// and a held call read as above, under core's prefix by the step's key;
// a decision task's step opens its decision, then asks and waits in the
// SDK's steps past it (`<task>:task#ask`, `#asked`, `#answer`) and
// core's by that wait's key (`$grasp:wait:<key>:reached|woken|again`,
// host.ts, `waitForDecision`): the task's step, waiting until its outcome
// (`…:outcome`) is recorded, reached then.
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
 * name's key; and a call connect held for its person (`held`) or on an
 * unknown outcome (`unknown`, host.ts, `#waitWhileHeld`): when it was
 * first held, its first wait, its checks, its waits between them and its
 * record of waiting, then its run again (`:run`).
 */
const coreWait = new RegExp(
  `^${waitStepPrefix.replaceAll("$", "\\$")}(?<key>[0-9a-f]{16}):(?:(?:busy|key):\\d+(?<rest>:waiting|:run|:timed_out)?|(?:held|unknown):\\d+(?<held>:since|:first|:\\d+(?::check)?|:waiting:held|:run)|retry:[1-9]\\d*:(?<retry>decide|wait|run))$`,
  "u"
);

/**
 * One of core's steps of a decision's wait on the run host, by the wait's
 * key (host.ts, `waitForDecision`): its looks and its waits again, then
 * the outcome it records.
 */
const decisionWait = new RegExp(
  `^${waitStepPrefix.replaceAll("$", "\\$")}(?<key>[0-9a-f]{16}):(?:reached|woken:\\d+|again:[1-9]\\d*|(?<outcome>outcome))$`,
  "u"
);

/** A decision's own steps past its task step on the run host (the SDK's). */
const sealedDecisionPart = /^#(?:ask|asked|answer)$/u;

/**
 * The wait a decision's ask leads to (the SDK's): core's steps of it go by
 * its key from the first, a look that may find it answered before it is
 * ever reached. A sealed decision has no reminder (sealed-run.ts).
 */
const answerAfter: Readonly<Record<string, string>> = { "#ask": "#answer" };

/**
 * What a step is of the task step it is part of: a round of it (its own
 * attempts, a retry's, or a held call's run again), a retry's backoff,
 * its decision's wait, its held call's wait for its person, or, on the
 * run host, its decision's recorded outcome.
 */
type Role = "round" | "backoff" | "decision" | "held" | "outcome";

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
 * name (`base`, past which the host may add to it) or one of core's waits
 * of a round of it, by the round's key (`waitKeyOf` of its name).
 */
type Place =
  | {
      kind: "task";
      base: string;
      task: string;
      item: string | null;
      role: Role;
      /** Whether it starts a task step of its name anew once one ran. */
      starts: boolean;
      /**
       * The steps by whose keys core names its waits of this task step
       * (`waitKeyOf`): its own, or the decision wait it leads to.
       */
      keys: readonly string[];
    }
  | {
      kind: "wait";
      key: string;
      role: Role;
      /** A retry's run again, whose own waits go by its name's key. */
      keyed: boolean;
    };

/**
 * Where engine step `name` of a run on the run host stands, if it is part
 * of a task's step: one its build's table places (`steps`), or one of
 * core's steps of its decision's wait.
 */
const sealedPlaceOf = (name: string, steps: SealedSteps): Place | undefined => {
  const decided = decisionWait.exec(name)?.groups;
  if (decided?.key !== undefined) {
    return {
      kind: "wait",
      key: decided.key,
      role: decided.outcome === undefined ? "decision" : "outcome",
      keyed: false,
    };
  }
  const step = sealedStepOf(name, steps);
  if (step === undefined) {
    return undefined;
  }
  const own = step.part === "";
  if (!(own || sealedDecisionPart.test(step.part))) {
    return undefined;
  }
  // A decision's steps come after its task step's own, which opened it.
  const answer = answerAfter[step.part];
  const ownName = name.slice(0, name.length - step.part.length);
  return {
    kind: "task",
    base: `${step.task}:${step.kind}:${step.item ?? ""}`,
    task: step.task,
    item: step.item,
    role: own ? "round" : "decision",
    starts: own,
    keys: answer === undefined ? [name] : [`${ownName}${answer}`],
  };
};

/**
 * Where engine step `name` of a run of resource-host.ts stands, if it is
 * part of a task's step: one of its task's own name.
 */
const namedPlaceOf = (name: string): Place | undefined => {
  const named = stepName.exec(unprefixed(name))?.groups;
  const part = named?.part ?? "";
  const role = roleOf(part);
  if (named?.base === undefined || named.task === undefined || !role) {
    return undefined;
  }
  // A decision's wait comes before its own step, the rest after it.
  const own = role === "round" && part === "";
  return {
    kind: "task",
    base: named.base,
    task: named.task,
    item: named.item ?? null,
    role,
    starts: own || role === "decision",
    // A round's waits for its turn or its AI provider are named by its key.
    keys: role === "round" && !part.includes(":held:") ? [name] : [],
  };
};

/**
 * Where engine step `name` stands, if it is part of a task's step: for a
 * run on the run host, as its build's table places it (`steps`).
 */
const placeOf = (name: string, steps?: SealedSteps): Place | undefined => {
  const waited = coreWait.exec(name)?.groups;
  if (waited?.key === undefined) {
    return steps === undefined
      ? namedPlaceOf(name)
      : sealedPlaceOf(name, steps);
  }
  const { key, retry, held } = waited;
  if (held !== undefined) {
    // Waiting for its person, or its outcome, until it runs again (an
    // attempt more of the step), unless a check fails it.
    return {
      kind: "wait",
      key,
      role: held === ":run" ? "round" : "held",
      keyed: false,
    };
  }
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
  } else if (role === "outcome") {
    state = stateAfter[record.type] ?? known.state;
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
  // the task step it is of (`Place.starts`).
  const own = place.role === "round" && place.starts;
  const latest = reading.current.get(place.base);
  let into = latest;
  if (into === undefined || (place.starts && into.own)) {
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
  for (const keyed of place.keys) {
    // oxlint-disable-next-line no-await-in-loop -- a digest each, of names alone
    reading.byKey.set(await waitKeyOf(keyed), into);
  }
  return into;
};

/** Folds `record` into the task step it is part of, if any (`placed`). */
const foldRecord = async (
  reading: Reading,
  record: HistoryRecord,
  steps: SealedSteps | undefined
): Promise<void> => {
  if (record.unreadable || record.step === null) {
    return;
  }
  const place = placeOf(record.step.name, steps);
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
 * order the run reached them (`steps`): for a run on the run host, as its
 * build's table of tasks places them (`sealed`, `sealedStepsOf`).
 */
export const traceReading = (
  sealed?: SealedSteps
): {
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
      await foldRecord(reading, record, sealed);
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
 * run's, against the build it runs (`build`), which tells how it names
 * its steps (`sealedStepsOf`).
 */
export const tracedSteps = async (
  env: Env,
  id: string,
  build: () => Promise<LoadedBuild>
): Promise<TracedSteps> => {
  const stub = runObjectOf(env, id);
  let sealed: SealedSteps | undefined;
  try {
    sealed = sealedStepsOf(await build());
  } catch (error) {
    // Logged where it loads (workflow-builds.ts): read as a build of
    // resource-host.ts names its steps, so a run on the run host shows none.
    log.error("workflow.trace_build_unreadable", {
      runId: id,
      ...errorFields(error),
    });
  }
  const reading = traceReading(sealed);
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
  runId: unknown,
  options?: unknown
): Promise<WorkflowRunTrace> => {
  const { doors } = workflowResourceErrors.parse(
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
      truncated: false,
      detailsRemoved: true,
    };
  }
  const { steps, truncated } = await tracedSteps(
    env,
    run.id,
    async () => await loadWorkflowBuild(env, workflow.id, run.version)
  );
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
