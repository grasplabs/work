import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { coreStepPrefix } from "@grasp-os/shared/workflows";

import { loadWorkflowBuild } from "../workflow-builds.ts";
import { runObjectOf } from "./engine.ts";

// What an independent run waits on now, as its screens are shown it (spec
// 10.7.2), read from the engine's journal (workerflow's `pendingWaits`),
// never guessed from its definition or status:
//
// - a timer: a task's sleep (a `wait` task), or a step of a task waiting
//   for its retry's backoff;
// - a hold of the platform's (`blocked`): a call connect held for the
//   person it acts for to confirm (`policy`), a call whose outcome no one
//   knows yet (`uncertain`), or a step waiting for a share of what runs at
//   once (`quota`), as core's own steps of it are named
//   (`$grasp:wait:<key>:<kind>:<round>…`, host.ts): one wait per held step,
//   however many checks and rounds it took.
//
// Independent runs listen for no events, open no decisions and start no
// runs yet, so they have no such waits. What a wait shows is metadata
// only: a task's ID as its version's sealed build names it (a step of any
// other name is left out: it could be made of what the run read), its
// kind and its times, never a value of the run's. Read after the run's row,
// whose revision a snapshot carries: a wait opened or closed since moves
// that revision on (resource-runs.ts, `projectResourceRun`), so the screen
// reads it again.

/** The most waits a snapshot lists, as the SDK reads them (`maxWaits`). */
const maxWaits = 256;

/** A step of a task, as the generated code names it: its kind, then its ID. */
const taskStep =
  /^(?:task|enter|leave|item):(?<id>[a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:@[a-z0-9.\-/]+)?$/u;

/** One of core's own steps of a wait it holds a step at (host.ts, `waitStep`). */
const holdStep = new RegExp(
  `^${coreStepPrefix.replaceAll("$", "\\$")}wait:(?<key>[0-9a-f]{16}):(?<kind>busy|held|unknown):`,
  "u"
);

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

/** The task IDs run `run`'s version's sealed build declares; none if unreadable. */
const sealedTasks = async (
  env: Env,
  run: { workflowId: string; version: number; manifestHash: string }
): Promise<ReadonlySet<string>> => {
  try {
    const { tasks } = await loadWorkflowBuild(
      env,
      run.workflowId,
      run.version,
      run.manifestHash
    );
    return new Set(tasks.map(({ id }) => id));
  } catch (error) {
    // Logged where it loads (workflow-builds.ts): its waits name no task.
    log.error("workflow.waits_build_unreadable", {
      workflowId: run.workflowId,
      version: run.version,
      ...errorFields(error),
    });
    return new Set();
  }
};

/** A pending wait as the engine lists it (workerflow's `PendingWait`). */
interface Pending {
  readonly ordinal: number;
  readonly type: "sleep" | "waitForEvent" | "retry";
  readonly name: string;
  readonly openedAt: number | null;
  readonly deadline: number | null;
}

/**
 * The hold `wait` is a step of, once per held step (`holding`, the keys
 * shown so far); `undefined` for any other wait, or a held step shown.
 */
const holdOf = (wait: Pending, holding: Set<string>): Json | undefined => {
  const hold = holdStep.exec(wait.name)?.groups;
  const shown =
    hold?.kind === "busy" || hold?.kind === "held" || hold?.kind === "unknown"
      ? holds[hold.kind]
      : undefined;
  if (
    hold?.key === undefined ||
    shown === undefined ||
    wait.openedAt === null ||
    holding.has(hold.key)
  ) {
    return undefined;
  }
  holding.add(hold.key);
  return {
    id: `hold-${hold.key}`,
    taskId: "$run",
    key: "$run",
    title: shown.title,
    openedAt: wait.openedAt,
    deadline: wait.deadline,
    kind: "blocked",
    reason: shown.reason,
    message: shown.message,
  };
};

/**
 * The timer `wait` is, a sleep or a retry of a task the build declares
 * (`tasks`); `undefined` for any other wait.
 */
const timerOf = (
  wait: Pending,
  tasks: ReadonlySet<string>
): Json | undefined => {
  const task = taskStep.exec(wait.name)?.groups?.id;
  if (
    task === undefined ||
    !tasks.has(task) ||
    wait.openedAt === null ||
    wait.deadline === null ||
    wait.type === "waitForEvent"
  ) {
    return undefined;
  }
  return {
    id: `wait-${wait.ordinal}`,
    taskId: task,
    key: task,
    title: task,
    openedAt: wait.openedAt,
    deadline: wait.deadline,
    kind: "timer",
    purpose: wait.type === "sleep" ? "sleep" : "retry",
  };
};

/**
 * What run `run` waits on now, as a screen's snapshot lists it (see the
 * header): none while it has no record in the engine.
 */
export const runWaits = async (
  env: Env,
  run: {
    id: string;
    workflowId: string;
    version: number;
    manifestHash: string;
  }
): Promise<Json[]> => {
  const pending = await runObjectOf(env, run.id).pendingWaits();
  if (pending === undefined || pending.length === 0) {
    return [];
  }
  const tasks = await sealedTasks(env, run);
  const waits: Json[] = [];
  const holding = new Set<string>();
  for (const wait of pending) {
    const shown = holdOf(wait, holding) ?? timerOf(wait, tasks);
    if (shown !== undefined) {
      waits.push(shown);
    }
  }
  return waits.slice(0, maxWaits);
};
