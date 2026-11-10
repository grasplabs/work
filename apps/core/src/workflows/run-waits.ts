import { eventFingerprint } from "@grasp-os/runtime/host";
import type { BoundWorkflow } from "@grasp-os/runtime/host";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { coreStepPrefix } from "@grasp-os/shared/workflows";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { workflowDecisions } from "../db/core/schema.ts";
import {
  answerableByNow,
  decisionOfEventType,
  resourceDecisionPending,
} from "../decisions/decisions.ts";
import { loadWorkflowBuild } from "../workflow-builds.ts";
import { runObjectOf } from "./engine.ts";
import { waitKeyOf } from "./host.ts";
import { sealedStepOf } from "./sealed-steps.ts";
import type { SealedSteps } from "./sealed-steps.ts";

// What an independent run waits on now, as its pages are shown it (spec
// 10.7.2), read from the engine's journal (workerflow's `pendingWaits`),
// never guessed from its definition or status. The run host (sealed-run.ts)
// names its steps `<task>:<part>`, from a task's second run in a loop's
// items on with its count of earlier runs after `@` (sealed-steps.ts),
// each placed by its build's table of tasks:
//
// - a timer: a wait task's sleep (`<task>:task`, a deadline's too), a
//   retry of any of a task's steps, or a catch's retry's backoff and its
//   rounds, under core's prefix by the retried step's key
//   (`$grasp:wait:<key>:retry:<round>:wait`, host.ts, `#retried`), of the
//   task whose step has that key in the run's journal;
// - a hold of the platform's (`blocked`): a call connect held for the
//   person it acts for to confirm (`policy`), once a round; or a step
//   waiting for a share of what runs at once (`quota`), as core's own
//   steps of that are named (`$grasp:wait:<key>:busy:<round>…`, host.ts),
//   once a step; each of the task whose step has the key it goes by, or
//   of the run if none has;
// - a person's decision: its wait (`<task>:task#answer`, the SDK's), and
//   its waits again under core's prefix by that wait's key
//   (`$grasp:wait:<key>:again:<round>`, host.ts, `waitForDecision`), by
//   the decision's ID its event names (decisions.ts, `decisionEventType`),
//   as its key the decision binding its task asks through, one the
//   release sealed;
// - an event an event wait waits for (`<task>:task` of a listen task):
//   one wait for each event of the release's reference it listens for.
//
// What a wait shows is metadata only: a task's ID as its version's sealed
// build names it (a step of any other name is left out: it could be made
// of what the run read), its kind, its times, and what the release names
// (a decision's key, an event's alias); never a value of the run's. Whether
// a person may answer a decision here is the reference's to say
// (`canRespond` is false). Read after the run's row, whose revision a
// snapshot carries: a wait opened or closed since moves that revision on
// (resource-runs.ts, `projectResourceRun`), so the page reads it again.

/** A decision wait, as `withRespond` reads one. */
const decisionWaitSchema = z
  .looseObject({ kind: z.literal("decision"), id: z.string() })
  .transform((wait) => ({ id: wait.id, wait }));

/** The most waits a snapshot lists, as the SDK reads them (`maxWaits`). */
const maxWaits = 256;

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

/** Any of core's own steps of a wait, by the key of the step it is of. */
const coreWaitStep = new RegExp(`^${waitPrefix}(?<key>[0-9a-f]{16}):`, "u");

/** What each kind of hold is, as a page reads it. */
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
  /** Whether the person may send the run its events now. */
  readonly canSend: boolean;
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

