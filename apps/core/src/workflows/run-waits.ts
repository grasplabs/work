import { eventFingerprint } from "@grasp-os/sdk/host";
import type { BoundWorkflow } from "@grasp-os/sdk/host";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  coreStepPrefix,
  decisionPollStepPrefix,
} from "@grasp-os/shared/workflows";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { workflowDecisions, workflowResourceRuns } from "../db/core/schema.ts";
import {
  answerableByNow,
  decisionOfEventType,
  resourceDecisionPending,
} from "../decisions/decisions.ts";
import { loadWorkflowBuild } from "../workflow-builds.ts";
import { runObjectOf } from "./engine.ts";
import { waitKeyOf } from "./host.ts";
import { sealedStepOf, sealedStepsOf } from "./sealed-steps.ts";
import type { SealedSteps } from "./sealed-steps.ts";

// What an independent run waits on now, as its screens are shown it (spec
// 10.7.2), read from the engine's journal (workerflow's `pendingWaits`),
// never guessed from its definition or status. By the steps the run's
// host names (resource-host.ts), each of a task its version's sealed build
// declares, `<kind>:<task>` with the scope of a loop's item after `@`:
//
// - a timer: a `wait` task's sleep (`task:<task>`), or the backoff of a
//   retry of a task's step, or of one of core's steps of it (its held
//   call's run again, `…:held:<round>:run`; its decision's looks,
//   `…:decision:<look>`);
// - a hold of the platform's (`blocked`): a call connect held for the
//   person it acts for to confirm (`policy`: `…:held:<round>:<check>` and
//   its checks), once a round; or a step waiting for a share of what runs
//   at once (`quota`), as core's own steps of that are named
//   (`$grasp:wait:<key>:busy:<round>…`, host.ts), once a step;
// - a person's decision (its wait, `$grasp:decision:<task step>:wait:<round>`,
//   read as `<task step>:decision:wait:<round>`), by the decision's ID
//   its event names (decisions.ts, `decisionEventType`), as its key the
//   decision binding its task asks through, one the release sealed;
// - an event a listen task waits for (`task:<task>` of a listen task):
//   one wait for each event of the release's reference it listens for;
// - a child run a run task waits for (`task:<task>` of a run task): the
//   run's one child still under way, by its handle.
//
// A run of a build generated for the run host (sealed-run.ts) names its
// steps otherwise, `<task>:<kind>` with each loop's index after `@`
// (sealed-steps.ts), each placed by its build's table of tasks:
//
// - a timer: a wait task's sleep (`<task>:task`, a deadline's too), a
//   retry of any of a task's steps, or a catch's retry's backoff and its
//   rounds, under core's prefix by the retried step's key
//   (`$grasp:wait:<key>:retry:<round>:wait`, host.ts, `#retried`), of the
//   task whose step has that key in the run's journal;
// - a person's decision: its wait (`<task>:task#answer`, or
//   `#answer-after-reminder`, the SDK's), and its waits again under
//   core's prefix by that wait's key (`$grasp:wait:<key>:again:<round>`,
//   host.ts, `waitForDecision`), by the decision's ID its event names;
// - holds of the platform's, as above.
//
// What a wait shows is metadata only: a task's ID as its version's sealed
// build names it (a step of any other name is left out: it could be made
// of what the run read), its kind, its times, and what the release names
// (a decision's key, an event's alias); never a value of the run's. Whether
// a person may answer a decision here is the reference's to say
// (`canRespond` is false). Read after the run's row, whose revision a
// snapshot carries: a wait opened or closed since moves that revision on
// (resource-runs.ts, `projectResourceRun`), so the screen reads it again.

/** A decision wait, as `withRespond` reads one. */
const decisionWaitSchema = z
  .looseObject({ kind: z.literal("decision"), id: z.string() })
  .transform((wait) => ({ id: wait.id, wait }));

/** The most waits a snapshot lists, as the SDK reads them (`maxWaits`). */
const maxWaits = 256;

/**
 * A step of a task, as the run's host names it: its kind, its task's ID,
 * a loop item's scope, then what of the task it is (`rest`).
 */
