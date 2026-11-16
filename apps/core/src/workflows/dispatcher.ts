import type {
  WorkflowEvent,
  WorkflowStep,
} from "@grasp-os/workerflow/contracts";

import { runCandidateWorkflow } from "./candidate-runs.ts";
import { engineCall } from "./engine-asks.ts";
import type { RunPin } from "./engine.ts";
import { runFixtureWorkflow } from "./fixture-runs.ts";
import type { AiCalls, HostHooks, RunStep } from "./host.ts";
import { runResourceWorkflow } from "./resource-runs.ts";
import type { RunModelCalls, SentCalls } from "./sealed-run.ts";

// What every run executes (run-object.ts): each time the engine activates
// a run, at its start and on every wake or recovery, the dispatcher loads
// it afresh by what it is pinned to (engine.ts): an independent
// workflow's sealed version, a test run of its draft at one revision, or
// a run an App's test started.
//
// A run the engine has paused, terminated or taken over (a newer
// activation) is fenced by the engine: its calls of the step API never
// settle, so none of its code runs on in an activation that is over
// (@grasp-os/workerflow, activation.ts).

/**
 * The delay before every step's retry, in milliseconds, when tests set one
 * (`WORKFLOW_RETRY_DELAY_MS`): so a test of a step that fails for a moment
 * needn't wait out its real backoff.
 */
const testRetryDelayOf = (env: Env): number | undefined => {
  const set = Number(env.WORKFLOW_RETRY_DELAY_MS);
  return env.WORKFLOW_RETRY_DELAY_MS !== undefined &&
    Number.isInteger(set) &&
    set >= 0
    ? set
    : undefined;
};

/** The engine's `step`, as the host takes it. */
const runStepOf = (env: Env, step: WorkflowStep): RunStep => {
  const delay = testRetryDelayOf(env);
  // Each call told to the ask a host handles, if any, as it is made
  // (engine-asks.ts).
  return {
    do: async (name, config, fn) =>
      await engineCall(
        async () =>
          await step.do(
            name,
            delay === undefined || config.retries === undefined
              ? config
              : { ...config, retries: { ...config.retries, delay } },
            fn
          )
      ),
    sleep: async (name, duration) => {
      await engineCall(async () => {
        await step.sleep(name, duration);
      });
    },
    sleepUntil: async (name, timestamp) => {
      await engineCall(async () => {
        await step.sleepUntil(name, timestamp);
      });
    },
    waitForEvent: async (name, options) =>
      await engineCall(async () => await step.waitForEvent(name, options)),
    waitForMatch: async (name, options) =>
      await engineCall(async () => await step.waitForMatch(name, options)),
    busy: () => step.busy(),
  };
};

/**
 * What a run has of its own object beside the engine's journal: the
 * engine's lease of each step's attempt, read from the journal as it is
 * now (run-object.ts).
 */
export interface RunMemory {
  /** The model calls its JSON workflow made (sealed-run.ts). */
  modelCalls?: RunModelCalls;
  /** Its sealed build's calls tried once that went out (sealed-run.ts). */
  sentCalls?: SentCalls;
  /** Keeps the task whose step's failure it ends with (run-object.ts). */
  keepFailedTask?: (task: string | null) => void;
  /** Its AI calls in flight and answers no attempt took (host.ts). */
  aiCalls: AiCalls;
  leaseOf: HostHooks["leaseOf"];
  /**
   * Aborts once the activation running the run is over, however it ended:
   * a wait suspended it, whose call never settles, so the run's isolate,
   * on-prem a sandbox session holding a process, is let go of then.
   */
  over?: AbortSignal;
  /**
   * Whether the run is still this activation's: not cancelled, nor taken
   * over by a newer one (run-object.ts).
   */
  current?: () => boolean;
  /**
   * Ends the activation as a process that died would, and runs the run
   * again from its journal: an App's test's fault alone asks it
   * (fixture-runs.ts).
   */
  restart?: () => Promise<void>;
  /**
   * The run's time (workerflow's `runTime`): the wall clock unless an
   * App's test moved its clock on. The wall clock without it.
   */
  now?: () => number;
}

/**
 * Runs (or resumes) one activation of the run `event` names, as it is
 * pinned (engine.ts, `RunPin`).
 */
export const runPinned = async (
  env: Env,
  pin: RunPin,
  event: Pick<WorkflowEvent, "instanceId">,
  engineStep: WorkflowStep,
  memory: RunMemory
): Promise<unknown> => {
  const step = runStepOf(env, engineStep);
  if (pin.type === "resource") {
    // An independent workflow's sealed build: its input is its receipt's.
    return await runResourceWorkflow(env, pin, event.instanceId, step, memory);
  }
  if (pin.type === "candidate") {
    // A test run of a draft checkpoint: its input is its row's.
    return await runCandidateWorkflow(env, pin, event.instanceId, step, memory);
  }
  // An independent workflow's sealed build started by an App's test: its
  // input is its own record's.
  return await runFixtureWorkflow(env, pin, event.instanceId, step, memory);
};