/** The events a listen task's own wait waits for. */
const awaitedOf = (
  wait: Pending,
  id: string,
  task: WaitTask,
  context: WaitContext
): Json[] => {
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
 * The waits one pending wait of core's own steps of a wait for load is:
 * its hold, once a held step (`holding`); a retry of its step's run again;
 * none otherwise. Each of the task `taskOf` names by its step's key, or
 * of the run.
 */
const coreWaitsOf = (
  wait: Pending,
  holding: Set<string>,
  taskOf?: (key: string) => string | undefined
): Json[] => {
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
    return [holdWait(hold.kind, wait, taskOf?.(hold.key) ?? "$run")];
  }
  const key = coreWaitStep.exec(wait.name)?.groups?.key;
  if (wait.type !== "retry" || key === undefined || wait.deadline === null) {
    return [];
  }
  const task = taskOf?.(key);
  return [
    task === undefined
      ? retryWait(wait, "$run", "Retrying a step")
      : retryWait(wait, task, task),
  ];
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
    return coreWaitsOf(wait, holding, (key) => context.keyed?.get(key));
  }
  if (wait.type === "retry") {
    return [retryWait(wait, step.task, step.task)];
  }
  const own = step.kind === "task" && step.part === "";
  if (wait.type === "sleep") {
    return own && wait.deadline !== null ? [sleepWait(wait, step.task)] : [];
  }
  if (step.kind === "task" && step.part === "#answer") {
    return decisionOf(wait, step.task, task, context);
  }
  return own ? awaitedOf(wait, step.task, task, context) : [];
};

/**
 * The waits a page is shown of `pending`, the engine's list of a run's
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
  for (const wait of pending) {
    waits.push(...sealedWaitsOf(wait, context.tasks, context, holding));
  }
  return waits.slice(0, maxWaits);
};

/** The tasks run `run`'s version's sealed build declares; none if unreadable. */
const sealedTasks = async (
  env: Env,
  run: { workflowId: string; version: number; manifestHash: string }
): Promise<ReadonlyMap<string, WaitTask>> => {
  try {
    const build = await loadWorkflowBuild(
      env,
      run.workflowId,
      run.version,
      run.manifestHash
    );
    return new Map(
      build.tasks.map((task) => {
        const { kind, steps, scope } = task;
        return [
          task.id,
          task.kind === "call" && task.call.name === "grasp.decision"
            ? { kind, steps, scope, decision: task.call.binding }
            : { kind, steps, scope },
        ];
      })
    );
  } catch (error) {
    // Logged where it loads (workflow-builds.ts): its waits name no task.
    log.error("workflow.waits_build_unreadable", {
      workflowId: run.workflowId,
      version: run.version,
      ...errorFields(error),
    });
    return new Map();
  }
};

/** A catch's retry's run again of a step, by the step's key (host.ts). */
const retryRun = new RegExp(
  `^${waitPrefix}(?<key>[0-9a-f]{16}):retry:[1-9]\\d*:run$`,
  "u"
);

/**
 * The task of each of `names`, engine steps of a run on the run host in
 * the order its journal reached them, as its build's table places it
 * (`steps`), by the key core names its own steps of it by (`waitKeyOf`):
 * `WaitContext.keyed`. A catch's retry's run again goes by a key of its
 * own (host.ts, `#waitBefore`), its task's, after its step.
 */
export const tasksByKey = async (
  names: readonly string[],
  steps: SealedSteps
): Promise<ReadonlyMap<string, string>> => {
  const keyed = new Map<string, string>();
  for (const name of names) {
    const retried = retryRun.exec(name)?.groups?.key;
    const task =
      retried === undefined
        ? sealedStepOf(name, steps)?.task
        : keyed.get(retried);
    if (task !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- a digest each, of names alone
      keyed.set(await waitKeyOf(name), task);
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

/**
 * What run `run` waits on now, as a page's snapshot lists it (see the
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
  const tasks = await sealedTasks(env, run);
  const keyed = pending.some((wait) => coreWaitStep.test(wait.name))
    ? await keyedTasks(env, run.id, tasks)
    : undefined;
  return shownWaits(pending, {
    tasks,
    ...(keyed === undefined ? {} : { keyed }),
    decisionKeys: new Set(Object.keys(declared.decisions)),
    listens: declared.listens,
    events: new Map(fingerprints),
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
   * decision of it the App's page's to answer (page-decisions.ts,
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