const taskStep =
  /^(?:task|enter|leave|item):(?<id>[a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:@[a-z0-9.\-/]+)?(?<rest>(?::[a-z0-9]+)*)$/u;

/** What of a task a step is, past its name (`taskStep`'s `rest`). */
const heldWait = /^:held:(?<round>\d+):\d+$/u;
const heldCheck = /^:held:(?<round>\d+):\d+:check$/u;
const heldRun = /^:held:\d+:run$/u;
const decisionWait = /^:decision:wait:\d+$/u;
const decisionLook =
  /^:decision:(?:asked|remind|reminded|reached|outcome|woken:\d+)$/u;
/** A try's retry of a task's step: a round of it, and the backoff before one. */
const retryRound = /^:retry:\d+$/u;
const retryBackoff = /^:retry:\d+:wait$/u;
/**
 * A step of a retried round (resource-host.ts, `#retried`): core's own
 * steps of a held call or a decision in the round, `:retry:<round>` then
 * what they are as in a first round. The round's own steps (`retryRound`,
 * `retryBackoff`) are the retry's, not these.
 */
const retriedStep =
  /^:retry:(?<round>\d+)(?<inner>:(?:held|decision):[a-z0-9:]+)$/u;

/** The prefix of core's own steps of a wait (host.ts, `waitStepPrefix`). */
const waitPrefix = `${coreStepPrefix.replaceAll("$", "\\$")}wait:`;

/**
 * One of core's own steps a run waits in while it holds a step for load
 * (host.ts, `#waitBefore`): a round's sleep or wait (`<round>`), its first
 * wait (`<round>:first`), its waits between checks (`<round>:<check>`)
 * and its checks (`<round>:<check>:check`). Anchored at the end, so the
 * round's other steps (`:run`, the held step running again) are not the
 * hold: a retry of one is a retry (`retryOf`).
 */
const holdStep = new RegExp(
  `^${waitPrefix}(?<key>[0-9a-f]{16}):(?<kind>busy|held|unknown):\\d+(?::(?:first|\\d+(?::check)?))?$`,
  "u"
);

/** Any of core's own steps of a wait. */
const coreWaitStep = new RegExp(`^${waitPrefix}[0-9a-f]{16}:`, "u");

/** What each kind of hold is, as a screen reads it. */
const holds = {
  held: {
    reason: "policy",
    title: "Waiting for confirmation",
    message:
      "A call of this run waits for the person it acts for to confirm it.",
  },
  unknown: {
    reason: "uncertain",
    title: "Outcome unknown",
    message:
      "A call of this run may or may not have taken effect: it waits until that is known.",
  },
  busy: {
    reason: "quota",
    title: "Waiting for capacity",
    message: "A step of this run waits for its turn to run.",
  },
} as const;

/** A task its version's sealed build declares, as its waits read it. */
export interface WaitTask {
  readonly kind: string;
  /** A decision task's decision binding: its decisions' key. */
  readonly decision?: string;
  /** Its engine steps, and the loops around it (`SealedTask`). */
  readonly steps: readonly string[];
  readonly scope: readonly string[];
}

/** A pending wait as the engine lists it (workerflow's `PendingWait`). */
export interface Pending {
  readonly ordinal: number;
  readonly type: "sleep" | "waitForEvent" | "retry";
  readonly name: string;
  /** The event type a wait takes; null for a sleep, a retry or a match. */
  readonly eventType: string | null;
  readonly openedAt: number | null;
  readonly deadline: number | null;
}

/** What a run's waits are read against: its build and its release. */
export interface WaitContext {
  /** The tasks its version's sealed build declares, by ID. */
  readonly tasks: ReadonlyMap<string, WaitTask>;
  /** The decision keys the release sealed for the run's workflow. */
  readonly decisionKeys: ReadonlySet<string>;
  /** Its listen tasks, by ID, with the aliases of the events each takes. */
  readonly listens: Readonly<Record<string, readonly string[]>>;
  /** The release's events of the run's workflow: each alias's fingerprint. */
  readonly events: ReadonlyMap<string, string>;
  /** The run's one child still under way, if it has exactly one. */
  readonly child: Json | undefined;
  /** Whether the person may send the run its events now. */
  readonly canSend: boolean;
  /**
   * Whether its build was generated for the run host, which names its
   * steps by its table of tasks (sealed-steps.ts).
   */
  readonly sealed?: boolean;
  /**
   * For a run on the run host, the task of each of its journal's steps by
   * the key core names its own steps of it by (`waitKeyOf`): read only
   * while it waits in one of those a task's (`keyedWait`).
   */
  readonly keyed?: ReadonlyMap<string, string>;
}

/** A wait's fields: its ID, task, key and times. */
const fieldsOf = (
  id: string,
  task: string,
  key: string,
  title: string,
  wait: Pending
) => ({
  id,
  taskId: task,
  key,
  title,
  openedAt: wait.openedAt ?? 0,
  deadline: wait.deadline,
});

/** A hold of `kind`, of task `task` or, unnamed, of the run. */
const holdWait = (
  kind: keyof typeof holds,
  wait: Pending,
  task: string
): Json => {
  const shown = holds[kind];
  return {
    // By its place in the journal: never a name the run's code chose.
    ...fieldsOf(`hold-${wait.ordinal}`, task, task, shown.title, wait),
    kind: "blocked",
    reason: shown.reason,
    message: shown.message,
  };
};

/** A retry's backoff, of task `task` or, unnamed, of the run. */
const retryWait = (wait: Pending, task: string, title: string): Json => ({
  ...fieldsOf(`wait-${wait.ordinal}`, task, task, title, wait),
  kind: "timer",
  purpose: "retry",
});

/** A task's sleep, of task `id`. */
const sleepWait = (wait: Pending, id: string): Json => ({
  ...fieldsOf(`wait-${wait.ordinal}`, id, id, id, wait),
  kind: "timer",
  purpose: "sleep",
});

/**
 * The hold a held call's wait or check is, once a round (`holding`), of
 * the retried round `retry` names, if one.
 */
const heldOf = (
  wait: Pending,
  id: string,
  rest: string,
  holding: Set<string>,
  retry = ""
): Json[] | undefined => {
  const isWait = wait.type === "waitForEvent" && heldWait.test(rest);
  const isCheck = wait.type === "retry" && heldCheck.test(rest);
  if (!(isWait || isCheck)) {
    return undefined;
  }
  const round = (heldWait.exec(rest) ?? heldCheck.exec(rest))?.groups?.round;
  const once = `${id}${retry}:${round ?? ""}`;
  if (holding.has(once)) {
    return [];
  }
  holding.add(once);
  return [holdWait("held", wait, id)];
};

/** The timer a task's sleep or retry is, if it is one a screen reads. */
const timerOf = (wait: Pending, id: string, rest: string): Json[] => {
  if (wait.type === "retry") {
    return rest === "" ||
      heldRun.test(rest) ||
      decisionLook.test(rest) ||
      retryRound.test(rest)
      ? [retryWait(wait, id, id)]
      : [];
  }
  // A try's backoff before it runs a failed step again (resource-host.ts,
  // `#retried`): a retry, as the engine's own are.
  if (retryBackoff.test(rest)) {
    return wait.deadline === null ? [] : [retryWait(wait, id, id)];
  }
  return rest === "" && wait.deadline !== null ? [sleepWait(wait, id)] : [];
};

/** The decision a decision task's wait is, by the ID its event names. */
const decisionOf = (
  wait: Pending,
  id: string,
  task: WaitTask,
  context: WaitContext
): Json[] => {
  const decision =
    wait.eventType === null ? undefined : decisionOfEventType(wait.eventType);
  const key = task.decision;
  if (decision === undefined || key === undefined) {
    return [];
  }
  return context.decisionKeys.has(key)
    ? [
        {
          ...fieldsOf(decision, id, key, id, wait),
          kind: "decision",
          // Whether its viewer may answer it is theirs (`withRespond`).
          canRespond: false,
        },
      ]
    : [];
};

/** The child or events a run or listen task's own wait waits for. */
const awaitedOf = (
  wait: Pending,
  id: string,
  task: WaitTask,
  context: WaitContext
): Json[] => {
  if (task.kind === "run") {
    return context.child === undefined
      ? []
      : [
          {
            ...fieldsOf(`wait-${wait.ordinal}`, id, id, id, wait),
            kind: "child",
            child: context.child,
          },
        ];
  }
  if (task.kind !== "listen") {
    return [];
  }
  return (context.listens[id] ?? []).flatMap((alias, index) => {
    const fingerprint = context.events.get(alias);
    return fingerprint === undefined
      ? []
      : [
          {
            ...fieldsOf(`wait-${wait.ordinal}-${index}`, id, id, id, wait),
            kind: "event",
            event: { kind: "workflowEvent", alias, fingerprint },
            canSend: context.canSend,
          },
        ];
  });
};

/**
 * The waits one pending wait of a task's step is (`id`, its task; `rest`,
 * what of it the step is), each hold once (`holding`): none for one of
 * no kind a screen reads.
 */
const taskWaitsOf = (
  wait: Pending,
  id: string,
  rest: string,
  context: WaitContext,
  holding: Set<string>
): Json[] => {
  const task = context.tasks.get(id);
  if (task === undefined || wait.openedAt === null) {
    return [];
  }
  // A retried round's held call or decision reads as a first round's.
  const retried = retriedStep.exec(rest)?.groups;
  const step = retried?.inner ?? rest;
  const held = heldOf(
    wait,
    id,
    step,
    holding,
    retried === undefined ? "" : `:retry:${retried.round ?? ""}`
  );
  if (held !== undefined) {
    return held;
  }
  if (wait.type !== "waitForEvent") {
    return timerOf(wait, id, step);
  }
  if (decisionWait.test(step)) {
    return decisionOf(wait, id, task, context);
  }
  return rest === "" ? awaitedOf(wait, id, task, context) : [];
};

/**
 * The waits one pending wait of core's own steps of a wait for load is:
 * its hold, once a held step (`holding`); a retry of its step's run again;
 * none otherwise.
 */
const coreWaitsOf = (wait: Pending, holding: Set<string>): Json[] => {
  if (wait.openedAt === null) {
    return [];
  }
  const hold = holdStep.exec(wait.name)?.groups;
  if (
    hold?.key !== undefined &&
    (hold.kind === "busy" || hold.kind === "held" || hold.kind === "unknown")
  ) {
    if (holding.has(hold.key)) {
      return [];
    }
    holding.add(hold.key);
    return [holdWait(hold.kind, wait, "$run")];
  }
  return wait.type === "retry" &&
    coreWaitStep.test(wait.name) &&
    wait.deadline !== null
    ? [retryWait(wait, "$run", "Retrying a step")]
    : [];
};

/**
 * One of core's own steps of a task's step on the run host, by that
 * step's key (`waitKeyOf`): a catch's retry's decision, backoff or run
 * again (`retry:<round>:…`, host.ts, `#retried`), or a decision's wait
 * again (`again:<round>`, `waitForDecision`).
 */
const keyedWait = new RegExp(
  `^${waitPrefix}(?<key>[0-9a-f]{16}):(?:retry:[1-9]\\d*:(?<retry>decide|wait|run)|again:[1-9]\\d*)$`,
  "u"
);

/** A decision's wait for its answer, past its task step (the SDK's). */
const answerPart = /^#answer(?:-after-reminder)?$/u;

/**
 * The waits one pending wait of core's own steps of a task's step on the
 * run host is (`keyedWait`), of the task `context.keyed` names by its
 * key: a retry, its backoff's included, of the run if no task has that
 * key; a decision's wait again.
 */
const keyedWaitsOf = (
  wait: Pending,
  key: string,
  retry: string | undefined,
  context: WaitContext
): Json[] => {
  const id = context.keyed?.get(key);
  const task = id === undefined ? undefined : context.tasks.get(id);
  if (retry === undefined) {
    return id === undefined ||
      task === undefined ||
      wait.type !== "waitForEvent"
      ? []
      : decisionOf(wait, id, task, context);
  }
  const retrying =
    wait.type === "retry" || (wait.type === "sleep" && retry === "wait");
  if (!retrying || wait.deadline === null) {
    return [];
  }
  return id === undefined
    ? [retryWait(wait, "$run", "Retrying a step")]
    : [retryWait(wait, id, id)];
};

/**
 * The waits one pending wait of a run on the run host is, its steps
 * placed by its build's table of tasks (`steps`): a task's sleep, a retry
 * of any of its steps, a decision's wait, a listen's or a run's own; core's
 * own steps of a task's step (`keyedWaitsOf`) or of a wait for load
 * (`coreWaitsOf`), each hold once (`holding`); none otherwise.
 */
const sealedWaitsOf = (
  wait: Pending,
  steps: SealedSteps,
  context: WaitContext,
  holding: Set<string>
): Json[] => {
  if (wait.openedAt === null) {
    return [];
  }
  const keyed = keyedWait.exec(wait.name)?.groups;
  if (keyed?.key !== undefined) {
    return keyedWaitsOf(wait, keyed.key, keyed.retry, context);
  }
  const step = sealedStepOf(wait.name, steps);
  const task = step === undefined ? undefined : context.tasks.get(step.task);
  if (step === undefined || task === undefined) {
    return coreWaitsOf(wait, holding);
  }
  if (wait.type === "retry") {
    return [retryWait(wait, step.task, step.task)];
  }
  const own = step.kind === "task" && step.part === "";
  if (wait.type === "sleep") {
    return own && wait.deadline !== null ? [sleepWait(wait, step.task)] : [];
  }
  if (step.kind === "task" && answerPart.test(step.part)) {
    return decisionOf(wait, step.task, task, context);
  }
  return own ? awaitedOf(wait, step.task, task, context) : [];
};

/** A decision task's wait or look, past `decisionPollStepPrefix`. */
const decisionPoll = /^(?<step>.+):(?<part>wait|woken):(?<round>\d+)$/u;

/**
 * `name`, a decision task's wait or look as core names it (its own steps,
 * under `decisionPollStepPrefix`), read as its task's step:
 * `<task step>:decision:<wait|woken>:<round>`; any other name as it is.
 */
const taskStepName = (name: string): string => {
  if (!name.startsWith(decisionPollStepPrefix)) {
    return name;
  }
  const poll = decisionPoll.exec(name.slice(decisionPollStepPrefix.length));
  const { step, part, round } = poll?.groups ?? {};
  return step === undefined || part === undefined || round === undefined
    ? name
    : `${step}:decision:${part}:${round}`;
};

/**
 * The waits a screen is shown of `pending`, the engine's list of a run's
 * open waits, read against its build and release (`context`): each of a
 * kind it names (see the header), nothing else, as its name could be
 * made of what the run read.
 */
export const shownWaits = (
  pending: readonly Pending[],
  context: WaitContext
): Json[] => {
  const waits: Json[] = [];
  const holding = new Set<string>();
  const steps: SealedSteps | undefined =
    context.sealed === true ? context.tasks : undefined;
  for (const wait of pending) {
    if (steps !== undefined) {
      waits.push(...sealedWaitsOf(wait, steps, context, holding));
      continue;
    }
    const step = taskStep.exec(taskStepName(wait.name))?.groups;
    const shown =
      step?.id === undefined
        ? coreWaitsOf(wait, holding)
        : taskWaitsOf(wait, step.id, step.rest ?? "", context, holding);
    waits.push(...shown);
  }
  return waits.slice(0, maxWaits);
};

/**
 * The tasks run `run`'s version's sealed build declares, and whether it
 * was generated for the run host (`sealedStepsOf`); none if unreadable.
 */
const sealedTasks = async (
  env: Env,
  run: { workflowId: string; version: number; manifestHash: string }
): Promise<{ tasks: ReadonlyMap<string, WaitTask>; sealed: boolean }> => {
  try {
    const build = await loadWorkflowBuild(
      env,
      run.workflowId,
      run.version,
      run.manifestHash
    );
    return {
      tasks: new Map(
        build.tasks.map((task) => {
          const { kind, steps, scope } = task;
          return [
            task.id,
            task.kind === "call" && task.call.name === "grasp.decision"
              ? { kind, steps, scope, decision: task.call.binding }
              : { kind, steps, scope },
          ];
        })
      ),
      sealed: sealedStepsOf(build) !== undefined,
    };
  } catch (error) {
    // Logged where it loads (workflow-builds.ts): its waits name no task.
    log.error("workflow.waits_build_unreadable", {
      workflowId: run.workflowId,
      version: run.version,
      ...errorFields(error),
    });
    return { tasks: new Map(), sealed: false };
  }
};

/**
 * The task of each of `names`, engine steps of a run on the run host, as
 * its build's table places it (`steps`), by the key core names its own
 * steps of it by (`waitKeyOf`): `WaitContext.keyed`.
 */
export const tasksByKey = async (
  names: readonly string[],
  steps: SealedSteps
): Promise<ReadonlyMap<string, string>> => {
  const keyed = new Map<string, string>();
  for (const name of names) {
    const step = sealedStepOf(name, steps);
    if (step !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- a digest each, of names alone
      keyed.set(await waitKeyOf(name), step.task);
    }
  }
  return keyed;
};

/**
 * Of run `runId` on the run host, the task of each step its journal holds,
 * by its key (`tasksByKey`); none while the engine can't say (logged).
 */
const keyedTasks = async (
  env: Env,
  runId: string,
  steps: SealedSteps
): Promise<ReadonlyMap<string, string>> => {
  try {
    const page = await runObjectOf(env, runId).history({
      after: 0,
      limit: 1,
      steps: [{ kind: null, prefix: null }],
    });
    const names = (page?.steps[0] ?? []).map(({ name }) => name);
    return await tasksByKey(names, steps);
  } catch (error) {
    log.warn("workflow.waits_steps_unreadable", {
      runId,
      ...errorFields(error),
    });
    return new Map();
  }
};

/** Run `runId`'s one child still under way, by its handle, if it has one. */
const onlyChild = async (
  env: Env,
  runId: string
): Promise<Json | undefined> => {
  const children = await drizzle(env.DB)
    .select({
      runId: workflowResourceRuns.id,
      workflowId: workflowResourceRuns.workflowResourceId,
      workflowVersion: workflowResourceRuns.version,
      manifestHash: workflowResourceRuns.manifestHash,
    })
    .from(workflowResourceRuns)
    .where(
      and(
        eq(workflowResourceRuns.parentRunId, runId),
        inArray(workflowResourceRuns.status, ["starting", "running", "paused"])
      )
    )
    .limit(2);
  const [child] = children;
  return children.length === 1 ? child : undefined;
};

/**
 * What run `run` waits on now, as a screen's snapshot lists it (see the
 * header), for the release's binding of its workflow (`declared`): none
 * while it has no record in the engine, or while the engine can't say
 * (logged: the rest of the snapshot is still worth showing).
 */
export const runWaits = async (
  env: Env,
  run: {
    id: string;
    workflowId: string;
    version: number;
    manifestHash: string;
  },
  declared: Pick<BoundWorkflow, "events" | "listens" | "decisions">,
  canSend: boolean
): Promise<Json[]> => {
  let pending: readonly Pending[] | undefined;
  try {
    pending = await runObjectOf(env, run.id).pendingWaits();
  } catch (error) {
    log.warn("workflow.waits_unreadable", {
      runId: run.id,
      ...errorFields(error),
    });
    return [];
  }
  if (pending === undefined || pending.length === 0) {
    return [];
  }
  const fingerprints = await Promise.all(
    Object.entries(declared.events).map(
      async ([alias, event]) => [alias, await eventFingerprint(event)] as const
    )
  );
  const waitsChild = pending.some(
    (wait) => wait.type === "waitForEvent" && wait.eventType === null
  );
  const { tasks, sealed } = await sealedTasks(env, run);
  const keyed =
    sealed && pending.some((wait) => keyedWait.test(wait.name))
      ? await keyedTasks(env, run.id, tasks)
      : undefined;
  return shownWaits(pending, {
    tasks,
    sealed,
    ...(keyed === undefined ? {} : { keyed }),
    decisionKeys: new Set(Object.keys(declared.decisions)),
    listens: declared.listens,
    events: new Map(fingerprints),
    child: waitsChild ? await onlyChild(env, run.id) : undefined,
    canSend,
  });
};

/** Who a snapshot's waits are shown to, as answering its decisions goes. */
export interface WaitViewer {
  readonly userId: string;
  /** Grasp staff answer no client's decision (decisions.ts). */
  readonly staff?: boolean;
  /**
   * Whether the run's restricted mode is the App's: only then is a
   * decision of it the App's screen's to answer (screen-runs.ts,
   * `appDecision`).
   */
  readonly sameRestriction: boolean;
}

/**
 * `waits` with each decision's `canRespond` the viewer's (spec 10.7.2):
 * whether they may answer it there now, as the decision service has it
 * (`answerableByNow`: eligible, still pending), never for staff, and only
 * where the run's restricted mode is the App's. Read in one statement for
 * every decision listed.
 */
export const withRespond = async (
  env: Env,
  runId: string,
  waits: readonly Json[],
  viewer: WaitViewer
): Promise<Json[]> => {
  const decisions = waits.flatMap((wait) => {
    const parsed = decisionWaitSchema.safeParse(wait);
    return parsed.success ? [parsed.data.id] : [];
  });
  if (
    decisions.length === 0 ||
    viewer.staff === true ||
    !viewer.sameRestriction
  ) {
    return [...waits];
  }
  const db = drizzle(env.DB);
  const rows = await db
    .select({ id: workflowDecisions.id })
    .from(workflowDecisions)
    .where(
      and(
        eq(workflowDecisions.resourceRunId, runId),
        inArray(workflowDecisions.id, decisions),
        resourceDecisionPending(new Date()),
        answerableByNow(db, viewer.userId)
      )
    );
  const answerable = new Set(rows.map(({ id }) => id));
  return waits.map((wait) => {
    const parsed = decisionWaitSchema.safeParse(wait);
    return parsed.success && answerable.has(parsed.data.id)
      ? { ...parsed.data.wait, canRespond: true }
      : wait;
  });
};
